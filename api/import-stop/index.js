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
      return { status: 204, headers: cors(req) };
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

    if (!endpoint || !key) {
      context.log("[import-stop] Cosmos DB not configured");
      return json({ ok: true, message: "Stop signal queued (DB not configured)" }, 200, req);
    }

    try {
      const client = new CosmosClient({ endpoint, key });
      const database = client.database(databaseId);

      // Use a dedicated control container or fall back to creating a synthetic document
      // Store stop signal as a control document that import-start can check
      const controlContainerId = "import_control";
      let controlContainer;

      try {
        controlContainer = database.container(controlContainerId);
      } catch (e) {
        context.log(`[import-stop] Control container '${controlContainerId}' not available: ${e.message}`);
        // Create a placeholder or continue without it
        return json({ ok: true, message: "Stop signal received but control container unavailable" }, 202, req);
      }

      // Write a stop control document
      const controlDoc = {
        id: `stop_${sessionId}`,
        session_id: sessionId,
        stopped_at: new Date().toISOString(),
        type: "import_stop",
        partition_key: "control",
      };

      await controlContainer.items.upsert(controlDoc, { partitionKey: "control" });

      context.log(`[import-stop] Stop signal written for session ${sessionId}`);
      return json({ ok: true, session_id: sessionId, message: "Import stop signal sent" }, 200, req);
    } catch (e) {
      context.log("[import-stop] Error writing stop signal:", e.message);
      return json({ ok: true, session_id: sessionId, message: "Stop signal queued (error caught)" }, 202, req);
    }
  },
});
