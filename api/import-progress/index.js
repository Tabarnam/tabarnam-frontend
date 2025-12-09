// api/import-progress/index.js
const { app } = require("@azure/functions");
const { CosmosClient } = require("@azure/cosmos");

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

app.http("import-progress", {
  route: "import/progress",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    if (req.method === "OPTIONS") return { status: 204, headers: cors(req) };

    const sessionId = new URL(req.url).searchParams.get("session_id");
    const take = Number(new URL(req.url).searchParams.get("take") || "200") || 200;

    if (!sessionId) {
      return json({ error: "session_id is required" }, 400, req);
    }

    console.log(`[import-progress] Polling for session_id: ${sessionId}, take: ${take}`);

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
      // Check if import was stopped
      let stopped = false;
      try {
        const controlContainer = client.database(databaseId).container("import_control");
        const { resources: stopResources } = await controlContainer.items
          .query({
            query: "SELECT c.id FROM c WHERE c.session_id = @sid AND c.type = @type",
            parameters: [
              { name: "@sid", value: sessionId },
              { name: "@type", value: "import_stop" }
            ]
          }, { enableCrossPartitionQuery: true })
          .fetchAll();
        stopped = stopResources && stopResources.length > 0;
      } catch (e) {
        // Control container doesn't exist yet, import is not stopped
        stopped = false;
      }

      // Query companies from Cosmos DB for this session
      const q = {
        query: `
          SELECT c.id, c.company_name, c.name, c.url, c.website_url, c.industries, c.product_keywords, c.created_at
          FROM c
          WHERE c.session_id = @sid
          ORDER BY c.created_at DESC
        `,
        parameters: [
          { name: "@sid", value: sessionId },
          { name: "@take", value: take }
        ],
      };

      const { resources } = await container.items.query(q, { enableCrossPartitionQuery: true }).fetchAll();
      const saved = resources.length || 0;
      const lastCreatedAt = resources?.[0]?.created_at || "";

      console.log(`[import-progress] Found ${saved} companies in Cosmos DB for session ${sessionId}, stopped: ${stopped}`);

      // Return what we found in Cosmos DB
      return json({
        ok: true,
        session_id: sessionId,
        items: resources.slice(0, take),
        steps: [],
        stopped: stopped,
        saved,
        lastCreatedAt
      }, 200, req);
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
