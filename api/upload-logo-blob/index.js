const { app } = require("@azure/functions");
const { BlobServiceClient, StorageSharedKeyCredential, generateBlobSASUrl } = require("@azure/storage-blob");
const { CosmosClient } = require("@azure/cosmos");
const sharp = require("sharp");
const { v4: uuidv4 } = require("uuid");

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

// Helper function to get storage credentials - ignores any admin overrides
function getStorageCredentials(ctx) {
  // Hard-target env-based storage, ignoring any admin-configurable overrides
  const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME || "tabarnamstor2356";
  const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;

  ctx.log(`[upload-logo-blob] Using account: ${accountName}`);
  ctx.log(`[upload-logo-blob] Account key present: ${!!accountKey}`);

  return { accountName, accountKey };
}

// Helper function to get Cosmos DB connection
function getCosmosContainer(ctx) {
  const endpoint = process.env.COSMOS_DB_ENDPOINT || "";
  const key = process.env.COSMOS_DB_KEY || "";
  const database = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
  const container = process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies";

  if (!endpoint || !key) {
    ctx.log("[upload-logo-blob] Cosmos DB not configured - logo URL will not be saved to company document");
    return null;
  }

  try {
    const client = new CosmosClient({ endpoint, key });
    return client.database(database).container(container);
  } catch (e) {
    ctx.error("[upload-logo-blob] Failed to create Cosmos client:", e?.message);
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

app.http("upload-logo-blob", {
  route: "upload-logo-blob",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    if (req.method === "OPTIONS") return { status: 204, headers: cors(req) };

    try {
      // Get Azure Blob Storage credentials (hard-targets env vars, ignores admin overrides)
      const { accountName, accountKey } = getStorageCredentials(ctx);

      ctx.log(`[upload-logo-blob] DEBUG accountName: ${accountName}`);
      ctx.log(`[upload-logo-blob] DEBUG accountKey present: ${!!accountKey}`);

      if (!accountKey) {
        ctx.error("[upload-logo-blob] Missing storage account key");

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

      // Initialize blob service client using SharedKeyCredential
      let blobServiceClient;
      try {
        const credentials = new StorageSharedKeyCredential(accountName, accountKey);
        const storageUrl = `https://${accountName}.blob.core.windows.net`;
        blobServiceClient = new BlobServiceClient(storageUrl, credentials);
        ctx.log(`[upload-logo-blob] DEBUG BlobServiceClient created`);
        ctx.log(`[upload-logo-blob] DEBUG endpoint: ${storageUrl}`);
        ctx.log(`[upload-logo-blob] DEBUG blobServiceClient.url: ${blobServiceClient.url}`);
      } catch (credError) {
        ctx.error("[upload-logo-blob] Failed to initialize BlobServiceClient:", credError.message);
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

      // Parse form data
      const formData = await req.formData();
      const file = formData.get("file");
      const companyId = formData.get("companyId");

      if (!file || !companyId) {
        return json(
          { ok: false, error: "Missing file or companyId" },
          400,
          req
        );
      }

      // Validate file size (max 5MB)
      if (file.size > 5 * 1024 * 1024) {
        return json(
          { ok: false, error: "File too large (max 5MB)" },
          400,
          req
        );
      }

      // Validate file type (PNG, JPG, SVG, GIF)
      const allowedTypes = ["image/png", "image/jpeg", "image/svg+xml", "image/gif"];
      if (!allowedTypes.includes(file.type)) {
        return json(
          { ok: false, error: "Invalid file type (PNG, JPG, SVG, GIF only)" },
          400,
          req
        );
      }

      const containerName = "company-logos";
      const containerClient = blobServiceClient.getContainerClient(containerName);

      ctx.log(`[upload-logo-blob] DEBUG containerName: ${containerName}`);
      ctx.log(`[upload-logo-blob] DEBUG containerClient.url: ${containerClient.url}`);

      // Try to create container if it doesn't exist
      try {
        ctx.log(`[upload-logo-blob] DEBUG attempting containerClient.exists()...`);
        const existsResponse = await containerClient.exists();
        ctx.log(`[upload-logo-blob] DEBUG containerClient.exists() returned: ${existsResponse}`);
        if (existsResponse) {
          ctx.log(`[upload-logo-blob] Container already exists: ${containerName}`);
        } else {
          ctx.log(`[upload-logo-blob] DEBUG container does not exist, attempting create...`);
          await containerClient.create({ access: "blob" });
          ctx.log(`[upload-logo-blob] Created new container: ${containerName}`);
        }
      } catch (containerError) {
        ctx.error(`[upload-logo-blob] Container operation error: ${containerError.message}`);
        ctx.error(`[upload-logo-blob] Container error code: ${containerError.code}`);
        ctx.error(`[upload-logo-blob] Container error details: ${JSON.stringify(containerError)}`);
        // Continue anyway - upload may still work if container exists
      }

      // Read file as buffer
      const buffer = await file.arrayBuffer();
      const uint8Array = new Uint8Array(buffer);

      // Process image with sharp (resize to max 500x500)
      let processedBuffer = uint8Array;
      if (file.type !== "image/svg+xml") {
        try {
          processedBuffer = await sharp(uint8Array)
            .resize({ width: 500, height: 500, fit: "inside", withoutEnlargement: true })
            .toBuffer();
          ctx.log(`[upload-logo-blob] Resized image for company ${companyId}`);
        } catch (sharpError) {
          ctx.warn(`[upload-logo-blob] Sharp resize failed, using original: ${sharpError.message}`);
          processedBuffer = uint8Array;
        }
      }

      // Generate unique blob name (e.g., companyId-uuid.ext)
      const fileExtension = file.type.split("/")[1] === "svg+xml" ? "svg" : file.type.split("/")[1];
      const blobName = `${companyId}/${uuidv4()}.${fileExtension}`;

      // Get blob client and upload
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      await blockBlobClient.upload(processedBuffer, processedBuffer.length, {
        blobHTTPHeaders: { blobContentType: file.type || "image/png" },
      });

      // Generate SAS URL with 1-year expiration for secure blob access
      let logoUrl = blockBlobClient.url;
      try {
        const { accountName, accountKey } = getStorageCredentials(ctx);
        const credentials = new StorageSharedKeyCredential(accountName, accountKey);

        // Generate SAS URL valid for 1 year
        logoUrl = generateBlobSASUrl({
          containerName: containerName,
          blobName: blobName,
          accountName: accountName,
          accountKey: accountKey,
          permissions: require("@azure/storage-blob").BlobSASPermissions.parse("r"),
          expiresOn: new Date(new Date().getTime() + 365 * 24 * 60 * 60 * 1000),
        });
        ctx.log(`[upload-logo-blob] Generated SAS URL for blob: ${logoUrl.substring(0, 100)}...`);
      } catch (sasError) {
        ctx.warn(`[upload-logo-blob] Failed to generate SAS URL, using plain blob URL instead: ${sasError.message}`);
        // Fall back to plain URL if SAS generation fails
      }

      ctx.log(`[upload-logo-blob] Successfully uploaded logo for company ${companyId}`);

      // Now update the company document in Cosmos with the new logo URL
      try {
        const cosmosContainer = getCosmosContainer(ctx);
        if (cosmosContainer) {
          ctx.log(`[upload-logo-blob] Attempting to save logo URL to company document in Cosmos...`);

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
            ctx.log(`[upload-logo-blob] Found company document:`, {
              id: doc.id,
              company_name: doc.company_name,
              normalized_domain: doc.normalized_domain
            });

            // Get the partition key (normalized_domain)
            let partitionKey = doc.normalized_domain;
            if (!partitionKey || String(partitionKey).trim() === "") {
              partitionKey = toNormalizedDomain(doc.website_url || doc.url || doc.domain || "");
              ctx.log(`[upload-logo-blob] No normalized_domain found, computed from URL: ${partitionKey}`);
            }

            // Update the document with the new logo_url
            const updatedDoc = {
              ...doc,
              logo_url: logoUrl,
              updated_at: new Date().toISOString(),
            };

            ctx.log(`[upload-logo-blob] Upserting company document with logo_url...`, {
              id: doc.id,
              logo_url: logoUrl.substring(0, 100),
              partitionKey: partitionKey
            });

            try {
              await cosmosContainer.items.upsert(updatedDoc, { partitionKey });
              ctx.log(`[upload-logo-blob] Successfully updated company document with logo URL`);
            } catch (upsertError) {
              ctx.log(`[upload-logo-blob] Upsert with partition key failed, attempting fallback...`, {
                error: upsertError?.message
              });
              try {
                await cosmosContainer.items.upsert(updatedDoc);
                ctx.log(`[upload-logo-blob] Fallback upsert succeeded`);
              } catch (fallbackError) {
                ctx.error(`[upload-logo-blob] Failed to update company document:`, fallbackError?.message);
              }
            }
          } else {
            ctx.log(`[upload-logo-blob] No company document found for ID: ${companyId}`);
          }
        } else {
          ctx.log(`[upload-logo-blob] Cosmos DB not available - logo URL saved to blob storage but not persisted to company document`);
        }
      } catch (cosmosError) {
        ctx.error(`[upload-logo-blob] Error updating company document:`, cosmosError?.message);
      }

      return json(
        { ok: true, logo_url: logoUrl, message: "Logo uploaded successfully" },
        200,
        req
      );
    } catch (error) {
      ctx.error("[upload-logo-blob] Upload error:", error.message);
      ctx.error("[upload-logo-blob] Error code:", error.code);
      ctx.error("[upload-logo-blob] Stack:", error.stack);

      const { accountName } = getStorageCredentials(ctx);
      const errorResponse = {
        ok: false,
        error: error.message || "Upload failed - please try again",
        errorCode: error.code,
        accountName,
        containerName: "company-logos",
        endpoint: `https://${accountName}.blob.core.windows.net`,
        debug: true
      };
      return json(errorResponse, 500, req);
    }
  },
});
