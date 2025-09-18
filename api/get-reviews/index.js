// GET /api/get-reviews?company=Acme
import { app } from "@azure/functions";
import { CosmosClient } from "@azure/cosmos";

/**
 * Env:
 *  COSMOS_DB_ENDPOINT, COSMOS_DB_KEY, COSMOS_DB_DATABASE
 *  COSMOS_DB_REVIEWS_CONTAINER (default "reviews")
 */
app.http("getReviews", {
  route: "get-reviews",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req) => {
    if (req.method === "OPTIONS") return { status: 204, headers: cors(req) };

    const endpoint = process.env.COSMOS_DB_ENDPOINT;
    const key = process.env.COSMOS_DB_KEY;
    const databaseId = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
    const containerId = process.env.COSMOS_DB_REVIEWS_CONTAINER || "reviews";
    if (!endpoint || !key) return json({ error: "Cosmos env not configured" }, 500, req);

    const company = (new URL(req.url)).searchParams.get("company") || "";
    if (!company.trim()) return json({ error: "company query param required" }, 400, req);

    const client = new CosmosClient({ endpoint, key });
    const container = client.database(databaseId).container(containerId);

    // Partition by company_name (recommended for performance)
    const sql = {
      query: `
        SELECT r.id, r.company_name, r.rating, r.text, r.user_name, r.user_location,
               r.flagged_bot, r.bot_reason, r.created_at
        FROM r
        WHERE r.company_name = @company
        ORDER BY r.created_at DESC
      `,
      parameters: [{ name: "@company", value: company }]
    };

    try {
      const { resources } = await container.items.query(sql, { enableCrossPartitionQuery: true }).fetchAll();
      return json({ reviews: resources || [] }, 200, req);
    } catch (e) {
      return json({ error: e.message || "Query failed" }, 500, req);
    }
  }
});

function cors(req) {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}
function json(obj, status = 200, req) {
  return { status, headers: { ...cors(req), "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
