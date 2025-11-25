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

app.http("adminRecentImports", {
  route: "admin/recent-imports",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    if (req.method === "OPTIONS") return { status: 204, headers: cors(req) };

    const take = Number(new URL(req.url).searchParams.get("take") || "25") || 25;

    console.log(`[admin-recent-imports] Fetching ${take} most recent imports`);

    const endpoint = (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim();
    const key = (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim();
    const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
    const containerId = (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();

    if (!endpoint || !key) {
      console.error("[admin-recent-imports] Cosmos DB not configured");
      return json({ error: "Cosmos not configured" }, 500, req);
    }

    const client = new CosmosClient({ endpoint, key });
    const container = client.database(databaseId).container(containerId);

    try {
      // Query most recent companies across all sessions
      const q = {
        query: `
          SELECT TOP @take
            c.id, 
            c.company_name, 
            c.name, 
            c.url, 
            c.website_url, 
            c.created_at,
            c.session_id
          FROM c
          WHERE c.created_at != null
          ORDER BY c.created_at DESC
        `,
        parameters: [
          { name: "@take", value: take }
        ],
      };

      const { resources } = await container.items.query(q, { enableCrossPartitionQuery: true }).fetchAll();

      console.log(`[admin-recent-imports] Found ${resources.length} recent imports`);

      // Format the response with imported_by (extract from session_id or use 'System')
      const imports = resources.map(r => ({
        id: r.id,
        company_name: r.company_name || r.name || "",
        url: r.url || r.website_url || "",
        website_url: r.website_url || r.url || "",
        created_at: r.created_at || "",
        imported_by: r.session_id ? "Admin" : "System", // In future, link session_id to user
        session_id: r.session_id || ""
      }));

      return json({
        ok: true,
        imports,
        count: imports.length
      }, 200, req);
    } catch (e) {
      console.error("[admin-recent-imports] Query error:", e.message);
      console.error("[admin-recent-imports] Full error:", e);
      return json(
        { error: "query failed", detail: e?.message || String(e) },
        500,
        req
      );
    }
  },
});
