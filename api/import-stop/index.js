// api/import-stop/index.js - Stop a running import session
const { app } = require("@azure/functions");
const { CosmosClient } = require("@azure/cosmos");

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
