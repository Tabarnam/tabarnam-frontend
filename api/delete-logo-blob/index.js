const { app } = require("@azure/functions");
const { BlobServiceClient, StorageSharedKeyCredential } = require("@azure/storage-blob");

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

      if (!accountKey) {
        ctx.error("[delete-logo-blob] Missing storage account key");
        return json(
          {
            ok: false,
            error: "Server storage not configured. Please ensure AZURE_STORAGE_ACCOUNT_KEY is set in Function App Configuration.",
            ...(process.env.NODE_ENV !== "production" && { accountName, debug: true })
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
        ctx.log(`[delete-logo-blob] Using account: ${accountName}`);
        ctx.log(`[delete-logo-blob] Endpoint: ${storageUrl}`);
      } catch (credError) {
        ctx.error("[delete-logo-blob] Failed to initialize BlobServiceClient:", credError.message);
        return json(
          {
            ok: false,
            error: "Failed to initialize storage client.",
            ...(process.env.NODE_ENV !== "production" && { accountName, error: credError.message })
          },
          500,
          req
        );
      }

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

      const { accountName } = getStorageCredentials(ctx);
      return json(
        {
          ok: false,
          error: error.message || "Deletion failed - please try again",
          ...(process.env.NODE_ENV !== "production" && {
            accountName,
            containerName: CONTAINER_NAME,
            debug: true
          })
        },
        500,
        req
      );
    }
  },
});
