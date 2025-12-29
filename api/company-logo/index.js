const { app } = require("@azure/functions");
const { BlobServiceClient, StorageSharedKeyCredential } = require("@azure/storage-blob");

const CONTAINER_NAME = "company-logos";

function cors(req) {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function getStorageCredentials(ctx) {
  const accountName =
    process.env.AZURE_STORAGE_ACCOUNT_NAME ||
    process.env.VITE_AZURE_STORAGE_ACCOUNT_NAME ||
    "tabarnamstor2356";
  const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;

  ctx.log(`[company-logo] Configured account: ${accountName}`);
  ctx.log(`[company-logo] Account key present: ${!!accountKey}`);

  return { accountName, accountKey };
}

function json(obj, status = 200, req) {
  return {
    status,
    headers: { ...cors(req), "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

async function streamToBuffer(readableStream) {
  if (!readableStream) return Buffer.from("");
  const chunks = [];
  for await (const chunk of readableStream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function extractAccountNameFromSrc(src) {
  const raw = typeof src === "string" ? src.trim() : "";
  if (!raw || !/^https?:\/\//i.test(raw)) return "";

  try {
    const u = new URL(raw);
    const host = (u.hostname || "").toLowerCase();
    if (!host.endsWith(".blob.core.windows.net")) return "";

    const account = host.split(".")[0] || "";
    return account.trim();
  } catch {
    return "";
  }
}

function extractBlobName(src) {
  const raw = typeof src === "string" ? src.trim() : "";
  if (!raw) return "";

  // Allow passing just the blob path: <companyId>/<uuid>.<ext>
  if (!/^https?:\/\//i.test(raw)) {
    const cleaned = raw.replace(/^\/+/, "");
    if (!cleaned) return "";

    return cleaned.startsWith(`${CONTAINER_NAME}/`) ? cleaned.slice(`${CONTAINER_NAME}/`.length) : cleaned;
  }

  let u;
  try {
    u = new URL(raw);
  } catch {
    return "";
  }

  // Only allow reading from Azure Blob endpoints.
  if (!u.hostname.toLowerCase().endsWith(".blob.core.windows.net")) return "";

  const rawPath = u.pathname.startsWith("/") ? u.pathname.slice(1) : u.pathname;
  const segments = rawPath.split("/").filter(Boolean);
  if (!segments.length) return "";

  // Expected: /company-logos/<companyId>/<file>
  if (segments[0] === CONTAINER_NAME) return segments.slice(1).join("/");

  // Tolerate paths where the container appears later in the path.
  const idx = segments.indexOf(CONTAINER_NAME);
  if (idx !== -1 && idx + 1 < segments.length) return segments.slice(idx + 1).join("/");

  return "";
}

app.http("company-logo", {
  route: "company-logo",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    if (req.method === "OPTIONS") return { status: 200, headers: cors(req) };

    try {
      let { accountName, accountKey } = getStorageCredentials(ctx);
      if (!accountKey) {
        return json(
          {
            ok: false,
            error: "Server storage not configured. Please ensure AZURE_STORAGE_ACCOUNT_KEY is set in Function App Configuration.",
            accountName,
          },
          500,
          req
        );
      }

      const src = req.query.get("src") || "";

      const accountNameFromSrc = extractAccountNameFromSrc(src);
      if (accountNameFromSrc && accountNameFromSrc !== String(accountName || "").toLowerCase()) {
        ctx.log(`[company-logo] Overriding account from src URL: ${accountName} -> ${accountNameFromSrc}`);
        accountName = accountNameFromSrc;
      }

      const blobName = extractBlobName(src);

      if (!blobName) {
        return json(
          {
            ok: false,
            error: "Missing or invalid src. Expected an Azure blob URL under company-logos, or a blob path like <companyId>/<file>.",
          },
          400,
          req
        );
      }

      const credentials = new StorageSharedKeyCredential(accountName, accountKey);
      const storageUrl = `https://${accountName}.blob.core.windows.net`;
      const blobServiceClient = new BlobServiceClient(storageUrl, credentials);

      const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);

      // Lightweight 304 support
      const ifNoneMatch = req.headers.get("if-none-match");

      let downloadResponse;
      try {
        downloadResponse = await blockBlobClient.download(0);
      } catch (e) {
        const status = e?.statusCode || e?.status || 500;
        if (status === 404) {
          return {
            status: 404,
            headers: {
              ...cors(req),
              "Cache-Control": "public, max-age=60",
              "Content-Type": "text/plain; charset=utf-8",
            },
            body: "Not found",
          };
        }

        ctx.error(`[company-logo] download failed for ${blobName}: ${e?.message || e}`);
        return json({ ok: false, error: "Failed to fetch logo." }, 500, req);
      }

      const etag = downloadResponse.etag || downloadResponse._response?.headers?.get?.("etag") || "";
      if (etag && ifNoneMatch && ifNoneMatch === etag) {
        return {
          status: 304,
          headers: {
            ...cors(req),
            ETag: etag,
            "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
          },
        };
      }

      const buf = await streamToBuffer(downloadResponse.readableStreamBody);

      const contentType =
        downloadResponse.contentType || downloadResponse._response?.headers?.get?.("content-type") || "application/octet-stream";

      const lastModified = downloadResponse.lastModified
        ? new Date(downloadResponse.lastModified).toUTCString()
        : downloadResponse._response?.headers?.get?.("last-modified") || "";

      const headers = {
        ...cors(req),
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
        "Content-Length": String(buf.length),
      };

      if (etag) headers.ETag = etag;
      if (lastModified) headers["Last-Modified"] = lastModified;

      return {
        status: 200,
        headers,
        body: buf,
      };
    } catch (e) {
      ctx.error(`[company-logo] Unexpected error: ${e?.message || e}`);
      return json({ ok: false, error: "Unexpected error." }, 500, req);
    }
  },
});
