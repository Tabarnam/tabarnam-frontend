// Microlink API client + screenshot processing helper.
//
// Reads the Microlink Pro API key from process.env.MICROLINK_API_KEY (set in
// the Function App configuration; never log or echo it). The endpoint returns
// a temporary CDN URL for the rendered screenshot, which we download into a
// Buffer for downstream sharp re-encoding + Azure blob upload.

const { tryLoadSharp } = require("./_shared");
const { sharp, reason: sharpLoadError } = tryLoadSharp();

const MICROLINK_BASE = "https://pro.microlink.io/";
const SCREENSHOT_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const TARGET_WIDTH = 1280;
const TARGET_HEIGHT = 800;
const WEBP_QUALITY = 82;

function getMicrolinkKey() {
  return (process.env.MICROLINK_API_KEY || "").trim();
}

function getMicrolinkUrl(websiteUrl) {
  const u = new URL(MICROLINK_BASE);
  u.searchParams.set("url", websiteUrl);
  u.searchParams.set("screenshot", "true");
  u.searchParams.set("viewport.width", String(TARGET_WIDTH));
  u.searchParams.set("viewport.height", String(TARGET_HEIGHT));
  // Slower waitFor: many of our companies are mid-tier shops where the hero
  // image lazy-loads after first paint. 5s gives that time without busting
  // our 70s per-call budget.
  u.searchParams.set("waitFor", "5000");
  // Microlink Pro adblocking + cookie banner removal
  u.searchParams.set("adblock", "true");
  u.searchParams.set("device", "desktop");
  // Residential proxy bypasses Cloudflare/PerimeterX bot challenges. Included
  // in Microlink Pro by default — no separate add-on required.
  u.searchParams.set("proxy", "true");
  return u.toString();
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call Microlink for a single URL. Returns:
 *   { ok: true,  bytes: Buffer, contentType: "image/png" }
 *   { ok: false, reason: "..." }
 */
async function fetchMicrolinkScreenshot(websiteUrl, ctx) {
  const apiKey = getMicrolinkKey();
  if (!apiKey) return { ok: false, reason: "missing_microlink_api_key" };

  let raw = String(websiteUrl || "").trim();
  if (!raw) return { ok: false, reason: "missing_website_url" };
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

  const url = getMicrolinkUrl(raw);
  ctx?.log?.(`[microlink] requesting screenshot for ${raw}`);

  let res;
  try {
    res = await fetchWithTimeout(
      url,
      { method: "GET", headers: { "x-api-key": apiKey, accept: "application/json" } },
      SCREENSHOT_TIMEOUT_MS
    );
  } catch (e) {
    return { ok: false, reason: `microlink_request_failed: ${e?.message || e}` };
  }

  let payload;
  try {
    payload = await res.json();
  } catch (e) {
    return { ok: false, reason: `microlink_invalid_json: ${e?.message || e}` };
  }

  if (!res.ok || payload?.status !== "success") {
    const detail = payload?.message || payload?.code || `http_${res.status}`;
    // Surface the upstream code/status alongside the message so we can tell
    // "API rejected the request" (fast, plan/quota/syntax) apart from "render
    // failed for this site" (slow, target-specific). Without this, both look
    // identical in the logs.
    const diag = `http=${res.status} status=${payload?.status || "n/a"} code=${payload?.code || "n/a"}`;
    ctx?.log?.(`[microlink] error for ${raw}: ${detail} (${diag})`);
    return { ok: false, reason: `microlink_error: ${detail}` };
  }

  const screenshotUrl = payload?.data?.screenshot?.url;
  if (!screenshotUrl || typeof screenshotUrl !== "string") {
    return { ok: false, reason: "microlink_no_screenshot_url" };
  }

  // Download the rendered image from the temporary CDN URL Microlink returned
  let imgRes;
  try {
    imgRes = await fetchWithTimeout(screenshotUrl, { method: "GET" }, DOWNLOAD_TIMEOUT_MS);
  } catch (e) {
    return { ok: false, reason: `download_failed: ${e?.message || e}` };
  }
  if (!imgRes.ok) {
    return { ok: false, reason: `download_http_${imgRes.status}` };
  }

  let bytes;
  try {
    const ab = await imgRes.arrayBuffer();
    bytes = Buffer.from(ab);
  } catch (e) {
    return { ok: false, reason: `download_buffer_failed: ${e?.message || e}` };
  }

  if (!bytes || bytes.length < 1024) {
    return { ok: false, reason: "download_too_small" };
  }

  return {
    ok: true,
    bytes,
    contentType: imgRes.headers?.get?.("content-type") || "image/png",
  };
}

/**
 * Resize + re-encode raw screenshot bytes to webp matching our standard
 * 1280x800 viewport homepage format. Returns Buffer.
 */
async function reencodeAsWebp(bytes) {
  if (!sharp) {
    throw new Error(`sharp_unavailable: ${sharpLoadError}`);
  }
  return sharp(bytes)
    .resize(TARGET_WIDTH, TARGET_HEIGHT, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();
}

module.exports = {
  fetchMicrolinkScreenshot,
  reencodeAsWebp,
  TARGET_WIDTH,
  TARGET_HEIGHT,
};
