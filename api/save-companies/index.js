const { app } = require("@azure/functions");

function json(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "content-type,x-functions-key",
    },
    body: JSON.stringify(obj),
  };
}

app.http("saveCompanies", {
  route: "save-companies",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    const method = String(req.method || "").toUpperCase();

    if (method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "content-type,x-functions-key",
        },
      };
    }

    if (method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    try {
      const { CosmosClient } = require("@azure/cosmos");

      const endpoint = (process.env.COSMOS_DB_ENDPOINT || "").trim();
      const key = (process.env.COSMOS_DB_KEY || "").trim();
      const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
      const containerId = (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();

      if (!endpoint || !key) {
        return json({ ok: false, error: "Cosmos DB not configured" }, 500);
      }

      const bodyObj = await req.json().catch(() => ({}));
      const companies = bodyObj.companies || [];
      if (!Array.isArray(companies) || companies.length === 0) {
        return json({ ok: false, error: "companies array required" }, 400);
      }

      const client = new CosmosClient({ endpoint, key });
      const database = client.database(databaseId);
      const container = database.container(containerId);

      let saved = 0;
      let failed = 0;
      const errors = [];
      const sessionId = `manual_${Date.now()}_${Math.random().toString(36).slice(2)}`;

      for (const company of companies) {
        try {
          const doc = {
            id: `company_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            company_name: company.company_name || company.name || "",
            name: company.name || company.company_name || "",
            url: company.url || "",
            website_url: company.url || "",
            industries: company.industries || [],
            product_keywords: company.product_keywords || "",
            headquarters_location: company.headquarters_location || "",
            manufacturing_locations: Array.isArray(company.manufacturing_locations) ? company.manufacturing_locations : [],
            red_flag: Boolean(company.red_flag),
            red_flag_reason: company.red_flag_reason || "",
            location_confidence: company.location_confidence || "medium",
            source: "manual_import",
            session_id: sessionId,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };

          if (!doc.company_name && !doc.url) {
            failed++;
            errors.push(`Skipped entry: no company_name or url`);
            continue;
          }

          await container.items.create(doc);
          saved++;
        } catch (e) {
          failed++;
          errors.push(
            `Failed to save "${company.company_name || company.name}": ${e.message}`
          );
        }
      }

      return json(
        {
          ok: true,
          saved,
          failed,
          total: companies.length,
          session_id: sessionId,
          errors: errors.length > 0 ? errors : undefined,
        },
        200
      );
    } catch (e) {
      return json(
        { ok: false, error: `Database error: ${e.message || String(e)}` },
        500
      );
    }
  },
});
