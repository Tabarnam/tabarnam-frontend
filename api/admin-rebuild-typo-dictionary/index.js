/**
 * Admin endpoint to rebuild the persisted typo-correction dictionary.
 *
 * The dictionary is built by scanning every active company (a full
 * cross-partition read — seconds of wall time and tens of thousands of RU on a
 * serverless account), then stored as a singleton doc with
 * id = "_index_typo_dictionary" so every worker can point-read it instead of
 * repeating the scan.
 *
 * The import pipeline calls the same rebuild automatically when an import
 * finishes (that's when the corpus actually changes). This endpoint exists
 * because TIMERS DO NOT EXECUTE on this Flex app (documented platform defect,
 * 2026-08-07) — so an operator or external scheduler needs a way to force a
 * rebuild without waiting for the doc's 24h age-out.
 *
 * POST /api/admin-rebuild-typo-dictionary
 */

let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}

const { rebuildAndPersistDictionary } = require("../_typoCorrection");

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
    const databaseId = env("COSMOS_DB_DATABASE", "tabarnam-db");
    const containerId = env("COSMOS_DB_COMPANIES_CONTAINER", "companies");

    if (!endpoint || !key) return null;

    const client = require("../_cosmosConfig").getCosmosClient();
    return client.database(databaseId).container(containerId);
  } catch (err) {
    console.error("Failed to initialize Cosmos container:", err);
    return null;
  }
}

/**
 * Rebuild + persist the dictionary, resolving the Cosmos container itself.
 * Exposed so the import pipeline can call it in-process when an import
 * finishes — mirroring how the homepage/logo backfill jobs are triggered.
 */
async function rebuildTypoDictionary({ source = "manual", logger = console } = {}) {
  const container = getCompaniesContainer();
  if (!container) return { ok: false, error: "Cosmos not configured" };
  const log = typeof logger?.log === "function" ? logger.log.bind(logger) : console.log;
  const result = await rebuildAndPersistDictionary(container, { log });
  log(
    `[typo-dict] rebuild (${source}): ok=${result.ok} terms=${result.term_count ?? "-"} ` +
      `nameTokens=${result.name_token_count ?? "-"} ms=${result.build_ms ?? "-"}`
  );
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

  if (method !== "POST") {
    return json({ ok: false, error: "Method Not Allowed" }, 405);
  }

  const log = typeof context?.log === "function" ? context.log.bind(context) : console.log;
  const container = getCompaniesContainer();
  if (!container) {
    return json({ ok: false, error: "Cosmos not configured" }, 500);
  }

  try {
    const result = await rebuildAndPersistDictionary(container, { log });
    return json(result, result.ok ? 200 : 500);
  } catch (e) {
    const msg = e?.message || "Rebuild failed";
    (context?.error || console.error)(`[admin-rebuild-typo-dictionary] ${msg}`);
    return json({ ok: false, error: msg }, 500);
  }
}

app.http("admin-rebuild-typo-dictionary", {
  route: "admin-rebuild-typo-dictionary",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: require("../_adminAuth").withAdminGuard(async (req, context) => handleRebuild(req, context)),
});

module.exports = app;
module.exports.handleRebuild = handleRebuild;
module.exports.rebuildTypoDictionary = rebuildTypoDictionary;
