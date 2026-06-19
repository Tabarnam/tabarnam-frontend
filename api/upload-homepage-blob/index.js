let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}
const { BlobServiceClient, StorageSharedKeyCredential } = require("@azure/storage-blob");
const { CosmosClient } = require("@azure/cosmos");
const { tryLoadSharp } = require("../_shared");
const { v4: uuidv4 } = require("uuid");

const CONTAINER_NAME = "company-homepages";

// Homepage screenshots are larger than logos — above-the-fold web captures.
const MAX_INPUT_BYTES = 5 * 1024 * 1024; // 5MB accepted, downscaled + re-encoded
const TARGET_WIDTH = 1280;
const TARGET_HEIGHT = 800;
const WEBP_QUALITY = 82;

const { sharp, reason: sharpLoadError } = tryLoadSharp();

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

function getStorageCredentials(ctx) {
  const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME || "tabarnamstor2356";
  const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;
  ctx.log(`[upload-homepage-blob] Using account: ${accountName}`);
  ctx.log(`[upload-homepage-blob] Account key present: ${!!accountKey}`);
  return { accountName, accountKey };
}

function getCosmosContainer(ctx) {
  const endpoint = process.env.COSMOS_DB_ENDPOINT || "";
  const key = process.env.COSMOS_DB_KEY || "";
  const database = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
  const container = process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies";

  if (!endpoint || !key) {
    ctx.log("[upload-homepage-blob] Cosmos DB not configured - homepage URL will not be persisted");
    return null;
  }

  try {
    const client = require("../_cosmosConfig").getCosmosClient();
    return client.database(database).container(container);
  } catch (e) {
    ctx.error("[upload-homepage-blob] Failed to create Cosmos client:", e?.message);
    return null;
  }
}

function toNormalizedDomain(s = "") {
  try {
    const u = s.startsWith("http") ? new URL(s) : new URL(`https://${s}`);
    let h = u.hostname.toLowerCase();
    if (h.startsWith("www.")) h = h.slice(4);
    return h || "unknown";
  } catch {
    return "unknown";
  }
}

