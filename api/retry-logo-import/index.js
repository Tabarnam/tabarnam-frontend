const { app } = require("@azure/functions");
const { CosmosClient } = require("@azure/cosmos");
const { importCompanyLogo } = require("../_logoImport");

function env(k, d = "") {
  const v = process.env[k];
  return (v == null ? d : String(v)).trim();
}

function cors(req) {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-functions-key",
  };
}

function json(obj, status = 200, req) {
  return {
    status,
    headers: { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(obj),
  };
}

let cosmosClient = null;

function getCompaniesContainer() {
  const endpoint = env("COSMOS_DB_ENDPOINT");
  const key = env("COSMOS_DB_KEY");
  const databaseId = env("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = env("COSMOS_DB_COMPANIES_CONTAINER", "companies");

  if (!endpoint || !key) return null;
  cosmosClient ||= new CosmosClient({ endpoint, key });
  return cosmosClient.database(databaseId).container(containerId);
}

function toNormalizedDomain(s = "") {
  try {
    const u = s.startsWith("http") ? new URL(s) : new URL(`https://${s}`);
    let h = u.hostname.toLowerCase();
    if (h.startsWith("www.")) h = h.slice(4);
    return h || "unknown";
  } catch {
    return "unknown";
  }
}

app.http("retry-logo-import", {
  route: "retry-logo-import",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    if (req.method === "OPTIONS") return { status: 200, headers: cors(req) };

    let body = {};
    try {
      body = await req.json();
    } catch {
      return json({ ok: false, error: "Invalid JSON" }, 400, req);
    }

    const companyId = String(body.company_id || body.companyId || body.id || "").trim();
    if (!companyId) {
      return json({ ok: false, error: "company_id required" }, 400, req);
    }

    const container = getCompaniesContainer();
    if (!container) {
      return json({ ok: false, error: "Cosmos DB not configured" }, 503, req);
    }

    try {
      const querySpec = {
        query: "SELECT TOP 1 * FROM c WHERE c.id = @id OR c.company_id = @id ORDER BY c._ts DESC",
        parameters: [{ name: "@id", value: companyId }],
      };

      const { resources } = await container.items
        .query(querySpec, { enableCrossPartitionQuery: true })
        .fetchAll();

      const doc = resources?.[0] || null;
      if (!doc) {
        return json({ ok: false, error: "Company not found", company_id: companyId }, 404, req);
      }

      const domain = String(doc.normalized_domain || "").trim() || toNormalizedDomain(doc.website_url || doc.url || doc.domain || "");
      const websiteUrl = String(doc.website_url || doc.url || doc.domain || "").trim();

      const result = await importCompanyLogo(
        {
          companyId: doc.id,
          domain,
          websiteUrl,
          logoSourceUrl: String(doc.logo_source_url || "").trim() || undefined,
        },
        context
      );

      const partitionKey = String(doc.normalized_domain || "").trim() || toNormalizedDomain(doc.website_url || doc.url || doc.domain || "") || "unknown";

      const updatedDoc = {
        ...doc,
        logo_import_status: result.logo_import_status,
        logo_source_url: result.logo_source_url || doc.logo_source_url || null,
        logo_error: result.logo_error || "",
        ...(result.logo_url ? { logo_url: result.logo_url } : {}),
        updated_at: new Date().toISOString(),
      };

      try {
        await container.items.upsert(updatedDoc, { partitionKey });
      } catch (e) {
        context?.log?.("[retry-logo-import] Upsert with partition key failed, retrying without", e?.message || e);
        await container.items.upsert(updatedDoc);
      }

      return json(
        {
          ok: true,
          company_id: doc.id,
          logo_import_status: result.logo_import_status,
          logo_source_url: result.logo_source_url || null,
          logo_url: result.logo_url || null,
          logo_error: result.logo_error || "",
        },
        200,
        req
      );
    } catch (e) {
      return json({ ok: false, error: e?.message || "Retry failed" }, 500, req);
    }
  },
});
