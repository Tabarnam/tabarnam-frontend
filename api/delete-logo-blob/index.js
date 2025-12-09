const { app } = require("@azure/functions");
const { BlobServiceClient, StorageSharedKeyCredential } = require("@azure/storage-blob");
const { CosmosClient } = require("@azure/cosmos");

const CONTAINER_NAME = "company-logos";

// Helper function to get storage credentials - ignores any admin overrides
function getStorageCredentials(ctx) {
  // Hard-target env-based storage, ignoring any admin-configurable overrides
  const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME || "tabarnamstor2356";
  const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;

  ctx.log(`[delete-logo-blob] Using account: ${accountName}`);
  ctx.log(`[delete-logo-blob] Account key present: ${!!accountKey}`);

  return { accountName, accountKey };
}

// Helper function to get Cosmos DB connection
function getCosmosContainer(ctx) {
  const endpoint = process.env.COSMOS_DB_ENDPOINT || "";
  const key = process.env.COSMOS_DB_KEY || "";
  const database = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
  const container = process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies";

  if (!endpoint || !key) {
    ctx.log("[delete-logo-blob] Cosmos DB not configured - logo URL will not be cleared from company document");
    return null;
  }

  try {
    const client = new CosmosClient({ endpoint, key });
    return client.database(database).container(container);
  } catch (e) {
    ctx.error("[delete-logo-blob] Failed to create Cosmos client:", e?.message);
    return null;
  }
}

// Helper to normalize domain from URL
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