async function uploadHomepageBlobHandler(req, ctx) {
  if (req.method === "OPTIONS") return { status: 200, headers: cors(req) };

  try {
    const { accountName, accountKey } = getStorageCredentials(ctx);
    if (!accountKey) {
      return json(
        { ok: false, error: "Server storage not configured. Please ensure AZURE_STORAGE_ACCOUNT_KEY is set.", accountName },
        500,
        req
      );
    }

    let blobServiceClient;
    try {
      const credentials = new StorageSharedKeyCredential(accountName, accountKey);
      blobServiceClient = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, credentials);
    } catch (credError) {
      ctx.error("[upload-homepage-blob] Failed to initialize BlobServiceClient:", credError.message);
      return json({ ok: false, error: "Failed to initialize storage client.", details: credError.message }, 500, req);
    }

    const formData = await req.formData();
    const file = formData.get("file");
    const companyId = formData.get("company_id") || formData.get("companyId");
    // Optional partition-key hint: lets us point-read the doc instead of a
    // slow cross-partition Cosmos query (which can take 5-15s and push the
    // request over the SWA 45s gateway timeout).
    const normalizedDomainHint = String(formData.get("normalized_domain") || "").trim().toLowerCase();

    if (!file || !companyId) {
      return json({ ok: false, error: "Missing file or company_id" }, 400, req);
    }

    if (typeof file.size === "number" && file.size > MAX_INPUT_BYTES) {
      return json({ ok: false, error: `File too large (max ${Math.round(MAX_INPUT_BYTES / 1024 / 1024)}MB)` }, 400, req);
    }

    const allowedTypes = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
    if (!allowedTypes.includes(file.type)) {
      return json({ ok: false, error: "Invalid file type (PNG, JPG, or WebP only)" }, 400, req);
    }

    if (!sharp) {
      ctx.error(`[upload-homepage-blob] Sharp unavailable: ${sharpLoadError}`);
      return json({ ok: false, error: "Image processing is currently unavailable." }, 503, req);
    }

    const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);

    try {
      const exists = await containerClient.exists();
      if (exists) {
        try {
          await containerClient.setAccessPolicy("blob");
        } catch (accessError) {
          ctx.warn?.(`[upload-homepage-blob] Could not set container access policy: ${accessError?.message || accessError}`);
        }
      } else {
        try {
          await containerClient.create({ access: "blob" });
        } catch (createError) {
          ctx.warn?.(`[upload-homepage-blob] Public-create failed, retrying private: ${createError?.message || createError}`);
          await containerClient.create();
        }
      }
    } catch (containerError) {
      ctx.error(`[upload-homepage-blob] Container operation error: ${containerError.message}`);
    }

    const buffer = await file.arrayBuffer();
    const uint8Array = new Uint8Array(buffer);

    let processedBuffer;
    try {
      processedBuffer = await sharp(uint8Array)
        .resize(TARGET_WIDTH, TARGET_HEIGHT, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();
      ctx.log(`[upload-homepage-blob] Re-encoded to webp ${processedBuffer.length}B for ${companyId}`);
    } catch (sharpError) {
      ctx.error(`[upload-homepage-blob] sharp failed: ${sharpError.message}`);
      return json({ ok: false, error: "Failed to process image. Please try a different file." }, 400, req);
    }

    const blobName = `${companyId}/${uuidv4()}.webp`;
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.upload(processedBuffer, processedBuffer.length, {
      blobHTTPHeaders: { blobContentType: "image/webp" },
    });

    const homepageUrl = blockBlobClient.url;
    ctx.log(`[upload-homepage-blob] Uploaded homepage image for company ${companyId}`);

    const cosmosContainer = getCosmosContainer(ctx);
    if (!cosmosContainer) {
      try {
        await blockBlobClient.deleteIfExists();
      } catch {
        // ignore cleanup failure
      }
      return json({ ok: false, error: "Cosmos DB not configured; cannot persist homepage reference." }, 503, req);
    }

    // Fast path: if the client provided normalized_domain, point-read by id
    // + partition key. Falls back to cross-partition query when missing.
    let doc = null;
    if (normalizedDomainHint) {
      try {
        const t0 = Date.now();
        const { resource } = await cosmosContainer.item(String(companyId), normalizedDomainHint).read();
        if (resource) {
          doc = resource;
          ctx.log(`[upload-homepage-blob] Cosmos point-read found doc in ${Date.now() - t0}ms`);
        } else {
          ctx.log(`[upload-homepage-blob] Cosmos point-read returned no doc (in ${Date.now() - t0}ms); falling back to cross-partition`);
        }
      } catch (e) {
        ctx.log(`[upload-homepage-blob] Cosmos point-read failed (${e?.code || e?.message}); falling back to cross-partition`);
      }
    }
    if (!doc) {
      const querySpec = {
        query: "SELECT * FROM c WHERE c.id = @id OR c.company_id = @id",
        parameters: [{ name: "@id", value: companyId }],
      };
      const t0 = Date.now();
      const queryResult = await cosmosContainer.items.query(querySpec, { enableCrossPartitionQuery: true }).fetchAll();
      ctx.log(`[upload-homepage-blob] Cosmos cross-partition query took ${Date.now() - t0}ms`);
      doc = Array.isArray(queryResult?.resources) && queryResult.resources.length > 0 ? queryResult.resources[0] : null;
    }

    if (!doc) {
      try {
        await blockBlobClient.deleteIfExists();
      } catch {
        // ignore cleanup failure
      }
      return json({ ok: false, error: `Company not found for company_id: ${companyId}` }, 404, req);
    }

    let partitionKey = doc.normalized_domain;
    if (!partitionKey || String(partitionKey).trim() === "") {
      partitionKey = toNormalizedDomain(doc.website_url || doc.url || doc.domain || "");
    }

    const updatedDoc = {
      ...doc,
      homepage_image_url: homepageUrl,
      updated_at: new Date().toISOString(),
    };

    let persisted = false;
    let persistError = null;
    try {
      await cosmosContainer.items.upsert(updatedDoc, { partitionKey });
      persisted = true;
    } catch (upsertError) {
      try {
        await cosmosContainer.items.upsert(updatedDoc);
        persisted = true;
      } catch (fallbackError) {
        persistError = fallbackError?.message || upsertError?.message || "Upsert failed";
      }
    }

    if (!persisted) {
      try {
        await blockBlobClient.deleteIfExists();
      } catch {
        // ignore cleanup failure
      }
      return json({ ok: false, error: "Failed to persist homepage_image_url to database", detail: persistError }, 500, req);
    }

    return json({ ok: true, homepage_image_url: homepageUrl, message: "Homepage image uploaded successfully" }, 200, req);
  } catch (error) {
    ctx.error("[upload-homepage-blob] Upload error:", error.message);
    ctx.error("[upload-homepage-blob] Stack:", error.stack);
    return json({ ok: false, error: error.message || "Upload failed - please try again", errorCode: error.code }, 500, req);
  }
}

app.http("upload-homepage-blob", {
  route: "upload-homepage-blob",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: require("../_adminAuth").withAdminGuard(uploadHomepageBlobHandler),
});

module.exports = { handler: uploadHomepageBlobHandler };
