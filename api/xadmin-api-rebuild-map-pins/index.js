/**
 * Admin endpoint to force-rebuild the persisted map pins index (full
 * cross-partition scan → blob). The import pipeline calls the exported
 * rebuildMapPins in-process on completion (throttled); this endpoint exists
 * because TIMERS DO NOT EXECUTE on this Flex app, so an operator needs a way
 * to force a rebuild without waiting for the blob's 24h age-out.
 *
 * POST /api/xadmin-api-rebuild-map-pins
 */

let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}

const { rebuildAndPersistPins, getPinsBlobAgeMs } = require("../_pinsIndex");

function env(k, d = "") {
  const v = process.env[k];
  return (v == null ? d : String(v)).trim();
}

function json(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "content-type,x-functions-key",
    },
    body: JSON.stringify(obj),
  };
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
    console.error("Failed to initialize Cosmos container:", err);
    return null;
  }
}

/**
 * Rebuild + persist the pins index, resolving the container itself. Exposed
 * so the import pipeline can call it in-process on completion — mirroring
 * rebuildTypoDictionary. `minAgeMs` throttles: skip when the current blob is
 * younger (import completions fire 60-120×/day; the scan should not).
 */
async function rebuildMapPins({ source = "manual", logger = console, minAgeMs = 0 } = {}) {
  const log = typeof logger?.log === "function" ? logger.log.bind(logger) : console.log;
  if (minAgeMs > 0) {
    const age = await getPinsBlobAgeMs();
    if (age != null && age < minAgeMs) {
      log(`[pins-index] rebuild (${source}) skipped — blob is ${Math.round(age / 60000)}min old (< ${Math.round(minAgeMs / 60000)}min)`);
      return { ok: true, skipped: true, blob_age_ms: age };
    }
  }
  const container = getCompaniesContainer();
  if (!container) return { ok: false, error: "Cosmos not configured" };
  const result = await rebuildAndPersistPins(container, { log });
  log(
    `[pins-index] rebuild (${source}): ok=${result.ok} count=${result.count ?? "-"} ` +
      `bytes=${result.bytes ?? "-"} ru=${result.build_request_charge ?? "-"} ms=${result.build_ms ?? "-"}`
  );

  // The company-facets blob derives from the same catalog and goes stale for
  // the same reasons, so it rebuilds on the same trigger and inherits the same
  // throttle rather than getting a second one that could drift out of step.
  // Awaited but never allowed to fail the pins result: facets are enrichment
  // for /company pages, pins are load-bearing for the map and /made-in.
  try {
    const { rebuildAndPersistFacets } = require("../_companyFacets");
    const facets = await rebuildAndPersistFacets(container, { log });
    log(
      `[company-facets] rebuild (${source}): ok=${facets.ok} count=${facets.count ?? "-"} ` +
        `bytes=${facets.bytes ?? "-"} ru=${facets.build_request_charge ?? "-"} ms=${facets.build_ms ?? "-"}`
    );
  } catch (e) {
    log(`[company-facets] rebuild (${source}) failed (non-fatal): ${e?.message || e}`);
  }

  return result;
}

async function handleRebuild(req, context) {
  const method = String(req.method || "").toUpperCase();
  if (method === "OPTIONS") {
    return {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "content-type,x-functions-key",
      },
    };
  }
  if (method !== "POST") return json({ ok: false, error: "Method Not Allowed" }, 405);

  const log = typeof context?.log === "function" ? context.log.bind(context) : console.log;
  try {
    const container = getCompaniesContainer();
    if (!container) return json({ ok: false, error: "Cosmos not configured" }, 500);
    const result = await rebuildAndPersistPins(container, { log });
    return json(result, result.ok ? 200 : 500);
  } catch (e) {
    const msg = e?.message || "Rebuild failed";
    (context?.error || console.error)(`[xadmin-api-rebuild-map-pins] ${msg}`);
    return json({ ok: false, error: msg }, 500);
  }
}

app.http("xadmin-api-rebuild-map-pins", {
  route: "xadmin-api-rebuild-map-pins",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: require("../_adminAuth").withAdminGuard(async (req, context) => handleRebuild(req, context)),
});

module.exports = app;
module.exports.handleRebuild = handleRebuild;
module.exports.rebuildMapPins = rebuildMapPins;
