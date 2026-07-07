// api/_reviewImages.js
//
// Store/serve/delete images attached to community reviews. Images arrive as
// (client-compressed) data URLs embedded in the submit-review request, are
// re-encoded with sharp (strips EXIF, caps dimensions), and stored in a public
// blob container with unguessable names. Reuses the same Azure Blob pattern as
// the logo/homepage uploaders. No standalone public upload endpoint exists — so
// nobody can use us as an arbitrary file host; images only ever land alongside a
// moderated pending review and are exposed publicly only after approval.

const { BlobServiceClient, StorageSharedKeyCredential } = require("@azure/storage-blob");
const { randomUUID } = require("node:crypto");
const { tryLoadSharp } = require("./_shared");

const CONTAINER = (process.env.REVIEW_IMAGES_CONTAINER || "review-images").trim();
const MAX_IMAGES = 3;
const MAX_INPUT_BYTES = 12 * 1024 * 1024; // safety cap on a single decoded image
const ALLOWED = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

function getAccount() {
  return {
    accountName: (process.env.AZURE_STORAGE_ACCOUNT_NAME || "tabarnamstor2356").trim(),
    accountKey: (process.env.AZURE_STORAGE_ACCOUNT_KEY || "").trim(),
  };
}

function isStorageConfigured() {
  const { accountName, accountKey } = getAccount();
  return Boolean(accountName && accountKey);
}

let cachedService;
function getServiceClient() {
  if (!isStorageConfigured()) return null;
  if (cachedService) return cachedService;
  const { accountName, accountKey } = getAccount();
  cachedService = new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    new StorageSharedKeyCredential(accountName, accountKey)
  );
  return cachedService;
}

let containerReady = false;
async function getContainerClient() {
  const svc = getServiceClient();
  if (!svc) return null;
  const container = svc.getContainerClient(CONTAINER);
  if (!containerReady) {
    try {
      await container.createIfNotExists({ access: "blob" });
    } catch {
      try {
        await container.createIfNotExists();
      } catch {
        /* ignore — upload will surface any real error */
      }
    }
    containerReady = true;
  }
  return container;
}

function parseDataUrl(dataUrl) {
  const m = /^data:([^;,]+);base64,(.+)$/i.exec(String(dataUrl || "").trim());
  if (!m) return null;
  const mime = m[1].toLowerCase();
  if (!ALLOWED.has(mime)) return null;
  let buf;
  try {
    buf = Buffer.from(m[2], "base64");
  } catch {
    return null;
  }
  if (!buf.length || buf.length > MAX_INPUT_BYTES) return null;
  return { mime, buf };
}

// Re-encode + upload one data-URL image. Returns the public blob URL or null.
async function processAndUploadReviewImage(dataUrl, reviewId, ctx) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return null;

  const { sharp } = tryLoadSharp();
  if (!sharp) {
    ctx?.log?.warn?.("[review-images] sharp unavailable — skipping image");
    return null;
  }

  let out;
  try {
    out = await sharp(parsed.buf, { failOn: "none" })
      .rotate() // apply EXIF orientation, then metadata is dropped on re-encode
      .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
  } catch (e) {
    ctx?.log?.warn?.(`[review-images] process failed: ${e?.message || e}`);
    return null;
  }

  const container = await getContainerClient();
  if (!container) return null;

  const name = `${String(reviewId || "r")}/${randomUUID()}.webp`;
  try {
    const blob = container.getBlockBlobClient(name);
    await blob.uploadData(out, {
      blobHTTPHeaders: { blobContentType: "image/webp", blobCacheControl: "public, max-age=31536000" },
    });
    // Public blob access is disabled account-wide, so return a same-origin proxy
    // URL (served by api/review-image) rather than the raw blob URL.
    return `/api/review-image?src=${encodeURIComponent(name)}`;
  } catch (e) {
    ctx?.log?.warn?.(`[review-images] upload failed: ${e?.message || e}`);
    return null;
  }
}

// Resolve a stored image value (proxy URL, or legacy raw blob URL) to its blob
// name within the review-images container.
function blobNameFromStored(stored) {
  const s = String(stored || "").trim();
  if (!s) return null;
  const srcIdx = s.indexOf("src=");
  if (s.includes("/api/review-image") && srcIdx >= 0) {
    const raw = s.slice(srcIdx + 4).split("&")[0];
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  try {
    const u = new URL(s);
    const parts = u.pathname.replace(/^\/+/, "").split("/");
    const cont = parts.shift();
    if (cont === CONTAINER) return decodeURIComponent(parts.join("/"));
  } catch {
    /* not a URL */
  }
  return null;
}

// Fetch a review image blob for the public proxy. Returns { buf } or null (404).
async function downloadReviewImage(blobName) {
  const svc = getServiceClient();
  if (!svc) return null;
  const name = String(blobName || "").trim();
  if (!name || name.includes("..")) return null;
  try {
    const buf = await svc.getContainerClient(CONTAINER).getBlockBlobClient(name).downloadToBuffer();
    return { buf, contentType: "image/webp" };
  } catch (e) {
    if ((e?.statusCode || e?.status) === 404) return null;
    throw e;
  }
}

// Process up to MAX_IMAGES data URLs; returns the URLs that uploaded OK.
async function uploadReviewImages(dataUrls, reviewId, ctx) {
  if (!Array.isArray(dataUrls) || !dataUrls.length || !isStorageConfigured()) return [];
  const urls = [];
  for (const d of dataUrls.slice(0, MAX_IMAGES)) {
    const u = await processAndUploadReviewImage(d, reviewId, ctx);
    if (u) urls.push(u);
  }
  return urls;
}

// Best-effort deletion of a review's image blobs (on remove).
async function deleteReviewImages(urls, ctx) {
  if (!Array.isArray(urls) || !urls.length) return;
  const svc = getServiceClient();
  if (!svc) return;
  const container = svc.getContainerClient(CONTAINER);
  for (const url of urls) {
    try {
      const blobName = blobNameFromStored(url);
      if (!blobName) continue;
      await container.getBlockBlobClient(blobName).deleteIfExists();
    } catch (e) {
      ctx?.log?.warn?.(`[review-images] delete failed: ${e?.message || e}`);
    }
  }
}

module.exports = { uploadReviewImages, deleteReviewImages, downloadReviewImage, isStorageConfigured, MAX_IMAGES };
