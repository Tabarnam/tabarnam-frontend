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
  return (v == null ? d : String(v)).trim();
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

function extractLikelyLogoImg(html, baseUrl) {
  const imgRe = /<img\b[^>]*>/gi;
  let m;
  let best = { score: -Infinity, url: "" };

  while ((m = imgRe.exec(html)) !== null) {
    const tag = m[0];
    const attrs = parseImgAttributes(tag);
    const src = attrs.src || attrs["data-src"] || "";
    const abs = absolutizeUrl(src, baseUrl);
    if (!abs) continue;

    const id = String(attrs.id || "").toLowerCase();
    const cls = String(attrs.class || "").toLowerCase();
    const alt = String(attrs.alt || "").toLowerCase();

    const idx = m.index || 0;
    let score = 0;

    const hay = `${id} ${cls} ${alt}`;
    if (hay.includes("logo")) score += 50;
    if (hay.includes("brand")) score += 10;
    if (hay.includes("header")) score += 5;

    // Prefer images close to the top of the page.
    if (idx < 5000) score += 12;
    else if (idx < 15000) score += 6;

    const uLower = abs.toLowerCase();
    if (uLower.includes("logo")) score += 25;
    if (uLower.includes("brand")) score += 6;
    if (uLower.endsWith(".svg")) score += 5;

    // Penalize obvious favicons.
    if (uLower.includes("favicon") || uLower.endsWith(".ico")) score -= 100;

    if (score > best.score) {
      best = { score, url: abs };
    }
  }

  return best.url;
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

  // As a last resort, try /favicon.ico
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

  // Deduplicate
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

async function discoverLogoSourceUrl({ domain, websiteUrl }, logger = console) {
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

      const og = extractMetaImage(text, baseUrl, "og");
      if (og) {
        return { ok: true, logo_source_url: og, strategy: "og:image", page_url: baseUrl };
      }

      const tw = extractMetaImage(text, baseUrl, "twitter");
      if (tw) {
        return { ok: true, logo_source_url: tw, strategy: "twitter:image", page_url: baseUrl };
      }

      const schema = extractSchemaOrgLogo(text, baseUrl);
      if (schema) {
        return { ok: true, logo_source_url: schema, strategy: "schema.org", page_url: baseUrl };
      }

      const img = extractLikelyLogoImg(text, baseUrl);
      if (img) {
        return { ok: true, logo_source_url: img, strategy: "header-img", page_url: baseUrl };
      }

      const icon = extractFavicon(text, baseUrl);
      if (icon) {
        return { ok: true, logo_source_url: icon, strategy: "favicon", page_url: baseUrl };
      }

      lastError = "no logo candidates found";
    } catch (e) {
      lastError = e?.message || String(e);
      logger?.warn?.(`[logoImport] discover failed for ${home}: ${lastError}`);
    }
  }

  // Final fallback: Clearbit (kept for backwards compatibility)
  if (d) {
    return {
      ok: true,
      logo_source_url: `https://logo.clearbit.com/${encodeURIComponent(d)}`,
      strategy: "clearbit",
      page_url: "",
      warning: lastError || "fallback",
    };
  }

  return { ok: false, logo_source_url: "", strategy: "", page_url: "", error: lastError || "missing domain" };
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

async function fetchImageBufferWithRetries(url, { timeoutMs = 10000, maxBytes = 8 * 1024 * 1024, retries = 2 } = {}) {
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

async function importCompanyLogo(
  { companyId, domain, websiteUrl, logoSourceUrl },
  logger = console
) {
  if (!companyId) {
    return {
      ok: false,
      logo_import_status: "failed",
      logo_error: "missing companyId",
      logo_source_url: logoSourceUrl || "",
      logo_url: null,
    };
  }

  let discovery = null;
  if (logoSourceUrl) {
    discovery = {
      ok: true,
      logo_source_url: String(logoSourceUrl).trim(),
      strategy: "provided",
      page_url: "",
    };
  } else {
    discovery = await discoverLogoSourceUrl({ domain, websiteUrl }, logger);
  }

  const source = String(discovery?.logo_source_url || "").trim();
  if (!source) {
    return {
      ok: true,
      logo_import_status: "missing",
      logo_error: discovery?.error || "missing logo_source_url",
      logo_source_url: "",
      logo_url: null,
      logo_discovery_strategy: discovery?.strategy || "",
    };
  }

  try {
    const { buf, contentType, finalUrl } = await fetchImageBufferWithRetries(source, {
      retries: 2,
      timeoutMs: 10000,
      maxBytes: 8 * 1024 * 1024,
    });

    const isSvg = sniffIsSvg(contentType, finalUrl || source, buf);
    const pngBuffer = await rasterizeToPng(buf, { maxSize: 500, isSvg });
    const logoUrl = await uploadPngToBlob({ companyId, pngBuffer }, logger);

    return {
      ok: true,
      logo_import_status: "imported",
      logo_error: "",
      logo_source_url: finalUrl || source,
      logo_url: logoUrl,
      logo_discovery_strategy: discovery?.strategy || "",
      logo_discovery_page_url: discovery?.page_url || "",
    };
  } catch (e) {
    return {
      ok: false,
      logo_import_status: "failed",
      logo_error: e?.message || String(e),
      logo_source_url: source,
      logo_url: null,
      logo_discovery_strategy: discovery?.strategy || "",
      logo_discovery_page_url: discovery?.page_url || "",
    };
  }
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
  },
};
