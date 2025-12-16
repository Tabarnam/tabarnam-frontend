const { app } = require("@azure/functions");
const { BlobServiceClient, StorageSharedKeyCredential } = require("@azure/storage-blob");

function cors(req) {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
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

app.http("test-storage", {
  route: "test-storage",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    if (req.method === "OPTIONS") return { status: 200, headers: cors(req) };

    try {
      const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME || "tabarnamstor2356";
      const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;

      ctx.log(`[test-storage] Testing storage: account=${accountName}`);

      if (!accountKey) {
        return json(
          {
            ok: false,
            error: "Storage account key not configured",
            accountName,
            debug: true
          },
          500,
          req
        );
      }

      // Initialize client
      const credentials = new StorageSharedKeyCredential(accountName, accountKey);
      const storageUrl = `https://${accountName}.blob.core.windows.net`;
      const blobServiceClient = new BlobServiceClient(storageUrl, credentials);

      ctx.log(`[test-storage] BlobServiceClient created: ${blobServiceClient.url}`);

      // Try to access the company-logos container
      const containerName = "company-logos";
      const containerClient = blobServiceClient.getContainerClient(containerName);

      ctx.log(`[test-storage] ContainerClient created: ${containerClient.url}`);

      // Check if container exists
      const exists = await containerClient.exists();
      ctx.log(`[test-storage] Container exists: ${exists}`);

      if (!exists) {
        return json(
          {
            ok: false,
            error: `Container "${containerName}" does not exist`,
            accountName,
            containerName,
            endpoint: storageUrl,
            containerExists: false,
            debug: true
          },
          404,
          req
        );
      }

      // List blobs in container
      const blobsArray = [];
      let iterCount = 0;
      const maxBlobs = 10; // Limit to first 10 blobs
      
      for await (const blob of containerClient.listBlobsFlat()) {
        blobsArray.push({
          name: blob.name,
          size: blob.properties.contentLength,
          contentType: blob.properties.contentType,
          created: blob.properties.createdOn
        });
        iterCount++;
        if (iterCount >= maxBlobs) break;
      }

      ctx.log(`[test-storage] Found ${blobsArray.length} blobs in container`);

      return json(
        {
          ok: true,
          accountName,
          containerName,
          endpoint: storageUrl,
          containerExists: true,
          blobCount: blobsArray.length,
          blobs: blobsArray,
          debug: true
        },
        200,
        req
      );
    } catch (error) {
      ctx.error(`[test-storage] Error: ${error.message}`);
      ctx.error(`[test-storage] Error code: ${error.code}`);
      ctx.error(`[test-storage] Stack: ${error.stack}`);

      const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME || "tabarnamstor2356";
      return json(
        {
          ok: false,
          error: error.message,
          errorCode: error.code,
          accountName,
          endpoint: `https://${accountName}.blob.core.windows.net`,
          debug: true
        },
        500,
        req
      );
    }
  },
});
