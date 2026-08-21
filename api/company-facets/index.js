/**
 * GET /api/company-facets?id=<companyId> — industries, product terms and
 * rating for ONE company.
 *
 * The server-rendered /company/<slug> page already includes these, so this
 * exists purely so React can render the same sections when it takes over.
 * Without it the page would visibly drop its products list the moment the app
 * mounted.
 *
 * Single company by id, not the whole blob: the facets payload is several
 * megabytes across the catalog, and a page that needs one row should not
 * download all of them. (Contrast /api/map-pins, which serves its whole
 * payload because the map genuinely plots every company at once.)
 */

let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}

const { getFacets } = require("../_companyFacets");

function env(k, d = "") {
  const v = process.env[k];
  return (v == null ? d : String(v)).trim();
}

function getCompaniesContainer() {
  try {
    if (!env("COSMOS_DB_ENDPOINT") || !env("COSMOS_DB_KEY")) return null;
    const client = require("../_cosmosConfig").getCosmosClient();
    return client
      .database(env("COSMOS_DB_DATABASE", "tabarnam-db"))
      .container(env("COSMOS_DB_COMPANIES_CONTAINER", "companies"));
  } catch (err) {
    console.error("[company-facets] Failed to initialize Cosmos container:", err);
    return null;
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

// Worker-local index over the cached blob, rebuilt only when the blob changes.
let _byId = { generatedAt: "", map: null };

function indexFor(cache) {
  if (_byId.generatedAt === cache.generatedAt && _byId.map) return _byId.map;
  const payload = JSON.parse(cache.body);
  const map = new Map();
  for (const row of Array.isArray(payload?.companies) ? payload.companies : []) {
    if (Array.isArray(row) && row[0]) map.set(row[0], row);
  }
  _byId = { generatedAt: cache.generatedAt, map };
  return map;
}

function getQueryValue(req, key) {
  if (req?.query && typeof req.query.get === "function") return req.query.get(key);
  return req?.query?.[key] || "";
}

async function handleCompanyFacets(req, context) {
  if (String(req.method || "").toUpperCase() === "OPTIONS") {
    return { status: 200, headers: CORS };
  }

  const id = String(getQueryValue(req, "id") || "").trim();
  if (!id) {
    return {
      status: 400,
      headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ ok: false, error: "id is required" }),
    };
  }

  const cache = await getFacets(getCompaniesContainer());
  if (!cache || !cache.body) {
    // Enrichment: "we don't have it" is a normal answer, not an error the
    // caller should surface. 200 with empty facets keeps the page simple.
    (context?.warn || console.warn)("[company-facets] no facets blob available");
    return {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ ok: true, facets: null }),
    };
  }

  const row = indexFor(cache).get(id) || null;
  const etag = `W/"facets-${cache.generatedAt}-${id}"`;
  const headers = {
    ...CORS,
    "Content-Type": "application/json",
    // Facets change only when an import or a save rewrites them.
    "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
    ETag: etag,
  };

  const ifNoneMatch = req.headers?.get ? req.headers.get("if-none-match") : req.headers?.["if-none-match"];
  if (ifNoneMatch && String(ifNoneMatch).includes(etag)) return { status: 304, headers };

  return {
    status: 200,
    headers,
    body: JSON.stringify({
      ok: true,
      facets: row
        ? {
            industries: Array.isArray(row[1]) ? row[1] : [],
            products: Array.isArray(row[2]) ? row[2] : [],
            stars: typeof row[3] === "number" ? row[3] : null,
            reviews: typeof row[4] === "number" ? row[4] : 0,
          }
        : null,
    }),
  };
}

app.http("company-facets", {
  route: "company-facets",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: handleCompanyFacets,
});

module.exports = app;
module.exports.handleCompanyFacets = handleCompanyFacets;
