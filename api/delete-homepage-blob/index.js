let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}
const { BlobServiceClient, StorageSharedKeyCredential } = require("@azure/storage-blob");
const { CosmosClient } = require("@azure/cosmos");

const CONTAINER_NAME = "company-homepages";

function getStorageCredentials(ctx) {
  const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME || "tabarnamstor2356";
  const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;
  ctx.log(`[delete-homepage-blob] Using account: ${accountName}`);
  ctx.log(`[delete-homepage-blob] Account key present: ${!!accountKey}`);
  return { accountName, accountKey };
}

function getCosmosContainer(ctx) {
  const endpoint = process.env.COSMOS_DB_ENDPOINT || "";
  const key = process.env.COSMOS_DB_KEY || "";
  const database = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
  const container = process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies";

  if (!endpoint || !key) {
    ctx.log("[delete-homepage-blob] Cosmos DB not configured - homepage URL will not be cleared");
    return null;
  }

  try {
    const client = new CosmosClient({ endpoint, key });
    return client.database(database).container(container);
  } catch (e) {
    ctx.error("[delete-homepage-blob] Failed to create Cosmos client:", e?.message);
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

async function deleteHomepageBlobHandler(req, ctx) {
  if (req.method === "OPTIONS") return { status: 200, headers: cors(req) };

  try {
    const { accountName, accountKey } = getStorageCredentials(ctx);
    if (!accountKey) {
      return json({ ok: false, error: "Server storage not configured." }, 500, req);
    }

    let body = {};
    try {
      body = await req.json();
    } catch {
      return json({ ok: false, error: "Invalid JSON" }, 400, req);
    }

    const blobUrl = body.blob_url;
    if (!blobUrl) {
      return json({ ok: false, error: "Missing blob_url" }, 400, req);
    }

    const credentials = new StorageSharedKeyCredential(accountName, accountKey);
    const blobServiceClient = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, credentials);
    const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);

    let blobName = "";
    try {
      const url = new URL(blobUrl);
      const rawPath = url.pathname.startsWith("/") ? url.pathname.slice(1) : url.pathname;
      const segments = rawPath.split("/");
      if (segments[0] === CONTAINER_NAME) {
        blobName = segments.slice(1).join("/");
      } else {
        blobName = segments.slice(-1)[0] || "";
      }
    } catch (parseError) {
      ctx.log(`[delete-homepage-blob] Failed to parse blob_url: ${parseError.message}`);
      const urlParts = blobUrl.split("/");
      blobName = urlParts.slice(-1)[0] || "";
    }

    if (!blobName) {
      return json({ ok: false, error: "Could not extract blob name from URL" }, 400, req);
    }

    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.delete();
    ctx.log(`[delete-homepage-blob] Deleted blob: ${blobName}`);

    try {
      const cosmosContainer = getCosmosContainer(ctx);
      if (cosmosContainer) {
        const companyId = blobName.split("/")[0] || null;
        if (companyId) {
          const querySpec = {
            query: "SELECT * FROM c WHERE c.id = @id OR c.company_id = @id",
            parameters: [{ name: "@id", value: companyId }],
          };
          const queryResult = await cosmosContainer.items.query(querySpec, { enableCrossPartitionQuery: true }).fetchAll();
          const { resources } = queryResult;

          if (resources && resources.length > 0) {
            const doc = resources[0];
            let partitionKey = doc.normalized_domain;
            if (!partitionKey || String(partitionKey).trim() === "") {
              partitionKey = toNormalizedDomain(doc.website_url || doc.url || doc.domain || "");
            }

            const updatedDoc = {
              ...doc,
              homepage_image_url: null,
              homepage_approved: false,
              updated_at: new Date().toISOString(),
            };

            try {
              await cosmosContainer.items.upsert(updatedDoc, { partitionKey });
            } catch (upsertError) {
              try {
                await cosmosContainer.items.upsert(updatedDoc);
              } catch (fallbackError) {
                ctx.error(`[delete-homepage-blob] Failed to clear homepage_image_url:`, fallbackError?.message);
              }
            }
          }
        }
      }
    } catch (cosmosError) {
      ctx.error(`[delete-homepage-blob] Error clearing homepage_image_url:`, cosmosError?.message);
    }

    return json({ ok: true, message: "Homepage image deleted successfully" }, 200, req);
  } catch (error) {
    ctx.error("[delete-homepage-blob] Deletion error:", error.message);
    return json({ ok: false, error: error.message || "Deletion failed", errorCode: error.code }, 500, req);
  }
}

app.http("delete-homepage-blob", {
  route: "delete-homepage-blob",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: deleteHomepageBlobHandler,
});

module.exports = { handler: deleteHomepageBlobHandler };
