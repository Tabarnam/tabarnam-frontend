const { app } = require("@azure/functions");
const { BlobServiceClient } = require("@azure/storage-blob");
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

// Helper function to get storage credentials with fallbacks
function getStorageCredentials(ctx) {
  // Log what we're looking for (for debugging)
  ctx.log('[upload-logo-blob] Attempting to retrieve storage credentials...');

  // Try multiple possible env var names (Azure may use different naming conventions)
  const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
  const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;

  // If direct env vars not found, try parsing AzureWebJobsStorage
  let fallbackName = null;
  let fallbackKey = null;

  if (process.env.AzureWebJobsStorage) {
    const connStr = process.env.AzureWebJobsStorage;
    const nameMatch = connStr.match(/AccountName=([^;]+)/);
    const keyMatch = connStr.match(/AccountKey=([^;=]+)/);
    fallbackName = nameMatch ? nameMatch[1] : null;
    fallbackKey = keyMatch ? keyMatch[1] : null;
    ctx.log('[upload-logo-blob] Parsed from AzureWebJobsStorage - name:', !!fallbackName, 'key:', !!fallbackKey);
  }

  const finalName = accountName || fallbackName;
  const finalKey = accountKey || fallbackKey;

  ctx.log(`[upload-logo-blob] Final credentials - name present: ${!!finalName}, key present: ${!!finalKey}`);
  ctx.log(`[upload-logo-blob] Direct env vars - AZURE_STORAGE_ACCOUNT_NAME: ${!!accountName}, AZURE_STORAGE_ACCOUNT_KEY: ${!!accountKey}`);

  // Log all environment variables containing STORAGE or AZURE for debugging
  const storageEnvKeys = Object.keys(process.env).filter(k =>
    k.includes('STORAGE') || (k.includes('AZURE') && !k.includes('CREDENTIAL') && !k.includes('PASSWORD'))
  );
  ctx.log(`[upload-logo-blob] Available storage env vars: ${storageEnvKeys.join(', ') || 'NONE'}`);

  return { accountName: finalName, accountKey: finalKey };
}

app.http("upload-logo-blob", {
  route: "upload-logo-blob",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    if (req.method === "OPTIONS") return { status: 204, headers: cors(req) };

    try {
      // Diagnostic logging - log raw env var presence at handler entry
      console.log('[upload-logo-blob] hasNameEnv =', !!process.env.AZURE_STORAGE_ACCOUNT_NAME);
      console.log('[upload-logo-blob] hasKeyEnv =', !!process.env.AZURE_STORAGE_ACCOUNT_KEY);
      console.log('[upload-logo-blob] hasConn =', !!process.env.AzureWebJobsStorage);
      console.log('[upload-logo-blob] accountName =', process.env.AZURE_STORAGE_ACCOUNT_NAME || 'NOT SET');

      // Get Azure Blob Storage credentials
      const { accountName, accountKey } = getStorageCredentials(ctx);

      if (!accountName || !accountKey) {
        ctx.error("[upload-logo-blob] Missing storage credentials");
        ctx.error(`[upload-logo-blob] Debug: accountName=${!!accountName}, accountKey=${!!accountKey}`);

        return json(
          {
            ok: false,
            error: "Server storage not configured. Please ensure AZURE_STORAGE_ACCOUNT_NAME and AZURE_STORAGE_ACCOUNT_KEY environment variables are set in the Function App Configuration."
          },
          500,
          req
        );
      }

      // Initialize blob service client with fallback approach
      // Try connection string first (primary method), but if it fails, use SharedKeyCredential
      let blobServiceClient;
      try {
        const connectionString = `DefaultEndpointProtocol=https;AccountName=${accountName};AccountKey=${accountKey};EndpointSuffix=core.windows.net`;
        blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
        ctx.log(`[upload-logo-blob] Successfully created BlobServiceClient from connection string`);
      } catch (connError) {
        ctx.warn(`[upload-logo-blob] Connection string method failed: ${connError.message}. Falling back to SharedKeyCredential.`);
        try {
          const { StorageSharedKeyCredential } = require("@azure/storage-blob");
          const credentials = new StorageSharedKeyCredential(accountName, accountKey);
          const storageUrl = `https://${accountName}.blob.core.windows.net`;
          blobServiceClient = new BlobServiceClient(storageUrl, credentials);
          ctx.log(`[upload-logo-blob] Successfully created BlobServiceClient from SharedKeyCredential`);
        } catch (credError) {
          ctx.error("[upload-logo-blob] Both connection string and SharedKeyCredential methods failed");
          ctx.error("[upload-logo-blob] Connection string error:", connError.message);
          ctx.error("[upload-logo-blob] SharedKeyCredential error:", credError.message);
          return json(
            {
              ok: false,
              error: "Failed to initialize storage client. Please contact support."
            },
            500,
            req
          );
        }
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

      // Try to create container if it doesn't exist
      try {
        const existsResponse = await containerClient.exists();
        if (existsResponse) {
          ctx.log(`[upload-logo-blob] Container already exists: ${containerName}`);
        } else {
          await containerClient.create({ access: "blob" });
          ctx.log(`[upload-logo-blob] Created new container: ${containerName}`);
        }
      } catch (containerError) {
        ctx.warn(`[upload-logo-blob] Container creation warning: ${containerError.message}`);
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

      const blobUrl = blockBlobClient.url;
      ctx.log(`[upload-logo-blob] Successfully uploaded logo for company ${companyId}: ${blobUrl}`);

      return json(
        { ok: true, logo_url: blobUrl, message: "Logo uploaded successfully" },
        200,
        req
      );
    } catch (error) {
      ctx.error("[upload-logo-blob] Upload error:", error.message);
      ctx.error("[upload-logo-blob] Stack:", error.stack);

      return json(
        { ok: false, error: error.message || "Upload failed - please try again" },
        500,
        req
      );
    }
  },
});
