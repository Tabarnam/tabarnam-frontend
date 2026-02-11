let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}

const { getBuildInfo } = require("../_buildInfo");

async function checkCosmos() {
  try {
    const endpoint = (process.env.COSMOS_DB_ENDPOINT || "").trim();
    const key = (process.env.COSMOS_DB_KEY || "").trim();
    if (!endpoint || !key) return { ok: false, reason: "not_configured" };

    const { CosmosClient } = require("@azure/cosmos");
    const client = new CosmosClient({ endpoint, key });
    const db = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
    const { resource } = await client.database(db).read();
    return { ok: Boolean(resource), db };
  } catch (e) {
    return { ok: false, reason: e?.message || "unknown" };
  }
}

async function checkXai() {
  const base = (
    process.env.XAI_EXTERNAL_BASE ||
    process.env.XAI_INTERNAL_BASE ||
    ""
  ).trim();
  if (!base) return { ok: false, reason: "not_configured" };
  return { ok: true, configured: true };
}

async function handler(req, context) {
  const method = String(req.method || "").toUpperCase();

  if (method === "OPTIONS") {
    return {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "content-type,x-functions-key",
      },
    };
  }

  const url = new URL(req.url || "https://localhost/api/health");
  const deep = url.searchParams.get("deep") === "true";

  const result = {
    ok: true,
    name: "health",
    ts: new Date().toISOString(),
    ...getBuildInfo(),
  };

  if (deep) {
    const [cosmos, xai] = await Promise.all([checkCosmos(), checkXai()]);
    result.dependencies = { cosmos, xai };
    result.ok = cosmos.ok !== false;
  }

  return {
    status: result.ok ? 200 : 503,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(result),
  };
}

app.http("health", {
  route: "health",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler,
});

module.exports = { handler };
