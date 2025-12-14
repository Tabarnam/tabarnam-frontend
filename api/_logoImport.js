const {
  BlobServiceClient,
  StorageSharedKeyCredential,
  BlobSASPermissions,
  generateBlobSASQueryParameters,
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
          Accept: "image/svg+xml,image/png,image/jpeg,image/webp,*/*",
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

async function fetchAndEvaluateCandidate(candidate, logger = console) {
  const sourceUrl = String(candidate?.url || "").trim();
  if (!sourceUrl) return { ok: false, reason: "missing_url" };

  if (hasAnyToken(sourceUrl, LOGO_NEGATIVE_TOKENS) && !candidate?.strong_signal) {
    return { ok: false, reason: "negative_url_tokens" };
  }

  try {
    const { buf, contentType, finalUrl } = await fetchImageBufferWithRetries(sourceUrl, {
      retries: 1,
      timeoutMs: 8000,
      maxBytes: 6 * 1024 * 1024,
    });

    const resolvedUrl = finalUrl || sourceUrl;
    const isSvg = sniffIsSvg(contentType, resolvedUrl, buf);

    if (isSvg) {
      return { ok: true, buf, contentType, finalUrl: resolvedUrl, isSvg, width: null, height: null };
    }

    if (isLikelyNonLogoByContentType(contentType, candidate)) {
      return { ok: false, reason: "raster_jpeg_weak_signal" };
    }

    const { width, height } = await getImageMetadata(buf, isSvg);

    if (isLikelyHeroDimensions({ width, height }) && !candidate?.strong_signal) {
      return { ok: false, reason: `likely_hero_dimensions_${width}x${height}` };
    }

    return { ok: true, buf, contentType, finalUrl: resolvedUrl, isSvg, width, height };
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

function collectLogoCandidatesFromHtml(html, baseUrl) {
  const candidates = [];

  const schema = extractSchemaOrgLogo(html, baseUrl);
  if (schema) {
    candidates.push({
      url: schema,
      source: "schema.org",
      page_url: baseUrl,
      score: 180 + extScore(getFileExt(schema)) + (hasAnyToken(schema, LOGO_POSITIVE_TOKENS) ? 40 : 0),
      strong_signal: true,
    });
  }

  candidates.push(...collectImgCandidates(html, baseUrl));

  const og = extractMetaImage(html, baseUrl, "og");
  if (og) {
    const hay = og;
    candidates.push({
      url: og,
      source: "og:image",
      page_url: baseUrl,
      score:
        60 +
        extScore(getFileExt(og)) +
        (hasAnyToken(hay, LOGO_POSITIVE_TOKENS) ? 50 : -10) +
        (hasAnyToken(hay, LOGO_NEGATIVE_TOKENS) ? -120 : 0),
      strong_signal: hasAnyToken(hay, LOGO_POSITIVE_TOKENS) || getFileExt(og) === "svg",
    });
  }

  const tw = extractMetaImage(html, baseUrl, "twitter");
  if (tw) {
    const hay = tw;
    candidates.push({
      url: tw,
      source: "twitter:image",
      page_url: baseUrl,
      score:
        55 +
        extScore(getFileExt(tw)) +
        (hasAnyToken(hay, LOGO_POSITIVE_TOKENS) ? 50 : -10) +
        (hasAnyToken(hay, LOGO_NEGATIVE_TOKENS) ? -120 : 0),
      strong_signal: hasAnyToken(hay, LOGO_POSITIVE_TOKENS) || getFileExt(tw) === "svg",
    });
  }

  const icon = extractFavicon(html, baseUrl);
  if (icon) {
    candidates.push({
      url: icon,
      source: "favicon",
      page_url: baseUrl,
      score: 5 + extScore(getFileExt(icon)),
      strong_signal: getFileExt(icon) === "svg" || getFileExt(icon) === "png" || hasAnyToken(icon, ["favicon", "icon"]),
    });
  }

  return dedupeAndSortCandidates(candidates);
}

async function discoverLogoCandidates({ domain, websiteUrl }, logger = console) {
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
      const candidates = collectLogoCandidatesFromHtml(text, baseUrl);

      if (candidates.length > 0) {
        return { ok: true, candidates, page_url: baseUrl, warning: "" };
      }

      lastError = "no logo candidates found";
    } catch (e) {
      lastError = e?.message || String(e);
      logger?.warn?.(`[logoImport] discover failed for ${home}: ${lastError}`);
    }
  }

  return { ok: false, candidates: [], page_url: "", error: lastError || "missing domain" };
}

async function discoverLogoSourceUrl({ domain, websiteUrl }, logger = console) {
  const d = normalizeDomain(domain);

  const discovered = await discoverLogoCandidates({ domain: d, websiteUrl }, logger);
  const candidates = dedupeAndSortCandidates(discovered?.candidates || []);

  const maxToTry = 8;
  for (let i = 0; i < Math.min(maxToTry, candidates.length); i += 1) {
    const candidate = candidates[i];
    const evalResult = await fetchAndEvaluateCandidate(candidate, logger);
    if (evalResult.ok) {
      return {
        ok: true,
        logo_source_url: evalResult.finalUrl || candidate.url,
        strategy: candidate.source || "unknown",
        page_url: candidate.page_url || discovered?.page_url || "",
        warning: "",
      };
    }
  }

  if (d) {
    return {
      ok: true,
      logo_source_url: `https://logo.clearbit.com/${encodeURIComponent(d)}`,
      strategy: "clearbit",
      page_url: "",
      warning: discovered?.error || "fallback",
    };
  }

  return {
    ok: false,
    logo_source_url: "",
    strategy: "",
    page_url: "",
    error: discovered?.error || "missing domain",
  };
}

async function rasterizeToPng(buf, { maxSize = 500, isSvg = false } = {}) {
  try {
    let pipeline = sharp(buf, isSvg ? { density: 300 } : undefined);
    pipeline = pipeline.resize({ width: maxSize, height: maxSize, fit: "inside", withoutEnlargement: true });
    return await pipeline.png({ quality: 90 }).toBuffer();
  } catch (e) {
    throw new Error(`image processing failed: ${e?.message || String(e)}`);
  }
}

function getStorageCredentials() {
  const accountName = env("AZURE_STORAGE_ACCOUNT_NAME", "");
  const accountKey = env("AZURE_STORAGE_ACCOUNT_KEY", "");
  return { accountName, accountKey };
}

async function uploadPngToBlob({ companyId, pngBuffer }, logger = console) {
  const { accountName, accountKey } = getStorageCredentials();
  if (!accountName || !accountKey) {
    throw new Error("storage not configured");
  }

  const credentials = new StorageSharedKeyCredential(accountName, accountKey);
  const blobServiceClient = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, credentials);

  const containerName = "company-logos";
  const containerClient = blobServiceClient.getContainerClient(containerName);

  try {
    const exists = await containerClient.exists();
    if (!exists) await containerClient.create({ access: "blob" });
  } catch (e) {
    logger?.warn?.(`[logoImport] container create/exists failed: ${e?.message || e}`);
  }

  const blobName = `${companyId}/${uuidv4()}.png`;
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  await blockBlobClient.upload(pngBuffer, pngBuffer.length, {
    blobHTTPHeaders: { blobContentType: "image/png" },
  });

  let logoUrl = blockBlobClient.url;
  try {
    const expiresOn = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    const sasParams = generateBlobSASQueryParameters(
      {
        containerName,
        blobName,
        permissions: BlobSASPermissions.parse("r"),
        expiresOn,
      },
      credentials
    );
    logoUrl = `${blockBlobClient.url}?${sasParams.toString()}`;
  } catch (e) {
    logger?.warn?.(`[logoImport] SAS generation failed: ${e?.message || e}`);
  }

  return logoUrl;
}

