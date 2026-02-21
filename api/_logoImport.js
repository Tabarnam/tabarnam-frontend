const {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
} = require("@azure/storage-blob");
const { tryLoadSharp } = require("./_shared");
const { v4: uuidv4 } = require("uuid");

// Load sharp safely - will be null if unavailable
const { sharp, reason: sharpLoadError } = tryLoadSharp();

function env(k, d = "") {
  const v = process.env[k];
  return v == null ? d : String(v).trim();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clampNumber(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

function createTimeBudget(budgetMs, { defaultMs = 20_000, maxMs = 25_000 } = {}) {
  const cap = clampNumber(budgetMs, 0, maxMs, defaultMs);
  const startMs = Date.now();
  const deadlineMs = startMs + cap;

  return {
    start_ms: startMs,
    deadline_ms: deadlineMs,
    budget_ms: cap,
    elapsed_ms: () => Date.now() - startMs,
    remaining_ms: (marginMs = 0) => deadlineMs - Date.now() - (Number(marginMs) || 0),
  };
}

function computeBudgetedTimeoutMs(budget, desiredMs, { minMs = 800, marginMs = 350, maxMs = 25_000 } = {}) {
  const desired = clampNumber(desiredMs, 1, maxMs, desiredMs);
  if (!budget || typeof budget.remaining_ms !== "function") {
    return clampNumber(desired, minMs, maxMs, desired);
  }

  const remaining = budget.remaining_ms(marginMs);
  return clampNumber(remaining, minMs, desired, minMs);
}

function isBudgetExhausted(budget, { marginMs = 0, minRemainingMs = 1 } = {}) {
  if (!budget || typeof budget.remaining_ms !== "function") return false;
  return budget.remaining_ms(marginMs) < minRemainingMs;
}

function normalizeDomain(domain) {
  const raw = String(domain || "").trim().toLowerCase();
  if (!raw) return "";
  return raw.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
}

function normalizeUrlCandidate(u) {
  const s = String(u || "").trim();
  if (!s) return "";
  if (s.startsWith("data:")) return "";
  return s;
}

function decodeHtmlEntities(s) {
  const str = String(s || "");
  if (!str) return str;
  return str
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function absolutizeUrl(candidate, baseUrl) {
  const raw = normalizeUrlCandidate(candidate);
  if (!raw) return "";

  // Decode HTML entities (&amp; → &, etc.) since values come from raw HTML attributes
  const decoded = decodeHtmlEntities(raw);

  try {
    if (decoded.startsWith("//")) {
      const base = new URL(baseUrl);
      return `${base.protocol}${decoded}`;
    }
    return new URL(decoded, baseUrl).toString();
  } catch {
    return "";
  }
}

function parseSrcsetBestUrl(srcset, baseUrl) {
  const raw = String(srcset || "").trim();
  if (!raw) return "";

  const entries = raw.split(",").map((entry) => {
    const parts = entry.trim().split(/\s+/);
    const url = parts[0] || "";
    const descriptor = parts[1] || "";
    let weight = 0;

    if (descriptor.endsWith("w")) {
      weight = parseFloat(descriptor) || 0;
    } else if (descriptor.endsWith("x")) {
      weight = (parseFloat(descriptor) || 1) * 1000;
    } else {
      weight = 1;
    }

    return { url, weight };
  });

  entries.sort((a, b) => b.weight - a.weight);

  for (const entry of entries) {
    const abs = absolutizeUrl(entry.url, baseUrl);
    if (abs) return abs;
  }

  return "";
}

function extractFirstMatch(html, regex) {
  const m = html.match(regex);
  return m && m[1] ? String(m[1]).trim() : "";
}

function extractMetaImage(html, baseUrl, kind) {
  const key = kind === "og" ? "og:image" : "twitter:image";

  const patterns = [
    new RegExp(`<meta\\b[^>]*property=["']${key}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta\\b[^>]*content=["']([^"']+)["'][^>]*property=["']${key}["'][^>]*>`, "i"),
    new RegExp(`<meta\\b[^>]*name=["']${key}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta\\b[^>]*content=["']([^"']+)["'][^>]*name=["']${key}["'][^>]*>`, "i"),
  ];

  for (const re of patterns) {
    const found = extractFirstMatch(html, re);
    const abs = absolutizeUrl(found, baseUrl);
    if (abs) return abs;
  }
  return "";
}

function extractMetaProperty(html, baseUrl, key) {
  const property = String(key || "").trim();
  if (!property) return "";

  const patterns = [
    new RegExp(`<meta\\b[^>]*property=["']${property}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta\\b[^>]*content=["']([^"']+)["'][^>]*property=["']${property}["'][^>]*>`, "i"),
    new RegExp(`<meta\\b[^>]*name=["']${property}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta\\b[^>]*content=["']([^"']+)["'][^>]*name=["']${property}["'][^>]*>`, "i"),
  ];

  for (const re of patterns) {
    const found = extractFirstMatch(html, re);
    const abs = absolutizeUrl(found, baseUrl);
    if (abs) return abs;
  }

  return "";
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function* walkJson(value) {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const v of value) yield* walkJson(v);
    return;
  }
  if (typeof value === "object") {
    yield value;
    for (const v of Object.values(value)) yield* walkJson(v);
  }
}

function extractSchemaOrgLogo(html, baseUrl) {
  const scriptRe = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;

  while ((m = scriptRe.exec(html)) !== null) {
    const raw = String(m[1] || "").trim();
    const parsed = safeJsonParse(raw);
    if (!parsed) continue;

    for (const obj of walkJson(parsed)) {
      const t = obj["@type"];
      const types = Array.isArray(t) ? t : t ? [t] : [];
      const isOrg = types.some((x) => String(x || "").toLowerCase() === "organization");
      if (!isOrg) continue;

      const logo = obj.logo || obj.image;
      if (typeof logo === "string") {
        const abs = absolutizeUrl(logo, baseUrl);
        if (abs) return abs;
      }
      if (logo && typeof logo === "object") {
        const u = logo.url || logo.contentUrl || logo["@id"];
        const abs = absolutizeUrl(u, baseUrl);
        if (abs) return abs;
      }
    }
  }

  return "";
}

function parseImgAttributes(tag) {
  const attrs = {};
  const attrRe = /(\w[\w:-]*)\s*=\s*(["'])([\s\S]*?)\2/g;
  let m;
  while ((m = attrRe.exec(tag)) !== null) {
    attrs[m[1].toLowerCase()] = m[3];
  }
  return attrs;
}

const LOGO_POSITIVE_TOKENS = ["logo", "wordmark", "logotype", "brand", "mark"];
const LOGO_NEGATIVE_TOKENS = [
  "hero",
  "banner",
  "carousel",
  "slider",
  "slideshow",
  "lifestyle",
  "campaign",
  "collection",
  "product",
  "gallery",
  "lookbook",
  "model",
  "people",
  "person",
  "press",
  "article",
  "blog",
  "story",
  "cover",
  "background",
  // UI icons commonly found as inline SVGs in headers — never company logos
  "cart",
  "basket",
  "bag",
  "search",
  "menu",
  "hamburger",
  "close",
  "arrow",
  "chevron",
  "user",
  "account",
];

function normalizeForTokens(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function hasAnyToken(hay, tokens) {
  const h = normalizeForTokens(hay);
  if (!h) return false;
  return tokens.some((t) => h.includes(normalizeForTokens(t)));
}

function getFileExt(url) {
  const u = String(url || "").toLowerCase().split("?")[0].split("#")[0];
  const m = u.match(/\.([a-z0-9]{2,5})$/);
  return m ? m[1] : "";
}

/**
 * Strip CDN resize/format params so the CDN delivers the original full-resolution image.
 *
 * Handles two cases:
 * 1. Known CDN hosts (Shopify, etc.) — strip width/height/crop/fit params that force thumbnails
 *    e.g. `?crop=center&height=32&width=32` on cdn.shopify.com URLs
 * 2. SVG format override — strip `fm=` param (e.g. imgix fm=webp) on any host
 */
const CDN_RESIZE_PARAMS = ["width", "height", "crop", "w", "h", "fit"];
const CDN_RESIZE_HOSTS = [".shopify.com", ".shopifycdn.net"];

function stripCdnResizeParams(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const isCdnResizeHost = CDN_RESIZE_HOSTS.some(
      (p) => host === p.slice(1) || host.endsWith(p)
    );
    if (isCdnResizeHost) {
      let changed = false;
      for (const p of CDN_RESIZE_PARAMS) {
        if (u.searchParams.has(p)) {
          u.searchParams.delete(p);
          changed = true;
        }
      }
      if (changed) return u.toString();
    }
    // Original SVG fm= stripping for any host
    const ext = getFileExt(url);
    if (ext === "svg" && u.searchParams.has("fm")) {
      u.searchParams.delete("fm");
      return u.toString();
    }
  } catch {}
  return url;
}

function extScore(ext) {
  switch (ext) {
    case "svg":
      return 45;
    case "png":
      return 30;
    case "webp":
      return 12;
    case "jpg":
    case "jpeg":
      return 4;
    case "gif":
      return -10;
    case "ico":
      return -35;
    default:
      return 0;
  }
}

function strongLogoSignal({ url, id = "", cls = "", alt = "" } = {}) {
  const hay = `${id} ${cls} ${alt} ${url}`;
  if (hasAnyToken(hay, ["logo", "wordmark", "logotype"])) return true;
  const ext = getFileExt(url);
  if ((ext === "svg" || ext === "png") && hasAnyToken(hay, ["brand", "mark"])) return true;
  return false;
}

/**
 * Detect when a logo candidate's filename references a brand name that does NOT
 * match the parent company name.  Returns a negative score adjustment (penalty)
 * when the filename contains a capitalized token (likely a brand name) that is
 * absent from companyNameTokens.  Example: "Martex_Logo.png" for "WestPoint Home"
 * → "Martex" is capitalized and not in ["westpoint","home"] → penalty.
 */
function subBrandPenalty(url, companyNameTokens) {
  if (!Array.isArray(companyNameTokens) || companyNameTokens.length === 0) return 0;
  const filename = (url || "").split("/").pop()?.split("?")[0] || "";
  if (!filename) return 0;
  const filenameTokens = filename.replace(/[_\-\.]/g, " ").split(/\s+/).filter((t) => t.length >= 3);
  if (filenameTokens.length === 0) return 0;

  const SKIP = ["logo", "brand", "mark", "icon", "img", "image", "svg", "png", "jpg", "jpeg", "webp"];
  const hasCompanyName = companyNameTokens.some((t) =>
    filenameTokens.some((ft) => ft.toLowerCase() === t.toLowerCase())
  );
  const hasOtherBrand = filenameTokens.some(
    (ft) =>
      /^[A-Z]/.test(ft) &&
      !SKIP.includes(ft.toLowerCase()) &&
      !companyNameTokens.some((t) => ft.toLowerCase() === t.toLowerCase())
  );
  if (hasOtherBrand && !hasCompanyName) return -120;
  return 0;
}

function scoreCandidate({ url, source, id = "", cls = "", alt = "", idx = 0, width = null, height = null }) {
  const hay = `${id} ${cls} ${alt} ${url}`;
  const ext = getFileExt(url);

  let score = 0;

  score += extScore(ext);

  if (hasAnyToken(hay, LOGO_POSITIVE_TOKENS)) score += 90;
  if (hasAnyToken(hay, ["header", "navbar", "nav"])) score += 10;
  // Bonus when the filename itself contains logo-related terms
  const filename = (url.split("/").pop() || "").split("?")[0].toLowerCase();
  if (hasAnyToken(filename, ["logo", "brand", "wordmark"])) score += 40;

  if (hasAnyToken(hay, LOGO_NEGATIVE_TOKENS)) score -= 140;

  if (idx < 5000) score += 14;
  else if (idx < 15000) score += 7;

  const w = Number.isFinite(width) ? width : null;
  const h = Number.isFinite(height) ? height : null;
  if (w != null && w > 1200) score -= 50;
  if (h != null && h > 600) score -= 70;

  if (ext === "ico" && source !== "favicon") score -= 90;

  return score;
}

function collectCandidatesBySelector(html, baseUrl, selector, { allowedHostRoot }) {
  const out = [];
  const lowerSelector = selector.toLowerCase();

  // Try to find image tags that match the selector in ID, class, or src
  const imgRe = /<img\b[^>]*>/gi;
  let m;
  while ((m = imgRe.exec(html)) !== null) {
    const tag = m[0];
    const attrs = parseImgAttributes(tag);
    const src = attrs.src || attrs["data-src"] || attrs["data-lazy-src"] || "";
    const abs = absolutizeUrl(src, baseUrl);
    if (!abs) continue;

    const id = String(attrs.id || "").toLowerCase();
    const cls = String(attrs.class || "").toLowerCase();

    // Check if selector matches ID or class (simple check)
    const matchesSelector =
      id === lowerSelector ||
      id === selector ||
      cls.includes(lowerSelector) ||
      tag.toLowerCase().includes(lowerSelector);

    if (matchesSelector) {
      out.push(
        addLocationMeta(
          {
            url: abs,
            source: "selector",
            page_url: baseUrl,
            score: 500, // High score for manual selector
            strong_signal: true,
          },
          { location: "selector", source: "selector", allowedHostRoot }
        )
      );
    }
  }

  // Also check for background images if selector looks like a class or ID
  if (selector.startsWith(".") || selector.startsWith("#")) {
    const cleanSelector = selector.substring(1).toLowerCase();
    const divRe = /<(div|span|section|header|a)\b[^>]*style=[^>]*background-image:[^>]*>/gi;
    while ((m = divRe.exec(html)) !== null) {
      const tag = m[0];
      const attrs = parseImgAttributes(tag); // parseImgAttributes works for any tag basically
      const id = String(attrs.id || "").toLowerCase();
      const cls = String(attrs.class || "").toLowerCase();

      if (id === cleanSelector || cls.includes(cleanSelector)) {
        const bgMatch = tag.match(/background-image:\s*url\(['"]?([^'")]*)['"]?\)/i);
        if (bgMatch && bgMatch[1]) {
          const abs = absolutizeUrl(bgMatch[1], baseUrl);
          if (abs) {
            out.push(
              addLocationMeta(
                {
                  url: abs,
                  source: "selector_bg",
                  page_url: baseUrl,
                  score: 450,
                  strong_signal: true,
                },
                { location: "selector", source: "selector", allowedHostRoot }
              )
            );
          }
        }
      }
    }
  }

  return out;
}

function collectImgCandidates(html, baseUrl) {
  const imgRe = /<img\b[^>]*>/gi;
  let m;
  const out = [];

  while ((m = imgRe.exec(html)) !== null) {
    const tag = m[0];
    const attrs = parseImgAttributes(tag);
    const src = attrs.src || attrs["data-src"] || attrs["data-lazy-src"] || "";
    let abs = absolutizeUrl(src, baseUrl);
    if (!abs && attrs.srcset) {
      abs = parseSrcsetBestUrl(attrs.srcset, baseUrl);
    }
    if (!abs) continue;

    const id = String(attrs.id || "").toLowerCase();
    const cls = String(attrs.class || "").toLowerCase();
    const alt = String(attrs.alt || "").toLowerCase();

    const idx = m.index || 0;
    const width = attrs.width != null ? Number(attrs.width) : null;
    const height = attrs.height != null ? Number(attrs.height) : null;

    const score = scoreCandidate({ url: abs, source: "img", id, cls, alt, idx, width, height });

    if (!hasAnyToken(`${id} ${cls} ${alt} ${abs}`, LOGO_POSITIVE_TOKENS) && getFileExt(abs) !== "svg") {
      if (score < 30) continue;
    }

    out.push({
      url: abs,
      source: "img",
      page_url: baseUrl,
      score,
      id,
      cls,
      alt,
      idx,
      width: Number.isFinite(width) ? width : null,
      height: Number.isFinite(height) ? height : null,
      strong_signal: strongLogoSignal({ url: abs, id, cls, alt }),
    });
  }

  return out;
}

function extractLikelyLogoImg(html, baseUrl) {
  const candidates = collectImgCandidates(html, baseUrl);
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.url || "";
}

function extractFavicon(html, baseUrl) {
  const linkRe = /<link\b[^>]*>/gi;
  let m;
  const candidates = [];

  while ((m = linkRe.exec(html)) !== null) {
    const tag = m[0];
    const attrs = parseImgAttributes(tag);
    const rel = String(attrs.rel || "").toLowerCase();
    if (!rel.includes("icon")) continue;

    const href = attrs.href || "";
    const abs = absolutizeUrl(href, baseUrl);
    if (!abs) continue;

    let score = 0;
    if (rel.includes("apple-touch-icon")) score += 5;
    if (rel.includes("shortcut")) score += 1;
    candidates.push({ url: abs, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  if (candidates[0]?.url) return candidates[0].url;

  try {
    const u = new URL(baseUrl);
    return `${u.origin}/favicon.ico`;
  } catch {
    return "";
  }
}

function buildHomeUrlCandidates(domain, websiteUrl) {
  const d = normalizeDomain(domain);
  const candidates = [];

  if (websiteUrl) {
    try {
      const u = new URL(websiteUrl.startsWith("http") ? websiteUrl : `https://${websiteUrl}`);
      candidates.push(u.origin);
    } catch {
      // ignore
    }
  }

  if (d) {
    candidates.push(`https://${d}`);
    if (!d.startsWith("www.")) candidates.push(`https://www.${d}`);
  }

  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const key = String(c || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

// User-agent rotation to avoid bot detection on websites that block automated requests
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (compatible; TabarnamBot/1.0; +https://tabarnam.com)",
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function fetchText(url, timeoutMs, retryCount = 0) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Use browser-like user agent first, fall back to bot user agent on retry
    const userAgent = retryCount === 0 ? USER_AGENTS[0] : getRandomUserAgent();
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": userAgent,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
      },
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, url: res.url, text };
  } catch (e) {
    // Retry once with a different user agent if first attempt fails
    if (retryCount === 0) {
      clearTimeout(timeout);
      await sleep(500);
      return fetchText(url, timeoutMs, retryCount + 1);
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function sniffIsSvg(contentType, url, buf) {
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("image/svg+xml")) return true;
  const u = String(url || "").toLowerCase();
  if (u.endsWith(".svg")) return true;

  try {
    const head = Buffer.from(buf).subarray(0, 200).toString("utf8");
    if (head.includes("<svg")) return true;
  } catch {
    // ignore
  }

  return false;
}

async function fetchImageBufferWithRetries(
  url,
  { timeoutMs = 10000, maxBytes = 8 * 1024 * 1024, retries = 2 } = {}
) {
  const u = String(url || "").trim();
  if (!u) throw new Error("missing logo_source_url");

  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Use browser-like user agent, rotating on retries to avoid bot detection
      const userAgent = USER_AGENTS[attempt % USER_AGENTS.length];
      const res = await fetch(u, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          Accept: "image/svg+xml,image/png,image/jpeg,image/webp,image/gif,*/*",
          "User-Agent": userAgent,
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      if (!res.ok) {
        throw new Error(`image fetch failed status=${res.status}`);
      }

      const contentType = res.headers.get("content-type") || "";
      const arrayBuffer = await res.arrayBuffer();
      const buf = Buffer.from(arrayBuffer);

      if (buf.length === 0) throw new Error("empty image response");
      if (buf.length > maxBytes) throw new Error(`image too large (${buf.length} bytes)`);

      return { buf, contentType, finalUrl: res.url };
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        const backoff = 250 * Math.pow(2, attempt);
        await sleep(backoff);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr || "fetch failed"));
}

/**
 * Parse SVG viewBox or explicit width/height attributes to extract dimensions.
 * Fallback for when sharp library fails to extract SVG metadata.
 */
function parseSvgViewBoxDimensions(buf) {
  try {
    const svgText = buf.toString("utf8").slice(0, 4000);

    // Try viewBox first: viewBox="0 0 width height" or viewBox="minX minY width height"
    const viewBoxMatch = svgText.match(/viewBox=["']([^"']+)["']/i);
    if (viewBoxMatch) {
      const parts = viewBoxMatch[1].trim().split(/[\s,]+/).map(Number);
      if (parts.length >= 4) {
        const [, , w, h] = parts;
        if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
          return { width: Math.round(w), height: Math.round(h) };
        }
      }
    }

    // Try explicit width/height attributes (may have units like "px" - extract number only)
    const widthMatch = svgText.match(/\bwidth=["']([0-9.]+)/i);
    const heightMatch = svgText.match(/\bheight=["']([0-9.]+)/i);
    if (widthMatch && heightMatch) {
      const w = parseFloat(widthMatch[1]);
      const h = parseFloat(heightMatch[1]);
      if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
        return { width: Math.round(w), height: Math.round(h) };
      }
    }

    return { width: null, height: null };
  } catch {
    return { width: null, height: null };
  }
}

async function getImageMetadata(buf, isSvg) {
  if (!sharp) {
    // Sharp unavailable - try SVG viewBox fallback
    if (isSvg && buf) {
      const dims = parseSvgViewBoxDimensions(buf);
      if (dims.width && dims.height) return dims;
    }
    return { width: null, height: null };
  }
  try {
    const meta = await sharp(buf, isSvg ? { density: 200 } : undefined).metadata();
    let width = Number.isFinite(meta?.width) ? meta.width : null;
    let height = Number.isFinite(meta?.height) ? meta.height : null;

    // SVG viewBox fallback when sharp returns null dimensions
    if (isSvg && (!width || !height) && buf) {
      const fallback = parseSvgViewBoxDimensions(buf);
      width = width || fallback.width;
      height = height || fallback.height;
    }

    return { width, height };
  } catch {
    // On error, try SVG viewBox fallback
    if (isSvg && buf) {
      return parseSvgViewBoxDimensions(buf);
    }
    return { width: null, height: null };
  }
}

function isLikelyHeroDimensions({ width, height }) {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;

  // Square images (aspect ratio 0.8-1.25) are likely logos, not hero banners
  const aspectRatio = width / height;
  if (aspectRatio >= 0.8 && aspectRatio <= 1.25) return false;

  if (width >= 1600 && height >= 700) return true;
  if (width >= 1200 && height >= 600) return true;
  if (width >= 1000 && height >= 500) return true;
  if (height >= 800) return true;
  return false;
}

function isLikelyNonLogoByContentType(contentType, candidate) {
  const ct = String(contentType || "").toLowerCase();
  if (!ct) return false;
  if (ct.includes("image/jpeg") || ct.includes("image/jpg")) {
    if (candidate?.strong_signal) return false;
    // Case-insensitive check for logo tokens in URL
    const urlLower = String(candidate?.url || "").toLowerCase();
    if (hasAnyToken(urlLower, ["logo", "wordmark", "logotype"])) return false;
    return true;
  }
  return false;
}

function isAllowedLogoExtension(ext) {
  const e = String(ext || "").toLowerCase();
  return e === "png" || e === "jpg" || e === "jpeg" || e === "svg" || e === "webp";
}

function isAllowedLogoContentType(contentType) {
  const ct = String(contentType || "").toLowerCase();
  if (!ct.startsWith("image/")) return false;
  if (ct.includes("image/png")) return true;
  if (ct.includes("image/jpeg") || ct.includes("image/jpg")) return true;
  if (ct.includes("image/svg+xml")) return true;
  if (ct.includes("image/webp")) return true;
  return false;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Detect and resolve SVG sprite `<use href="...">` references.
 *
 * Many modern sites use SVG sprites: the inline `<svg>` is a hollow shell
 * referencing an external .svg file via `<use href="/path/sprite.svg#id">`.
 * When stored standalone (e.g. in blob storage), the relative href breaks,
 * producing a blank image.  This function detects that pattern, fetches the
 * external SVG, extracts the referenced symbol, and returns a self-contained
 * SVG buffer with the real vector content inlined.
 */
async function maybeResolveSvgSpriteReference(svgText, pageUrl, logger, pageHtml = "") {
  // Detect <use href="..." /> or <use xlink:href="..." />
  const useMatch = svgText.match(/<use\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i)
    || svgText.match(/<use\b[^>]*\bxlink:href=["']([^"']+)["'][^>]*>/i);
  if (!useMatch) return { wasSprite: false };

  const hrefRaw = useMatch[1];
  // Split into URL part + fragment ID
  const hashIdx = hrefRaw.indexOf("#");
  const urlPart = hashIdx >= 0 ? hrefRaw.slice(0, hashIdx) : hrefRaw;
  const fragmentId = hashIdx >= 0 ? hrefRaw.slice(hashIdx + 1) : "";

  if (!urlPart) {
    // Pure fragment reference (#id) within the same document.
    // Try to resolve from the full page HTML where <symbol> definitions live.
    if (!fragmentId || !pageHtml) {
      return { wasSprite: true, ok: false, reason: "svg_sprite_internal_ref_only" };
    }

    const internalSymbolRe = new RegExp(
      `<(symbol|svg)\\b[^>]*\\bid=["']${escapeRegExp(fragmentId)}["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
      "i"
    );
    const internalMatch = pageHtml.match(internalSymbolRe);
    if (!internalMatch) {
      return { wasSprite: true, ok: false, reason: "svg_sprite_symbol_not_found_in_page" };
    }

    const internalContent = internalMatch[2];
    let internalViewBox = "";
    const internalVbMatch = internalMatch[0].match(/viewBox=["']([^"']+)["']/i);
    if (internalVbMatch) internalViewBox = internalVbMatch[1];

    if (!internalContent || internalContent.trim().length < 10) {
      return { wasSprite: true, ok: false, reason: "svg_sprite_empty_symbol" };
    }

    if (looksLikeUnsafeSvg(Buffer.from(internalContent, "utf8"))) {
      return { wasSprite: true, ok: false, reason: "svg_sprite_unsafe_internal" };
    }

    // Build self-contained SVG — reuse existing logic from the external sprite path
    const internalSvgOpenMatch = svgText.match(/<svg\b[^>]*>/i);
    let internalResolvedOpen = internalSvgOpenMatch
      ? internalSvgOpenMatch[0]
      : `<svg viewBox="${internalViewBox || "0 0 100 100"}" xmlns="http://www.w3.org/2000/svg">`;

    if (!internalResolvedOpen.includes("xmlns")) {
      internalResolvedOpen = internalResolvedOpen.replace(/<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    // Inject viewBox from symbol if the wrapper SVG doesn't have one
    if (internalViewBox && !internalResolvedOpen.includes("viewBox")) {
      internalResolvedOpen = internalResolvedOpen.replace(/<svg\b/, `<svg viewBox="${internalViewBox}"`);
    }
    internalResolvedOpen = internalResolvedOpen.replace(/\s+class="[^"]*"/gi, "");

    const internalResolvedSvg = `${internalResolvedOpen}\n${internalContent}\n</svg>`;
    const internalResolvedBuf = Buffer.from(internalResolvedSvg, "utf8");

    logger?.info?.(`[logoImport] SVG sprite resolved (internal): #${fragmentId} -> ${internalResolvedBuf.length} bytes`);
    return { wasSprite: true, ok: true, buf: internalResolvedBuf };
  }

  // Resolve to absolute URL using the page origin
  let absoluteUrl;
  try {
    absoluteUrl = new URL(urlPart, pageUrl).toString();
  } catch {
    return { wasSprite: true, ok: false, reason: "svg_sprite_invalid_href" };
  }

  // Fetch the external SVG file
  let externalSvgText;
  try {
    const fetchResult = await fetchImageBufferWithRetries(absoluteUrl, {
      timeoutMs: 3000,
      maxBytes: 2 * 1024 * 1024,
      retries: 0,
    });
    externalSvgText = fetchResult.buf.toString("utf8");
  } catch (e) {
    logger?.warn?.(`[logoImport] SVG sprite fetch failed for ${absoluteUrl}: ${e?.message}`);
    return { wasSprite: true, ok: false, reason: "svg_sprite_fetch_failed" };
  }

  // Validate the external SVG
  if (looksLikeUnsafeSvg(Buffer.from(externalSvgText, "utf8"))) {
    return { wasSprite: true, ok: false, reason: "svg_sprite_unsafe_external" };
  }

  // Extract the symbol/element by fragment ID
  let symbolContent = "";
  let symbolViewBox = "";
  if (fragmentId) {
    // Look for <symbol id="fragmentId"> ... </symbol> or <svg id="fragmentId"> ... </svg>
    const symbolRe = new RegExp(
      `<(symbol|svg)\\b[^>]*\\bid=["']${escapeRegExp(fragmentId)}["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
      "i"
    );
    const symbolMatch = externalSvgText.match(symbolRe);
    if (symbolMatch) {
      symbolContent = symbolMatch[2];
      // Extract viewBox from symbol tag if present
      const vbMatch = symbolMatch[0].match(/viewBox=["']([^"']+)["']/i);
      if (vbMatch) symbolViewBox = vbMatch[1];
    }
  }

  if (!symbolContent) {
    // No matching symbol found — try using the entire external SVG content
    // Strip the outer <svg> wrapper to get inner content
    const innerMatch = externalSvgText.match(/<svg\b[^>]*>([\s\S]*)<\/svg>/i);
    if (innerMatch) {
      symbolContent = innerMatch[1];
    }
  }

  if (!symbolContent || symbolContent.trim().length < 10) {
    return { wasSprite: true, ok: false, reason: "svg_sprite_empty_symbol" };
  }

  // Build resolved SVG: reuse original <svg> attributes, replace <use> with symbol content
  const svgOpenMatch = svgText.match(/<svg\b[^>]*>/i);
  const svgOpen = svgOpenMatch
    ? svgOpenMatch[0]
    : `<svg viewBox="${symbolViewBox || "0 0 100 100"}" xmlns="http://www.w3.org/2000/svg">`;

  // Ensure xmlns is present for standalone SVG
  let resolvedOpen = svgOpen;
  if (!resolvedOpen.includes("xmlns")) {
    resolvedOpen = resolvedOpen.replace(/<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
  }

  // Remove CSS class attributes (Tailwind classes like h-[22px] are meaningless in standalone SVG)
  resolvedOpen = resolvedOpen.replace(/\s+class="[^"]*"/gi, "");

  const resolvedSvg = `${resolvedOpen}\n${symbolContent}\n</svg>`;
  const resolvedBuf = Buffer.from(resolvedSvg, "utf8");

  logger?.info?.(`[logoImport] SVG sprite resolved: ${absoluteUrl}#${fragmentId} → ${resolvedBuf.length} bytes`);

  return { wasSprite: true, ok: true, buf: resolvedBuf };
}

function looksLikeUnsafeSvg(buf) {
  try {
    const head = Buffer.from(buf).subarray(0, 24000).toString("utf8").toLowerCase();
    if (head.includes("<script")) return true;
    if (head.includes("javascript:")) return true;
    if (/\son\w+\s*=/.test(head)) return true; // onload=, onclick=, etc
    return false;
  } catch {
    return true;
  }
}

function isReasonableLogoAspectRatio({ width, height }) {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  if (width <= 0 || height <= 0) return false;
  const ratio = width / height;
  if (ratio < 0.2) return false;
  if (ratio > 5) return false;
  return true;
}

async function headProbeImage(url, { timeoutMs = 6000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Use browser-like user agent to avoid bot detection
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "image/svg+xml,image/png,image/jpeg,image/webp,image/*,*/*",
        "User-Agent": USER_AGENTS[0],
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    const contentType = res.headers.get("content-type") || "";
    const contentLengthRaw = res.headers.get("content-length") || "";
    const contentLength = Number.isFinite(Number(contentLengthRaw)) ? Number(contentLengthRaw) : null;

    return {
      ok: res.ok,
      status: res.status,
      finalUrl: res.url,
      contentType,
      contentLength,
    };
  } catch {
    return { ok: false, status: 0, finalUrl: "", contentType: "", contentLength: null };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAndEvaluateCandidate(candidate, logger = console, options = {}) {
  const sourceUrl = stripCdnResizeParams(String(candidate?.url || "").trim());
  if (!sourceUrl) return { ok: false, reason: "missing_url" };

  const budget = options?.budget;
  if (isBudgetExhausted(budget, { marginMs: 0, minRemainingMs: 800 })) {
    return { ok: false, reason: "budget_exhausted" };
  }

  if (sourceUrl.startsWith("data:")) {
    // Allow inline SVG data URIs from the logo candidate pipeline
    if (candidate?.is_inline_svg && sourceUrl.startsWith("data:image/svg+xml;base64,")) {
      try {
        const b64 = sourceUrl.slice("data:image/svg+xml;base64,".length);
        let buf = Buffer.from(b64, "base64");
        if (looksLikeUnsafeSvg(buf)) return { ok: false, reason: "unsafe_svg" };

        // Detect SVG sprites: <use href="..."> or <use xlink:href="...">
        // Sprite-only SVGs are hollow shells that reference external .svg files;
        // they render blank when served standalone from blob storage.
        const svgText = buf.toString("utf8");
        const resolved = await maybeResolveSvgSpriteReference(svgText, candidate?.page_url, logger, options?.pageHtml || "");
        if (resolved.wasSprite) {
          if (!resolved.ok) return { ok: false, reason: resolved.reason || "svg_sprite_unresolvable" };
          // Reject sprites whose reference URL contains negative tokens (e.g. "ui-icons.svg#accounts-icon").
          // The normal LOGO_NEGATIVE_TOKENS check (line 942) is skipped for inline SVGs (strong_signal=true)
          // and the data: URI source URL doesn't contain readable tokens.
          const spriteRef = (svgText.match(/<use\b[^>]*\bhref=["']([^"']+)["']/i) || [])[1] || "";
          if (spriteRef && hasAnyToken(spriteRef, LOGO_NEGATIVE_TOKENS)
              && !hasAnyToken(spriteRef, LOGO_POSITIVE_TOKENS)) {
            return { ok: false, reason: "svg_sprite_negative_tokens" };
          }
          buf = resolved.buf;
          if (looksLikeUnsafeSvg(buf)) return { ok: false, reason: "unsafe_svg" };
        }

        // Reject SVGs that are clearly UI icons (class="icon icon-*", role="presentation").
        // Shopify themes embed user/cart/search icons as inline SVGs in <header>;
        // these should never be accepted as company logos.
        // Check both original SVG text AND resolved sprite content — sprite resolution
        // strips class attributes (line 820), so we must also inspect the original wrapper.
        const origLower = svgText.toLowerCase();
        const resolvedLower = resolved.wasSprite ? buf.toString("utf8").toLowerCase() : origLower;
        const svgLower = origLower + " " + resolvedLower;
        const isIconSvg = /\bclass="[^"]*\bicon\b[^"]*"/.test(svgLower)
          && !hasAnyToken(svgLower, ["logo", "wordmark", "logotype", "brand"]);
        if (isIconSvg) return { ok: false, reason: "svg_icon_class" };

        let { width, height } = parseSvgViewBoxDimensions(buf);
        if (!Number.isFinite(width) || !Number.isFinite(height)) {
          // Inline SVGs in headers are high-confidence — use declared/viewBox dimensions
          width = candidate?.width || 200;
          height = candidate?.height || 80;
        }
        if (width < 24 || height < 24) return { ok: false, reason: `too_small_dimensions_${width}x${height}` };
        return { ok: true, buf, contentType: "image/svg+xml", finalUrl: candidate?.page_url || "", isSvg: true, width, height };
      } catch (e) {
        return { ok: false, reason: `inline_svg_error_${e?.message || "unknown"}` };
      }
    }
    return { ok: false, reason: "data_url" };
  }

  const allowedHostRoot = String(candidate?.allowed_host_root || "").trim().toLowerCase();
  if (allowedHostRoot && !isAllowedCandidateUrl(sourceUrl, allowedHostRoot)) {
    return { ok: false, reason: "offsite_url" };
  }

  if (hasAnyToken(sourceUrl, LOGO_NEGATIVE_TOKENS) && !candidate?.strong_signal) {
    return { ok: false, reason: "negative_url_tokens" };
  }

  const urlExt = getFileExt(sourceUrl);
  if (urlExt && !isAllowedLogoExtension(urlExt)) {
    return { ok: false, reason: `unsupported_extension_${urlExt}` };
  }

  const headTimeoutMs = computeBudgetedTimeoutMs(budget, 6000, { minMs: 900, marginMs: 400, maxMs: 8000 });
  const head = await headProbeImage(sourceUrl, { timeoutMs: headTimeoutMs });
  const probedType = String(head.contentType || "").toLowerCase();

  if (!head.ok) {
    // Some CDNs block HEAD but serve GET fine — only bail on definitive resource-not-found errors
    const st = head.status || 0;
    if (st === 404 || st === 410) {
      return { ok: false, reason: `head_status_${st}` };
    }
    // For 403, 405, 0 (network error), etc. — skip HEAD validation and fall through to full GET fetch
  }

  if (head.ok) {
    if (allowedHostRoot && head.finalUrl && !isAllowedCandidateUrl(head.finalUrl, allowedHostRoot)) {
      return { ok: false, reason: "offsite_head_redirect" };
    }
    if (!isAllowedLogoContentType(probedType)) return { ok: false, reason: `unsupported_content_type_${probedType || "unknown"}` };
    if (head.contentLength != null && head.contentLength <= 1024) return { ok: false, reason: `too_small_${head.contentLength}_bytes` };
  }

  if (isBudgetExhausted(budget, { marginMs: 0, minRemainingMs: 1200 })) {
    return { ok: false, reason: "budget_exhausted" };
  }

  try {
    const fetchTimeoutMs = computeBudgetedTimeoutMs(budget, 8000, { minMs: 1400, marginMs: 650, maxMs: 12_000 });

    const { buf, contentType, finalUrl } = await fetchImageBufferWithRetries(sourceUrl, {
      retries: 1,
      timeoutMs: fetchTimeoutMs,
      maxBytes: 6 * 1024 * 1024,
    });

    if (!Buffer.isBuffer(buf) || buf.length <= 1024) {
      return { ok: false, reason: `too_small_${buf?.length || 0}_bytes` };
    }

    const resolvedUrl = finalUrl || head.finalUrl || sourceUrl;
    const ct = String(contentType || head.contentType || "").toLowerCase();

    if (allowedHostRoot && resolvedUrl && !isAllowedCandidateUrl(resolvedUrl, allowedHostRoot)) {
      return { ok: false, reason: "offsite_fetch_redirect" };
    }

    if (!isAllowedLogoContentType(ct)) {
      return { ok: false, reason: `unsupported_content_type_${ct || "unknown"}` };
    }

    const isSvg = sniffIsSvg(ct, resolvedUrl, buf);

    if (isSvg) {
      if (looksLikeUnsafeSvg(buf)) return { ok: false, reason: "unsafe_svg" };

      let { width, height } = await getImageMetadata(buf, true);

      // For high-confidence SVG sources, assume reasonable dimensions if extraction failed
      // Header logos with high scores are almost always valid logos
      const isHighConfidence = candidate?.strong_signal ||
        (candidate?.source === "header" && (candidate?.score || 0) > 400) ||
        (sourceUrl && sourceUrl.toLowerCase().includes("/logo"));

      if (!Number.isFinite(width) || !Number.isFinite(height)) {
        if (isHighConfidence) {
          // Default to reasonable logo dimensions for trusted sources
          width = width || 200;
          height = height || 80;
        } else {
          return { ok: false, reason: "unknown_svg_dimensions" };
        }
      }
      // SVG viewBox dimensions are suggestive, not binding — exempt high-confidence
      // candidates (strong_signal, header logos, URLs with "/logo") from the minimum
      // area check while still rejecting tiny icons (max dim < 64).
      if (Math.max(width, height) < 64 || ((width * height) < 2048 && !isHighConfidence)) {
        return { ok: false, reason: `too_small_dimensions_${width}x${height}` };
      }
      if (!isReasonableLogoAspectRatio({ width, height }) && !candidate?.strong_signal) {
        return { ok: false, reason: `unreasonable_aspect_ratio_${width}x${height}` };
      }

      return { ok: true, buf, contentType: ct, finalUrl: resolvedUrl, isSvg, width, height };
    }

    if (isLikelyNonLogoByContentType(ct, candidate)) {
      return { ok: false, reason: "raster_jpeg_weak_signal" };
    }

    const { width, height } = await getImageMetadata(buf, false);

    if (!Number.isFinite(width) || !Number.isFinite(height) || Math.max(width, height) < 64 || (width * height) < 2048) {
      return { ok: false, reason: `too_small_dimensions_${width || "?"}x${height || "?"}` };
    }

    if (!isReasonableLogoAspectRatio({ width, height }) && !candidate?.strong_signal) {
      return { ok: false, reason: `unreasonable_aspect_ratio_${width}x${height}` };
    }

    if (isLikelyHeroDimensions({ width, height }) && !candidate?.strong_signal) {
      return { ok: false, reason: `likely_hero_dimensions_${width}x${height}` };
    }

    return { ok: true, buf, contentType: ct, finalUrl: resolvedUrl, isSvg: false, width, height };
  } catch (e) {
    logger?.warn?.(`[logoImport] candidate fetch/eval failed: ${candidate?.url} ${e?.message || e}`);
    return { ok: false, reason: e?.message || String(e) };
  }
}

function dedupeAndSortCandidates(candidates) {
  const bestByUrl = new Map();

  for (const c of candidates || []) {
    const u = String(c?.url || "").trim();
    if (!u) continue;
    const key = u.toLowerCase();
    const existing = bestByUrl.get(key);
    if (!existing || (Number(c.score) || 0) > (Number(existing.score) || 0)) {
      bestByUrl.set(key, c);
    }
  }

  const out = Array.from(bestByUrl.values());
  out.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  return out;
}

const COMMON_SUBDOMAIN_PREFIXES = ["www", "m", "app", "web", "shop", "store", "en"];

function normalizeHostnameForCompare(hostname) {
  let h = String(hostname || "").trim().toLowerCase();
  if (!h) return "";
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h.startsWith("www.")) h = h.slice(4);
  return h;
}

function deriveAllowedHostRootFromUrl(rawUrl) {
  try {
    const raw = String(rawUrl || "").trim();
    if (!raw) return "";

    const u = raw.includes("://") ? new URL(raw) : new URL(`https://${raw}`);
    const host = normalizeHostnameForCompare(u.hostname);
    if (!host) return "";

    const parts = host.split(".").filter(Boolean);
    if (parts.length >= 3 && COMMON_SUBDOMAIN_PREFIXES.includes(parts[0])) {
      return parts.slice(1).join(".");
    }

    return host;
  } catch {
    return "";
  }
}

function reconcileAllowedHostRoot(a, b) {
  const ah = normalizeHostnameForCompare(a);
  const bh = normalizeHostnameForCompare(b);
  if (!ah) return bh;
  if (!bh) return ah;
  if (ah === bh) return ah;

  // Prefer the shorter root when one is a subdomain of the other.
  if (ah.endsWith(`.${bh}`)) return bh;
  if (bh.endsWith(`.${ah}`)) return ah;

  return ah;
}

function isHostnameAllowed(hostname, allowedHostRoot) {
  const host = normalizeHostnameForCompare(hostname);
  const root = normalizeHostnameForCompare(allowedHostRoot);
  if (!host || !root) return false;
  return host === root || host.endsWith(`.${root}`);
}

function isAllowedOnSiteUrl(rawUrl, allowedHostRoot) {
  try {
    const u = new URL(String(rawUrl || "").trim());
    return isHostnameAllowed(u.hostname, allowedHostRoot);
  } catch {
    return false;
  }
}

// Well-known CDN/DAM/hosting platforms used for static assets including logos.
const KNOWN_CDN_HOST_PATTERNS = [
  // DAM / asset management
  ".widen.net",
  ".imgix.net",
  ".cloudinary.com",
  ".contentful.com",
  ".prismic.io",
  ".sanity.io",
  ".storyblok.com",
  ".datocms-assets.com",
  // E-commerce / website builder CDNs
  ".shopify.com",
  ".squarespace-cdn.com",
  ".wixstatic.com",
  ".bigcommerce.com",
  // Cloud CDNs
  ".cloudfront.net",
  ".amazonaws.com",
  ".azureedge.net",
  ".akamaized.net",
  ".akamaihd.net",
  ".fastly.net",
  // Other common image CDNs
  ".wp.com",
  ".ctfassets.net",
  ".githubusercontent.com",
  ".twimg.com",
];

function isKnownCdnHost(hostname) {
  const h = String(hostname || "").trim().toLowerCase();
  if (!h) return false;
  return KNOWN_CDN_HOST_PATTERNS.some((pattern) => h === pattern.slice(1) || h.endsWith(pattern));
}

function isAllowedCandidateUrl(rawUrl, allowedHostRoot) {
  if (isAllowedOnSiteUrl(rawUrl, allowedHostRoot)) return true;

  try {
    const u = new URL(String(rawUrl || "").trim());
    if (isKnownCdnHost(u.hostname)) return true;
  } catch {
    // fall through
  }

  return false;
}

function extractTagInnerBlocks(html, tagName, { maxBlocks = 6 } = {}) {
  const h = String(html || "");
  const tag = String(tagName || "").trim();
  if (!h || !tag) return [];

  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const blocks = [];
  let m;
  while ((m = re.exec(h)) !== null) {
    blocks.push(String(m[1] || ""));
    if (blocks.length >= maxBlocks) break;
  }
  return blocks;
}

function buildCompanyNameTokens(companyName) {
  const norm = normalizeForTokens(companyName);
  if (!norm) return [];
  return norm
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .slice(0, 4);
}

const FOOTER_REJECT_TOKENS = [
  "payment",
  "payments",
  "visa",
  "mastercard",
  "amex",
  "paypal",
  "klarna",
  "afterpay",
  "affirm",
  "stripe",
  "shopify",
  "trust",
  "badge",
  "badges",
  "secure",
  "ssl",
];

function addLocationMeta(candidate, { location, source, allowedHostRoot }) {
  return {
    ...candidate,
    source: source || candidate.source,
    location: location || candidate.location || null,
    allowed_host_root: allowedHostRoot || candidate.allowed_host_root || "",
    logo_source_domain: allowedHostRoot || candidate.logo_source_domain || "",
  };
}

function collectHeaderNavImgCandidates(html, baseUrl, { companyNameTokens, allowedHostRoot } = {}) {
  const blocks = [...extractTagInnerBlocks(html, "header"), ...extractTagInnerBlocks(html, "nav")];
  const out = [];

  for (const block of blocks) {
    const list = collectImgCandidates(block, baseUrl);
    for (const c of list) {
      const hay = `${c.id || ""} ${c.cls || ""} ${c.alt || ""} ${c.url || ""}`;

      let boost = 240;
      if (hasAnyToken(hay, ["site logo", "header logo"])) boost += 80;
      if (hasAnyToken(hay, ["logo", "brand"])) boost += 60;
      if (hasAnyToken(c.alt || "", ["logo"])) boost += 35;
      if (Array.isArray(companyNameTokens) && companyNameTokens.some((t) => hasAnyToken(c.alt || "", [t]))) boost += 70;
      boost += subBrandPenalty(c.url, companyNameTokens);

      out.push(
        addLocationMeta(
          {
            ...c,
            source: "header",
            score: (Number(c.score) || 0) + boost,
            strong_signal: Boolean(c.strong_signal || hasAnyToken(hay, ["logo", "wordmark", "logotype"])),
          },
          { location: "header", source: "header", allowedHostRoot }
        )
      );
    }
  }

  return out;
}

/**
 * Extract inline <svg> elements from <header>/<nav> blocks as logo candidates.
 * Many modern brands (especially Shopify stores) embed their logo as an inline SVG
 * rather than an <img> tag. This function discovers those by parsing the SVG content,
 * filtering out tiny decorative icons, and returning data-URI candidates.
 */
function collectInlineSvgCandidates(html, baseUrl, { companyNameTokens, allowedHostRoot } = {}) {
  const blocks = [...extractTagInnerBlocks(html, "header"), ...extractTagInnerBlocks(html, "nav")];
  const out = [];

  for (const block of blocks) {
    const svgRe = /<svg\b[^>]*>[\s\S]*?<\/svg>/gi;
    let m;
    while ((m = svgRe.exec(block)) !== null) {
      const svgTag = m[0];
      // Skip tiny decorative SVGs (chevrons, arrows, hamburger icons)
      const widthMatch = svgTag.match(/\bwidth=["']?([0-9.]+)/i);
      const heightMatch = svgTag.match(/\bheight=["']?([0-9.]+)/i);
      const w = widthMatch ? parseFloat(widthMatch[1]) : null;
      const h = heightMatch ? parseFloat(heightMatch[1]) : null;

      // Skip if dimensions indicate a tiny icon (both under 24px)
      if (w != null && h != null && w < 24 && h < 24) continue;

      // Also check viewBox for dimensions if explicit w/h missing
      const viewBoxMatch = svgTag.match(/viewBox=["']([^"']+)["']/i);
      let vbW = null, vbH = null;
      if (viewBoxMatch) {
        const parts = viewBoxMatch[1].trim().split(/[\s,]+/).map(Number);
        if (parts.length === 4) { vbW = parts[2]; vbH = parts[3]; }
      }
      const effectiveW = w || vbW;
      const effectiveH = h || vbH;
      if (effectiveW != null && effectiveH != null && effectiveW < 24 && effectiveH < 24) continue;

      // Build a data URI from the SVG content
      const svgBuf = Buffer.from(svgTag, "utf8");
      const dataUri = `data:image/svg+xml;base64,${svgBuf.toString("base64")}`;

      // Score: inline SVGs in the header with logo-like dimensions are high-confidence
      const hay = svgTag.toLowerCase();
      let score = 180 + 45; // header base + SVG ext bonus
      const hasLogoSignal = hasAnyToken(hay, ["logo", "wordmark", "logotype", "brand"]);
      if (hasLogoSignal) score += 80;
      // Penalize hollow SVG sprite references — but only if they lack logo-like signals.
      // Sprites like <use href="#icon--logo"> should not be penalized since we can now
      // resolve internal fragment references from the page HTML.
      if (/<use\b[^>]*\bhref=["']|<use\b[^>]*\bxlink:href=["']/i.test(svgTag)) {
        if (!hasLogoSignal) score -= 120;
      }
      // Penalize SVGs with icon-like class/role attributes — never company logos.
      // Shopify themes embed user/cart/search icons as inline SVGs in <header>;
      // without this penalty they score 225 (header base + SVG bonus) and beat
      // the minimum acceptance threshold.
      const hasIconSignal = hasAnyToken(hay, ["icon-user", "icon-cart", "icon-bag", "icon-search", "icon-menu", "icon-account", "icon-close", "icon-arrow"])
        || /\brole=["']presentation["']/.test(hay)
        || /\baria-hidden=["']true["']/.test(hay);
      if (hasIconSignal && !hasLogoSignal) score -= 200;
      // Wide-and-short aspect ratio typical of wordmarks
      if (effectiveW && effectiveH && effectiveW / effectiveH > 2) score += 40;

      out.push(
        addLocationMeta(
          {
            url: dataUri,
            source: "header",
            page_url: baseUrl,
            score,
            strong_signal: true,
            is_inline_svg: true,
            width: effectiveW ? Math.round(effectiveW) : null,
            height: effectiveH ? Math.round(effectiveH) : null,
          },
          { location: "header", source: "header", allowedHostRoot }
        )
      );
    }
  }
  return out;
}

/**
 * Detect logo images wrapped in homepage links (<a href="/"><img ...></a>).
 * This is one of the most common patterns for company logos — the logo is an
 * anchor linking back to the homepage. Boost these candidates significantly.
 */
function collectHomepageLinkImgCandidates(html, baseUrl, { companyNameTokens, allowedHostRoot } = {}) {
  const out = [];
  // Match <a> tags that link to "/" or the site root (with optional trailing slash)
  // and contain <img> tags within them.
  let siteOrigin = "";
  try { siteOrigin = new URL(baseUrl).origin; } catch {}
  const homePaths = ["/", `${siteOrigin}/`, `${siteOrigin}`];
  if (siteOrigin) {
    try {
      const u = new URL(siteOrigin);
      const wwwVariant = u.hostname.startsWith("www.")
        ? `${u.protocol}//${u.hostname.replace(/^www\./, "")}`
        : `${u.protocol}//www.${u.hostname}`;
      homePaths.push(`${wwwVariant}/`, wwwVariant);
    } catch {}
  }

  // Find all <a>...</a> blocks that contain an <img>
  const aRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let am;
  while ((am = aRe.exec(html)) !== null) {
    const aAttrs = parseImgAttributes(`<a ${am[1]}>`);
    const href = String(aAttrs.href || "").trim();
    if (!href) continue;

    // Check if this link points to the homepage
    const isHomeLink = homePaths.some((hp) => {
      if (!hp) return false;
      const hpNorm = hp.replace(/\/+$/, "").toLowerCase();
      const hrefNorm = href.replace(/\/+$/, "").toLowerCase();
      return hrefNorm === hpNorm || hrefNorm === "/" || hrefNorm === "";
    });
    if (!isHomeLink) continue;

    // Extract <img> tags from within this <a> block
    const innerHtml = am[2] || "";
    const imgCandidates = collectImgCandidates(innerHtml, baseUrl);
    for (const c of imgCandidates) {
      const hay = `${c.id || ""} ${c.cls || ""} ${c.alt || ""} ${c.url || ""}`;

      // Homepage-link images get a strong boost — this is a classic logo pattern
      let boost = 280;
      if (hasAnyToken(hay, ["logo", "brand", "wordmark"])) boost += 60;
      if (Array.isArray(companyNameTokens) && companyNameTokens.some((t) => hasAnyToken(c.alt || "", [t]))) boost += 80;
      boost += subBrandPenalty(c.url, companyNameTokens);

      out.push(
        addLocationMeta(
          {
            ...c,
            source: "homepage_link",
            score: (Number(c.score) || 0) + boost,
            strong_signal: true, // Homepage-link images are strong logo signals
          },
          { location: "homepage_link", source: "homepage_link", allowedHostRoot }
        )
      );
    }
  }

  return out;
}

function collectFooterImgCandidates(html, baseUrl, { companyNameTokens, allowedHostRoot } = {}) {
  const blocks = extractTagInnerBlocks(html, "footer");
  const out = [];

  for (const block of blocks) {
    const list = collectImgCandidates(block, baseUrl);
    for (const c of list) {
      const hay = `${c.id || ""} ${c.cls || ""} ${c.alt || ""} ${c.url || ""}`;

      if (hasAnyToken(hay, FOOTER_REJECT_TOKENS)) continue;

      const hasBrandSignal =
        Boolean(c.strong_signal) ||
        hasAnyToken(hay, ["logo", "wordmark", "logotype", "brand"]) ||
        (Array.isArray(companyNameTokens) && companyNameTokens.some((t) => hasAnyToken(hay, [t])));

      if (!hasBrandSignal) continue;

      const boost = 90 + subBrandPenalty(c.url, companyNameTokens);

      out.push(
        addLocationMeta(
          {
            ...c,
            source: "footer",
            score: (Number(c.score) || 0) + boost,
            strong_signal: true,
          },
          { location: "footer", source: "footer", allowedHostRoot }
        )
      );
    }
  }

  return out;
}

function collectIconLinkCandidates(html, baseUrl, { allowedHostRoot } = {}) {
  const linkRe = /<link\b[^>]*>/gi;
  let m;
  const out = [];

  while ((m = linkRe.exec(html)) !== null) {
    const tag = m[0];
    const attrs = parseImgAttributes(tag);
    const rel = String(attrs.rel || "").toLowerCase();
    if (!rel.includes("icon")) continue;

    const href = attrs.href || "";
    const abs = absolutizeUrl(href, baseUrl);
    if (!abs) continue;

    const ext = getFileExt(abs);
    const isIco = ext === "ico";

    let score = 160 + extScore(ext);
    if (rel.includes("apple-touch-icon")) score += 15;
    if (rel.includes("mask-icon")) score += 10;
    if (rel.includes("shortcut")) score += 2;
    if (isIco) score -= 80;

    out.push(
      addLocationMeta(
        {
          url: abs,
          source: "icon",
          page_url: baseUrl,
          score,
          strong_signal: !isIco,
        },
        { location: "icon", source: "icon", allowedHostRoot }
      )
    );
  }

  if (out.length === 0) {
    try {
      const u = new URL(baseUrl);
      const fallback = `${u.origin}/favicon.ico`;
      out.push(
        addLocationMeta(
          {
            url: fallback,
            source: "icon",
            page_url: baseUrl,
            score: 20 + extScore(getFileExt(fallback)) - 120,
            strong_signal: false,
          },
          { location: "icon", source: "icon", allowedHostRoot }
        )
      );
    } catch {
      // ignore
    }
  }

  return out;
}

function filterOnSiteCandidates(candidates, allowedHostRoot) {
  const root = normalizeHostnameForCompare(allowedHostRoot);
  if (!root) return [];
  const out = [];
  for (const c of (Array.isArray(candidates) ? candidates : [])) {
    // Inline SVGs are extracted from the page itself — no host check needed
    if (c?.is_inline_svg) {
      out.push(c);
    } else if (isAllowedOnSiteUrl(c?.url, root)) {
      out.push(c);
    } else if (c?.strong_signal && isAllowedCandidateUrl(c?.url, root)) {
      // CDN-hosted logos with strong signal allowed; slight penalty to prefer on-site equivalents
      out.push({ ...c, score: (Number(c.score) || 0) - 15 });
    }
  }
  return out;
}

function collectLogoCandidatesFromHtml(html, baseUrl, options = {}) {
  const companyNameTokens = buildCompanyNameTokens(options?.companyName || "");
  const selector = String(options?.selector || "").trim();

  const allowedFromOptions = String(options?.allowedHostRoot || options?.allowed_host_root || "").trim();
  const allowedFromBase = deriveAllowedHostRootFromUrl(baseUrl);
  const allowedHostRoot = reconcileAllowedHostRoot(allowedFromOptions, allowedFromBase);

  const metaCandidates = [];

  // If selector is provided, look for it first
  if (selector) {
    const selectorCandidates = collectCandidatesBySelector(html, baseUrl, selector, { allowedHostRoot });
    if (selectorCandidates.length > 0) {
      metaCandidates.push(...selectorCandidates);
    }
  }

  const schemaLogo = extractSchemaOrgLogo(html, baseUrl);
  if (schemaLogo) {
    metaCandidates.push(
      addLocationMeta(
        {
          url: schemaLogo,
          source: "jsonld",
          page_url: baseUrl,
          score: 240 + extScore(getFileExt(schemaLogo)) + (hasAnyToken(schemaLogo, LOGO_POSITIVE_TOKENS) ? 40 : 0),
          strong_signal: true,
        },
        { location: "jsonld", source: "jsonld", allowedHostRoot }
      )
    );
  }

  const ogLogo = extractMetaProperty(html, baseUrl, "og:logo");
  if (ogLogo) {
    metaCandidates.push(
      addLocationMeta(
        {
          url: ogLogo,
          source: "og_logo",
          page_url: baseUrl,
          score: 220 + extScore(getFileExt(ogLogo)) + (hasAnyToken(ogLogo, LOGO_POSITIVE_TOKENS) ? 30 : 0),
          strong_signal: hasAnyToken(ogLogo, LOGO_POSITIVE_TOKENS),
        },
        { location: "meta", source: "og_logo", allowedHostRoot }
      )
    );
  }

  const ogImage = extractMetaProperty(html, baseUrl, "og:image") || extractMetaImage(html, baseUrl, "og");
  if (ogImage) {
    metaCandidates.push(
      addLocationMeta(
        {
          url: ogImage,
          source: "og_image",
          page_url: baseUrl,
          score: 140 + extScore(getFileExt(ogImage)) + (hasAnyToken(ogImage, LOGO_POSITIVE_TOKENS) ? 20 : 0),
          strong_signal: hasAnyToken(ogImage, LOGO_POSITIVE_TOKENS),
        },
        { location: "meta", source: "og_image", allowedHostRoot }
      )
    );
  }

  const twitterImage = extractMetaProperty(html, baseUrl, "twitter:image") || extractMetaImage(html, baseUrl, "twitter");
  if (twitterImage) {
    metaCandidates.push(
      addLocationMeta(
        {
          url: twitterImage,
          source: "twitter_image",
          page_url: baseUrl,
          score: 120 + extScore(getFileExt(twitterImage)) + (hasAnyToken(twitterImage, LOGO_POSITIVE_TOKENS) ? 20 : 0),
          strong_signal: hasAnyToken(twitterImage, LOGO_POSITIVE_TOKENS),
        },
        { location: "meta", source: "twitter_image", allowedHostRoot }
      )
    );
  }

  const inlineSvgCandidates = collectInlineSvgCandidates(html, baseUrl, { companyNameTokens, allowedHostRoot });
  const headerCandidates = collectHeaderNavImgCandidates(html, baseUrl, { companyNameTokens, allowedHostRoot });
  const homepageLinkCandidates = collectHomepageLinkImgCandidates(html, baseUrl, { companyNameTokens, allowedHostRoot });
  const iconCandidates = collectIconLinkCandidates(html, baseUrl, { allowedHostRoot });
  const footerCandidates = collectFooterImgCandidates(html, baseUrl, { companyNameTokens, allowedHostRoot });

  const all = [...metaCandidates, ...inlineSvgCandidates, ...headerCandidates, ...homepageLinkCandidates, ...iconCandidates, ...footerCandidates];
  const onSite = filterOnSiteCandidates(all, allowedHostRoot);
  return dedupeAndSortCandidates(onSite);
}

async function discoverLogoCandidates({ domain, websiteUrl, companyName, selector }, logger = console, options = {}) {
  const d = normalizeDomain(domain);
  const homes = buildHomeUrlCandidates(d, websiteUrl);

  const budget = options?.budget;
  let lastError = "";

  for (const home of homes) {
    if (isBudgetExhausted(budget, { marginMs: 0, minRemainingMs: 1200 })) {
      lastError = "time_budget_exhausted";
      break;
    }

    try {
      const timeoutMs = computeBudgetedTimeoutMs(budget, 8000, { minMs: 1200, marginMs: 650, maxMs: 10_000 });
      const { ok, status, url: finalUrl, text } = await fetchText(home, timeoutMs);
      if (!ok || !text) {
        lastError = `homepage fetch failed status=${status}`;
        continue;
      }

      const baseUrl = finalUrl || home;
      const allowedFromWebsite = deriveAllowedHostRootFromUrl(websiteUrl);
      const allowedFromBase = deriveAllowedHostRootFromUrl(baseUrl);
      const allowedHostRoot = reconcileAllowedHostRoot(allowedFromWebsite || d, allowedFromBase);

      const candidates = collectLogoCandidatesFromHtml(text, baseUrl, {
        companyName,
        allowedHostRoot,
        selector,
      });

      if (candidates.length > 0) {
        return { ok: true, candidates, page_url: baseUrl, allowed_host_root: allowedHostRoot, warning: "", page_html: text };
      }

      lastError = "no_on_site_candidates";
    } catch (e) {
      lastError = e?.message || String(e);
      logger?.warn?.(`[logoImport] discover failed for ${home}: ${lastError}`);
    }
  }

  return { ok: false, candidates: [], page_url: "", allowed_host_root: d || "", error: lastError || "missing domain" };
}

async function discoverLogoSourceUrl({ domain, websiteUrl, companyName, selector }, logger = console, options = {}) {
  const d = normalizeDomain(domain);
  const budget = options?.budget || createTimeBudget(options?.budgetMs, { defaultMs: 12_000, maxMs: 20_000 });

  const discovered = await discoverLogoCandidates({ domain: d, websiteUrl, companyName, selector }, logger, { budget });
  const pageHtml = discovered?.page_html || "";
  const candidates = dedupeAndSortCandidates(discovered?.candidates || []);
  candidates.sort(sortCandidatesStrict);

  const maxToTry = 8;
  for (let i = 0; i < Math.min(maxToTry, candidates.length); i += 1) {
    if (isBudgetExhausted(budget, { marginMs: 0, minRemainingMs: 1200 })) {
      break;
    }

    const candidate = candidates[i];
    const evalResult = await fetchAndEvaluateCandidate(candidate, logger, { budget, pageHtml });
    if (evalResult.ok) {
      return {
        ok: true,
        logo_source_url: evalResult.finalUrl || candidate.url,
        logo_source_location: candidate.location || null,
        logo_source_domain: candidate.logo_source_domain || discovered?.allowed_host_root || null,
        strategy: candidate.source || "unknown",
        page_url: candidate.page_url || discovered?.page_url || "",
        warning: "",
      };
    }
  }

  const err = String(discovered?.error || "no suitable logo found") || "no suitable logo found";

  return {
    ok: false,
    logo_source_url: "",
    logo_source_location: null,
    logo_source_domain: discovered?.allowed_host_root || null,
    strategy: "",
    page_url: "",
    error: err,
  };
}

async function rasterizeToPng(buf, { maxSize = 500, isSvg = false } = {}) {
  if (!sharp) {
    throw new Error("Image processing unavailable (sharp module not loaded)");
  }
  try {
    let pipeline = sharp(buf, isSvg ? { density: 300 } : undefined);
    pipeline = pipeline.resize({ width: maxSize, height: maxSize, fit: "inside", withoutEnlargement: true });

    // By default Sharp strips metadata unless withMetadata() is explicitly used.
    return await pipeline.png({ quality: 90 }).toBuffer();
  } catch (e) {
    const msg = e?.message || String(e);
    // Include sharp unavailable in the error message for better diagnostics
    if (!sharp || msg.includes("undefined is not a function")) {
      throw new Error(`Image processing unavailable: ${msg}`);
    }
    throw new Error(`image processing failed: ${msg}`);
  }
}

async function uploadBufferToBlob({ companyId, buffer, ext, contentType }, logger = console) {
  const { accountName, accountKey } = getStorageCredentials();
  if (!accountName || !accountKey) {
    throw new Error("storage not configured");
  }

  const safeExt = String(ext || "").replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";

  const credentials = new StorageSharedKeyCredential(accountName, accountKey);
  const blobServiceClient = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, credentials);

  const containerName = "company-logos";
  const containerClient = blobServiceClient.getContainerClient(containerName);

  try {
    const exists = await containerClient.exists();
    if (!exists) {
      await containerClient.create();
    }
  } catch (e) {
    logger?.warn?.(`[logoImport] container create/exists failed: ${e?.message || e}`);
  }

  const blobName = `${companyId}/logo.${safeExt}`;
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  await blockBlobClient.upload(buffer, buffer.length, {
    blobHTTPHeaders: { blobContentType: contentType || "application/octet-stream" },
  });

  // Return a SAS URL with long-lived read-only access.  The storage account has
  // public blob access disabled, so bare URLs 403.  A 10-year SAS avoids that.
  const sasToken = generateBlobSASQueryParameters(
    {
      containerName,
      blobName,
      permissions: BlobSASPermissions.parse("r"),
      expiresOn: new Date(Date.now() + 10 * 365.25 * 24 * 60 * 60 * 1000),
    },
    credentials,
  ).toString();
  return `${blockBlobClient.url}?${sasToken}`;
}

function getStorageCredentials() {
  const accountName = env("AZURE_STORAGE_ACCOUNT_NAME", "");
  const accountKey = env("AZURE_STORAGE_ACCOUNT_KEY", "");
  return { accountName, accountKey };
}

async function uploadPngToBlob({ companyId, pngBuffer }, logger = console) {
  return uploadBufferToBlob({ companyId, buffer: pngBuffer, ext: "png", contentType: "image/png" }, logger);
}

async function uploadSvgToBlob({ companyId, svgBuffer }, logger = console) {
  return uploadBufferToBlob({ companyId, buffer: svgBuffer, ext: "svg", contentType: "image/svg+xml" }, logger);
}

function candidateSourceRank(source) {
  switch (String(source || "").toLowerCase()) {
    case "jsonld":
      return 8;
    case "homepage_link":
      return 9;
    case "header":
      return 10;
    case "og_logo":
      return 12;
    case "og_image":
      return 14;
    case "twitter_image":
      return 16;
    case "icon":
    case "favicon":
      return 20;
    case "footer":
      return 30;
    case "provided":
      return 40;
    default:
      return 70;
  }
}

function isIcoUrl(url) {
  return getFileExt(url) === "ico";
}

function toLogoSourceType(source) {
  const s = String(source || "").toLowerCase();
  if (s === "header" || s === "icon" || s === "footer" || s === "favicon" || s === "img" || s === "schema.org") {
    return "website";
  }
  if (s === "provided") return "provided";
  return s || "unknown";
}

function sortCandidatesStrict(a, b) {
  const ar = candidateSourceRank(a?.source);
  const br = candidateSourceRank(b?.source);
  if (ar !== br) return ar - br;

  const aIco = isIcoUrl(a?.url);
  const bIco = isIcoUrl(b?.url);
  if (aIco !== bIco) return aIco ? 1 : -1;

  return (Number(b?.score) || 0) - (Number(a?.score) || 0);
}

async function importCompanyLogo({ companyId, domain, websiteUrl, companyName, logoSourceUrl }, logger = console, options = {}) {
  // Early exit if sharp is unavailable
  if (!sharp) {
    logger?.warn?.(`[logoImport] Sharp module unavailable (${sharpLoadError}). Skipping logo processing.`);
    return {
      ok: true, // Logo processing is skipped, but import continues
      logo_status: "skipped",
      logo_import_status: "skipped",
      logo_stage_status: "skipped",
      logo_error: `Sharp module unavailable: ${sharpLoadError}`,
      logo_last_error: { code: "SHARP_UNAVAILABLE", message: sharpLoadError },
      logo_source_url: logoSourceUrl || null,
      logo_source_type: logoSourceUrl ? "provided" : null,
      logo_url: null,
      logo_telemetry: {
        budget_ms: 0,
        elapsed_ms: 0,
        discovery_ok: false,
        discovery_page_url: "",
        allowed_host_root: "",
        candidates_total: 0,
        candidates_tried: 0,
        tiers: [],
        rejection_reasons: { sharp_unavailable: 1 },
        time_budget_exhausted: false,
      },
    };
  }

  const budget = options?.budget || createTimeBudget(options?.budgetMs, { defaultMs: 15_000, maxMs: 20_000 });

  const telemetry = {
    budget_ms: budget.budget_ms,
    elapsed_ms: 0,
    discovery_ok: null,
    discovery_page_url: "",
    allowed_host_root: "",
    candidates_total: 0,
    candidates_tried: 0,
    tiers: [],
    rejection_reasons: {},
    time_budget_exhausted: false,
  };

  const finalizeTelemetry = () => {
    try {
      telemetry.elapsed_ms = budget.elapsed_ms();
    } catch {
      telemetry.elapsed_ms = telemetry.elapsed_ms || 0;
    }
    return telemetry;
  };

  const bumpReason = (reason) => {
    const key = String(reason || "unknown").slice(0, 120);
    telemetry.rejection_reasons[key] = (telemetry.rejection_reasons[key] || 0) + 1;
  };

  if (!companyId) {
    return {
      ok: false,
      logo_status: "error",
      logo_import_status: "failed",
      logo_stage_status: "invalid_input",
      logo_error: "missing companyId",
      logo_source_url: logoSourceUrl || null,
      logo_source_type: logoSourceUrl ? "provided" : null,
      logo_url: null,
      logo_telemetry: finalizeTelemetry(),
    };
  }

  const normalizedDomain = normalizeDomain(domain);
  const siteUrl = String(websiteUrl || "").trim();

  if ((!normalizedDomain || normalizedDomain === "unknown") && !siteUrl) {
    return {
      ok: true,
      logo_status: "not_found_on_site",
      logo_import_status: "missing",
      logo_stage_status: "missing_domain",
      logo_error: "missing domain",
      logo_source_url: null,
      logo_source_location: null,
      logo_source_domain: null,
      logo_source_type: null,
      logo_url: null,
      logo_discovery_strategy: "",
      logo_discovery_page_url: "",
      logo_telemetry: finalizeTelemetry(),
    };
  }

  const allCandidates = [];

  if (logoSourceUrl) {
    const providedUrl = String(logoSourceUrl).trim();
    if (providedUrl) {
      allCandidates.push({
        url: providedUrl,
        source: "provided",
        page_url: "",
        score: 500 + extScore(getFileExt(providedUrl)) + (hasAnyToken(providedUrl, LOGO_POSITIVE_TOKENS) ? 80 : 0),
        strong_signal: strongLogoSignal({ url: providedUrl }),
      });
    }
  }

  let discovered = { ok: false, candidates: [], page_url: "", allowed_host_root: normalizedDomain || "", error: "" };

  if (!isBudgetExhausted(budget, { minRemainingMs: 1200 })) {
    discovered = await discoverLogoCandidates(
      { domain: normalizedDomain || domain, websiteUrl: siteUrl, companyName },
      logger,
      { budget }
    );
  } else {
    discovered = { ok: false, candidates: [], page_url: "", allowed_host_root: normalizedDomain || "", error: "time_budget_exhausted" };
    telemetry.time_budget_exhausted = true;
  }

  const pageHtml = discovered?.page_html || "";
  telemetry.discovery_ok = Boolean(discovered?.ok);
  telemetry.discovery_page_url = String(discovered?.page_url || "");
  telemetry.allowed_host_root = String(discovered?.allowed_host_root || "");

  allCandidates.push(...(Array.isArray(discovered?.candidates) ? discovered.candidates : []));

  const deduped = dedupeAndSortCandidates(allCandidates);
  telemetry.candidates_total = deduped.length;

  const tierOrder = ["provided", "jsonld", "header", "homepage_link", "og_logo", "og_image", "twitter_image", "icon", "footer", "img"];
  const tierMax = {
    provided: 2,
    jsonld: 3,
    header: 5,
    homepage_link: 4,
    og_logo: 2,
    og_image: 2,
    twitter_image: 2,
    icon: 4,
    footer: 3,
    img: 2,
  };

  const buildTierList = (tier) => {
    const list = deduped.filter((c) => String(c?.source || "").toLowerCase() === tier);
    list.sort((a, b) => {
      const diff = (Number(b?.score) || 0) - (Number(a?.score) || 0);
      if (diff) return diff;
      return String(a?.url || "").localeCompare(String(b?.url || ""));
    });
    return list;
  };

  let lastReason = "";

  for (const tier of tierOrder) {
    if (isBudgetExhausted(budget, { minRemainingMs: 1200 })) {
      telemetry.time_budget_exhausted = true;
      break;
    }

    const tierCandidates = buildTierList(tier);
    if (tierCandidates.length === 0) continue;

    const limit = Math.min(tierCandidates.length, Number(tierMax[tier] || 2));

    const tierTelemetry = {
      tier,
      attempted: 0,
      rejected: 0,
      ok: false,
      selected_url: "",
      selected_content_type: "",
      reasons: {},
      attempted_samples: [],
    };

    for (let i = 0; i < limit; i += 1) {
      const candidate = tierCandidates[i];

      if (isBudgetExhausted(budget, { minRemainingMs: 1200 })) {
        telemetry.time_budget_exhausted = true;
        break;
      }

      tierTelemetry.attempted += 1;
      telemetry.candidates_tried += 1;

      if (tierTelemetry.attempted_samples.length < 2) {
        tierTelemetry.attempted_samples.push(String(candidate?.url || ""));
      }

      try {
        logger?.log?.("logo_candidate_found", {
          company_id: companyId,
          candidate_url: candidate?.url || "",
          candidate_source: candidate?.source || "",
          candidate_score: Number(candidate?.score) || 0,
          attempt: telemetry.candidates_tried,
          tier,
          remaining_ms: typeof budget.remaining_ms === "function" ? budget.remaining_ms(0) : null,
        });
      } catch {
        // ignore
      }

      const evalResult = await fetchAndEvaluateCandidate(candidate, logger, { budget, pageHtml });

      if (!evalResult.ok) {
        const reason = String(evalResult.reason || "unknown");
        lastReason = reason || lastReason;

        tierTelemetry.rejected += 1;
        tierTelemetry.reasons[reason] = (tierTelemetry.reasons[reason] || 0) + 1;
        bumpReason(reason);

        try {
          logger?.log?.("logo_candidate_rejected", {
            company_id: companyId,
            candidate_url: candidate?.url || "",
            candidate_source: candidate?.source || "",
            candidate_score: Number(candidate?.score) || 0,
            rejection_reason: reason,
            tier,
            attempt: telemetry.candidates_tried,
          });
        } catch {
          // ignore
        }

        continue;
      }

      try {
        logger?.log?.("logo_download_ok", {
          company_id: companyId,
          source_url: evalResult.finalUrl || candidate?.url || "",
          content_type: evalResult.contentType || "",
          width: evalResult.width || null,
          height: evalResult.height || null,
          is_svg: Boolean(evalResult.isSvg),
          tier,
        });
      } catch {
        // ignore
      }

      if (isBudgetExhausted(budget, { minRemainingMs: 1200 })) {
        telemetry.time_budget_exhausted = true;
        lastReason = "budget_exhausted_before_upload";
        bumpReason(lastReason);
        break;
      }

      try {
        let logoUrl = null;

        if (evalResult.isSvg) {
          logoUrl = await uploadSvgToBlob({ companyId, svgBuffer: evalResult.buf }, logger);
        } else {
          const pngBuffer = await rasterizeToPng(evalResult.buf, { maxSize: 500, isSvg: false });
          logoUrl = await uploadPngToBlob({ companyId, pngBuffer }, logger);
        }

        try {
          logger?.log?.("logo_uploaded_ok", {
            company_id: companyId,
            logo_url: logoUrl,
            tier,
          });
        } catch {
          // ignore
        }

        tierTelemetry.ok = true;
        tierTelemetry.selected_url = String(evalResult.finalUrl || candidate.url || "");
        tierTelemetry.selected_content_type = String(evalResult.contentType || "");

        telemetry.tiers.push(tierTelemetry);

        return {
          ok: true,
          logo_status: "imported",
          logo_import_status: "imported",
          logo_stage_status: "ok",
          logo_error: "",
          logo_source_url: evalResult.finalUrl || candidate.url,
          logo_source_location: candidate.location || null,
          logo_source_domain: candidate.logo_source_domain || discovered?.allowed_host_root || null,
          logo_source_type: toLogoSourceType(candidate.source),
          logo_url: logoUrl,
          logo_discovery_strategy: candidate.source || "",
          logo_discovery_page_url: candidate.page_url || discovered?.page_url || "",
          logo_telemetry: finalizeTelemetry(),
        };
      } catch (e) {
        const reason = e?.message || String(e);
        lastReason = reason || lastReason;
        tierTelemetry.rejected += 1;
        tierTelemetry.reasons[reason] = (tierTelemetry.reasons[reason] || 0) + 1;
        bumpReason(reason);
        continue;
      }
    }

    telemetry.tiers.push(tierTelemetry);

    if (tierTelemetry.ok) {
      break;
    }

    if (telemetry.time_budget_exhausted) {
      break;
    }
  }

  const errorReason =
    telemetry.time_budget_exhausted && (!telemetry.candidates_total || telemetry.candidates_tried === 0)
      ? "time_budget_exhausted"
      : lastReason || discovered?.error || "no on-site logo found";

  const stageStatus = telemetry.time_budget_exhausted ? "budget_exhausted" : telemetry.candidates_total === 0 ? "no_candidates" : "not_found_on_site";

  if (Object.keys(telemetry.rejection_reasons).length > 0) {
    try {
      logger?.log?.("logo_import_summary", {
        company_id: companyId,
        domain: normalizedDomain,
        candidates_total: telemetry.candidates_total,
        candidates_tried: telemetry.candidates_tried,
        rejection_reasons: telemetry.rejection_reasons,
        stage_status: stageStatus,
        time_budget_exhausted: telemetry.time_budget_exhausted,
      });
    } catch {
      // ignore
    }
  }

  return {
    ok: true,
    logo_status: "not_found_on_site",
    logo_import_status: "missing",
    logo_stage_status: stageStatus,
    logo_error: errorReason,
    logo_source_url: null,
    logo_source_location: null,
    logo_source_domain: discovered?.allowed_host_root || normalizedDomain || null,
    logo_source_type: null,
    logo_url: null,
    logo_discovery_strategy: "",
    logo_discovery_page_url: discovered?.page_url || "",
    logo_telemetry: finalizeTelemetry(),
  };
}

module.exports = {
  discoverLogoSourceUrl,
  importCompanyLogo,
  uploadSvgToBlob,
  looksLikeUnsafeSvg,
  _test: {
    normalizeDomain,
    absolutizeUrl,
    decodeHtmlEntities,
    parseSrcsetBestUrl,
    stripCdnResizeParams,
    isKnownCdnHost,
    isAllowedCandidateUrl,
    extractMetaImage,
    extractSchemaOrgLogo,
    extractLikelyLogoImg,
    extractFavicon,
    collectLogoCandidatesFromHtml,
    collectInlineSvgCandidates,
    maybeResolveSvgSpriteReference,
    dedupeAndSortCandidates,
    strongLogoSignal,
  },
};
