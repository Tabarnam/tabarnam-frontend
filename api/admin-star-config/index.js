const { app } = require("@azure/functions");
const { CosmosClient } = require("@azure/cosmos");

const E = (key, def = "") => (process.env[key] ?? def).toString().trim();

function getHeader(req, name) {
  if (!req || !req.headers) return "";
  const headers = req.headers;
  if (typeof headers.get === "function") {
    try {
      return headers.get(name) || headers.get(name.toLowerCase()) || "";
    } catch {
      return "";
    }
  }
  return headers[name] || headers[name.toLowerCase()] || "";
}

const cors = (req) => {
  const origin = getHeader(req, "origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
};

const json = (obj, status = 200, req) => ({
  status,
  headers: { ...cors(req), "Content-Type": "application/json" },
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

function getStarConfigContainer() {
  const client = getCosmosClient();
  if (!client) return null;
  const databaseId = E("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = E("COSMOS_DB_STAR_CONFIG_CONTAINER", "star_config");
  return client.database(databaseId).container(containerId);
}

const DEFAULT_CONFIG = {
  id: "star-config",
  hq_weight: 1,
  manufacturing_weight: 1,
  review_threshold: 4,
  min_reviews: 3,
};

async function getJson(req) {
  if (!req) return {};
  if (typeof req.json === "function") {
    try {
      const val = await req.json();
      if (val && typeof val === "object") return val;
    } catch {}
  }
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.rawBody === "string" && req.rawBody) {
    try {
      const parsed = JSON.parse(req.rawBody);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  return {};
}

async function handle(req, context) {
  const method = String(req.method || "").toUpperCase();

  if (method === "OPTIONS") {
    return { status: 204, headers: cors(req) };
  }

  const container = getStarConfigContainer();
  if (!container) {
    return json({ error: "Cosmos DB not configured" }, 500, req);
  }

  try {
    if (method === "GET") {
      const query = { query: "SELECT TOP 1 * FROM c", parameters: [] };
      const { resources } = await container.items
        .query(query, { enableCrossPartitionQuery: true })
        .fetchAll();

      if (!resources || resources.length === 0) {
        await container.items.upsert(DEFAULT_CONFIG);
        return json({ config: DEFAULT_CONFIG }, 200, req);
      }

      const cfg = resources[0];
      return json({ config: cfg }, 200, req);
    }

    if (method === "PUT") {
      const body = await getJson(req);

      const incoming = body.config || body;
      if (!incoming || typeof incoming !== "object") {
        return json({ error: "config payload required" }, 400, req);
      }

      const merged = {
        ...DEFAULT_CONFIG,
        ...incoming,
        id: DEFAULT_CONFIG.id,
      };

      await container.items.upsert(merged);
      return json({ ok: true, config: merged }, 200, req);
    }

    return json({ error: "Method not allowed" }, 405, req);
  } catch (e) {
    if (context && typeof context.log === "function") {
      context.log("Error in admin-star-config:", e?.message || e);
    }
    return json({ error: e?.message || "Internal error" }, 500, req);
  }
}

module.exports = async function (context, req) {
  const res = await handle(req, context);
  context.res = res;
};
