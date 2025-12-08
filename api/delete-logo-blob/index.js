const { app } = require("@azure/functions");
const { BlobServiceClient } = require("@azure/storage-blob");

const CONTAINER_NAME = "company-logos";

// Helper function to get storage credentials with fallbacks
function getStorageCredentials(ctx) {
  ctx.log('[delete-logo-blob] Attempting to retrieve storage credentials...');

  const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
  const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;

  let fallbackName = null;
  let fallbackKey = null;

  if (process.env.AzureWebJobsStorage) {
    const connStr = process.env.AzureWebJobsStorage;
    const nameMatch = connStr.match(/AccountName=([^;]+)/);
    const keyMatch = connStr.match(/AccountKey=([^;=]+)/);
    fallbackName = nameMatch ? nameMatch[1] : null;
    fallbackKey = keyMatch ? keyMatch[1] : null;
    ctx.log('[delete-logo-blob] Parsed from AzureWebJobsStorage - name:', !!fallbackName, 'key:', !!fallbackKey);
  }

  const finalName = accountName || fallbackName;
  const finalKey = accountKey || fallbackKey;

  ctx.log(`[delete-logo-blob] Final credentials - name present: ${!!finalName}, key present: ${!!finalKey}`);
  ctx.log(`[delete-logo-blob] Direct env vars - AZURE_STORAGE_ACCOUNT_NAME: ${!!accountName}, AZURE_STORAGE_ACCOUNT_KEY: ${!!accountKey}`);

  return { accountName: finalName, accountKey: finalKey };
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
      // Diagnostic logging - log raw env var presence at handler entry
      console.log('[delete-logo-blob] hasNameEnv =', !!process.env.AZURE_STORAGE_ACCOUNT_NAME);
      console.log('[delete-logo-blob] hasKeyEnv =', !!process.env.AZURE_STORAGE_ACCOUNT_KEY);
      console.log('[delete-logo-blob] hasConn =', !!process.env.AzureWebJobsStorage);
      console.log('[delete-logo-blob] accountName =', process.env.AZURE_STORAGE_ACCOUNT_NAME || 'NOT SET');

      // Get Azure Blob Storage credentials
      const { accountName, accountKey } = getStorageCredentials(ctx);

      if (!accountName || !accountKey) {
        ctx.error("[delete-logo-blob] Missing storage credentials");
        ctx.error(`[delete-logo-blob] Debug: accountName=${!!accountName}, accountKey=${!!accountKey}`);
        return json(
          {
            ok: false,
            error: "Server storage not configured. Please ensure AZURE_STORAGE_ACCOUNT_NAME and AZURE_STORAGE_ACCOUNT_KEY environment variables are set in the Function App Configuration."
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

      // Initialize blob service client
      const connectionString = `DefaultEndpointProtocol=https;AccountName=${accountName};AccountKey=${accountKey};EndpointSuffix=core.windows.net`;
      const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);

      // Extract blob name from URL
      const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
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

      return json(
        { ok: true, message: "Logo deleted successfully" },
        200,
        req
      );
    } catch (error) {
      ctx.error("[delete-logo-blob] Deletion error:", error.message);
      ctx.error("[delete-logo-blob] Stack:", error.stack);
      return json(
        { ok: false, error: error.message || "Deletion failed - please try again" },
        500,
        req
      );
    }
  },
});