function cors(req) {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(obj, status = 200, req) {
  return {
    status,
    headers: { ...cors(req), "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

app.http("delete-logo-blob", {
  route: "delete-logo-blob",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    if (req.method === "OPTIONS") return { status: 204, headers: cors(req) };

    try {
      // Get Azure Blob Storage credentials (hard-targets env vars, ignores admin overrides)
      const { accountName, accountKey } = getStorageCredentials(ctx);

      ctx.log(`[delete-logo-blob] DEBUG accountName: ${accountName}`);
      ctx.log(`[delete-logo-blob] DEBUG accountKey present: ${!!accountKey}`);

      if (!accountKey) {
        ctx.error("[delete-logo-blob] Missing storage account key");
        return json(
          {
            ok: false,
            error: "Server storage not configured. Please ensure AZURE_STORAGE_ACCOUNT_KEY is set in Function App Configuration.",
            accountName,
            debug: true
          },
          500,
          req
        );
      }

      let body = {};
      try {
        body = await req.json();
      } catch (e) {
        return json({ ok: false, error: "Invalid JSON" }, 400, req);
      }

      const blobUrl = body.blob_url;
      if (!blobUrl) {
        return json(
          { ok: false, error: "Missing blob_url" },
          400,
          req
        );
      }

      // Initialize blob service client using SharedKeyCredential
      let blobServiceClient;
      try {
        const credentials = new StorageSharedKeyCredential(accountName, accountKey);
        const storageUrl = `https://${accountName}.blob.core.windows.net`;
        blobServiceClient = new BlobServiceClient(storageUrl, credentials);
        ctx.log(`[delete-logo-blob] DEBUG BlobServiceClient created`);
        ctx.log(`[delete-logo-blob] DEBUG endpoint: ${storageUrl}`);
        ctx.log(`[delete-logo-blob] DEBUG blobServiceClient.url: ${blobServiceClient.url}`);
      } catch (credError) {
        ctx.error("[delete-logo-blob] Failed to initialize BlobServiceClient:", credError.message);
        return json(
          {
            ok: false,
            error: "Failed to initialize storage client.",
            accountName,
            error: credError.message,
            debug: true
          },
          500,
          req
        );
      }

      // Extract blob name from URL
      const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
      ctx.log(`[delete-logo-blob] DEBUG containerName: ${CONTAINER_NAME}`);
      ctx.log(`[delete-logo-blob] DEBUG containerClient.url: ${containerClient.url}`);
      const urlParts = blobUrl.split("/");
      const blobName = urlParts.slice(-1)[0];

      if (!blobName) {
        return json(
          { ok: false, error: "Could not extract blob name from URL" },
          400,
          req
        );
      }

      // Delete the blob
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      await blockBlobClient.delete();

      ctx.log(`[delete-logo-blob] Successfully deleted blob: ${blobName}`);

      // Now clear the logo URL from the company document in Cosmos
      try {
        const cosmosContainer = getCosmosContainer(ctx);
        if (cosmosContainer) {
          ctx.log(`[delete-logo-blob] Attempting to clear logo URL from company document in Cosmos...`);

          // Extract company ID from blob name (format: company_id/uuid.ext)
          const blobNameParts = blobName.split("/");
          const companyId = blobNameParts.length > 0 ? blobNameParts[0] : null;

          if (companyId) {
            // Query for the company by ID (using cross-partition query)
            const querySpec = {
              query: "SELECT * FROM c WHERE c.id = @id OR c.company_id = @id",
              parameters: [{ name: "@id", value: companyId }],
            };

            const queryResult = await cosmosContainer.items
              .query(querySpec, { enableCrossPartitionQuery: true })
              .fetchAll();

            const { resources } = queryResult;

            if (resources && resources.length > 0) {
              const doc = resources[0];
              ctx.log(`[delete-logo-blob] Found company document:`, {
                id: doc.id,
                company_name: doc.company_name,
                normalized_domain: doc.normalized_domain
              });

              // Get the partition key (normalized_domain)
              let partitionKey = doc.normalized_domain;
              if (!partitionKey || String(partitionKey).trim() === "") {
                partitionKey = toNormalizedDomain(doc.website_url || doc.url || doc.domain || "");
                ctx.log(`[delete-logo-blob] No normalized_domain found, computed from URL: ${partitionKey}`);
              }

              // Update the document to clear the logo_url
              const updatedDoc = {
                ...doc,
                logo_url: null,
                updated_at: new Date().toISOString(),
              };

              ctx.log(`[delete-logo-blob] Upserting company document to clear logo_url...`, {
                id: doc.id,
                partitionKey: partitionKey
              });

              try {
                await cosmosContainer.items.upsert(updatedDoc, { partitionKey });
                ctx.log(`[delete-logo-blob] Successfully cleared logo URL from company document`);
              } catch (upsertError) {
                ctx.log(`[delete-logo-blob] Upsert with partition key failed, attempting fallback...`, {
                  error: upsertError?.message
                });
                try {
                  await cosmosContainer.items.upsert(updatedDoc);
                  ctx.log(`[delete-logo-blob] Fallback upsert succeeded`);
                } catch (fallbackError) {
                  ctx.error(`[delete-logo-blob] Failed to clear logo URL from company document:`, fallbackError?.message);
                }
              }
            } else {
              ctx.log(`[delete-logo-blob] No company document found for ID: ${companyId}`);
            }
          } else {
            ctx.log(`[delete-logo-blob] Could not extract company ID from blob name: ${blobName}`);
          }
        } else {
          ctx.log(`[delete-logo-blob] Cosmos DB not available - logo deleted from blob storage but not cleared from company document`);
        }
      } catch (cosmosError) {
        ctx.error(`[delete-logo-blob] Error clearing logo URL from company document:`, cosmosError?.message);
      }

      return json(
        { ok: true, message: "Logo deleted successfully" },
        200,
        req
      );
    } catch (error) {
      ctx.error("[delete-logo-blob] Deletion error:", error.message);
      ctx.error("[delete-logo-blob] Error code:", error.code);
      ctx.error("[delete-logo-blob] Stack:", error.stack);

      const { accountName } = getStorageCredentials(ctx);
      const errorResponse = {
        ok: false,
        error: error.message || "Deletion failed - please try again",
        errorCode: error.code,
        accountName,
        containerName: CONTAINER_NAME,
        endpoint: `https://${accountName}.blob.core.windows.net`,
        debug: true
      };
      return json(errorResponse, 500, req);
    }
  },
});
