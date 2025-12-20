const { app } = require("@azure/functions");
const { CosmosClient } = require("@azure/cosmos");
const {
  getContainerPartitionKeyPath,
  buildPartitionKeyCandidates,
} = require("../_cosmosPartitionKey");

function cors(req) {
  const origin = req?.headers?.get?.("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-functions-key",
  };
}

function json(obj, status = 200, req, extraHeaders) {
  return {
    status,
    headers: {
      ...cors(req),
      "Content-Type": "application/json",
      ...(extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {}),
    },
    body: JSON.stringify(obj),
  };
}

let companiesPkPathPromise;
async function getCompaniesPkPath(container) {
  if (!container) return "/normalized_domain";
  companiesPkPathPromise ||= getContainerPartitionKeyPath(container, "/normalized_domain");
  try {
    return await companiesPkPathPromise;
  } catch {
    return "/normalized_domain";
  }
}

async function readControlDoc(container, id, sessionId) {
  if (!container) return null;
  const containerPkPath = await getCompaniesPkPath(container);

  const docForCandidates = {
    id,
    session_id: sessionId,
    normalized_domain: "import",
    partition_key: "import",
    type: "import_control",
  };

  const candidates = buildPartitionKeyCandidates({
    doc: docForCandidates,
    containerPkPath,
    requestedId: id,
  });

  let lastErr = null;
  for (const partitionKeyValue of candidates) {
    try {
      const item =
        partitionKeyValue !== undefined
          ? container.item(id, partitionKeyValue)
          : container.item(id);
      const { resource } = await item.read();
      return resource || null;
    } catch (e) {
      lastErr = e;
      if (e?.code === 404) return null;
    }
  }

  if (lastErr && lastErr.code !== 404) {
    try {
      console.warn(`[import-status] session=${sessionId} control doc read failed: ${lastErr.message}`);
    } catch {}
  }
  return null;
}

async function hasAnyCompanyDocs(container, sessionId) {
  if (!container) return false;
  try {
    const q = {
      query: `SELECT TOP 1 c.id FROM c WHERE c.session_id = @sid AND NOT STARTSWITH(c.id, '_import_')`,
      parameters: [{ name: "@sid", value: sessionId }],
    };

    const { resources } = await container.items
      .query(q, { enableCrossPartitionQuery: true })
      .fetchAll();

    return Array.isArray(resources) && resources.length > 0;
  } catch (e) {
    try {
      console.warn(`[import-status] session=${sessionId} company probe failed: ${e?.message || String(e)}`);
    } catch {}
    return false;
  }
}

async function fetchRecentCompanies(container, sessionId, take) {
  if (!container) return [];
  const n = Math.max(0, Math.min(Number(take) || 10, 200));
  if (!n) return [];

  const q = {
    query: `
      SELECT c.id, c.company_name, c.name, c.url, c.website_url, c.industries, c.product_keywords, c.created_at
      FROM c
      WHERE c.session_id = @sid AND NOT STARTSWITH(c.id, '_import_')
      ORDER BY c.created_at DESC
    `,
    parameters: [{ name: "@sid", value: sessionId }],
  };

  const { resources } = await container.items
    .query(q, { enableCrossPartitionQuery: true })
    .fetchAll();

  return Array.isArray(resources) ? resources.slice(0, n) : [];
}

function normalizeErrorPayload(value) {
  if (!value) return null;
  if (typeof value === "string") return { message: value };
  if (typeof value === "object") return value;
  return { message: String(value) };
}

async function handler(req, context) {
  const method = String(req?.method || "").toUpperCase();
  if (method === "OPTIONS") return { status: 200, headers: cors(req) };

  const url = new URL(req.url);
  const sessionId = String(url.searchParams.get("session_id") || "").trim();
  const take = Number(url.searchParams.get("take") || "10") || 10;

  if (!sessionId) {
    return json({ ok: false, error: "Missing session_id" }, 400, req);
  }

  const endpoint = (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim();
  const key = (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim();
  const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
  const containerId = (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();

  if (!endpoint || !key) {
    return json({ ok: false, error: "Cosmos not configured" }, 500, req);
  }

  try {
    const client = new CosmosClient({ endpoint, key });
    const container = client.database(databaseId).container(containerId);

    const sessionDocId = `_import_session_${sessionId}`;
    const completionDocId = `_import_complete_${sessionId}`;
    const timeoutDocId = `_import_timeout_${sessionId}`;
    const stopDocId = `_import_stop_${sessionId}`;
    const errorDocId = `_import_error_${sessionId}`;

    const [sessionDoc, completionDoc, timeoutDoc, stopDoc, errorDoc] = await Promise.all([
      readControlDoc(container, sessionDocId, sessionId),
      readControlDoc(container, completionDocId, sessionId),
      readControlDoc(container, timeoutDocId, sessionId),
      readControlDoc(container, stopDocId, sessionId),
      readControlDoc(container, errorDocId, sessionId),
    ]);

    let known = Boolean(sessionDoc || completionDoc || timeoutDoc || stopDoc || errorDoc);
    if (!known) known = await hasAnyCompanyDocs(container, sessionId);

    if (!known) {
      return json({ ok: false, error: "Unknown session_id", session_id: sessionId }, 404, req);
    }

    const errorPayload = normalizeErrorPayload(errorDoc?.error || null);
    const timedOut = Boolean(timeoutDoc);
    const stopped = Boolean(stopDoc);
    const completed = Boolean(completionDoc);

    const items = await fetchRecentCompanies(container, sessionId, take).catch(() => []);
    const saved =
      (typeof completionDoc?.saved === "number" ? completionDoc.saved : null) ??
      (typeof sessionDoc?.saved === "number" ? sessionDoc.saved : null) ??
      (Array.isArray(items) ? items.length : 0);

    const lastCreatedAt = Array.isArray(items) && items.length > 0 ? String(items[0]?.created_at || "") : "";

    if (errorPayload || timedOut || stopped) {
      const errorOut =
        errorPayload ||
        (timedOut
          ? { code: "IMPORT_TIMEOUT", message: "Import timed out" }
          : stopped
            ? { code: "IMPORT_STOPPED", message: "Import was stopped" }
            : null);

      return json(
        {
          ok: true,
          state: "failed",
          session_id: sessionId,
          error: errorOut,
          items,
          saved,
          lastCreatedAt,
          completed: false,
          timedOut,
          stopped: true,
        },
        200,
        req
      );
    }

    if (completed) {
      return json(
        {
          ok: true,
          state: "complete",
          session_id: sessionId,
          result: {
            saved,
            completed_at: completionDoc?.completed_at || completionDoc?.created_at || null,
            reason: completionDoc?.reason || null,
          },
          items,
          saved,
          lastCreatedAt,
          completed: true,
          timedOut: false,
          stopped: true,
        },
        200,
        req
      );
    }

    return json(
      {
        ok: true,
        state: "running",
        session_id: sessionId,
        items,
        saved,
        lastCreatedAt,
        completed: false,
        timedOut: false,
        stopped: false,
      },
      200,
      req
    );
  } catch (e) {
    const msg = e?.message || String(e);
    try {
      console.error(`[import-status] session=${sessionId} error: ${msg}`);
    } catch {}
    return json({ ok: false, error: "Status handler failure", detail: msg, session_id: sessionId }, 500, req);
  }
}

app.http("import-status", {
  route: "import/status",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler,
});

app.http("import-status-alt", {
  route: "import-status",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler,
});

module.exports = { _test: { handler } };
