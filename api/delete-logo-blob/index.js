const { app } = require("@azure/functions");
const { BlobServiceClient } = require("@azure/storage-blob");

const STORAGE_ACCOUNT = "tabarnamstor2356";
const STORAGE_ACCOUNT_KEY = process.env.AZURE_STORAGE_ACCOUNT_KEY || "";
const CONTAINER_NAME = "company-logos";

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

    if (!STORAGE_ACCOUNT_KEY) {
      console.error("[delete-logo-blob] AZURE_STORAGE_ACCOUNT_KEY not configured");
      return json(
        { ok: false, error: "Server storage not configured" },
        500,
        req
      );
    }

    try {
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
      const blobServiceClient = BlobServiceClient.fromConnectionString(
        `DefaultEndpointProtocol=https;AccountName=${STORAGE_ACCOUNT};AccountKey=${STORAGE_ACCOUNT_KEY};EndpointSuffix=core.windows.net`
      );

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

      console.log(`[delete-logo-blob] Deleted blob: ${blobName}`);

      return json(
        { ok: true, message: "Logo deleted successfully" },
        200,
        req
      );
    } catch (error) {
      console.error("[delete-logo-blob] Error:", error);
      return json(
        { ok: false, error: error.message || "Deletion failed" },
        500,
        req
      );
    }
  },
});
