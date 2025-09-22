// GET /api/reviews-debug?company=Snow%20Cosmetics%20LLC
import { app } from "@azure/functions";
import { CosmosClient } from "@azure/cosmos";

app.http("reviewsDebug", {
  route: "reviews-debug",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req) => {
    if (req.method === "OPTIONS") return { status: 204, headers: cors(req) };

    const endpoint   = process.env.COSMOS_DB_ENDPOINT;
    const key        = process.env.COSMOS_DB_KEY;
    const databaseId = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
    const containerId= process.env.COSMOS_DB_REVIEWS_CONTAINER || "reviews";

    if (!endpoint || !key) {
      return json({
        ok: false,
        error: "Cosmos env not configured",
        needed: ["COSMOS_DB_ENDPOINT", "COSMOS_DB_KEY"],
      }, 500, req);
    }

    const client    = new CosmosClient({ endpoint, key });
    const database  = client.database(databaseId);
    const container = database.container(containerId);

    // Read container to confirm partition key path
    let pkPath = null;
    try {
      const { resource: cMeta } = await container.read();
      pkPath = cMeta?.partitionKey?.paths?.[0] || null;
    } catch (e) {
      return json({ ok: false, error: `Container read failed: ${e.message}` }, 500, req);
    }

    const url = new URL(req.url);
    const company = (url.searchParams.get("company") || "").trim();

    // Grab a few latest docs (cross-partition) and company matches if provided
    const latestQuery = {
      query: `
        SELECT TOP 5 r.id, r.company, r.company_name, r.rating, r.created_at
        FROM r
        ORDER BY r._ts DESC
      `
    };
    const matchesQuery = {
      query: `
        SELECT TOP 20 r.id, r.company, r.company_name, r.rating, r.created_at
        FROM r
        WHERE (r.company = @c OR r.company_name = @c)
        ORDER BY r.created_at DESC
      `,
      parameters: [{ name: "@c", value: company }]
    };

    try {
      const latest = await container.items
        .query(latestQuery, { enableCrossPartitionQuery: true })
        .fetchAll();

      let matches = { resources: [] };
      if (company) {
        matches = await container.items
          .query(matchesQuery, { enableCrossPartitionQuery: true })
          .fetchAll();
      }

      return json({
        ok: true,
        config: {
          endpointMasked: maskEndpoint(endpoint),
          databaseId,
          containerId,
          partitionKeyPath: pkPath,
        },
        latest: latest?.resources ?? [],
        matches: company ? (matches?.resources ?? []) : undefined,
      }, 200, req);
    } catch (e) {
      return json({ ok: false, error: e.message || "Query failed" }, 500, req);
    }
  }
});

function maskEndpoint(ep) {
  try {
    const u = new URL(ep);
    const host = u.hostname;
    if (host.length <= 8) return host;
    return `${host.slice(0, 4)}…${host.slice(-4)}`;
  } catch { return "(invalid endpoint)"; }
}

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
