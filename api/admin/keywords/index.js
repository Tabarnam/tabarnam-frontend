const { CosmosClient } = require("@azure/cosmos");

const { CosmosClient } = require("@azure/cosmos");

const { app } = require("../../_app");

function env(k, d = "") {
  const v = process.env[k];
  return (v == null ? d : String(v)).trim();
}

function corsHeaders(req) {
  const origin = (req?.headers?.get?.("origin") || req?.headers?.get?.("Origin") || "*").toString();
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-client-request-id, x-session-id",
  };
}

function json(body, status = 200, req) {
  return {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

let cosmosClient = null;

function getCosmosClient() {
  const endpoint = env("COSMOS_DB_ENDPOINT") || env("COSMOS_ENDPOINT");
  const key = env("COSMOS_DB_KEY") || env("COSMOS_KEY");
  if (!endpoint || !key) return null;
  cosmosClient ||= new CosmosClient({ endpoint, key });
  return cosmosClient;
}

function getContainer(containerId) {
  const client = getCosmosClient();
  if (!client) return null;

  const databaseId = env("COSMOS_DB_DATABASE", env("COSMOS_DB", "tabarnam-db"));
  return client.database(databaseId).container(containerId);
}

function normalizeStringArray(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((v) => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
}

function applyQueryParams(list, req) {
  const raw = normalizeStringArray(list);

  let q = "";
  let limit = 0;
  let offset = 0;

  try {
    const u = new URL(req?.url);
    q = String(u.searchParams.get("q") || "").trim().toLowerCase();
    limit = Number(u.searchParams.get("limit") || 0);
    offset = Number(u.searchParams.get("offset") || 0);
  } catch {
    // ignore
  }

  const filtered = q ? raw.filter((v) => v.toLowerCase().includes(q)) : raw;

  const safeOffset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;

  if (!safeLimit) return filtered.slice(safeOffset);
  return filtered.slice(safeOffset, safeOffset + safeLimit);
}

async function readKeywordsDocument(container) {
  try {
    const { resource } = await container.item("keywords", "keywords").read();
    return resource?.list || resource?.keywords || null;
  } catch {
    return null;
  }
}

async function adminKeywordsHandler(req, context) {
  const method = String(req?.method || "").toUpperCase();

  if (method === "OPTIONS") {
    return json({}, 200, req);
  }

  if (method !== "GET") {
    return json({ error: "Method not allowed" }, 405, req);
  }

  const keywordsContainer = getContainer("keywords");
  const companiesContainer = getContainer(env("COSMOS_DB_COMPANIES_CONTAINER", "companies"));

  if (!keywordsContainer && !companiesContainer) {
    context?.log?.("[admin/keywords] Cosmos DB not configured");
    return json({ error: "Cosmos DB not configured" }, 503, req);
  }

  let keywords = null;

  if (keywordsContainer) {
    keywords = await readKeywordsDocument(keywordsContainer);
  }

  if (!keywords && companiesContainer) {
    keywords = await readKeywordsDocument(companiesContainer);
  }

  const result = applyQueryParams(keywords || [], req);
  return json(result, 200, req);
}

app.http("adminControlledKeywords", {
  route: "admin/keywords",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: adminKeywordsHandler,
});

module.exports.handler = adminKeywordsHandler;
