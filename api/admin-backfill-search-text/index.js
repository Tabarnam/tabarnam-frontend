/**
 * Admin endpoint to backfill search_text_norm and search_text_compact fields
 * for all existing company records in Cosmos DB
 * POST /api/admin-backfill-search-text
 */

let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}

const { CosmosClient } = require("@azure/cosmos");
const { patchCompanyWithSearchText } = require("../_computeSearchText");

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

    const client = new CosmosClient({ endpoint, key });
    return client.database(databaseId).container(containerId);
  } catch (err) {
    console.error("Failed to initialize Cosmos container:", err);
    return null;
  }
}

async function backfillSearchText(req, context) {
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

  const container = getCompaniesContainer();
  if (!container) {
    return json({ ok: false, error: "Cosmos DB not configured" }, 503);
  }

  try {
    let processed = 0;
    let updated = 0;
    let failed = 0;

    // Query all company documents (excluding import control documents)
    const query = `
      SELECT c.id, c.company_id, c.company_name, c.display_name, c.name, 
             c.tagline, c.industries, c.categories, c.product_keywords, c.keywords
      FROM c
      WHERE NOT STARTSWITH(c.id, '_') AND c.type != 'import_control'
      ORDER BY c._ts DESC
    `;

    const iterator = container.items.query(query, { maxItemCount: 100 });

    for await (const { resources: companies } of iterator.getAsyncIterator()) {
      for (const company of companies) {
        try {
          processed++;

          // Fetch the full document using correct partition key
          const partitionKey = company.normalized_domain || company.id;
          const fullDoc = await container.item(company.id, partitionKey).read();
          const doc = fullDoc.resource;

          if (!doc) continue;

          // Patch with search text
          patchCompanyWithSearchText(doc);

          // Update the document using correct partition key
          await container.item(doc.id, doc.normalized_domain || doc.id).replace(doc);
          updated++;

          // Log progress periodically
          if (processed % 100 === 0) {
            context.log(`[admin-backfill-search-text] Processed: ${processed}, Updated: ${updated}, Failed: ${failed}`);
          }
        } catch (e) {
          failed++;
          console.error(`Failed to backfill ${company.id}:`, e.message);
        }
      }
    }

    return json({
      ok: true,
      message: "Backfill completed",
      processed,
      updated,
      failed,
    });
  } catch (e) {
    context.error(`Backfill failed: ${e.message}`);
    return json({ ok: false, error: e.message || "Backfill failed" }, 500);
  }
}

app.http("admin-backfill-search-text", {
  route: "admin-backfill-search-text",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    return backfillSearchText(req, context);
  },
});

module.exports = app;