async function importCompanyLogo({ companyId, domain, websiteUrl, logoSourceUrl }, logger = console) {
  if (!companyId) {
    return {
      ok: false,
      logo_import_status: "failed",
      logo_error: "missing companyId",
      logo_source_url: logoSourceUrl || "",
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
        score: 1000 + extScore(getFileExt(providedUrl)) + (hasAnyToken(providedUrl, LOGO_POSITIVE_TOKENS) ? 50 : 0),
        strong_signal: strongLogoSignal({ url: providedUrl }),
      });
    }
  }

  const discovered = await discoverLogoCandidates({ domain, websiteUrl }, logger);
  candidates.push(...(discovered?.candidates || []));

  const sorted = dedupeAndSortCandidates(candidates);

  let lastReason = "";
  const maxToTry = 10;

  for (let i = 0; i < Math.min(maxToTry, sorted.length); i += 1) {
    const candidate = sorted[i];
    const evalResult = await fetchAndEvaluateCandidate(candidate, logger);

    if (!evalResult.ok) {
      lastReason = evalResult.reason || lastReason;
      continue;
    }

    try {
      const pngBuffer = await rasterizeToPng(evalResult.buf, { maxSize: 500, isSvg: evalResult.isSvg });
      const logoUrl = await uploadPngToBlob({ companyId, pngBuffer }, logger);

      return {
        ok: true,
        logo_import_status: "imported",
        logo_error: "",
        logo_source_url: evalResult.finalUrl || candidate.url,
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
    logo_import_status: "missing",
    logo_error: lastReason || discovered?.error || "no suitable logo found",
    logo_source_url: "",
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
