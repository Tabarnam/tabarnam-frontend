// api/import-progress/index.js
const { app } = require("@azure/functions");
const { CosmosClient } = require("@azure/cosmos");
const {
  getContainerPartitionKeyPath,
  buildPartitionKeyCandidates,
} = require("../_cosmosPartitionKey");

const cors = (req) => {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
};

const json = (obj, status = 200, req) => ({
  status,
  headers: { ...cors(req), "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});

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
    console.warn(`[import-progress] session=${sessionId} control doc read failed: ${lastErr.message}`);
  }
  return null;
}

app.http("import-progress", {
  route: "import/progress",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    if (req.method === "OPTIONS") return { status: 200, headers: cors(req) };

    const sessionId = new URL(req.url).searchParams.get("session_id");
    const take = Number(new URL(req.url).searchParams.get("take") || "200") || 200;

    if (!sessionId) {
      return json({ error: "session_id is required" }, 400, req);
    }

    console.log(`[import-progress] session=${sessionId} polling take=${take}`);

    const endpoint = (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim();
    const key = (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim();
    const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
    const containerId = (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();

    if (!endpoint || !key) {
      console.error("[import-progress] Cosmos DB not configured");
      return json({ error: "Cosmos not configured" }, 500, req);
    }

    const client = new CosmosClient({ endpoint, key });
    const container = client.database(databaseId).container(containerId);

    try {
      // Check if import was stopped, timed out, completed, or failed
      let stopped = false;
      let timedOut = false;
      let completed = false;
      let failed = false;
      let error = null;

      const stopDocId = `_import_stop_${sessionId}`;
      const timeoutDocId = `_import_timeout_${sessionId}`;
      const completionDocId = `_import_complete_${sessionId}`;
      const errorDocId = `_import_error_${sessionId}`;

      const stopDoc = await readControlDoc(container, stopDocId, sessionId);
      const timeoutDoc = await readControlDoc(container, timeoutDocId, sessionId);
      const completionDoc = await readControlDoc(container, completionDocId, sessionId);
      const errorDoc = await readControlDoc(container, errorDocId, sessionId);
      const sessionDoc = await readControlDoc(container, `_import_session_${sessionId}`, sessionId);

      stopped = !!stopDoc;
      timedOut = !!timeoutDoc;
      completed = !!completionDoc;
      error = errorDoc && typeof errorDoc === "object" ? errorDoc.error || null : null;
      failed = !!error;

      // Query companies from Cosmos DB for this session (exclude reserved control documents)
      const q = {
        query: `
          SELECT c.id, c.company_name, c.name, c.url, c.website_url, c.industries, c.product_keywords, c.created_at
          FROM c
          WHERE c.session_id = @sid AND NOT STARTSWITH(c.id, '_import_')
          ORDER BY c.created_at DESC
        `,
        parameters: [{ name: "@sid", value: sessionId }],
      };

      const { resources } = await container.items.query(q, { enableCrossPartitionQuery: true }).fetchAll();

      const verifiedCount =
        sessionDoc && typeof sessionDoc.saved_verified_count === "number" && Number.isFinite(sessionDoc.saved_verified_count)
          ? sessionDoc.saved_verified_count
          : null;

      const saved = verifiedCount != null ? verifiedCount : resources.length || 0;
      const lastCreatedAt = resources?.[0]?.created_at || "";

      const saved_company_ids_verified = Array.isArray(sessionDoc?.saved_company_ids_verified)
        ? sessionDoc.saved_company_ids_verified
        : Array.isArray(sessionDoc?.saved_ids)
          ? sessionDoc.saved_ids
          : [];

      const saved_company_ids_unverified = Array.isArray(sessionDoc?.saved_company_ids_unverified)
        ? sessionDoc.saved_company_ids_unverified
        : [];

      const saved_verified_count = verifiedCount != null ? verifiedCount : saved_company_ids_verified.length;

      console.log(`[import-progress] session=${sessionId} found=${saved} stopped=${stopped} timedOut=${timedOut} completed=${completed}`);

      // Return what we found in Cosmos DB
      // Note: completed flag signals that import-start finished (0 results or successful save)
      return json(
        {
          ok: true,
          session_id: sessionId,
          items: resources.slice(0, take),
          steps: [],
          stopped: stopped || timedOut || completed || failed,
          timedOut,
          completed,
          failed,
          ...(error ? { error } : {}),
          saved,
          lastCreatedAt,
        },
        200,
        req
      );
    } catch (e) {
      console.error("[import-progress] Query error:", e.message);
      console.error("[import-progress] Full error:", e);
      return json(
        { error: "query failed", detail: e?.message || String(e) },
        500,
        req
      );
    }
  },
});
