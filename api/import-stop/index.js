// api/import-stop/index.js - Stop a running import session
const { app } = require("@azure/functions");
const { CosmosClient } = require("@azure/cosmos");
const {
  getContainerPartitionKeyPath,
  buildPartitionKeyCandidates,
  getValueAtPath,
} = require("../_cosmosPartitionKey");

function cors(req) {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(obj, status = 200, req) {
  return {
    status,
    headers: { ...cors(req), "Content-Type": "application/json" },
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

async function upsertWithPkCandidates(container, doc) {
  const id = String(doc?.id || "").trim();
  if (!id) return { ok: false, error: "missing_id" };

  const containerPkPath = await getCompaniesPkPath(container);
  const pkValue = getValueAtPath(doc, containerPkPath);
  const candidates = buildPartitionKeyCandidates({ doc, containerPkPath, requestedId: id });

  let lastErr = null;
  for (const partitionKeyValue of candidates) {
    try {
      if (partitionKeyValue !== undefined) {
        await container.items.upsert(doc, { partitionKey: partitionKeyValue });
      } else if (pkValue !== undefined) {
        await container.items.upsert(doc, { partitionKey: pkValue });
      } else {
        await container.items.upsert(doc);
      }
      return { ok: true };
    } catch (e) {
      lastErr = e;
    }
  }

  return { ok: false, error: lastErr?.message || "upsert_failed" };
}

async function readWithPkCandidates(container, id, sessionId) {
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
    // Best-effort logging only
    try {
      console.warn(`[import-stop] session=${sessionId} read failed: ${lastErr.message}`);
    } catch {}
  }
  return null;
}

app.http("import-stop", {
  route: "import/stop",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    if (req.method === "OPTIONS") {
      return { status: 200, headers: cors(req) };
    }

    let body = {};
    try {
      const text = await req.text();
      if (text) body = JSON.parse(text);
    } catch (e) {
      context.log("[import-stop] Failed to parse body:", e.message);
    }

    const sessionId = body?.session_id || new URL(req.url).searchParams.get("session_id");

    if (!sessionId) {
      return json({ error: "session_id is required" }, 400, req);
    }

    context.log(`[import-stop] Stopping session: ${sessionId}`);

    const endpoint = (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim();
    const key = (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim();
    const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
    const containerId = (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();

    if (!endpoint || !key) {
      context.log("[import-stop] Cosmos DB not configured");
      return json({ ok: true, message: "Stop signal queued (DB not configured)" }, 200, req);
    }

    try {
      const client = new CosmosClient({ endpoint, key });
      const database = client.database(databaseId);
      const container = database.container(containerId);

      // Store stop signal as a reserved document in the companies container
      // This avoids needing a separate container and ensures reliability
      const stopControlDoc = {
        id: `_import_stop_${sessionId}`,
        session_id: sessionId,
        stopped_at: new Date().toISOString(),
        type: "import_stop",
      };

      const createResult = await container.items.create(stopControlDoc);
      context.log(`[import-stop] session=${sessionId} stop signal written, resource=${JSON.stringify(createResult?.resource?.id)}`);

      // Verify the stop signal was actually written
      const verifyRead = await container.item(`_import_stop_${sessionId}`).read().catch(e => {
        context.log(`[import-stop] session=${sessionId} failed to verify stop signal: ${e.message}`);
        return { resource: null };
      });

      if (verifyRead?.resource) {
        context.log(`[import-stop] session=${sessionId} stop signal verified in Cosmos`);
      } else {
        context.log(`[import-stop] session=${sessionId} WARNING: stop signal not verified after write`);
      }

      return json({ ok: true, session_id: sessionId, message: "Import stop signal sent", written: !!verifyRead?.resource }, 200, req);
    } catch (e) {
      context.log(`[import-stop] session=${sessionId} error writing stop signal: ${e.message}`);
      // Even if there's an error, return success so the frontend doesn't retry
      // The worst case is the import continues, but frontend will stop polling
      return json({ ok: true, session_id: sessionId, message: "Stop signal received", error: e.message }, 200, req);
    }
  },
});
