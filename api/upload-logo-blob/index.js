const { app } = require("@azure/functions");
const { BlobServiceClient, StorageSharedKeyCredential, BlobSASPermissions, generateBlobSASQueryParameters } = require("@azure/storage-blob");
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
    if (req.method === "OPTIONS") return { status: 200, headers: cors(req) };

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
      let credentials;
      try {
        credentials = new StorageSharedKeyCredential(accountName, accountKey);
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
            details: credError.message,
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

      const MAX_BYTES = 300 * 1024;
      if (typeof file.size === "number" && file.size > MAX_BYTES) {
        return json({ ok: false, error: "File too large (max 300KB)" }, 400, req);
      }

      const allowedTypes = ["image/png", "image/jpeg", "image/webp"];
      if (!allowedTypes.includes(file.type)) {
        return json({ ok: false, error: "Invalid file type (PNG, JPG, WebP only)" }, 400, req);
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

      let processedBuffer;
      try {
        processedBuffer = await sharp(uint8Array)
          .resize(256, 256, {
            fit: "contain",
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          })
          .webp({ quality: 80 })
          .toBuffer();

        ctx.log(`[upload-logo-blob] Processed logo to 256x256 WebP for company ${companyId}`);
      } catch (sharpError) {
        ctx.error(`[upload-logo-blob] Failed to process image: ${sharpError.message}`);
        return json({ ok: false, error: "Failed to process image. Please try a different file." }, 400, req);
      }

      const blobName = `${companyId}/${uuidv4()}.webp`;

      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      await blockBlobClient.upload(processedBuffer, processedBuffer.length, {
        blobHTTPHeaders: { blobContentType: "image/webp" },
      });

      // Generate SAS URL with 1-year expiration for secure blob access
      let logoUrl = blockBlobClient.url;
      try {
        const expiresOn = new Date(new Date().getTime() + 365 * 24 * 60 * 60 * 1000);
        const sasParams = generateBlobSASQueryParameters(
          {
            containerName,
            blobName,
            permissions: BlobSASPermissions.parse("r"),
            expiresOn,
          },
          credentials
        );
        logoUrl = `${blockBlobClient.url}?${sasParams.toString()}`;
        ctx.log(`[upload-logo-blob] Generated SAS URL for blob access`);
      } catch (sasError) {
        ctx.warn(`[upload-logo-blob] Failed to generate SAS URL, using plain blob URL instead: ${sasError.message}`);
        // Fall back to plain URL if SAS generation fails
      }

      ctx.log(`[upload-logo-blob] Successfully uploaded logo for company ${companyId}`);

      // Persist the logo URL to Cosmos DB (required for admin logo persistence)
      const cosmosContainer = getCosmosContainer(ctx);
      if (!cosmosContainer) {
        try {
          await blockBlobClient.deleteIfExists();
        } catch {
          // ignore cleanup failure
        }
        return json({ ok: false, error: "Cosmos DB not configured; cannot persist logo reference." }, 503, req);
      }

      // Query for the company by ID (using cross-partition query)
      const querySpec = {
        query: "SELECT * FROM c WHERE c.id = @id OR c.company_id = @id",
        parameters: [{ name: "@id", value: companyId }],
      };

      const queryResult = await cosmosContainer.items
        .query(querySpec, { enableCrossPartitionQuery: true })
        .fetchAll();

      const resources = queryResult?.resources;
      const doc = Array.isArray(resources) && resources.length > 0 ? resources[0] : null;

      if (!doc) {
        try {
          await blockBlobClient.deleteIfExists();
        } catch {
          // ignore cleanup failure
        }
        return json({ ok: false, error: `Company not found for company_id: ${companyId}` }, 404, req);
      }

      // Get the partition key (normalized_domain)
      let partitionKey = doc.normalized_domain;
      if (!partitionKey || String(partitionKey).trim() === "") {
        partitionKey = toNormalizedDomain(doc.website_url || doc.url || doc.domain || "");
      }

      const updatedDoc = {
        ...doc,
        logo_url: logoUrl,
        updated_at: new Date().toISOString(),
      };

      let persisted = false;
      let persistError = null;

      try {
        await cosmosContainer.items.upsert(updatedDoc, { partitionKey });
        persisted = true;
      } catch (upsertError) {
        try {
          await cosmosContainer.items.upsert(updatedDoc);
          persisted = true;
        } catch (fallbackError) {
          persistError = fallbackError?.message || upsertError?.message || "Upsert failed";
        }
      }

      if (!persisted) {
        try {
          await blockBlobClient.deleteIfExists();
        } catch {
          // ignore cleanup failure
        }
        return json({ ok: false, error: "Failed to persist logo_url to database", detail: persistError }, 500, req);
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
