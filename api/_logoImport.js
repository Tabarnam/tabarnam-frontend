const {
  BlobServiceClient,
  StorageSharedKeyCredential,
} = require("@azure/storage-blob");
const sharp = require("sharp");
const { v4: uuidv4 } = require("uuid");

function env(k, d = "") {
  const v = process.env[k];
  return v == null ? d : String(v).trim();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

function absolutizeUrl(candidate, baseUrl) {
  const raw = normalizeUrlCandidate(candidate);
  if (!raw) return "";

  try {
    if (raw.startsWith("//")) {
      const base = new URL(baseUrl);
      return `${base.protocol}${raw}`;
    }
    return new URL(raw, baseUrl).toString();
  } catch {
    return "";
  }
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
  return tokens.some((t) => h.includes(t));
}

function getFileExt(url) {
  const u = String(url || "").toLowerCase().split("?")[0].split("#")[0];
  const m = u.match(/\.([a-z0-9]{2,5})$/);
  return m ? m[1] : "";
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
  if (ext === "svg") return true;
  if (ext === "png" && hasAnyToken(hay, ["brand", "mark"])) return true;
  return false;
}

function scoreCandidate({ url, source, id = "", cls = "", alt = "", idx = 0, width = null, height = null }) {
  const hay = `${id} ${cls} ${alt} ${url}`;
  const ext = getFileExt(url);

  let score = 0;

  score += extScore(ext);

  if (hasAnyToken(hay, LOGO_POSITIVE_TOKENS)) score += 90;
  if (hasAnyToken(hay, ["header", "navbar", "nav"])) score += 10;

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

function collectImgCandidates(html, baseUrl) {
  const imgRe = /<img\b[^>]*>/gi;
  let m;
  const out = [];

  while ((m = imgRe.exec(html)) !== null) {
    const tag = m[0];
    const attrs = parseImgAttributes(tag);
    const src = attrs.src || attrs["data-src"] || attrs["data-lazy-src"] || "";
    const abs = absolutizeUrl(src, baseUrl);
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

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; TabarnamBot/1.0; +https://tabarnam.com)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, url: res.url, text };
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
      const res = await fetch(u, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          Accept: "image/svg+xml,image/png,image/jpeg,*/*",
          "User-Agent": "Mozilla/5.0 (compatible; TabarnamBot/1.0; +https://tabarnam.com)",
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

async function getImageMetadata(buf, isSvg) {
  try {
    const meta = await sharp(buf, isSvg ? { density: 200 } : undefined).metadata();
    const width = Number.isFinite(meta?.width) ? meta.width : null;
    const height = Number.isFinite(meta?.height) ? meta.height : null;
    return { width, height };
  } catch {
    return { width: null, height: null };
  }
}

function isLikelyHeroDimensions({ width, height }) {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
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
    if (!candidate?.strong_signal) return true;
    if (!hasAnyToken(candidate.url, ["logo", "wordmark", "logotype"])) return true;
  }
  return false;
}

function isAllowedLogoExtension(ext) {
  const e = String(ext || "").toLowerCase();
  return e === "png" || e === "jpg" || e === "jpeg" || e === "svg";
}

function isAllowedLogoContentType(contentType) {
  const ct = String(contentType || "").toLowerCase();
  if (!ct.startsWith("image/")) return false;
  if (ct.includes("image/png")) return true;
  if (ct.includes("image/jpeg") || ct.includes("image/jpg")) return true;
  if (ct.includes("image/svg+xml")) return true;
  return false;
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
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "image/svg+xml,image/png,image/jpeg,image/*,*/*",
        "User-Agent": "Mozilla/5.0 (compatible; TabarnamBot/1.0; +https://tabarnam.com)",
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

async function fetchAndEvaluateCandidate(candidate, logger = console) {
  const sourceUrl = String(candidate?.url || "").trim();
  if (!sourceUrl) return { ok: false, reason: "missing_url" };

  if (sourceUrl.startsWith("data:")) return { ok: false, reason: "data_url" };

  const allowedHostRoot = String(candidate?.allowed_host_root || "").trim().toLowerCase();
  if (allowedHostRoot && !isAllowedOnSiteUrl(sourceUrl, allowedHostRoot)) {
    return { ok: false, reason: "offsite_url" };
  }

  if (hasAnyToken(sourceUrl, LOGO_NEGATIVE_TOKENS) && !candidate?.strong_signal) {
    return { ok: false, reason: "negative_url_tokens" };
  }

  const urlExt = getFileExt(sourceUrl);
  if (urlExt && !isAllowedLogoExtension(urlExt)) {
    return { ok: false, reason: `unsupported_extension_${urlExt}` };
  }

  // Lightweight probe before downloading full image
  const head = await headProbeImage(sourceUrl, { timeoutMs: 6000 });
  const probedType = String(head.contentType || "").toLowerCase();

  if (!head.ok) return { ok: false, reason: `head_status_${head.status || 0}` };
  if (allowedHostRoot && head.finalUrl && !isAllowedOnSiteUrl(head.finalUrl, allowedHostRoot)) {
    return { ok: false, reason: "offsite_head_redirect" };
  }
  if (!isAllowedLogoContentType(probedType)) return { ok: false, reason: `unsupported_content_type_${probedType || "unknown"}` };
  if (head.contentLength != null && head.contentLength <= 1024) return { ok: false, reason: `too_small_${head.contentLength}_bytes` };

  try {
    const { buf, contentType, finalUrl } = await fetchImageBufferWithRetries(sourceUrl, {
      retries: 1,
      timeoutMs: 8000,
      maxBytes: 6 * 1024 * 1024,
    });

    if (!Buffer.isBuffer(buf) || buf.length <= 1024) {
      return { ok: false, reason: `too_small_${buf?.length || 0}_bytes` };
    }

    const resolvedUrl = finalUrl || head.finalUrl || sourceUrl;
    const ct = String(contentType || head.contentType || "").toLowerCase();

    if (allowedHostRoot && resolvedUrl && !isAllowedOnSiteUrl(resolvedUrl, allowedHostRoot)) {
      return { ok: false, reason: "offsite_fetch_redirect" };
    }

    if (!isAllowedLogoContentType(ct)) {
      return { ok: false, reason: `unsupported_content_type_${ct || "unknown"}` };
    }

    const isSvg = sniffIsSvg(ct, resolvedUrl, buf);

    if (isSvg) {
      if (looksLikeUnsafeSvg(buf)) return { ok: false, reason: "unsafe_svg" };

      const { width, height } = await getImageMetadata(buf, true);
      if (!Number.isFinite(width) || !Number.isFinite(height)) {
        return { ok: false, reason: "unknown_svg_dimensions" };
      }
      if (width < 64 || height < 64) {
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

    const { width, height } = await getImageMetadata(buf, isSvg);

    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 64 || height < 64) {
      return { ok: false, reason: `too_small_dimensions_${width || "?"}x${height || "?"}` };
    }

    if (!isReasonableLogoAspectRatio({ width, height }) && !candidate?.strong_signal) {
      return { ok: false, reason: `unreasonable_aspect_ratio_${width}x${height}` };
    }

    if (isLikelyHeroDimensions({ width, height }) && !candidate?.strong_signal) {
      return { ok: false, reason: `likely_hero_dimensions_${width}x${height}` };
    }

    return { ok: true, buf, contentType: ct, finalUrl: resolvedUrl, isSvg, width, height };
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

      const boost = 90;

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
  return (Array.isArray(candidates) ? candidates : []).filter((c) => isAllowedOnSiteUrl(c?.url, root));
}

function collectLogoCandidatesFromHtml(html, baseUrl, options = {}) {
  const companyNameTokens = buildCompanyNameTokens(options?.companyName || "");

  const allowedFromOptions = String(options?.allowedHostRoot || options?.allowed_host_root || "").trim();
  const allowedFromBase = deriveAllowedHostRootFromUrl(baseUrl);
  const allowedHostRoot = reconcileAllowedHostRoot(allowedFromOptions, allowedFromBase);

  const metaCandidates = [];

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

  const headerCandidates = collectHeaderNavImgCandidates(html, baseUrl, { companyNameTokens, allowedHostRoot });
  const iconCandidates = collectIconLinkCandidates(html, baseUrl, { allowedHostRoot });
  const footerCandidates = collectFooterImgCandidates(html, baseUrl, { companyNameTokens, allowedHostRoot });

  const all = [...metaCandidates, ...headerCandidates, ...iconCandidates, ...footerCandidates];
  const onSite = filterOnSiteCandidates(all, allowedHostRoot);
  return dedupeAndSortCandidates(onSite);
}

async function discoverLogoCandidates({ domain, websiteUrl, companyName }, logger = console) {
  const d = normalizeDomain(domain);
  const homes = buildHomeUrlCandidates(d, websiteUrl);

  let lastError = "";

  for (const home of homes) {
    try {
      const { ok, status, url: finalUrl, text } = await fetchText(home, 8000);
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
      });

      if (candidates.length > 0) {
        return { ok: true, candidates, page_url: baseUrl, allowed_host_root: allowedHostRoot, warning: "" };
      }

      lastError = "no on-site logo candidates found";
    } catch (e) {
      lastError = e?.message || String(e);
      logger?.warn?.(`[logoImport] discover failed for ${home}: ${lastError}`);
    }
  }

  return { ok: false, candidates: [], page_url: "", allowed_host_root: d || "", error: lastError || "missing domain" };
}

async function discoverLogoSourceUrl({ domain, websiteUrl, companyName }, logger = console) {
  const d = normalizeDomain(domain);

  const discovered = await discoverLogoCandidates({ domain: d, websiteUrl, companyName }, logger);
  const candidates = dedupeAndSortCandidates(discovered?.candidates || []);
  candidates.sort(sortCandidatesStrict);

  const maxToTry = 8;
  for (let i = 0; i < Math.min(maxToTry, candidates.length); i += 1) {
    const candidate = candidates[i];
    const evalResult = await fetchAndEvaluateCandidate(candidate, logger);
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

  return {
    ok: false,
    logo_source_url: "",
    logo_source_location: null,
    logo_source_domain: discovered?.allowed_host_root || null,
    strategy: "",
    page_url: "",
    error: discovered?.error || "no suitable logo found",
  };
}

async function rasterizeToPng(buf, { maxSize = 500, isSvg = false } = {}) {
  try {
    let pipeline = sharp(buf, isSvg ? { density: 300 } : undefined);
    pipeline = pipeline.resize({ width: maxSize, height: maxSize, fit: "inside", withoutEnlargement: true });

    // By default Sharp strips metadata unless withMetadata() is explicitly used.
    return await pipeline.png({ quality: 90 }).toBuffer();
  } catch (e) {
    throw new Error(`image processing failed: ${e?.message || String(e)}`);
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
      await containerClient.create({ access: "blob" });
    } else {
      // The container might already exist with private access.
      // Ensure it's publicly readable so returned logo URLs (without SAS) work in the UI.
      try {
        await containerClient.setAccessPolicy("blob");
      } catch (e) {
        logger?.warn?.(`[logoImport] setAccessPolicy failed: ${e?.message || e}`);
      }
    }
  } catch (e) {
    logger?.warn?.(`[logoImport] container create/exists failed: ${e?.message || e}`);
  }

  const blobName = `${companyId}/logo.${safeExt}`;
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  await blockBlobClient.upload(buffer, buffer.length, {
    blobHTTPHeaders: { blobContentType: contentType || "application/octet-stream" },
  });

  return blockBlobClient.url;
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

async function importCompanyLogo({ companyId, domain, websiteUrl, companyName, logoSourceUrl }, logger = console) {
  if (!companyId) {
    return {
      ok: false,
      logo_status: "error",
      logo_import_status: "failed",
      logo_error: "missing companyId",
      logo_source_url: logoSourceUrl || null,
      logo_source_type: logoSourceUrl ? "provided" : null,
      logo_url: null,
    };
  }

  const candidates = [];

  if (logoSourceUrl) {
    const providedUrl = String(logoSourceUrl).trim();
    if (providedUrl) {
      candidates.push({
        url: providedUrl,
        source: "provided",
        page_url: "",
        score: 5 + extScore(getFileExt(providedUrl)) + (hasAnyToken(providedUrl, LOGO_POSITIVE_TOKENS) ? 50 : 0),
        strong_signal: strongLogoSignal({ url: providedUrl }),
      });
    }
  }

  const discovered = await discoverLogoCandidates({ domain, websiteUrl, companyName }, logger);
  candidates.push(...(discovered?.candidates || []));

  const sorted = dedupeAndSortCandidates(candidates);
  sorted.sort(sortCandidatesStrict);

  let lastReason = "";
  const maxToTry = 12;

  for (let i = 0; i < Math.min(maxToTry, sorted.length); i += 1) {
    const candidate = sorted[i];

    try {
      logger?.log?.("logo_candidate_found", {
        company_id: companyId,
        candidate_url: candidate?.url || "",
        candidate_source: candidate?.source || "",
        candidate_score: Number(candidate?.score) || 0,
        attempt: i + 1,
      });
    } catch {
      // ignore
    }

    const evalResult = await fetchAndEvaluateCandidate(candidate, logger);

    if (!evalResult.ok) {
      lastReason = evalResult.reason || lastReason;

      const reason = String(evalResult.reason || "");
      if (reason.includes("too_small")) {
        try {
          logger?.log?.("logo_rejected_small", {
            company_id: companyId,
            candidate_url: candidate?.url || "",
            reason,
          });
        } catch {
          // ignore
        }
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
      });
    } catch {
      // ignore
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
        });
      } catch {
        // ignore
      }

      return {
        ok: true,
        logo_status: "imported",
        logo_import_status: "imported",
        logo_error: "",
        logo_source_url: evalResult.finalUrl || candidate.url,
        logo_source_location: candidate.location || null,
        logo_source_domain: candidate.logo_source_domain || discovered?.allowed_host_root || null,
        logo_source_type: toLogoSourceType(candidate.source),
        logo_url: logoUrl,
        logo_discovery_strategy: candidate.source || "",
        logo_discovery_page_url: candidate.page_url || discovered?.page_url || "",
      };
    } catch (e) {
      lastReason = e?.message || String(e);
      continue;
    }
  }

  return {
    ok: true,
    logo_status: "not_found_on_site",
    logo_import_status: "missing",
    logo_error: lastReason || discovered?.error || "no on-site logo found",
    logo_source_url: null,
    logo_source_location: null,
    logo_source_domain: discovered?.allowed_host_root || normalizeDomain(domain) || null,
    logo_source_type: null,
    logo_url: null,
    logo_discovery_strategy: "",
    logo_discovery_page_url: discovered?.page_url || "",
  };
}

module.exports = {
  discoverLogoSourceUrl,
  importCompanyLogo,
  _test: {
    normalizeDomain,
    absolutizeUrl,
    extractMetaImage,
    extractSchemaOrgLogo,
    extractLikelyLogoImg,
    extractFavicon,
    collectLogoCandidatesFromHtml,
    dedupeAndSortCandidates,
    strongLogoSignal,
  },
};
