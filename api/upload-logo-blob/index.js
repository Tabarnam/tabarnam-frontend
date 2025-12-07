const { app } = require("@azure/functions");
const { BlobServiceClient } = require("@azure/storage-blob");

const STORAGE_ACCOUNT = "tabarnamstor2356";
const STORAGE_ACCOUNT_KEY = process.env.AZURE_STORAGE_ACCOUNT_KEY || "yc2wE75NmkLuy74EoJMqMaNpNFm70vK2iptLuAzJ6XswlPOWREJEd5sNUS8sDNKV484jxhFLTPCo+AStzd3Kfw==";
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

app.http("upload-logo-blob", {
  route: "upload-logo-blob",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    if (req.method === "OPTIONS") return { status: 204, headers: cors(req) };

    try {
      // Initialize blob service client
      const blobServiceClient = BlobServiceClient.fromConnectionString(
        `DefaultEndpointProtocol=https;AccountName=${STORAGE_ACCOUNT};AccountKey=${STORAGE_ACCOUNT_KEY};EndpointSuffix=core.windows.net`
      );

      // Get or create container
      const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
      try {
        await containerClient.create({ access: "blob" });
        console.log(`[upload-logo-blob] Created container: ${CONTAINER_NAME}`);
      } catch (e) {
        if (e.code !== "ContainerAlreadyExists") throw e;
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

      // Generate blob name (companyId/filename)
      const fileName = file.name || "logo.png";
      const blobName = `${companyId}/${Date.now()}-${fileName}`;

      // Get blob client and upload
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      const arrayBuffer = await file.arrayBuffer();
      
      await blockBlobClient.upload(arrayBuffer, arrayBuffer.byteLength, {
        blobHTTPHeaders: { blobContentType: file.type || "image/png" },
      });

      const blobUrl = blockBlobClient.url;
      console.log(`[upload-logo-blob] Uploaded logo for company ${companyId}: ${blobUrl}`);

      return json(
        { ok: true, logo_url: blobUrl, message: "Logo uploaded successfully" },
        200,
        req
      );
    } catch (error) {
      console.error("[upload-logo-blob] Error:", error);
      return json(
        { ok: false, error: error.message || "Upload failed" },
        500,
        req
      );
    }
  },
});
