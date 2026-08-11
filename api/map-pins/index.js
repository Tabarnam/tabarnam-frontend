/**
 * GET /api/map-pins — public, slim map dataset of every mappable company
 * (id, name, truncated tagline, domain, HQ + manufacturing coordinates).
 * Consumed by the consumer map surfaces: the results map's all-match index
 * pins and the /map explore route.
 *
 * Served from the worker's SWR cache over the pins blob (see _pinsIndex.js).
 * The payload only changes on import/save/rebuild, so it gets real HTTP
 * caching — the Cache-Control/ETag pattern from company-logo — letting the
 * SWA edge and browsers absorb repeat loads.
 */

let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}

const { getPins, getCacheInfo } = require("../_pinsIndex");

function env(k, d = "") {
  const v = process.env[k];
  return (v == null ? d : String(v)).trim();
}

function getCompaniesContainer() {
  try {
    const endpoint = env("COSMOS_DB_ENDPOINT", "");
    const key = env("COSMOS_DB_KEY", "");
    if (!endpoint || !key) return null;
    const client = require("../_cosmosConfig").getCosmosClient();
    return client
      .database(env("COSMOS_DB_DATABASE", "tabarnam-db"))
      .container(env("COSMOS_DB_COMPANIES_CONTAINER", "companies"));
  } catch (err) {
    console.error("[map-pins] Failed to initialize Cosmos container:", err);
    return null;
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

async function handleMapPins(req, context) {
  if (String(req.method || "").toUpperCase() === "OPTIONS") {
    return { status: 200, headers: CORS };
  }

  const cache = await getPins(getCompaniesContainer());
  if (!cache || !cache.body) {
    const info = getCacheInfo();
    (context?.error || console.error)(`[map-pins] no pins available: ${info.last_error || "unknown"}`);
    return {
      status: 503,
      headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ ok: false, error: "pins index unavailable" }),
    };
  }

  // Weak ETag from the build timestamp: any rebuild/upsert changes it.
  const etag = `W/"pins-${cache.generatedAt}"`;
  const headers = {
    ...CORS,
    "Content-Type": "application/json",
    // 5-minute freshness + long stale-while-revalidate: repeat loads stay
    // instant, but a company save or import shows up within minutes instead
    // of being pinned for an hour. Clients also pass ?v=<schema> so a payload
    // version bump is never answered from a cache holding the old shape.
    "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
    ETag: etag,
  };

  const ifNoneMatch = req.headers?.get ? req.headers.get("if-none-match") : req.headers?.["if-none-match"];
  if (ifNoneMatch && String(ifNoneMatch).includes(etag)) {
    return { status: 304, headers };
  }

  return { status: 200, headers, body: cache.body };
}

app.http("map-pins", {
  route: "map-pins",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: handleMapPins,
});

module.exports = app;
module.exports.handleMapPins = handleMapPins;
