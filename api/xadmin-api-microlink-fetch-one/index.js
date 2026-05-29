// Per-row Microlink fetch — synchronous endpoint for /admin/images icon
// buttons. Takes one company_id and one asset type, runs Microlink, persists
// to Cosmos, returns the new URL. The bulk backfill jobs handle this at
// scale; this endpoint exists for one-off admin reviews where waiting for
// the next bulk run would be friction.
const { app } = require("../_app");
const { CosmosClient } = require("@azure/cosmos");

const { fetchAndPersistHomepageForCompany, fetchAndPersistLogoForCompany } = require("../_microlinkBackfill");

const E = (key, def = "") => (process.env[key] ?? def).toString().trim();

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };
}
const json = (obj, status = 200) => ({ status, headers: getCorsHeaders(), body: JSON.stringify(obj) });

let cosmosClient = null;
function getCosmosClient() {
  const endpoint = E("COSMOS_DB_ENDPOINT");
  const key = E("COSMOS_DB_KEY");
  if (!endpoint || !key) return null;
  cosmosClient ||= require("../_cosmosConfig").getCosmosClient();
  return cosmosClient;
}
function getCompaniesContainer() {
  const c = getCosmosClient();
  if (!c) return null;
  return c.database(E("COSMOS_DB_DATABASE", "tabarnam-db")).container(E("COSMOS_DB_COMPANIES_CONTAINER", "companies"));
}

async function findCompanyById(companiesContainer, companyId) {
  // We don't know the partition key (normalized_domain) up front, so fall
  // back to a cross-partition query by id. One-off admin clicks don't need
  // to be RU-optimized.
  try {
    const { resources } = await companiesContainer.items
      .query(
        { query: "SELECT * FROM c WHERE c.id = @id", parameters: [{ name: "@id", value: companyId }] },
        { enableCrossPartitionQuery: true }
      )
      .fetchAll();
    return (resources && resources[0]) || null;
  } catch {
    return null;
  }
}

async function handler(req, context) {
  const method = String(req?.method || "").toUpperCase();
  if (method === "OPTIONS") return { status: 200, headers: getCorsHeaders() };

  if (!E("MICROLINK_API_KEY")) return json({ error: "MICROLINK_API_KEY not configured on Function App" }, 500);

  let body = {};
  try { body = (await req.json()) || {}; } catch { body = {}; }

  const companyId = String(body?.company_id || "").trim();
  const asset = String(body?.asset || "").trim().toLowerCase();
  if (!companyId) return json({ error: "company_id is required" }, 400);
  if (asset !== "logo" && asset !== "homepage") {
    return json({ error: "asset must be 'logo' or 'homepage'" }, 400);
  }

  const companiesContainer = getCompaniesContainer();
  if (!companiesContainer) return json({ error: "Cosmos DB not configured" }, 500);

  const company = await findCompanyById(companiesContainer, companyId);
  if (!company) return json({ error: "company not found" }, 404);
  if (!company.website_url || !String(company.website_url).trim()) {
    return json({ error: "company has no website_url" }, 400);
  }

  context.log(`[microlink-fetch-one] company=${companyId} asset=${asset}`);

  // Per-row fetches NEVER auto-approve — admin is right there and reviews
  // the result manually. Consistent with the logo bulk job.
  const result = asset === "logo"
    ? await fetchAndPersistLogoForCompany(company, context)
    : await fetchAndPersistHomepageForCompany(company, context, { autoApprove: false });

  if (!result.ok) {
    return json({
      ok: false,
      company_id: companyId,
      asset,
      reason: result.reason,
      duration_ms: result.duration_ms,
    }, 200); // 200 because the failure is application-level (Microlink couldn't fetch); not an HTTP error
  }

  return json({
    ok: true,
    company_id: companyId,
    asset,
    duration_ms: result.duration_ms,
    ...(asset === "logo"
      ? { logo_url: result.logo_url, logo_source_url: result.logo_source_url }
      : { homepage_image_url: result.homepage_image_url }),
  });
}

app.http("adminMicrolinkFetchOne", {
  route: "xadmin-api-microlink-fetch-one",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler,
});

module.exports = { handler };
