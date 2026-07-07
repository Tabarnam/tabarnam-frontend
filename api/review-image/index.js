// api/review-image/index.js
//
// Public proxy that streams a community-review image blob. The storage account
// has public blob access disabled account-wide, so (like api/company-logo) we
// read the blob server-side with the account key and stream the bytes. Images
// are stored as webp with unguessable names; only approved reviews' image URLs
// are ever surfaced publicly (via get-reviews).
//
// Route: GET /review-image?src=<blobName>   (anonymous)

const { app } = require("../_app");
const { downloadReviewImage } = require("../_reviewImages");

const cors = (req) => ({
  "Access-Control-Allow-Origin": req?.headers?.get?.("origin") || "*",
  Vary: "Origin",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
});

// blobName is "<reviewId>/<uuid>.webp" — allow only that shape (no traversal).
const NAME_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.webp$/;

async function reviewImageHandler(req, ctx) {
  if (String(req.method || "").toUpperCase() === "OPTIONS") return { status: 200, headers: cors(req) };

  let src = "";
  try {
    src = String(new URL(req.url).searchParams.get("src") || "").trim();
  } catch {
    src = "";
  }
  try {
    if (src.includes("%")) src = decodeURIComponent(src);
  } catch {
    /* keep as-is */
  }

  if (!src || src.includes("..") || !NAME_RE.test(src)) {
    return { status: 400, headers: { ...cors(req), "Content-Type": "text/plain" }, body: "Invalid src" };
  }

  let result;
  try {
    result = await downloadReviewImage(src);
  } catch (e) {
    ctx?.error?.(`[review-image] download failed for ${src}: ${e?.message || e}`);
    return { status: 500, headers: { ...cors(req), "Content-Type": "text/plain" }, body: "Failed to fetch image" };
  }

  if (!result) {
    return {
      status: 404,
      headers: { ...cors(req), "Content-Type": "text/plain", "Cache-Control": "public, max-age=60" },
      body: "Not found",
    };
  }

  return {
    status: 200,
    headers: {
      ...cors(req),
      "Content-Type": result.contentType || "image/webp",
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Length": String(result.buf.length),
    },
    body: result.buf,
  };
}

app.http("reviewImage", {
  route: "review-image",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: reviewImageHandler,
});

module.exports = { handler: reviewImageHandler };
