import { app } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';

const E = (key, def = "") => (process.env[key] ?? def).toString().trim();

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };
}

const json = (obj, status = 200) => ({
  status,
  headers: getCorsHeaders(),
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

function getAnalyticsContainer() {
  const client = getCosmosClient();
  if (!client) return null;
  const databaseId = E("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = "analytics";
  return client.database(databaseId).container(containerId);
}

export default app.http('adminAnalytics', {
  route: 'admin-analytics',
  methods: ['GET', 'OPTIONS'],
  authLevel: 'anonymous',
}, async (req, context) => {
  const method = String(req.method || "").toUpperCase();

  if (method === "OPTIONS") {
    return {
      status: 204,
      headers: getCorsHeaders(),
    };
  }

  const container = getAnalyticsContainer();
  if (!container) {
    return json(
      {
        totalSearches: 0,
        uniqueUsers: 0,
        topSearchTerms: [],
        affiliateClicks: 0,
        amazonConversions: 0,
      },
      200
    );
  }

  try {
    const url = new URL(req.url);
    const startDate = url.searchParams.get("start") || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const endDate = url.searchParams.get("end") || new Date().toISOString();

    const { resources } = await container.items
      .query({
        query: "SELECT * FROM c WHERE c.created_at >= @start AND c.created_at <= @end ORDER BY c.created_at DESC",
        parameters: [
          { name: "@start", value: startDate },
          { name: "@end", value: endDate },
        ],
      })
      .fetchAll();

    const totalSearches = resources.filter(r => r.type === "search").length;
    const uniqueUsers = new Set(resources.map(r => r.user_id)).size;
    const affiliateClicks = resources.filter(r => r.type === "affiliate_click").length;
    const amazonConversions = resources.filter(r => r.type === "amazon_conversion").length;

    const searchTerms = {};
    resources
      .filter(r => r.type === "search")
      .forEach(r => {
        const term = r.search_term || "Unknown";
        searchTerms[term] = (searchTerms[term] || 0) + 1;
      });

    const topSearchTerms = Object.entries(searchTerms)
      .map(([term, count]) => ({ term, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return json(
      {
        totalSearches,
        uniqueUsers,
        topSearchTerms,
        affiliateClicks,
        amazonConversions,
      },
      200
    );
  } catch (e) {
    context.log("Error in admin-analytics:", e?.message || e);
    return json(
      {
        totalSearches: 0,
        uniqueUsers: 0,
        topSearchTerms: [],
        affiliateClicks: 0,
        amazonConversions: 0,
      },
      200
    );
  }
});
