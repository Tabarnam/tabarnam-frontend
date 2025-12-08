const { app } = require("@azure/functions");
const { BlobServiceClient } = require("@azure/storage-blob");
const sharp = require("sharp");
const { v4: uuidv4 } = require("uuid");

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

app.http("upload-logo-blob", {
  route: "upload-logo-blob",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    if (req.method === "OPTIONS") return { status: 204, headers: cors(req) };

    if (!STORAGE_ACCOUNT_KEY) {
      console.error("[upload-logo-blob] AZURE_STORAGE_ACCOUNT_KEY not configured");
      return json(
        { ok: false, error: "Server storage not configured - check AZURE_STORAGE_ACCOUNT_KEY environment variable" },
        500,
        req
      );
    }

    try {
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
          console.log(`[upload-logo-blob] Resized image for company ${companyId}`);
        } catch (sharpError) {
          console.warn(`[upload-logo-blob] Sharp resize failed, using original: ${sharpError.message}`);
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
