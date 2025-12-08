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
  // Try multiple possible env var names (Azure may use different naming conventions)
  const accountName =
    process.env.AZURE_STORAGE_ACCOUNT_NAME ||
    process.env.AzureWebJobsStorage?.match(/AccountName=([^;]+)/)?.[1] ||
    null;

  const accountKey =
    process.env.AZURE_STORAGE_ACCOUNT_KEY ||
    process.env.AzureWebJobsStorage?.match(/AccountKey=([^;]+)/)?.[1] ||
    null;

  ctx.log(`[upload-logo-blob] Storage config - accountName: ${accountName || 'NOT FOUND'}, key present: ${!!accountKey}`);

  // Log all environment variables containing STORAGE or AZURE for debugging
  const storageEnvKeys = Object.keys(process.env).filter(k =>
    k.includes('STORAGE') || (k.includes('AZURE') && !k.includes('CREDENTIAL') && !k.includes('PASSWORD'))
  );
  ctx.log(`[upload-logo-blob] Available storage-related env vars: ${storageEnvKeys.join(', ') || 'none'}`);

  return { accountName, accountKey };
}

app.http("upload-logo-blob", {
  route: "upload-logo-blob",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    if (req.method === "OPTIONS") return { status: 204, headers: cors(req) };

    try {
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

      // Construct connection string
      const connectionString = `DefaultEndpointProtocol=https;AccountName=${accountName};AccountKey=${accountKey};EndpointSuffix=core.windows.net`;

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

      // Initialize blob service client
      const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
      const containerName = "company-logos";
      const containerClient = blobServiceClient.getContainerClient(containerName);

      // Try to create container if it doesn't exist
      try {
        await containerClient.create({ access: "blob" });
        ctx.log(`[upload-logo-blob] Created container: ${containerName}`);
      } catch (e) {
        if (e.code !== "ContainerAlreadyExists") throw e;
        ctx.log(`[upload-logo-blob] Container already exists: ${containerName}`);
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
