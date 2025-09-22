// GET /api/get-reviews?company=Acme
import { app } from "@azure/functions";
import { CosmosClient } from "@azure/cosmos";

/**
 * Container is partitioned on /company.
 * We store both fields: company (pk) and company_name (for UI/back-compat).
 * This API accepts ?company=<name> and returns newest-first.
 */
app.http("getReviews", {
  route: "get-reviews",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    if (req.method === "OPTIONS") return { status: 204, headers: cors(req) };

    const endpoint   = process.env.COSMOS_DB_ENDPOINT;
    const key        = process.env.COSMOS_DB_KEY;
    const databaseId = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
    const containerId= process.env.COSMOS_DB_REVIEWS_CONTAINER || "reviews";
    if (!endpoint || !key) return json({ error: "Cosmos env not configured" }, 500, req);

    const company = (new URL(req.url)).searchParams.get("company")?.trim() || "";
    if (!company) return json({ error: "company query param required" }, 400, req);

    const client    = new CosmosClient({ endpoint, key });
    const container = client.database(databaseId).container(containerId);

    // First try targeted query within the exact partition (fast path).
    const byPkQuery = {
      query: `
        SELECT r.id, r.company, r.company_name, r.rating, r.text, r.user_name, r.user_location,
               r.flagged_bot, r.bot_reason, r.created_at
        FROM r
        WHERE r.company = @company
        ORDER BY r.created_at DESC
      `,
      parameters: [{ name: "@company", value: company }]
    };

    try {
      const byPk = await container.items.query(byPkQuery, { partitionKey: company, maxItemCount: 50 }).fetchAll();
      if (Array.isArray(byPk?.resources) && byPk.resources.length) {
        return json({ reviews: byPk.resources }, 200, req);
      }
    } catch (e) {
      // If partition-targeted query errors for any reason, fall through to cross-partition
      ctx?.warn?.(`get-reviews by-partition failed: ${e?.message || e}`);
    }

    // Fallback: cross-partition (also matches legacy docs that only had company_name).
    const crossQuery = {
      query: `
        SELECT r.id, r.company, r.company_name, r.rating, r.text, r.user_name, r.user_location,
               r.flagged_bot, r.bot_reason, r.created_at
        FROM r
        WHERE (r.company = @company OR r.company_name = @company)
        ORDER BY r.created_at DESC
      `,
      parameters: [{ name: "@company", value: company }]
    };

    try {
      const { resources } = await container.items.query(crossQuery, { enableCrossPartitionQuery: true, maxItemCount: 50 }).fetchAll();
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
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-client-request-id, x-session-id"
  };
}
function json(obj, status = 200, req) {
  return { status, headers: { ...cors(req), "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
