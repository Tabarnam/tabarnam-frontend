/**
 * Admin endpoint to rebuild the industry-affinity inverted index.
 *
 * This scans every active company, computes TF-IDF term→industry affinity,
 * and upserts a singleton document into the companies container with
 * id = "_index_industry_affinity".
 *
 * Triggered automatically by the nightly timer in rebuild-industry-index-timer,
 * or manually via POST /api/admin-rebuild-industry-index (useful after large
 * imports, before waiting for the nightly run).
 */

let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}

const { CosmosClient } = require("@azure/cosmos");
const {
  buildIndustryAffinityIndex,
  loadIndustryAffinityIndex,
  _resetCache,
} = require("../_industryAffinityIndex");

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
 * Runs the rebuild end-to-end: scan → compute → upsert → bust cache.
 * Exposed so the timer trigger can call it without going through HTTP.
 */
async function rebuildIndustryAffinityIndex(context) {
  const log = typeof context?.log === "function" ? context.log.bind(context) : console.log;
  const container = getCompaniesContainer();
  if (!container) {
    throw new Error("Cosmos DB not configured");
  }

  log("[admin-rebuild-industry-index] starting full rebuild…");
  const doc = await buildIndustryAffinityIndex(container, { log });
  log(
    `[admin-rebuild-industry-index] built: ${doc.total_companies} companies, ` +
    `${doc.term_count} terms, ${doc.industry_count} industries ` +
    `(build_ms=${doc.build_ms})`
  );

  await container.items.upsert(doc);
  // Bust the in-process cache so subsequent searches see the new doc.
  _resetCache();
  await loadIndustryAffinityIndex(container, { force: true });

  return doc;
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

  try {
    const doc = await rebuildIndustryAffinityIndex(context);
    return json({
      ok: true,
      total_companies: doc.total_companies,
      term_count: doc.term_count,
      industry_count: doc.industry_count,
      build_ms: doc.build_ms,
      generated_at: doc.generated_at,
    });
  } catch (e) {
    const msg = e?.message || "Rebuild failed";
    (context?.error || console.error)(`[admin-rebuild-industry-index] ${msg}`);
    return json({ ok: false, error: msg }, 500);
  }
}

app.http("admin-rebuild-industry-index", {
  route: "admin-rebuild-industry-index",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => handleRebuild(req, context),
});

module.exports = app;
module.exports.rebuildIndustryAffinityIndex = rebuildIndustryAffinityIndex;
