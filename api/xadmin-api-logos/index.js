const { app } = require("@azure/functions");
const { CosmosClient } = require("@azure/cosmos");

function json(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(obj),
  };
}

function getCosmosContainer() {
  const endpoint = process.env.COSMOS_DB_ENDPOINT || "";
  const key = process.env.COSMOS_DB_KEY || "";
  const database = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
  const container = process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies";

  if (!endpoint || !key) {
    return null;
  }

  try {
    const client = new CosmosClient({ endpoint, key });
    return client.database(database).container(container);
  } catch (e) {
    console.error("[xadmin-api-logos] Failed to create Cosmos client:", e?.message);
    return null;
  }
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

app.http("xadmin-api-logos", {
  route: "xadmin-api-logos/{companyId}",
  methods: ["PUT", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    if (req.method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "PUT, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      };
    }

    try {
      const companyId = req.params.companyId;
      if (!companyId) {
        return json({ ok: false, error: "Missing companyId" }, 400);
      }

      const body = await req.json();
      const { logo_url } = body;

      if (!logo_url || typeof logo_url !== "string") {
        return json({ ok: false, error: "Missing or invalid logo_url" }, 400);
      }

      const cosmosContainer = getCosmosContainer();
      if (!cosmosContainer) {
        return json(
          { ok: false, error: "Cosmos DB not configured" },
          500
        );
      }

      ctx.log(`[xadmin-api-logos] Updating logo_url for company: ${companyId}`);

      // Query for the company by ID (using cross-partition query)
      const querySpec = {
        query: "SELECT * FROM c WHERE c.id = @id OR c.company_id = @id",
        parameters: [{ name: "@id", value: companyId }],
      };

      const queryResult = await cosmosContainer.items
        .query(querySpec, { enableCrossPartitionQuery: true })
        .fetchAll();

      const { resources } = queryResult;

      if (!resources || resources.length === 0) {
        return json(
          { ok: false, error: "Company not found" },
          404
        );
      }

      const doc = resources[0];
      ctx.log(`[xadmin-api-logos] Found company document:`, {
        id: doc.id,
        company_name: doc.company_name,
      });

      // Get the partition key (normalized_domain)
      let partitionKey = doc.normalized_domain;
      if (!partitionKey || String(partitionKey).trim() === "") {
        partitionKey = toNormalizedDomain(doc.website_url || doc.url || doc.domain || "");
        ctx.log(`[xadmin-api-logos] No normalized_domain found, computed from URL: ${partitionKey}`);
      }

      // Update the document with the new logo_url
      const updatedDoc = {
        ...doc,
        logo_url: logo_url,
        updated_at: new Date().toISOString(),
      };

      ctx.log(`[xadmin-api-logos] Upserting company document with logo_url`);

      try {
        await cosmosContainer.items.upsert(updatedDoc, { partitionKey });
        ctx.log(`[xadmin-api-logos] Successfully updated company document`);
      } catch (upsertError) {
        ctx.log(`[xadmin-api-logos] Upsert with partition key failed, attempting fallback...`);
        try {
          await cosmosContainer.items.upsert(updatedDoc);
          ctx.log(`[xadmin-api-logos] Fallback upsert succeeded`);
        } catch (fallbackError) {
          ctx.error(`[xadmin-api-logos] Failed to update company document:`, fallbackError?.message);
          return json(
            { ok: false, error: "Failed to update company document" },
            500
          );
        }
      }

      return json(
        { ok: true, logo_url: logo_url },
        200
      );
    } catch (error) {
      ctx.error("[xadmin-api-logos] Error:", error?.message);
      return json(
        { ok: false, error: error?.message || "Server error" },
        500
      );
    }
  },
});
