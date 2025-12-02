import { app } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';

const E = (key, def = "") => (process.env[key] ?? def).toString().trim();

const json = (obj, status = 200, req) => ({
  status,
  headers: {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  },
  body: JSON.stringify(obj),
});

let cosmosClient = null;

function getCosmosClient() {
  const endpoint = E("COSMOS_DB_ENDPOINT");
  const key = E("COSMOS_DB_KEY");
  if (!endpoint || !key) return null;
  cosmosClient ||= new CosmosClient({ endpoint, key });
  return cosmosClient;
}

function getCompaniesContainer() {
  const client = getCosmosClient();
  if (!client) return null;
  const databaseId = E("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = E("COSMOS_DB_COMPANIES_CONTAINER", "companies");
  return client.database(databaseId).container(containerId);
}

export default app.http('adminImportStats', {
  route: 'admin-import-stats',
  methods: ['GET', 'OPTIONS'],
  authLevel: 'anonymous',
}, async (req, context) => {
  if (req.method === "OPTIONS") {
    return { status: 204, headers: { "Access-Control-Allow-Origin": "*" } };
  }

  const container = getCompaniesContainer();
  if (!container) {
    return json({ error: "Cosmos DB not configured", last24h: 0, last7d: 0, lastMonth: 0 }, 500, req);
  }

  try {
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const lastMonth = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const [res24, res7, resMonth] = await Promise.all([
      container.items.query({
        query: "SELECT VALUE COUNT(1) FROM c WHERE c.created_at > @date AND (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted = false)",
        parameters: [{ name: "@date", value: last24h }],
      }).fetchAll(),
      container.items.query({
        query: "SELECT VALUE COUNT(1) FROM c WHERE c.created_at > @date AND (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted = false)",
        parameters: [{ name: "@date", value: last7d }],
      }).fetchAll(),
      container.items.query({
        query: "SELECT VALUE COUNT(1) FROM c WHERE c.created_at > @date AND (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted = false)",
        parameters: [{ name: "@date", value: lastMonth }],
      }).fetchAll(),
    ]);

    return json(
      {
        last24h: res24.resources[0] || 0,
        last7d: res7.resources[0] || 0,
        lastMonth: resMonth.resources[0] || 0,
      },
      200,
      req
    );
  } catch (e) {
    context.log("Error in admin-import-stats:", e?.message || e);
    return json({ error: e?.message || "Internal error", last24h: 0, last7d: 0, lastMonth: 0 }, 500, req);
  }
});
