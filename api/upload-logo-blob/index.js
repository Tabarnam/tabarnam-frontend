const { app } = require("@azure/functions");
const { BlobServiceClient, StorageSharedKeyCredential } = require("@azure/storage-blob");
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

      const { accountName } = getStorageCredentials(ctx);
      return json(
        {
          ok: false,
          error: error.message || "Upload failed - please try again",
          ...(process.env.NODE_ENV !== "production" && {
            accountName,
            containerName: "company-logos",
            debug: true
          })
        },
        500,
        req
      );
    }
  },
});
