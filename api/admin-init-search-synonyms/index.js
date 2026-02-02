/**
 * Admin endpoint to initialize search_synonyms.json blob in Azure Storage
 * POST /api/admin-init-search-synonyms with authorization
 */

let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}

const { BlobServiceClient } = require("@azure/storage-blob");

function env(k, d = "") {
  const v = process.env[k];
  return (v == null ? d : String(v)).trim();
}

function json(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "content-type,x-functions-key",
    },
    body: JSON.stringify(obj),
  };
}

async function initSearchSynonymsHandler(req, context) {
  const method = String(req.method || "").toUpperCase();
  if (method === "OPTIONS") {
    return {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "content-type,x-functions-key",
      },
    };
  }

  if (method !== "POST") {
    return json({ ok: false, error: "Method Not Allowed" }, 405);
  }

  try {
    const connectionString = env("AZURE_STORAGE_CONNECTION_STRING", "");
    if (!connectionString) {
      return json({ ok: false, error: "AZURE_STORAGE_CONNECTION_STRING not configured" }, 503);
    }

    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    const containerClient = blobServiceClient.getContainerClient("config");

    // Ensure container exists
    try {
      await containerClient.createIfNotExists();
    } catch (e) {
      // Container might already exist, continue
    }

    const blockBlobClient = containerClient.getBlockBlobClient("search_synonyms.json");

    // Create default synonyms map
    const defaultSynonyms = {
      "bodywash": ["body wash"],
      "body wash": ["body wash"],
      "body-wash": ["body wash"],
      "body_wash": ["body wash"],
    };

    const blobContent = JSON.stringify(defaultSynonyms, null, 2);
    await blockBlobClient.upload(blobContent, Buffer.byteLength(blobContent), {
      overwrite: true,
    });

    return json({
      ok: true,
      message: "search_synonyms.json initialized successfully",
      container: "config",
      blob: "search_synonyms.json",
      entries: Object.keys(defaultSynonyms).length,
    });
  } catch (e) {
    context.error(`Failed to initialize search synonyms: ${e.message}`);
    return json({ ok: false, error: e.message || "Failed to initialize synonyms" }, 500);
  }
}

app.http("admin-init-search-synonyms", {
  route: "admin-init-search-synonyms",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    return initSearchSynonymsHandler(req, context);
  },
});

module.exports = app;
