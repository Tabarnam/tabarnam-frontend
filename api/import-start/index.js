let app;
try {
  ({ app } = require("@azure/functions"));
} catch {
  app = { http() {} };
}
const axios = require("axios");
const { CosmosClient } = require("@azure/cosmos");
let randomUUID;
try {
  ({ randomUUID } = require("crypto"));
} catch {
  randomUUID = null;
}
const {
  getContainerPartitionKeyPath,
  buildPartitionKeyCandidates,
  getValueAtPath,
} = require("../_cosmosPartitionKey");
const { getXAIEndpoint, getXAIKey } = require("../_shared");
function requireImportCompanyLogo() {
  const mod = require("../_logoImport");
  if (!mod || typeof mod.importCompanyLogo !== "function") {
    throw new Error("importCompanyLogo is not available");
  }
  return mod.importCompanyLogo;
}
const { geocodeLocationArray, pickPrimaryLatLng } = require("../_geocode");
const {
  validateCuratedReviewCandidate,
  checkUrlHealthAndFetchText,
} = require("../_reviewQuality");
const { getBuildInfo } = require("../_buildInfo");

const DEFAULT_HARD_TIMEOUT_MS = 25_000;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 20_000;

if (!globalThis.__importStartProcessHandlersInstalled) {
  globalThis.__importStartProcessHandlersInstalled = true;

  process.on("unhandledRejection", (reason) => {
    try {
      const msg = reason?.stack || reason?.message || String(reason);
      console.error("[import-start] unhandledRejection:", msg);
    } catch {
      console.error("[import-start] unhandledRejection");
    }
  });

  process.on("uncaughtException", (err) => {
    try {
      const msg = err?.stack || err?.message || String(err);
      console.error("[import-start] uncaughtException:", msg);
    } catch {
      console.error("[import-start] uncaughtException");
    }
  });
}

function json(obj, status = 200, extraHeaders) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "content-type,x-functions-key",
      ...(extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {}),
    },
    body: JSON.stringify(obj),
  };
}

function safeJsonParse(text) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readQueryParam(req, name) {
  if (!req || !name) return undefined;

  const query = req.query;
  if (query) {
    if (typeof query.get === "function") {
      try {
        const v = query.get(name);
        if (v !== null && v !== undefined) return v;
      } catch {}
    }

    const direct = query[name] ?? query[name.toLowerCase()] ?? query[name.toUpperCase()];
    if (direct !== null && direct !== undefined) return direct;
  }

  const rawUrl = typeof req.url === "string" ? req.url : "";
  if (rawUrl) {
    try {
      const u = new URL(rawUrl, "http://localhost");
      const v = u.searchParams.get(name);
      if (v !== null && v !== undefined) return v;
    } catch {}
  }

  return undefined;
}

async function readJsonBody(req) {
  if (!req) return {};

  if (typeof req.json === "function") {
    try {
      const val = await req.json();
      if (val && typeof val === "object") return val;
    } catch {}
  }

  if (req.body && typeof req.body === "object") return req.body;

  if (typeof req.body === "string" && req.body.trim()) {
    const parsed = safeJsonParse(req.body);
    if (parsed && typeof parsed === "object") return parsed;
  }

  const rawBody = req.rawBody;
  if (typeof rawBody === "string" && rawBody.trim()) {
    const parsed = safeJsonParse(rawBody);
    if (parsed && typeof parsed === "object") return parsed;
  }

  if (rawBody && (Buffer.isBuffer(rawBody) || rawBody instanceof Uint8Array)) {
    const parsed = safeJsonParse(Buffer.from(rawBody).toString("utf8"));
    if (parsed && typeof parsed === "object") return parsed;
  }

  return {};
}

function toErrorString(err) {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;
  if (typeof err.message === "string" && err.message.trim()) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function getHeader(req, name) {
  if (!req || !name) return null;
  const headers = req.headers;
  if (headers && typeof headers.get === "function") {
    try {
      const v = headers.get(name);
      return typeof v === "string" && v.trim() ? v.trim() : null;
    } catch {
      return null;
    }
  }
  const h = headers && typeof headers === "object" ? headers : {};
  const v = h[name] ?? h[name.toLowerCase()] ?? h[name.toUpperCase()];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function generateRequestId(req) {
  const existing =
    getHeader(req, "x-request-id") ||
    getHeader(req, "x-correlation-id") ||
    getHeader(req, "x-client-request-id");
  if (existing) return existing;
  if (typeof randomUUID === "function") return randomUUID();
  return `rid_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function extractXaiRequestId(headers) {
  const h = headers || {};
  const get = (k) => {
    const v = h[k] ?? h[k.toLowerCase()] ?? h[k.toUpperCase()];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  return (
    get("x-request-id") ||
    get("xai-request-id") ||
    get("x-correlation-id") ||
    get("x-ms-request-id") ||
    get("request-id") ||
    null
  );
}

function tryParseUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  try {
    return new URL(s);
  } catch {
    try {
      return new URL(`https://${s}`);
    } catch {
      return null;
    }
  }
}

function isXaiPublicApiUrl(raw) {
  const u = tryParseUrl(raw);
  if (!u) return false;
  const host = u.hostname.toLowerCase();
  if (host === "api.x.ai" || host === "x.ai" || host.endsWith(".x.ai")) {
    return true;
  }
  const path = u.pathname.toLowerCase();
  if (path.includes("/v1/chat/completions")) return true;
  return false;
}

function getImportStartProxyInfo() {
  // Import-start proxying is ONLY for a Tabarnam-controlled import worker.
  // Do not fall back to XAI_EXTERNAL_BASE (that is for XAI chat/search), and never to XAI public API.
  const candidates = [
    { key: "IMPORT_START_PROXY_BASE", value: process.env.IMPORT_START_PROXY_BASE },
    { key: "XAI_IMPORT_PROXY_BASE", value: process.env.XAI_IMPORT_PROXY_BASE },
  ];

  for (const c of candidates) {
    const v = String(c.value || "").trim();
    if (!v) continue;
    return { base: v, source: c.key };
  }

  return { base: "", source: "" };
}

function isProxyExplicitlyDisabled(value) {
  if (value === false) return true;
  if (value === 0) return true;
  if (value === null) return false;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (!v) return false;
    return v === "false" || v === "0" || v === "no" || v === "off";
  }
  return false;
}

function isProxyExplicitlyEnabled(value) {
  if (value === true) return true;
  if (value === 1) return true;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (!v) return false;
    return v === "true" || v === "1" || v === "yes" || v === "on";
  }
  return false;
}

function buildCounts({ enriched, debugOutput }) {
  const candidates_found = Array.isArray(enriched) ? enriched.length : 0;

  const keywords_generated = Array.isArray(debugOutput?.keywords_debug)
    ? debugOutput.keywords_debug.reduce((sum, k) => sum + (Number(k?.generated_count) || 0), 0)
    : 0;

  let reviews_valid = 0;
  let reviews_rejected = 0;

  if (Array.isArray(debugOutput?.reviews_debug)) {
    for (const entry of debugOutput.reviews_debug) {
      const candidates = Array.isArray(entry?.candidates) ? entry.candidates : [];
      for (const c of candidates) {
        if (c?.is_valid === true) reviews_valid += 1;
        else reviews_rejected += 1;
      }
    }
  }

  return {
    candidates_found,
    reviews_valid,
    reviews_rejected,
    keywords_generated,
  };
}

// Helper: normalize industries array
function normalizeIndustries(input) {
  if (Array.isArray(input))
    return [...new Set(input.map((s) => String(s).trim()).filter(Boolean))];
  if (typeof input === "string")
    return [
      ...new Set(
        input
          .split(/[,;|]/)
          .map((s) => s.trim())
          .filter(Boolean)
      ),
    ];
  return [];
}

function toBrandTokenFromWebsiteUrl(websiteUrl) {
  try {
    const raw = String(websiteUrl || "").trim();
    if (!raw) return "";
    const u = raw.includes("://") ? new URL(raw) : new URL(`https://${raw}`);
    let h = u.hostname.toLowerCase();
    if (h.startsWith("www.")) h = h.slice(4);
    const parts = h.split(".").filter(Boolean);
    return parts[0] || "";
  } catch {
    return "";
  }
}

function normalizeKeywordList(value) {
  const raw = value;
  const items = [];

  if (Array.isArray(raw)) {
    for (const v of raw) items.push(String(v));
  } else if (typeof raw === "string") {
    items.push(raw);
  }

  const split = items
    .flatMap((s) => String(s).split(/[,;|\n]/))
    .map((s) => s.trim())
    .filter(Boolean);

  const seen = new Set();
  const out = [];
  for (const k of split) {
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out;
}

function normalizeProductKeywords(value, { companyName, websiteUrl } = {}) {
  const list = normalizeKeywordList(value);
  const name = String(companyName || "").trim();
  const nameNorm = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const brandToken = toBrandTokenFromWebsiteUrl(websiteUrl);

  return list
    .map((k) => k.trim())
    .filter(Boolean)
    .filter((k) => {
      const kl = k.toLowerCase();
      if (nameNorm && kl.includes(nameNorm)) return false;
      if (brandToken && (kl === brandToken || kl.includes(brandToken))) return false;
      return true;
    })
    .slice(0, 25);
}

function keywordListToString(list) {
  return (Array.isArray(list) ? list : []).join(", ");
}

// Helper: get safe number
const safeNum = (n) => (Number.isFinite(Number(n)) ? Number(n) : undefined);

// Helper: parse center coordinates
function safeCenter(c) {
  const lat = safeNum(c?.lat),
    lng = safeNum(c?.lng);
  return lat !== undefined && lng !== undefined ? { lat, lng } : undefined;
}

// Helper: get normalized domain
const toNormalizedDomain = (s = "") => {
  try {
    const u = s.startsWith("http") ? new URL(s) : new URL(`https://${s}`);
    let h = u.hostname.toLowerCase();
    if (h.startsWith("www.")) h = h.slice(4);
    return h || "unknown";
  } catch {
    return "unknown";
  }
};

// Helper: enrich company data with location fields
function enrichCompany(company, center) {
  const c = { ...(company || {}) };
  c.industries = normalizeIndustries(c.industries);

  const websiteUrl = c.website_url || c.canonical_url || c.url || c.amazon_url || "";
  const companyName = c.company_name || c.name || "";

  const productKeywords = normalizeProductKeywords(c.product_keywords, {
    companyName,
    websiteUrl,
  });

  c.keywords = productKeywords;
  c.product_keywords = keywordListToString(productKeywords);

  const urlForDomain = c.canonical_url || c.website_url || c.url || c.amazon_url || "";
  c.normalized_domain = toNormalizedDomain(urlForDomain);

  // Ensure location fields are present
  c.headquarters_location = String(c.headquarters_location || "").trim();

  // Handle manufacturing_locations - accept country-only entries like "United States", "China", etc.
  if (Array.isArray(c.manufacturing_locations)) {
    c.manufacturing_locations = c.manufacturing_locations
      .map(l => String(l).trim())
      .filter(l => l.length > 0);
  } else if (typeof c.manufacturing_locations === 'string') {
    // If it's a single string, wrap it in an array
    const trimmed = String(c.manufacturing_locations || "").trim();
    c.manufacturing_locations = trimmed ? [trimmed] : [];
  } else {
    c.manufacturing_locations = [];
  }

  // Handle location_sources - structured data with source attribution
  if (!Array.isArray(c.location_sources)) {
    c.location_sources = [];
  }

  // Ensure each location_source has required fields
  c.location_sources = c.location_sources
    .filter(s => s && s.location)
    .map(s => ({
      location: String(s.location || "").trim(),
      source_url: String(s.source_url || "").trim(),
      source_type: s.source_type || "other",
      location_type: s.location_type || "other",
    }));

  // Handle tagline
  c.tagline = String(c.tagline || "").trim();

  c.red_flag = Boolean(c.red_flag);
  c.red_flag_reason = String(c.red_flag_reason || "").trim();
  c.location_confidence = (c.location_confidence || "medium").toString().toLowerCase();

  return c;
}

function toFiniteNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function normalizeLocationEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => {
      if (typeof entry === "string") {
        const address = entry.trim();
        return address ? { address } : null;
      }
      if (entry && typeof entry === "object") return entry;
      return null;
    })
    .filter(Boolean);
}

function buildImportLocations(company) {
  const headquartersBase =
    Array.isArray(company.headquarters) && company.headquarters.length > 0
      ? company.headquarters
      : Array.isArray(company.headquarters_locations) && company.headquarters_locations.length > 0
        ? company.headquarters_locations
        : company.headquarters_location && String(company.headquarters_location).trim()
          ? [{ address: String(company.headquarters_location).trim() }]
          : [];

  const manufacturingBase =
    Array.isArray(company.manufacturing_geocodes) && company.manufacturing_geocodes.length > 0
      ? company.manufacturing_geocodes
      : Array.isArray(company.manufacturing_locations) && company.manufacturing_locations.length > 0
        ? company.manufacturing_locations
        : [];

  return {
    headquartersBase: normalizeLocationEntries(headquartersBase),
    manufacturingBase: normalizeLocationEntries(manufacturingBase),
  };
}

async function geocodeCompanyLocations(company, { timeoutMs = 5000 } = {}) {
  const c = { ...(company || {}) };

  const { headquartersBase, manufacturingBase } = buildImportLocations(c);

  const [headquarters, manufacturing_geocodes] = await Promise.all([
    geocodeLocationArray(headquartersBase, { timeoutMs, concurrency: 4 }),
    geocodeLocationArray(manufacturingBase, { timeoutMs, concurrency: 4 }),
  ]);

  const primary = pickPrimaryLatLng(headquarters);

  const hq_lat = primary ? primary.lat : toFiniteNumber(c.hq_lat);
  const hq_lng = primary ? primary.lng : toFiniteNumber(c.hq_lng);

  return {
    ...c,
    headquarters,
    headquarters_locations: headquarters,
    manufacturing_locations: manufacturing_geocodes,
    manufacturing_geocodes,
    hq_lat,
    hq_lng,
  };
}

async function geocodeHQLocation(address, { timeoutMs = 5000 } = {}) {
  const list = [{ address: String(address || "").trim() }].filter((x) => x.address);
  if (!list.length) return { hq_lat: undefined, hq_lng: undefined };

  const results = await geocodeLocationArray(list, { timeoutMs, concurrency: 1 });
  const primary = pickPrimaryLatLng(results);
  return {
    hq_lat: primary ? primary.lat : undefined,
    hq_lng: primary ? primary.lng : undefined,
  };
}

// Check if company already exists by normalized domain
async function findExistingCompany(container, normalizedDomain, companyName) {
  if (!container) return null;

  const nameValue = (companyName || "").toLowerCase();

  try {
    let query;
    let parameters;

    if (normalizedDomain && normalizedDomain !== "unknown") {
      query = `
        SELECT c.id
        FROM c
        WHERE c.normalized_domain = @domain
           OR LOWER(c.company_name) = @name
      `;
      parameters = [
        { name: "@domain", value: normalizedDomain },
        { name: "@name", value: nameValue },
      ];
    } else {
      // If domain is unknown, only dedupe by name, not by 'unknown'
      query = `
        SELECT c.id
        FROM c
        WHERE LOWER(c.company_name) = @name
      `;
      parameters = [
        { name: "@name", value: nameValue },
      ];
    }

    const { resources } = await container.items
      .query({ query, parameters }, { enableCrossPartitionQuery: true })
      .fetchAll();

    return resources && resources.length > 0 ? resources[0] : null;
  } catch (e) {
    console.warn(`[import-start] Error checking for existing company: ${e.message}`);
    return null;
  }
}

// Helper: import logo (discover -> fetch w/ retries -> rasterize SVG -> upload to blob)
async function fetchLogo({ companyId, domain, websiteUrl, existingLogoUrl }) {
  if (existingLogoUrl) {
    return {
      ok: true,
      logo_import_status: "imported",
      logo_source_url: existingLogoUrl,
      logo_url: existingLogoUrl,
      logo_error: "",
      logo_discovery_strategy: "provided",
      logo_discovery_page_url: "",
    };
  }

  if (!domain || domain === "unknown") {
    return {
      ok: true,
      logo_import_status: "missing",
      logo_source_url: "",
      logo_url: null,
      logo_error: "missing domain",
      logo_discovery_strategy: "",
      logo_discovery_page_url: "",
    };
  }

  const importCompanyLogo = requireImportCompanyLogo();
  return importCompanyLogo({ companyId, domain, websiteUrl }, console);
}

// Fetch editorial reviews for a company using XAI
async function fetchEditorialReviews(company, xaiUrl, xaiKey, timeout, debugCollector, stageCtx) {
  const companyName = String(company?.company_name || company?.name || "").trim();
  const websiteUrl = String(company?.website_url || company?.url || "").trim();

  if (!companyName || !websiteUrl) {
    if (debugCollector) {
      debugCollector.push({
        company_name: companyName,
        website_url: websiteUrl,
        candidates: [],
        kept: 0,
        reason: "missing company_name or website_url",
      });
    }
    return [];
  }

  const debug = {
    company_name: companyName,
    website_url: websiteUrl,
    candidates: [],
    kept: 0,
  };

  const looksLikeReviewUrl = (u) => {
    const s = String(u || "").toLowerCase();
    return (
      s.includes("/review") ||
      s.includes("/reviews") ||
      s.includes("hands-on") ||
      s.includes("tested") ||
      s.includes("verdict")
    );
  };

  const isSameDomain = (a, b) => {
    const ah = String(a || "").toLowerCase().replace(/^www\./, "");
    const bh = String(b || "").toLowerCase().replace(/^www\./, "");
    if (!ah || !bh) return false;
    return ah === bh || ah.endsWith(`.${bh}`) || bh.endsWith(`.${ah}`);
  };

  try {
    const reviewMessage = {
      role: "user",
      content: `You are a research assistant finding editorial and professional reviews.
For this company, find and summarize up to 3 editorial/professional reviews ONLY.

Company: ${companyName}
Website: ${websiteUrl}
Industries: ${Array.isArray(company.industries) ? company.industries.join(", ") : ""}

CRITICAL REVIEW SOURCE REQUIREMENTS:
You MUST ONLY include editorial and professional sources. Do NOT include:
- Amazon customer reviews
- Google/Yelp reviews
- Customer testimonials or user-generated content
- Social media comments

ONLY accept reviews from:
- Magazines and industry publications
- News outlets and journalists
- Professional review websites
- Independent testing labs (ConsumerLab, Labdoor, etc.)
- Health/product analysis sites
- Major retailer editorial content (blogs, articles written in editorial voice)
- Company blog articles written in editorial/educational voice

Search for editorial commentary about this company and its products. If you find some, return up to 3 reviews. Include variety when possible (positive and critical/mixed). If you find fewer than 3, return only what you find (0-3).

For each review found, return a JSON object with:
{
  "source": "magazine|editorial_site|lab_test|news|professional_review",
  "source_url": "https://example.com/article",
  "title": "Article/review headline",
  "excerpt": "1-2 sentence summary of the editorial analysis or findings",
  "rating": null or number if the source uses a rating,
  "author": "Publication name or author name",
  "date": "YYYY-MM-DD or null if unknown"
}

Return ONLY a valid JSON array of review objects (0-3 items), no other text.
If you find NO editorial reviews after exhaustive search, return an empty array: []`,
    };

    const reviewPayload = {
      messages: [reviewMessage],
      model: "grok-4-latest",
      temperature: 0.2,
      stream: false,
    };

    console.log(`[import-start] Fetching editorial reviews for ${companyName}`);
    const response = await axios.post(xaiUrl, reviewPayload, {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${xaiKey}`,
      },
      timeout,
    });

    if (!(response.status >= 200 && response.status < 300)) {
      console.warn(`[import-start] Failed to fetch reviews for ${companyName}: status ${response.status}`);
      if (debugCollector) debugCollector.push({ ...debug, reason: `xai_status_${response.status}` });
      return [];
    }

    const responseText = response.data?.choices?.[0]?.message?.content || "";
    console.log(`[import-start] Review response preview for ${companyName}: ${responseText.substring(0, 80)}...`);

    let reviews = [];
    let parseError = null;
    try {
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        reviews = JSON.parse(jsonMatch[0]);
        if (!Array.isArray(reviews)) reviews = [];
      }
    } catch (err) {
      parseError = err?.message || String(err);
      reviews = [];
    }

    if (parseError) {
      console.warn(`[import-start] Failed to parse reviews for ${companyName}: ${parseError}`);
    }

    const candidates = (Array.isArray(reviews) ? reviews : [])
      .filter((r) => r && typeof r === "object")
      .slice(0, 3);

    const nowIso = new Date().toISOString();
    const curated = [];

    for (const r of candidates) {
      const url = String(r.source_url || r.url || "").trim();
      const title = String(r.title || "").trim();

      if (stageCtx?.setStage) {
        stageCtx.setStage("validateReviews", {
          company_name: companyName,
          website_url: websiteUrl,
          normalized_domain: String(company?.normalized_domain || ""),
          review_url: url,
        });
      }

      const v = await validateCuratedReviewCandidate(
        {
          companyName,
          websiteUrl,
          normalizedDomain: company.normalized_domain || "",
          url,
          title,
        },
        { timeoutMs: 8000, maxBytes: 60000, maxSnippets: 2, minWords: 10, maxWords: 25 }
      ).catch((e) => ({
        is_valid: false,
        link_status: "blocked",
        final_url: null,
        matched_brand_terms: [],
        evidence_snippets: [],
        match_confidence: 0,
        last_checked_at: nowIso,
        reason_if_rejected: e?.message || "validation error",
      }));

      const evidenceCount = Array.isArray(v?.evidence_snippets) ? v.evidence_snippets.length : 0;
      debug.candidates.push({
        url,
        title,
        link_status: v?.link_status,
        final_url: v?.final_url,
        is_valid: Boolean(v?.is_valid),
        matched_brand_terms: v?.matched_brand_terms || [],
        match_confidence: v?.match_confidence,
        evidence_snippets_count: evidenceCount,
        reason_if_rejected: v?.reason_if_rejected,
      });

      if (v?.is_valid === true) {
        const show_to_users =
          v.link_status === "ok" &&
          (typeof v.match_confidence !== "number" || v.match_confidence >= 0.7);

        const evidence = Array.isArray(v.evidence_snippets) ? v.evidence_snippets : [];
        const evidenceSentence = evidence.length ? `Evidence: \"${evidence[0]}\".` : "";

        const abstract = title
          ? `The article \"${title}\" explicitly mentions ${companyName}. ${evidenceSentence}`.trim()
          : `This article explicitly mentions ${companyName}. ${evidenceSentence}`.trim();

        curated.push({
          id: `xai_auto_${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.trunc(Math.random() * 1e6)}`,
          source: String(r.source || "editorial_site").trim() || "editorial_site",
          source_url: v.final_url || url,
          title,
          excerpt: "",
          abstract,
          rating: r.rating || null,
          author: String(r.author || "").trim(),
          date: r.date || null,
          created_at: nowIso,
          last_updated_at: nowIso,
          imported_via: "xai_import",

          show_to_users,
          is_public: show_to_users,
          link_status: v.link_status,
          last_checked_at: v.last_checked_at,
          matched_brand_terms: v.matched_brand_terms,
          evidence_snippets: v.evidence_snippets,
          match_confidence: v.match_confidence,
        });
        continue;
      }

      const finalUrl = String(v?.final_url || url || "").trim();
      const host = (() => {
        try {
          return new URL(finalUrl).hostname;
        } catch {
          return "";
        }
      })();

      const companyHost = (() => {
        try {
          return new URL(websiteUrl).hostname;
        } catch {
          return "";
        }
      })();

      const shouldKeepForManual =
        v?.link_status === "blocked" &&
        looksLikeReviewUrl(finalUrl) &&
        host &&
        companyHost &&
        !isSameDomain(host, companyHost);

      if (shouldKeepForManual) {
        curated.push({
          id: `xai_manual_${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.trunc(Math.random() * 1e6)}`,
          source: String(r.source || "editorial_site").trim() || "editorial_site",
          source_url: finalUrl || url,
          title,
          excerpt: String(r.excerpt || "").trim(),
          abstract: "",
          rating: r.rating || null,
          author: String(r.author || "").trim(),
          date: r.date || null,
          created_at: nowIso,
          last_updated_at: nowIso,
          imported_via: "xai_import",

          show_to_users: false,
          is_public: false,
          needs_manual_review: true,
          link_status: v?.link_status,
          last_checked_at: v?.last_checked_at || nowIso,
          matched_brand_terms: v?.matched_brand_terms || [],
          evidence_snippets: v?.evidence_snippets || [],
          match_confidence: typeof v?.match_confidence === "number" ? v.match_confidence : 0,
          validation_reason: v?.reason_if_rejected || "blocked",
        });
      }
    }

    debug.kept = curated.length;

    console.log(`[import-start] Found ${curated.length} curated reviews for ${companyName}`);

    if (debugCollector) {
      debugCollector.push(debug);
    }

    return curated;
  } catch (e) {
    console.warn(`[import-start] Error fetching reviews for ${companyName}: ${e.message}`);
    if (debugCollector) debugCollector.push({ ...debug, reason: e?.message || String(e) });
    return [];
  }
}

let cosmosCompaniesClient = null;
let companiesPkPathPromise;

function getCompaniesCosmosContainer() {
  try {
    const endpoint = (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim();
    const key = (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim();
    const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
    const containerId = (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();

    if (!endpoint || !key) return null;

    cosmosCompaniesClient ||= new CosmosClient({ endpoint, key });
    return cosmosCompaniesClient.database(databaseId).container(containerId);
  } catch {
    return null;
  }
}

async function getCompaniesPartitionKeyPath(companiesContainer) {
  if (!companiesContainer) return "/normalized_domain";
  companiesPkPathPromise ||= getContainerPartitionKeyPath(companiesContainer, "/normalized_domain");
  try {
    return await companiesPkPathPromise;
  } catch {
    return "/normalized_domain";
  }
}

async function readItemWithPkCandidates(container, id, docForCandidates) {
  if (!container || !id) return null;
  const containerPkPath = await getCompaniesPartitionKeyPath(container);

  const candidates = buildPartitionKeyCandidates({
    doc: docForCandidates,
    containerPkPath,
    requestedId: id,
  });

  let lastErr = null;
  for (const partitionKeyValue of candidates) {
    try {
      const item =
        partitionKeyValue !== undefined
          ? container.item(id, partitionKeyValue)
          : container.item(id);
      const { resource } = await item.read();
      return resource || null;
    } catch (e) {
      lastErr = e;
      if (e?.code === 404) return null;
    }
  }

  if (lastErr && lastErr.code !== 404) {
    console.warn(`[import-start] readItem failed id=${id} pkPath=${containerPkPath}: ${lastErr.message}`);
  }
  return null;
}

async function upsertItemWithPkCandidates(container, doc) {
  if (!container || !doc) return { ok: false, error: "no_container" };
  const id = String(doc.id || "").trim();
  if (!id) return { ok: false, error: "missing_id" };

  const containerPkPath = await getCompaniesPartitionKeyPath(container);
  const pkValue = getValueAtPath(doc, containerPkPath);
  const candidates = buildPartitionKeyCandidates({ doc, containerPkPath, requestedId: id });

  let lastErr = null;
  for (const partitionKeyValue of candidates) {
    try {
      if (partitionKeyValue !== undefined) {
        await container.items.upsert(doc, { partitionKey: partitionKeyValue });
      } else if (pkValue !== undefined) {
        await container.items.upsert(doc, { partitionKey: pkValue });
      } else {
        await container.items.upsert(doc);
      }
      return { ok: true };
    } catch (e) {
      lastErr = e;
    }
  }

  return { ok: false, error: lastErr?.message || "upsert_failed" };
}

function buildImportControlDocBase(sessionId) {
  return {
    session_id: sessionId,
    normalized_domain: "import",
    partition_key: "import",
    type: "import_control",
    updated_at: new Date().toISOString(),
  };
}

// Check if a session has been stopped
async function checkIfSessionStopped(sessionId) {
  try {
    const container = getCompaniesCosmosContainer();
    if (!container) return false;

    const stopDocId = `_import_stop_${sessionId}`;
    const resource = await readItemWithPkCandidates(container, stopDocId, {
      id: stopDocId,
      ...buildImportControlDocBase(sessionId),
      stopped_at: "",
    });
    return !!resource;
  } catch (e) {
    console.warn(`[import-start] Error checking stop status: ${e?.message || String(e)}`);
    return false;
  }
}

// Save companies to Cosmos DB (skip duplicates)
async function saveCompaniesToCosmos(companies, sessionId, axiosTimeout) {
  try {
    const endpoint = (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim();
    const key = (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim();
    const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
    const containerId = (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();

    if (!endpoint || !key) {
      console.warn("[import-start] Cosmos DB not configured, skipping save");
      return { saved: 0, failed: 0, skipped: 0 };
    }

    const client = new CosmosClient({ endpoint, key });
    const database = client.database(databaseId);
    const container = database.container(containerId);

    let saved = 0;
    let failed = 0;
    let skipped = 0;

    // Process companies in batches for better concurrency
    const BATCH_SIZE = 4;
    for (let batchStart = 0; batchStart < companies.length; batchStart += BATCH_SIZE) {
      // Check if import was stopped
      if (batchStart > 0) {
        const stopped = await checkIfSessionStopped(sessionId);
        if (stopped) {
          console.log(`[import-start] Import stopped by user after ${saved} companies`);
          break;
        }
      }

      const batch = companies.slice(batchStart, Math.min(batchStart + BATCH_SIZE, companies.length));

      // Process batch in parallel
      const batchResults = await Promise.allSettled(
        batch.map(async (company) => {
          const companyName = company.company_name || company.name || "";

          const normalizedDomain = toNormalizedDomain(
            company.website_url ||
              company.canonical_url ||
              company.url ||
              company.amazon_url ||
              company.normalized_domain ||
              ""
          );

          // Check if company already exists
          const existing = await findExistingCompany(container, normalizedDomain, companyName);
          if (existing) {
            console.log(`[import-start] Skipping duplicate company: ${companyName} (${normalizedDomain})`);
            return { type: "skipped" };
          }

          const finalNormalizedDomain = normalizedDomain && normalizedDomain !== "unknown" ? normalizedDomain : "unknown";

          // Fetch + upload logo for the company
          const companyId = `company_${Date.now()}_${Math.random().toString(36).slice(2)}`;

          const logoImport = await fetchLogo({
            companyId,
            domain: finalNormalizedDomain,
            websiteUrl: company.website_url || company.canonical_url || company.url || "",
            existingLogoUrl: company.logo_url || null,
          });

          // Calculate default rating based on company data
          const hasManufacturingLocations = Array.isArray(company.manufacturing_locations) && company.manufacturing_locations.length > 0;
          const hasHeadquarters = !!(company.headquarters_location && company.headquarters_location.trim());

          // Check for reviews from curated_reviews or legacy fields
          const hasCuratedReviews = Array.isArray(company.curated_reviews) && company.curated_reviews.length > 0;
          const hasEditorialReviews = (company.editorial_review_count || 0) > 0 ||
                                      (Array.isArray(company.reviews) && company.reviews.length > 0) ||
                                      hasCuratedReviews;

          const defaultRatingWithReviews = {
            star1: { value: hasManufacturingLocations ? 1.0 : 0.0, notes: [] },
            star2: { value: hasHeadquarters ? 1.0 : 0.0, notes: [] },
            star3: { value: hasEditorialReviews ? 1.0 : 0.0, notes: [] },
            star4: { value: 0.0, notes: [] },
            star5: { value: 0.0, notes: [] },
          };

          const doc = {
            id: companyId,
            company_name: companyName,
            name: company.name || companyName,
            url: company.url || company.website_url || company.canonical_url || "",
            website_url: company.website_url || company.canonical_url || company.url || "",
            industries: company.industries || [],
            product_keywords: company.product_keywords || "",
            keywords: Array.isArray(company.keywords) ? company.keywords : [],
            normalized_domain: finalNormalizedDomain,
            logo_url: logoImport.logo_url || null,
            logo_source_url: logoImport.logo_source_url || null,
            logo_import_status: logoImport.logo_import_status || "missing",
            logo_error: logoImport.logo_error || "",
            tagline: company.tagline || "",
            location_sources: Array.isArray(company.location_sources) ? company.location_sources : [],
            show_location_sources_to_users: Boolean(company.show_location_sources_to_users),
            hq_lat: company.hq_lat,
            hq_lng: company.hq_lng,
            headquarters_location: company.headquarters_location || "",
            headquarters_locations: company.headquarters_locations || [],
            headquarters: Array.isArray(company.headquarters) ? company.headquarters : Array.isArray(company.headquarters_locations) ? company.headquarters_locations : [],
            manufacturing_locations: company.manufacturing_locations || [],
            manufacturing_geocodes: Array.isArray(company.manufacturing_geocodes) ? company.manufacturing_geocodes : [],
            curated_reviews: Array.isArray(company.curated_reviews) ? company.curated_reviews : [],
            red_flag: Boolean(company.red_flag),
            red_flag_reason: company.red_flag_reason || "",
            location_confidence: company.location_confidence || "medium",
            social: company.social || {},
            amazon_url: company.amazon_url || "",
            rating_icon_type: "star",
            rating: defaultRatingWithReviews,
            source: "xai_import",
            session_id: sessionId,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };

          if (!doc.company_name && !doc.url) {
            throw new Error("Missing company_name and url");
          }

          await container.items.create(doc);
          return { type: "saved" };
        })
      );

      // Process batch results
      for (const result of batchResults) {
        if (result.status === "fulfilled") {
          if (result.value.type === "skipped") {
            skipped++;
          } else if (result.value.type === "saved") {
            saved++;
          }
        } else {
          failed++;
          console.warn(`[import-start] Failed to save company: ${result.reason?.message}`);
        }
      }
    }

    return { saved, failed, skipped };
  } catch (e) {
    console.error("[import-start] Error in saveCompaniesToCosmos:", e.message);
    return { saved: 0, failed: companies?.length || 0, skipped: 0 };
  }
}

// Max time to spend processing (4 minutes, safe from Azure's 5 minute timeout)
const MAX_PROCESSING_TIME_MS = 4 * 60 * 1000;

const importStartHandler = async (req, context) => {
    const requestId = generateRequestId(req);
    const responseHeaders = { "x-request-id": requestId };
    const jsonWithRequestId = (obj, status = 200) => json(obj, status, responseHeaders);

    console.log(`[import-start] request_id=${requestId} Function handler invoked`);

    try {
      const method = String(req.method || "").toUpperCase();
      if (method === "OPTIONS") {
        return {
          status: 200,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            "Access-Control-Allow-Headers": "content-type,x-functions-key",
            ...responseHeaders,
          },
        };
      }

      const payload = await readJsonBody(req);

      const proxyQuery = readQueryParam(req, "proxy");
      if (!Object.prototype.hasOwnProperty.call(payload || {}, "proxy") && proxyQuery !== undefined) {
        payload.proxy = proxyQuery;
      }

      const bodyObj = payload && typeof payload === "object" ? payload : {};
      const sessionId = bodyObj.session_id || `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;

      const startTime = Date.now();

      const normalizedQuery = String(bodyObj.query || "").trim();
      const normalizedLocation = String(bodyObj.location || "").trim();
      const normalizedLimit = Math.max(1, Math.min(25, Math.trunc(Number(bodyObj.limit) || 1)));

      const queryTypesRaw =
        Array.isArray(bodyObj.queryTypes)
          ? bodyObj.queryTypes
          : typeof bodyObj.queryTypes === "string"
            ? [bodyObj.queryTypes]
            : [];

      const queryTypes = queryTypesRaw
        .map((t) => String(t || "").trim())
        .filter(Boolean)
        .slice(0, 10);

      const normalizedQueryType =
        String(bodyObj.queryType || queryTypes[0] || "product_keyword").trim() || "product_keyword";

      bodyObj.query = normalizedQuery;
      bodyObj.location = normalizedLocation || "";
      bodyObj.limit = normalizedLimit;
      bodyObj.queryType = normalizedQueryType;
      bodyObj.queryTypes = queryTypes.length > 0 ? queryTypes : [normalizedQueryType];

      console.log(
        `[import-start] request_id=${requestId} session=${sessionId} normalized_request=` +
          JSON.stringify({
            session_id: sessionId,
            query: normalizedQuery,
            queryType: normalizedQueryType,
            queryTypes: bodyObj.queryTypes,
            location: normalizedLocation,
            limit: normalizedLimit,
            proxy: Object.prototype.hasOwnProperty.call(bodyObj, "proxy") ? bodyObj.proxy : undefined,
          })
      );

      const debugEnabled = bodyObj.debug === true || bodyObj.debug === "true";
      const debugOutput = debugEnabled
        ? {
            xai: {
              payload: null,
              prompt: null,
              raw_response: null,
              parse_error: null,
              parsed_companies: 0,
            },
            keywords_debug: [],
            reviews_debug: [],
            stages: [],
          }
        : null;

      let stage = "init";
      const buildInfo = getBuildInfo();
      const contextInfo = {
        company_name: String(payload?.company_name ?? "").trim(),
        website_url: String(payload?.website_url ?? "").trim(),
        normalized_domain: String(payload?.normalized_domain ?? "").trim(),
        xai_request_id: null,
      };
      let enrichedForCounts = [];

      const setStage = (nextStage, extra = {}) => {
        stage = String(nextStage || "unknown");

        if (extra && typeof extra === "object") {
          if (typeof extra.company_name === "string") contextInfo.company_name = extra.company_name;
          if (typeof extra.website_url === "string") contextInfo.website_url = extra.website_url;
          if (typeof extra.normalized_domain === "string") contextInfo.normalized_domain = extra.normalized_domain;
          if (typeof extra.xai_request_id === "string") contextInfo.xai_request_id = extra.xai_request_id;
        }

        if (debugOutput) {
          debugOutput.stages.push({ stage, ts: new Date().toISOString(), ...extra });
        }

        try {
          const extraKeys = extra && typeof extra === "object" ? Object.keys(extra) : [];
          if (extraKeys.length > 0) {
            console.log(
              `[import-start] request_id=${requestId} session=${sessionId} stage=${stage} extra=` +
                JSON.stringify(extra)
            );
          } else {
            console.log(`[import-start] request_id=${requestId} session=${sessionId} stage=${stage}`);
          }
        } catch {
          console.log(`[import-start] request_id=${requestId} session=${sessionId} stage=${stage}`);
        }
      };

      const respondError = async (err, { status = 500, details = {} } = {}) => {
        const errorMessage = toErrorString(err);
        const code =
          (details && typeof details.code === "string" && details.code.trim() ? details.code.trim() : null) ||
          (status === 400 ? "INVALID_REQUEST" : stage === "config" ? "IMPORT_START_NOT_CONFIGURED" : "IMPORT_START_FAILED");

        const message =
          (details && typeof details.message === "string" && details.message.trim()
            ? details.message.trim()
            : errorMessage) || "Import start failed";

        console.error(`[import-start] request_id=${requestId} session=${sessionId} stage=${stage} code=${code} message=${message}`);
        if (err?.stack) console.error(err.stack);

        const errorObj = {
          code,
          message,
          request_id: requestId,
          step: stage,
        };

        try {
          const container = getCompaniesCosmosContainer();
          if (container) {
            const errorDoc = {
              id: `_import_error_${sessionId}`,
              ...buildImportControlDocBase(sessionId),
              request_id: requestId,
              stage,
              error: errorObj,
              details: details && typeof details === "object" ? details : {},
            };
            await upsertItemWithPkCandidates(container, errorDoc);
          }
        } catch (e) {
          console.warn(
            `[import-start] request_id=${requestId} session=${sessionId} failed to write error doc: ${e?.message || String(e)}`
          );
        }

        const errorPayload = {
          ok: false,
          stage,
          session_id: sessionId,
          request_id: requestId,
          error: errorObj,
          legacy_error: message,
          ...buildInfo,
          company_name: contextInfo.company_name,
          website_url: contextInfo.website_url,
          normalized_domain: contextInfo.normalized_domain,
          xai_request_id: contextInfo.xai_request_id,
          ...(debugEnabled
            ? {
                stack: String(err?.stack || ""),
                counts: buildCounts({ enriched: enrichedForCounts, debugOutput }),
                debug: debugOutput,
              }
            : {}),
          ...(details && typeof details === "object" && Object.keys(details).length ? { details } : {}),
        };

        return jsonWithRequestId(errorPayload, status);
      };

      setStage("validate_request", {
        query: String(bodyObj.query || ""),
        queryType: String(bodyObj.queryType || ""),
        limit: Number(bodyObj.limit),
        location: String(bodyObj.location || ""),
      });

      const dryRun = bodyObj.dry_run === true || bodyObj.dry_run === "true";
      if (dryRun) {
        setStage("dry_run");
        return jsonWithRequestId(
          {
            ok: true,
            stage,
            session_id: sessionId,
            request_id: requestId,
            company_name: contextInfo.company_name,
            website_url: contextInfo.website_url,
            normalized_domain: contextInfo.normalized_domain,
            received: {
              query: String(bodyObj.query || ""),
              queryType: String(bodyObj.queryType || ""),
              queryTypes: Array.isArray(bodyObj.queryTypes) ? bodyObj.queryTypes : [],
              location: String(bodyObj.location || ""),
              limit: Number(bodyObj.limit) || 0,
            },
            ...buildInfo,
          },
          200
        );
      }

      if (!String(bodyObj.query || "").trim()) {
        return respondError(new Error("query is required"), {
          status: 400,
          details: {
            code: "IMPORT_START_VALIDATION_FAILED",
            message: "Query is required",
          },
        });
      }

      setStage("create_session");
      try {
        const container = getCompaniesCosmosContainer();
        if (container) {
          const sessionDoc = {
            id: `_import_session_${sessionId}`,
            ...buildImportControlDocBase(sessionId),
            created_at: new Date().toISOString(),
            request_id: requestId,
            request: {
              query: String(bodyObj.query || ""),
              queryType: String(bodyObj.queryType || ""),
              queryTypes: Array.isArray(bodyObj.queryTypes) ? bodyObj.queryTypes : [],
              location: String(bodyObj.location || ""),
              limit: Number(bodyObj.limit) || 0,
            },
          };
          const result = await upsertItemWithPkCandidates(container, sessionDoc);
          if (!result.ok) {
            console.warn(
              `[import-start] request_id=${requestId} session=${sessionId} failed to write session marker: ${result.error}`
            );
          }
        }
      } catch (e) {
        console.warn(
          `[import-start] request_id=${requestId} session=${sessionId} error writing session marker: ${e?.message || String(e)}`
        );
      }

      const hardTimeoutMs = Math.max(
        1000,
        Math.min(Number(bodyObj.hard_timeout_ms) || DEFAULT_HARD_TIMEOUT_MS, DEFAULT_HARD_TIMEOUT_MS)
      );

      const proxyRaw =
        Object.prototype.hasOwnProperty.call(bodyObj || {}, "proxy")
          ? bodyObj.proxy
          : readQueryParam(req, "proxy");

      const proxyDisabled = isProxyExplicitlyDisabled(proxyRaw);
      const proxyEnabled = isProxyExplicitlyEnabled(proxyRaw);

      let proxyBase = "";
      let proxySource = "";

      const proxyInfo = !proxyDisabled ? getImportStartProxyInfo() : { base: "", source: "" };
      proxyBase = proxyInfo.base;
      proxySource = proxyInfo.source;

      const proxyConfigured = Boolean(proxyBase);
      const proxyRequested = !proxyDisabled && (proxyEnabled || proxyConfigured);

      // Proxy is an optimization (to avoid SWA timeouts) and should never block production.
      if (proxyRequested) {
        if (proxyBase && isXaiPublicApiUrl(proxyBase)) {
          setStage("proxy_config", { upstream: proxyBase, proxy_source: proxySource });
          return respondError(new Error("Invalid proxy target: import-start cannot be proxied to XAI API"), {
            status: 500,
            details: {
              proxy_source: proxySource,
              upstream: proxyBase,
              message:
                "IMPORT_START_PROXY_BASE (or XAI_IMPORT_PROXY_BASE) must point to a Tabarnam-controlled import worker (e.g. an Azure App Service /api base). It must not point to https://api.x.ai/...",
            },
          });
        }

        if (proxyEnabled && !proxyBase) {
          const warning = {
            message:
              "Proxy was explicitly requested, but IMPORT_START_PROXY_BASE (or XAI_IMPORT_PROXY_BASE) is not configured. Falling back to local import.",
          };
          setStage("proxy_config", warning);
          if (debugOutput) debugOutput.proxy_warning = warning;
          console.warn("[import-start]", warning.message);
        }
      }

      const shouldProxy = proxyRequested && !!proxyBase;

      if (shouldProxy) {
        const upstreamTimeoutMs = Math.max(
          1000,
          Math.min(
            Number(bodyObj.upstream_timeout_ms) || DEFAULT_UPSTREAM_TIMEOUT_MS,
            Math.max(1000, hardTimeoutMs - 2000)
          )
        );

        setStage("proxyImportStart", { upstream: proxyBase, upstream_timeout_ms: upstreamTimeoutMs });

        const controller = new AbortController();
        let hardTimedOut = false;
        const timeoutId = setTimeout(() => {
          hardTimedOut = true;
          controller.abort();
        }, hardTimeoutMs);

        try {
          const key = getXAIKey();

          const base = proxyBase.replace(/\/$/, "");
          const candidatePaths = ["/import/start", "/import-start"]; // support both route styles

          let resp = null;
          let usedPath = candidatePaths[0];
          let usedUrl = `${base}${usedPath}`;

          for (const p of candidatePaths) {
            const url = `${base}${p}`;
            usedPath = p;
            usedUrl = url;

            const r = await axios.post(url, bodyObj, {
              headers: {
                "Content-Type": "application/json",
                ...(key
                  ? {
                      Authorization: `Bearer ${key}`,
                      "x-functions-key": key,
                    }
                  : {}),
              },
              timeout: upstreamTimeoutMs,
              signal: controller.signal,
              validateStatus: () => true,
            });

            resp = r;
            if (r.status !== 404) break;
          }

          setStage("proxyImportStart", { upstream_url: usedUrl, upstream_path: usedPath });

          const xaiRequestId = extractXaiRequestId(resp.headers);
          if (xaiRequestId) {
            setStage("proxyImportStart", { xai_request_id: xaiRequestId });
          }

          const parsed =
            typeof resp.data === "string"
              ? safeJsonParse(resp.data) ?? { message: resp.data }
              : resp.data;

          const body = parsed && typeof parsed === "object" ? parsed : { message: String(resp.data ?? "") };

          if (typeof body.ok !== "boolean") {
            body.ok = resp.status >= 200 && resp.status < 300;
          }

          if (!body.session_id) body.session_id = sessionId;
          if (!body.request_id) body.request_id = requestId;
          if (xaiRequestId && !body.xai_request_id) body.xai_request_id = xaiRequestId;

          const elapsedMs = Date.now() - startTime;
          const meta = body.meta && typeof body.meta === "object" ? body.meta : {};
          body.meta = {
            ...meta,
            mode: meta.mode || "proxy",
            elapsedMs,
            upstream: proxyBase,
            upstream_url: usedUrl,
          };

          return json(body, resp?.status || 502, responseHeaders);
        } catch (e) {
          const elapsedMs = Date.now() - startTime;
          const isTimeout =
            e?.code === "ECONNABORTED" ||
            e?.name === "CanceledError" ||
            String(e?.message || "").toLowerCase().includes("timeout") ||
            String(e?.message || "").toLowerCase().includes("aborted");

          if (hardTimedOut || isTimeout) {
            setStage("proxyImportStart", { timeout: true, elapsed_ms: elapsedMs });
            return respondError(new Error("timeout"), {
              status: 504,
              details: {
                upstream: proxyBase,
                elapsed_ms: elapsedMs,
                upstream_timeout_ms: upstreamTimeoutMs,
                hard_timeout_ms: hardTimeoutMs,
                original_error: toErrorString(e),
              },
            });
          }

          setStage("proxyImportStart");
          return respondError(e, {
            status: 502,
            details: { upstream: proxyBase, elapsed_ms: elapsedMs, upstream_timeout_ms: upstreamTimeoutMs },
          });
        } finally {
          clearTimeout(timeoutId);
        }
      }

      // Helper to check if we're running out of time
      const isOutOfTime = () => {
        const elapsed = Date.now() - startTime;
        return elapsed > MAX_PROCESSING_TIME_MS;
      };

      // Helper to check if we need to abort
      const shouldAbort = () => {
        if (isOutOfTime()) {
          console.warn(`[import-start] TIMEOUT: Processing exceeded ${MAX_PROCESSING_TIME_MS}ms limit`);
          return true;
        }
        return false;
      };

      try {
        const center = safeCenter(bodyObj.center);
        const queryTypesRaw = Array.isArray(bodyObj.queryTypes) ? bodyObj.queryTypes : [];
        const queryTypes = queryTypesRaw
          .map((t) => String(t || "").trim())
          .filter(Boolean)
          .slice(0, 10);

        const queryType = String(bodyObj.queryType || queryTypes[0] || "product_keyword").trim() || "product_keyword";
        const location = String(bodyObj.location || "").trim();

        const xaiPayload = {
          queryType: queryTypes.length > 0 ? queryTypes.join(", ") : queryType,
          queryTypes: queryTypes.length > 0 ? queryTypes : [queryType],
          query: bodyObj.query || "",
          location,
          limit: Math.max(1, Math.min(Number(bodyObj.limit) || 10, 25)),
          expand_if_few: bodyObj.expand_if_few ?? true,
          session_id: sessionId,
          ...(center ? { center } : {}),
        };

        console.log(`[import-start] XAI Payload:`, JSON.stringify(xaiPayload));
        if (debugOutput) {
          debugOutput.xai.payload = xaiPayload;
        }

        // Use a more aggressive timeout to ensure we finish before Azure kills the function
        // Limit to 2 minutes per API call to stay well within Azure's 5 minute limit
        const requestedTimeout = Number(bodyObj.timeout_ms) || 600000;
        const timeout = Math.min(requestedTimeout, 2 * 60 * 1000);
        console.log(`[import-start] Request timeout: ${timeout}ms (requested: ${requestedTimeout}ms)`);

        // Get XAI configuration (consolidated to use XAI_EXTERNAL_BASE primarily)
        const xaiUrl = getXAIEndpoint();
        const xaiKey = getXAIKey();

        console.log(`[import-start] XAI Endpoint: ${xaiUrl ? "configured" : "NOT SET"}`);
        console.log(`[import-start] XAI Key: ${xaiKey ? "configured" : "NOT SET"}`);
        console.log(`[import-start] Config source: ${process.env.XAI_EXTERNAL_BASE ? "XAI_EXTERNAL_BASE" : process.env.FUNCTION_URL ? "FUNCTION_URL (legacy)" : "none"}`);

        if (!xaiUrl || !xaiKey) {
          setStage("config");
          return respondError(new Error("XAI not configured"), {
            status: 500,
            details: {
              message: "Please set XAI_EXTERNAL_BASE and XAI_EXTERNAL_KEY environment variables",
            },
          });
        }

        // Early check: if import was already stopped, return immediately
        const wasAlreadyStopped = await checkIfSessionStopped(sessionId);
        if (wasAlreadyStopped) {
          setStage("stopped");
          console.log(`[import-start] session=${sessionId} stop signal detected before XAI call`);
          return jsonWithRequestId(
            {
              ok: false,
              stage,
              session_id: sessionId,
              request_id: requestId,
              error: {
                code: "IMPORT_STOPPED",
                message: "Import was stopped",
                request_id: requestId,
                step: stage,
              },
              legacy_error: "Import was stopped",
              ...buildInfo,
              companies: [],
              saved: 0,
            },
            200
          );
        }

        // Build XAI request message with PRIORITY on HQ and manufacturing locations
        const xaiMessage = {
          role: "user",
          content: `You are a business research assistant specializing in manufacturing location extraction. Find and return information about ${xaiPayload.limit} DIFFERENT companies or products based on this search.

Search query: "${xaiPayload.query}"
Search type(s): ${xaiPayload.queryType}
${xaiPayload.location ? `
Location boost: "${xaiPayload.location}"
- If you can, prefer and rank higher companies whose HQ or manufacturing locations match this location.
- The location is OPTIONAL; do not block the import if it is empty.
` : ""}

CRITICAL PRIORITY #1: HEADQUARTERS & MANUFACTURING LOCATIONS (THIS IS THE TOP VALUE PROP)
These location fields are FIRST-CLASS and non-negotiable. Be AGGRESSIVE and MULTI-SOURCE in extraction - do not accept "website is vague" as final answer.

1. HEADQUARTERS LOCATION (Required, high priority):
   - Extract the company's headquarters location at minimum: city, state/region, country.
   - If no street address is available, that is acceptable - city + state/region + country is the minimum acceptable.
   - Use the company's official "Headquarters", "Head Office", or primary corporate address.
   - Check: Official website's About/Contact pages, LinkedIn company profile, Crunchbase, business directories.
   - If the website's Contact page is missing/404, use the header/footer contact info and the Terms/Privacy pages for the company address.
   - Acceptable formats: "San Francisco, CA, USA" or "London, UK" or "Tokyo, Japan"

   IMPORTANT: Government Buyer Guides and Business Directories often list headquarters with complete address.
   Examples: Yumpu (government buyers guide), Dun & Bradstreet, LinkedIn, Crunchbase, Google Business, SIC/NAICS registries.

2. MANUFACTURING LOCATIONS (Array, STRONGLY REQUIRED - be aggressive and multi-source):
   - Gather ALL identifiable manufacturing, production, factory, and plant locations from ALL available sources.
   - Return as an array of strings, each string being a location. DO NOT leave this empty unless there is truly no credible signal.
   - Acceptable detail per entry: Full address OR City + state/region + country OR country only (e.g., "United States", "China").
   - "Country only" manufacturing locations are FULLY ACCEPTABLE and PREFERRED over empty array.
   - Examples of acceptable results: ["Charlotte, NC, USA", "Shanghai, China", "Vietnam", "United States", "Mexico"]

   PRIMARY SOURCES (check ALL of these first):
   a) Official website: "Facilities", "Plants", "Manufacturing", "Where We Make", "Our Factories", "Production Sites" pages
   b) Product pages: Any "Made in X" labels or manufacturing claims on product listings and packaging photos
   c) FAQ or policy pages: "Where is this made?", "Manufacturing standards", "Supply chain" sections
   d) About/Sustainability: "Where we produce", "Supply chain transparency", "Ethical sourcing" pages
   e) Job postings: Roles mentioning "factory", "plant", "warehouse", "production", "manufacturing" reveal facility locations
   f) LinkedIn company profile: Manufacturing locations and facility information often listed in company description

   SECONDARY SOURCES - USE THESE AGGRESSIVELY WHEN PRIMARY SOURCES ARE VAGUE (these are just as credible):
   g) Government Buyer Guides & Federal Databases:
      - Yumpu government buyer guide listings (often list exact location, products, "all made in USA" claims)
      - GSA Schedules and federal procurement databases
      - State business registrations and Secretary of State records
      - These databases often capture manufacturer status and location explicitly

   h) B2B and Industrial Manufacturer Directories:
      - Thomas Register (thomasnet.com) - explicitly lists manufacturers by industry and location
      - SIC/NAICS manufacturer registries
      - Industrial manufacturer databases (SJN databases, Kompass, etc.)
      - These sources EXPLICITLY note if a company is a "Manufacturer" vs. reseller, and list facility locations

   i) Public Import/Export Records and Trade Data:
      - Customs data, shipping records, and trade databases showing origin countries
      - Alibaba, Global Sources, and other trade platform records showing source locations
      - Repeated shipments from specific countries (China, Vietnam, etc.) indicate manufacturing origin

   j) Supplier Databases and Records:
      - Known suppliers and manufacturing partners reveal facility regions
      - Supply chain data aggregators often show where goods originate

   k) Packaging and Product Labeling:
      - "Made in..." text on actual product images, packaging, inserts, or labels found online
      - Manufacturing claims in product descriptions and certifications

   l) Media, Press, and Third-Party Sources:
      - Industry articles, news, blog posts, or investigations mentioning manufacturing locations
      - Product review sites that mention where items are made
      - LinkedIn company posts discussing facilities or manufacturing

   m) Financial/Regulatory Filings:
      - SEC filings, annual reports, business registrations mentioning facilities
      - Patent filings showing inventor locations (sometimes reveals manufacturing)

   INFERENCE RULES FOR MANUFACTURING LOCATIONS:
   - If a brand shows repeated shipments from a specific region in trade records (China, Vietnam, Mexico), include that region
   - If government guides or B2B directories list the company as a "Manufacturer" with specific location, include that location
   - If packaging or product listings consistently say "Made in [X]", include X even if the brand website doesn't explicitly state it
   - If multiple independent sources consistently point to one or more countries, include those countries
   - "All made in the USA" or similar inclusive statements → manufacturing_locations: ["United States"]
   - If only country-level information is available after exhaustive checking, country-only entries are FULLY VALID and PREFERRED
   - When inferring from suppliers, customs, packaging, or government guides, set location_confidence to "medium" and note the inference source in red_flag_reason
   - Inferred manufacturing locations from secondary sources should NOT trigger red_flag: true (the flag is only for completely unknown locations)

3. CONFIDENCE AND RED FLAGS:
   - location_confidence: "high" if HQ and manufacturing are clearly stated on official site; "medium" if inferred from reliable secondary sources (government guides, B2B directories, customs, packaging); "low" if from limited sources
   - If HQ is found but manufacturing is completely unknown AFTER exhaustive checking → red_flag: true, reason: "Manufacturing location unknown, not found in official site, government guides, B2B directories, customs records, or packaging"
   - If manufacturing is inferred from government guides, B2B directories, customs data, suppliers, or packaging → red_flag: false (this is NOT a reason to flag), location_confidence: "medium"
   - If BOTH HQ and manufacturing are documented → red_flag: false, reason: ""
   - Only leave manufacturing_locations empty and red_flag: true if there is TRULY no credible signal after checking government guides, B2B directories, custom records, supplier data, packaging, and media

4. SOURCE PRIORITY FOR HQ:
   a) Official website: About, Contact, Locations, Head Office sections
   b) Government Buyer Guides and business databases (Yumpu, GSA, state registrations)
   c) B2B directories (Thomas Register, etc.) and LinkedIn company profile
   d) Crunchbase / public business directories
   e) News and public records

5. LOCATION SOURCES (Required for structured data):
   - For EVERY location (both HQ and manufacturing) you extract, provide the source information in location_sources array
   - Each entry in location_sources must have:
     a) location: the exact location string (e.g., "San Francisco, CA, USA")
     b) source_url: the URL where this location was found (or empty string if no specific URL)
     c) source_type: one of: official_website, government_guide, b2b_directory, trade_data, packaging, media, other
     d) location_type: either "headquarters" or "manufacturing"
   - This allows us to display source attribution to users and verify data quality
   - Example: { "location": "Shanghai, China", "source_url": "https://company.com/facilities", "source_type": "official_website", "location_type": "manufacturing" }

6. TAGLINE (Optional but valuable):
   - Extract the company's official tagline, mission statement, or brand slogan if available
   - Check: Company website homepage, About page, marketing materials, "Tagline" or "Slogan" field
   - If no explicit tagline found, leave empty (do NOT fabricate)
   - Example: "Tagline": "Where Quality Meets Innovation" or empty string ""

7. PRODUCT KEYWORDS (Required - MUST follow these rules strictly):
   You are extracting structured product intelligence for a consumer-facing company.
   Your task is to generate a comprehensive, concrete list of the company’s actual products and product categories.
   Rules:
   • Return up to 25 product keywords
   • Each keyword must be a real product, product line, or specific product category
   • Avoid vague marketing terms (e.g., “premium,” “high-quality,” “innovative,” “lifestyle”)
   • Prefer noun-based product names
   • Include both flagship products and secondary products
   • If exact product names are not available, infer industry-standard product types sold by the company
   • Do NOT repeat near-duplicates (e.g., “water bottle” and “bottles”)
   • Do NOT include services unless the company primarily sells services
   Output format for product_keywords field:
   • Return a comma-separated list
   • Maximum 25 items
   • No explanations or extra text

CRITICAL REQUIREMENTS FOR THIS SEARCH:
- Do NOT return empty manufacturing_locations arrays unless you have exhaustively checked government guides, B2B directories, and trade data
- Do NOT treat "not explicitly stated on website" as "manufacturing location unknown" - use secondary sources
- Always prefer country-level manufacturing locations (e.g., "United States") over empty arrays
- Government Buyer Guides (like Yumpu entries) are CREDIBLE PRIMARY sources for both HQ and manufacturing claims
- Companies listed in B2B manufacturer directories should have their listed location included
- For EACH location returned, MUST have a corresponding entry in location_sources array (this is non-negotiable)

SECONDARY: DIVERSITY & COVERAGE
- Prioritize smaller, regional, and lesser-known companies (40% small/regional/emerging, 35% mid-market, 25% major brands)
- Return DIVERSE companies - independent manufacturers, local producers, regional specialists, family-owned businesses, emerging/niche players
- Include regional and international companies
- Verify each company URL is valid

FORMAT YOUR RESPONSE AS A VALID JSON ARRAY. EACH OBJECT MUST HAVE:
- company_name (string): Exact company name
- website_url (string): Valid company website URL (must work)
- industries (array): Industry categories
- product_keywords (string): Comma-separated list of up to 25 concrete product keywords (real products/product lines/product categories; no vague marketing terms; prefer noun phrases; include flagship + secondary products; infer industry-standard product types if needed; no near-duplicates; no services unless primarily services)
- headquarters_location (string, REQUIRED): "City, State/Region, Country" format (or empty string ONLY if truly unknown after checking all sources)
- manufacturing_locations (array, REQUIRED): Array of location strings (MUST include all credible sources - official, government guides, B2B directories, suppliers, customs, packaging labels). Use country-only entries (e.g., "United States") if that's all that's known.
- location_sources (array, REQUIRED): Array of objects with structure: { "location": "City, State, Country", "source_url": "https://...", "source_type": "official_website|government_guide|b2b_directory|trade_data|packaging|media|other", "location_type": "headquarters|manufacturing" }. Include ALL sources found for both HQ and manufacturing locations.
- red_flag (boolean, REQUIRED): true only if HQ unknown or manufacturing completely unverifiable despite exhaustive checking of ALL sources including government guides and B2B directories
- red_flag_reason (string, REQUIRED): Explanation if red_flag=true, empty string if false; may note if manufacturing was inferred from secondary sources
- hq_lat (number, optional): Headquarters latitude
- hq_lng (number, optional): Headquarters longitude
- amazon_url (string, optional): Amazon storefront URL
- tagline (string, optional): Company's official tagline or mission statement (from website or marketing materials)
- social (object, optional): Social media URLs {linkedin, instagram, x, twitter, facebook, tiktok, youtube}
- location_confidence (string, optional): "high", "medium", or "low" based on data quality and sources used

IMPORTANT FINAL RULES:
1. For companies with vague or missing manufacturing info on their website, ALWAYS check government guides, B2B directories, suppliers, import records, packaging claims, and third-party sources BEFORE returning an empty manufacturing_locations array.
2. Country-only manufacturing locations (e.g., ["United States"]) are FULLY ACCEPTABLE results - do NOT treat them as incomplete.
3. If government sources (like Yumpu buyer guides) list "all made in the USA", return manufacturing_locations: ["United States"] with high confidence.
4. Only flag as red_flag: true when you have actually exhaustively checked all sources listed above and still have no credible signal.

Return ONLY the JSON array, no other text. Return at least ${Math.max(1, xaiPayload.limit)} diverse results if possible.`,
        };

        if (debugOutput) {
          debugOutput.xai.prompt = xaiMessage.content;
        }

        const xaiRequestPayload = {
          messages: [xaiMessage],
          model: "grok-4-latest",
          temperature: 0.1,
          stream: false,
        };

        try {
          setStage("searchCompanies", {
            queryType: xaiPayload.queryType,
            query: xaiPayload.query,
            limit: xaiPayload.limit,
          });

          console.log(`[import-start] session=${sessionId} xai request payload = ${JSON.stringify(xaiPayload)}`);
          console.log(`[import-start] Calling XAI API at: ${xaiUrl}`);
          const xaiResponse = await axios.post(xaiUrl, xaiRequestPayload, {
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${xaiKey}`,
          },
          timeout: timeout,
        });

        const elapsed = Date.now() - startTime;
        console.log(`[import-start] session=${sessionId} xai response status=${xaiResponse.status}`);

        const xaiRequestId = extractXaiRequestId(xaiResponse.headers);
        if (xaiRequestId) {
          setStage("searchCompanies", { xai_request_id: xaiRequestId });
          if (debugOutput) debugOutput.xai.request_id = xaiRequestId;
        }

        if (xaiResponse.status >= 200 && xaiResponse.status < 300) {
          // Extract the response content
          const responseText = xaiResponse.data?.choices?.[0]?.message?.content || JSON.stringify(xaiResponse.data);
          console.log(`[import-start] XAI response preview: ${responseText.substring(0, 100)}...`);

          // Parse the JSON array from the response
          let companies = [];
          let parseError = null;
          try {
            const jsonMatch = responseText.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
              companies = JSON.parse(jsonMatch[0]);
              if (!Array.isArray(companies)) companies = [];
            }
          } catch (parseErr) {
            parseError = parseErr?.message || String(parseErr);
            console.warn(`[import-start] session=${sessionId} failed to parse companies from response: ${parseError}`);
            companies = [];
          }

          if (debugOutput) {
            debugOutput.xai.raw_response = responseText.length > 50000 ? responseText.slice(0, 50000) : responseText;
            debugOutput.xai.parse_error = parseError;
            debugOutput.xai.parsed_companies = Array.isArray(companies) ? companies.length : 0;
          }

          console.log(`[import-start] session=${sessionId} xai response status=${xaiResponse.status} companies=${companies.length}`);

          setStage("enrichCompany");
          const center = safeCenter(bodyObj.center);
          let enriched = companies.map((c) => enrichCompany(c, center));
          enrichedForCounts = enriched;

          // Early exit if no companies found
          if (enriched.length === 0) {
            console.log(`[import-start] session=${sessionId} no companies found in XAI response, returning early`);

            // Write a completion marker so import-progress knows this session is done with 0 results
            try {
              const container = getCompaniesCosmosContainer();
              if (container) {
                const completionDoc = {
                  id: `_import_complete_${sessionId}`,
                  ...buildImportControlDocBase(sessionId),
                  completed_at: new Date().toISOString(),
                  reason: "no_results_from_xai",
                  saved: 0,
                };

                const result = await upsertItemWithPkCandidates(container, completionDoc);
                if (!result.ok) {
                  console.warn(
                    `[import-start] request_id=${requestId} session=${sessionId} failed to upsert completion marker: ${result.error}`
                  );
                } else {
                  console.log(`[import-start] request_id=${requestId} session=${sessionId} completion marker written`);
                }
              }
            } catch (e) {
              console.warn(
                `[import-start] request_id=${requestId} session=${sessionId} error writing completion marker: ${e?.message || String(e)}`
              );
            }

            return jsonWithRequestId(
              {
                ok: true,
                session_id: sessionId,
                request_id: requestId,
                company_name: contextInfo.company_name,
                website_url: contextInfo.website_url,
                companies: [],
                meta: {
                  mode: "direct",
                  expanded: false,
                  timedOut: false,
                  elapsedMs: Date.now() - startTime,
                  no_results_reason: "XAI returned empty response",
                },
                saved: 0,
                skipped: 0,
                failed: 0,
              },
              200
            );
          }

          // Ensure product keywords exist and persistable
          async function mapWithConcurrency(items, concurrency, mapper) {
            const out = new Array(items.length);
            let idx = 0;

            const workers = new Array(Math.max(1, concurrency)).fill(0).map(async () => {
              while (idx < items.length) {
                const cur = idx++;
                try {
                  out[cur] = await mapper(items[cur], cur);
                } catch {
                  out[cur] = items[cur];
                }
              }
            });

            await Promise.all(workers);
            return out;
          }

          async function generateProductKeywords(company, { timeoutMs }) {
            const companyName = String(company?.company_name || company?.name || "").trim();
            const websiteUrl = String(company?.website_url || company?.url || "").trim();
            const tagline = String(company?.tagline || "").trim();

            const websiteText = await (async () => {
              const h = await checkUrlHealthAndFetchText(websiteUrl, {
                timeoutMs: Math.min(8000, timeoutMs),
                maxBytes: 80000,
              }).catch(() => null);
              return h?.ok ? String(h.text || "").slice(0, 4000) : "";
            })();

            const prompt = `SYSTEM (KEYWORDS / PRODUCTS LIST)
You are generating a comprehensive product keyword list for a company to power search and filtering.
Company:
• Name: ${companyName}
• Website: ${websiteUrl}
• Short description/tagline (if available): ${tagline}
Rules:
• Output ONLY a JSON object with a single field: "keywords".
• "keywords" must be an array of 15 to 25 short product phrases the company actually sells or makes.
• Use product-level specificity (e.g., "insulated cooler", "hard-sided cooler", "travel tumbler") not vague categories (e.g., "outdoor", "quality", "premium").
• Do NOT include brand name, company name, marketing adjectives, or locations.
• Do NOT repeat near-duplicates.
• If uncertain, infer from the website content and product collections; prioritize what is most likely sold.
${websiteText ? `\nWebsite content excerpt:\n${websiteText}\n` : ""}
Output JSON only:
{ "keywords": ["...", "..."] }`;

            const payload = {
              messages: [{ role: "user", content: prompt }],
              model: "grok-4-latest",
              temperature: 0.2,
              stream: false,
            };

            const res = await axios.post(xaiUrl, payload, {
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${xaiKey}`,
              },
              timeout: timeoutMs,
            });

            const text = res?.data?.choices?.[0]?.message?.content || "";

            let obj = null;
            try {
              const match = text.match(/\{[\s\S]*\}/);
              if (match) obj = JSON.parse(match[0]);
            } catch {
              obj = null;
            }

            const keywords = normalizeProductKeywords(obj?.keywords, {
              companyName,
              websiteUrl,
            });

            return {
              prompt,
              raw_response: text.length > 20000 ? text.slice(0, 20000) : text,
              keywords,
            };
          }

          async function ensureCompanyKeywords(company) {
            const companyName = String(company?.company_name || company?.name || "").trim();
            const websiteUrl = String(company?.website_url || company?.url || "").trim();

            const initialList = normalizeProductKeywords(company?.keywords || company?.product_keywords, {
              companyName,
              websiteUrl,
            });

            let finalList = initialList.slice(0, 25);
            const debugEntry = {
              company_name: companyName,
              website_url: websiteUrl,
              initial_count: initialList.length,
              initial_keywords: initialList,
              generated: false,
              generated_count: 0,
              final_count: 0,
              final_keywords: [],
              prompt: null,
              raw_response: null,
            };

            if (finalList.length < 10 && companyName && websiteUrl) {
              try {
                const gen = await generateProductKeywords(company, { timeoutMs: Math.min(timeout, 20000) });
                debugEntry.generated = true;
                debugEntry.prompt = gen.prompt;
                debugEntry.raw_response = gen.raw_response;
                debugEntry.generated_count = gen.keywords.length;

                const merged = [...finalList, ...gen.keywords];
                finalList = normalizeProductKeywords(merged, { companyName, websiteUrl }).slice(0, 25);
              } catch (e) {
                debugEntry.generated = true;
                debugEntry.raw_response = e?.message || String(e);
              }
            }

            company.keywords = finalList;
            company.product_keywords = keywordListToString(finalList);

            debugEntry.final_keywords = finalList;
            debugEntry.final_count = finalList.length;

            if (debugOutput) debugOutput.keywords_debug.push(debugEntry);

            return company;
          }

          setStage("generateKeywords");
          enriched = await mapWithConcurrency(enriched, 4, ensureCompanyKeywords);
          enrichedForCounts = enriched;

          // Geocode and persist per-location coordinates (HQ + manufacturing)
          setStage("geocodeLocations");
          console.log(`[import-start] session=${sessionId} geocoding start count=${enriched.length}`);
          for (let i = 0; i < enriched.length; i++) {
            if (shouldAbort()) {
              console.log(`[import-start] session=${sessionId} aborting during geocoding: time limit exceeded`);
              break;
            }

            const stopped = await checkIfSessionStopped(sessionId);
            if (stopped) {
              console.log(`[import-start] session=${sessionId} stop signal detected, aborting during geocoding`);
              break;
            }

            const company = enriched[i];
            try {
              enriched[i] = await geocodeCompanyLocations(company, { timeoutMs: 5000 });
            } catch (e) {
              console.log(`[import-start] session=${sessionId} geocoding failed for ${company?.company_name || "(unknown)"}: ${e?.message || String(e)}`);
            }
          }

          const okCount = enriched.filter((c) => Number.isFinite(c.hq_lat) && Number.isFinite(c.hq_lng)).length;
          console.log(`[import-start] session=${sessionId} geocoding done success=${okCount} failed=${enriched.length - okCount}`);

          // Fetch editorial reviews for companies
          if (!shouldAbort()) {
            setStage("fetchEditorialReviews");
            console.log(`[import-start] session=${sessionId} editorial review enrichment start count=${enriched.length}`);
            for (let i = 0; i < enriched.length; i++) {
              // Check if import was stopped OR we're running out of time
              if (shouldAbort()) {
                console.log(`[import-start] session=${sessionId} aborting during review fetch: time limit exceeded`);
                break;
              }

              const stopped = await checkIfSessionStopped(sessionId);
              if (stopped) {
                console.log(`[import-start] session=${sessionId} stop signal detected, aborting during review fetch`);
                break;
              }

              const company = enriched[i];
              setStage("fetchEditorialReviews", {
                company_name: String(company?.company_name || company?.name || ""),
                website_url: String(company?.website_url || company?.url || ""),
                normalized_domain: String(company?.normalized_domain || ""),
              });

              if (company.company_name && company.website_url) {
                const editorialReviews = await fetchEditorialReviews(
                  company,
                  xaiUrl,
                  xaiKey,
                  timeout,
                  debugOutput ? debugOutput.reviews_debug : null,
                  { setStage }
                );
                if (editorialReviews.length > 0) {
                  enriched[i] = { ...company, curated_reviews: editorialReviews };
                  console.log(`[import-start] session=${sessionId} fetched ${editorialReviews.length} editorial reviews for ${company.company_name}`);
                } else {
                  enriched[i] = { ...company, curated_reviews: [] };
                }
              } else {
                enriched[i] = { ...company, curated_reviews: [] };
              }
            }
            console.log(`[import-start] session=${sessionId} editorial review enrichment done`);
          }

          // Check if any companies have missing or weak location data
          // Trigger refinement if: HQ is missing, manufacturing is missing, or confidence is low (aggressive approach)
          const companiesNeedingLocationRefinement = enriched.filter(c =>
            (!c.headquarters_location || c.headquarters_location === "") ||
            (!c.manufacturing_locations || c.manufacturing_locations.length === 0) ||
            (c.location_confidence === "low")
          );

          // Location refinement pass: if too many companies have missing locations, run a refinement
          // But skip if we're running out of time
          if (companiesNeedingLocationRefinement.length > 0 && enriched.length > 0 && !shouldAbort()) {
            console.log(`[import-start] ${companiesNeedingLocationRefinement.length} companies need location refinement`);

            try {
              // Build refinement prompt focusing only on HQ + manufacturing locations
              const refinementMessage = {
                role: "user",
                content: `You are a research assistant specializing in company location data.
For the following companies, you previously found some information but HQ and/or manufacturing locations were missing or unclear.
AGGRESSIVELY re-check ONLY for headquarters location and manufacturing locations using ALL available sources.

SOURCES TO CHECK (in order):
1. Official website (About, Contact, Facilities, Manufacturing, Where We Make pages)
2. Government Buyer Guides (like Yumpu entries) - often list exact headquarters and "made in USA" claims
3. B2B/Industrial Manufacturer Directories (Thomas Register, SIC/NAICS registries, manufacturer databases)
4. LinkedIn company profile and product pages
5. Public import/export records and trade data showing manufacturing origin countries
6. Supplier databases and known manufacturing partners
7. Packaging labels and product descriptions mentioning "Made in..."
8. Media articles, product reviews, and third-party sources
9. Crunchbase and other business databases

CRITICAL RULES FOR MANUFACTURING LOCATIONS:
- Government Buyer Guide entries (Yumpu, GSA, etc.) listing "all made in USA" or similar → INCLUDE "United States" in manufacturing_locations
- B2B directories explicitly noting "Manufacturer" status + location → INCLUDE that location
- Repeated origin countries in trade/customs data → INCLUDE those countries
- Packaging claims "Made in [X]" → INCLUDE X
- Do NOT return empty manufacturing_locations arrays - prefer country-only entries (e.g., "United States", "China") if that's all that's known
- Country-only manufacturing locations are FULLY ACCEPTABLE and PREFERRED

Companies needing refinement:
${companiesNeedingLocationRefinement.map(c => `- ${c.company_name} (${c.url || 'N/A'}) - missing: ${!c.headquarters_location ? 'HQ' : ''} ${!c.manufacturing_locations || c.manufacturing_locations.length === 0 ? 'Manufacturing' : ''}`).join('\n')}

For EACH company, return ONLY:
{
  "company_name": "exact name",
  "headquarters_location": "City, State/Region, Country OR empty string ONLY if truly not found after checking all sources",
  "manufacturing_locations": ["location1", "location2", ...] (MUST include countries/locations from all sources checked - never empty unless exhaustively confirmed unknown),
  "red_flag": true/false,
  "red_flag_reason": "explanation if red_flag true, empty string if false; may note inference source (e.g., 'Inferred from customs records')",
  "location_confidence": "high|medium|low"
}

IMPORTANT:
- NEVER return empty manufacturing_locations after checking government guides, B2B directories, and trade data
- ALWAYS prefer "United States" or "China" over empty array
- Inferred locations from secondary sources are valid and do NOT require red_flag: true

Focus ONLY on location accuracy. Return a JSON array with these objects.
Return ONLY the JSON array, no other text.`,
              };

              const refinementPayload = {
                messages: [refinementMessage],
                model: "grok-4-latest",
                temperature: 0.1,
                stream: false,
              };

              console.log(`[import-start] Running location refinement pass for ${companiesNeedingLocationRefinement.length} companies`);
              const refinementResponse = await axios.post(xaiUrl, refinementPayload, {
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${xaiKey}`,
                },
                timeout: timeout,
              });

              if (refinementResponse.status >= 200 && refinementResponse.status < 300) {
                const refinementText = refinementResponse.data?.choices?.[0]?.message?.content || "";
                console.log(`[import-start] Refinement response preview: ${refinementText.substring(0, 100)}...`);

                let refinedLocations = [];
                try {
                  const jsonMatch = refinementText.match(/\[[\s\S]*\]/);
                  if (jsonMatch) {
                    refinedLocations = JSON.parse(jsonMatch[0]);
                    if (!Array.isArray(refinedLocations)) refinedLocations = [];
                  }
                } catch (parseErr) {
                  console.warn(`[import-start] Failed to parse refinement response: ${parseErr.message}`);
                }

                console.log(`[import-start] Refinement returned ${refinedLocations.length} location updates`);

                // Merge refinement results back into enriched companies
                if (refinedLocations.length > 0) {
                  const refinementMap = new Map();
                  refinedLocations.forEach(rl => {
                    const name = (rl.company_name || "").toLowerCase();
                    if (name) refinementMap.set(name, rl);
                  });

                  enriched = enriched.map(company => {
                    const companyName = (company.company_name || "").toLowerCase();
                    const refinement = refinementMap.get(companyName);
                    if (refinement) {
                      // Properly handle manufacturing_locations which might be a string or array
                      let refinedMfgLocations = refinement.manufacturing_locations || company.manufacturing_locations || [];
                      if (typeof refinedMfgLocations === 'string') {
                        refinedMfgLocations = refinedMfgLocations.trim() ? [refinedMfgLocations.trim()] : [];
                      }

                      return {
                        ...company,
                        headquarters_location: refinement.headquarters_location || company.headquarters_location || "",
                        manufacturing_locations: refinedMfgLocations,
                        red_flag: refinement.red_flag !== undefined ? refinement.red_flag : company.red_flag,
                        red_flag_reason: refinement.red_flag_reason !== undefined ? refinement.red_flag_reason : company.red_flag_reason || "",
                        location_confidence: refinement.location_confidence || company.location_confidence || "medium",
                      };
                    }
                    return company;
                  });

                  // Re-geocode refined companies (HQ + manufacturing)
                  console.log(`[import-start] Re-geocoding refined companies`);
                  for (let i = 0; i < enriched.length; i++) {
                    const company = enriched[i];
                    const wasUpdated = refinedLocations.some(
                      (rl) => (rl.company_name || "").toLowerCase() === (company.company_name || "").toLowerCase()
                    );
                    if (!wasUpdated) continue;
                    try {
                      enriched[i] = await geocodeCompanyLocations(company, { timeoutMs: 5000 });
                    } catch (e) {
                      console.log(`[import-start] Re-geocoding failed for ${company?.company_name || "(unknown)"}: ${e?.message || String(e)}`);
                    }
                  }

                  console.log(`[import-start] Merged refinement data back into companies`);
                }
              }
            } catch (refinementErr) {
              console.warn(`[import-start] Location refinement pass failed: ${refinementErr.message}`);
              // Continue with original data if refinement fails
            }
          }

          let saveResult = { saved: 0, failed: 0, skipped: 0 };
          if (enriched.length > 0) {
            setStage("saveCompaniesToCosmos");
            console.log(`[import-start] session=${sessionId} saveCompaniesToCosmos start count=${enriched.length}`);
            saveResult = await saveCompaniesToCosmos(enriched, sessionId, timeout);
            console.log(`[import-start] session=${sessionId} saveCompaniesToCosmos done saved=${saveResult.saved} skipped=${saveResult.skipped} duplicates=${saveResult.skipped}`);
          }

          // If expand_if_few is enabled and we got very few results (or all were skipped), try alternative search
          // But skip if we're running out of time
          const minThreshold = Math.max(1, Math.ceil(xaiPayload.limit * 0.6));
          if (xaiPayload.expand_if_few && (saveResult.saved + saveResult.failed) < minThreshold && companies.length > 0 && !shouldAbort()) {
            console.log(`[import-start] Few results found (${saveResult.saved} saved, ${saveResult.skipped} skipped). Attempting expansion search.`);

            try {
              // Create a more general search prompt for related companies
              const expansionMessage = {
                role: "user",
                content: `You previously found companies for "${xaiPayload.query}" (${xaiPayload.queryType}).
Find ${xaiPayload.limit} MORE DIFFERENT companies that are related to "${xaiPayload.query}" (search type(s): ${xaiPayload.queryType}${xaiPayload.location ? `, location boost: ${xaiPayload.location}` : ""}) but were not in the previous results.
PRIORITIZE finding smaller, regional, and lesser-known companies that are alternatives to major brands.
Focus on independent manufacturers, craft producers, specialty companies, and regional players that serve the same market.

For EACH company, you MUST AGGRESSIVELY extract:
1. headquarters_location: City, State/Region, Country format (required - check official site, government buyer guides, B2B directories, LinkedIn, Crunchbase)
2. manufacturing_locations: Array of locations from ALL sources including:
   - Official site and product pages
   - Government Buyer Guides (Yumpu, GSA, etc.) - often list manufacturing explicitly
   - B2B/Industrial Manufacturer Directories (Thomas Register, etc.)
   - Supplier and import/export records
   - Packaging claims and "Made in..." labels
   - Media articles
   Be AGGRESSIVE in extraction - NEVER return empty without exhaustively checking all sources above
   - Country-only entries (e.g., "United States", "China") are FULLY ACCEPTABLE

Format your response as a valid JSON array with this structure:
- company_name (string)
- website_url (string)
- industries (array)
- product_keywords (string): Comma-separated list of up to 25 concrete product keywords (real products/product lines/product categories; no vague marketing terms; prefer noun phrases; include flagship + secondary products; infer industry-standard product types if needed; no near-duplicates; no services unless primarily services)
- headquarters_location (string, REQUIRED - "City, State/Region, Country" format, or empty only if truly unknown after checking all sources)
- manufacturing_locations (array, REQUIRED - must include all locations from government guides, B2B directories, suppliers, customs, packaging, media. Use country-only entries if that's all known. NEVER empty without exhaustive checking)
- red_flag (boolean, optional)
- red_flag_reason (string, optional)
- location_confidence (string, optional)
- amazon_url, social (optional)

IMPORTANT: Do not leave manufacturing_locations empty after checking government guides, B2B directories, and trade data. Prefer "United States" or "China" over empty array.

Return ONLY the JSON array, no other text.`,
              };

              const expansionPayload = {
                messages: [expansionMessage],
                model: "grok-4-latest",
                temperature: 0.3,
                stream: false,
              };

              console.log(`[import-start] Making expansion search for "${xaiPayload.query}"`);
              const expansionResponse = await axios.post(xaiUrl, expansionPayload, {
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${xaiKey}`,
                },
                timeout: timeout,
              });

              if (expansionResponse.status >= 200 && expansionResponse.status < 300) {
                const expansionText = expansionResponse.data?.choices?.[0]?.message?.content || "";
                console.log(`[import-start] Expansion response preview: ${expansionText.substring(0, 100)}...`);

                let expansionCompanies = [];
                try {
                  const jsonMatch = expansionText.match(/\[[\s\S]*\]/);
                  if (jsonMatch) {
                    expansionCompanies = JSON.parse(jsonMatch[0]);
                    if (!Array.isArray(expansionCompanies)) expansionCompanies = [];
                  }
                } catch (parseErr) {
                  console.warn(`[import-start] Failed to parse expansion companies: ${parseErr.message}`);
                }

                console.log(`[import-start] Found ${expansionCompanies.length} companies in expansion search`);

                if (expansionCompanies.length > 0) {
                  let enrichedExpansion = expansionCompanies.map((c) => enrichCompany(c, center));
                  enrichedExpansion = await mapWithConcurrency(enrichedExpansion, 4, ensureCompanyKeywords);

                  // Geocode expansion companies
                  console.log(`[import-start] Geocoding ${enrichedExpansion.length} expansion companies`);
                  for (let i = 0; i < enrichedExpansion.length; i++) {
                    const company = enrichedExpansion[i];
                    if (company.headquarters_location && company.headquarters_location.trim()) {
                      const geoResult = await geocodeHQLocation(company.headquarters_location);
                      if (geoResult.hq_lat !== undefined && geoResult.hq_lng !== undefined) {
                        enrichedExpansion[i] = { ...company, ...geoResult };
                        console.log(`[import-start] Geocoded expansion company ${company.company_name}: ${company.headquarters_location} → (${geoResult.hq_lat}, ${geoResult.hq_lng})`);
                      }
                    }
                  }

                  // Fetch editorial reviews for expansion companies
                  console.log(`[import-start] Fetching editorial reviews for ${enrichedExpansion.length} expansion companies`);
                  for (let i = 0; i < enrichedExpansion.length; i++) {
                    const company = enrichedExpansion[i];
                    if (company.company_name && company.website_url) {
                      setStage("fetchEditorialReviews", {
                        company_name: String(company?.company_name || company?.name || ""),
                        website_url: String(company?.website_url || company?.url || ""),
                        normalized_domain: String(company?.normalized_domain || ""),
                      });

                      const editorialReviews = await fetchEditorialReviews(
                        company,
                        xaiUrl,
                        xaiKey,
                        timeout,
                        debugOutput ? debugOutput.reviews_debug : null,
                        { setStage }
                      );
                      if (editorialReviews.length > 0) {
                        enrichedExpansion[i] = { ...company, curated_reviews: editorialReviews };
                        console.log(`[import-start] Fetched ${editorialReviews.length} editorial reviews for expansion company ${company.company_name}`);
                      } else {
                        enrichedExpansion[i] = { ...company, curated_reviews: [] };
                      }
                    } else {
                      enrichedExpansion[i] = { ...company, curated_reviews: [] };
                    }
                  }

                  enriched = enriched.concat(enrichedExpansion);

                  // Re-save with expansion results
                  const expansionResult = await saveCompaniesToCosmos(enrichedExpansion, sessionId, timeout);
                  saveResult.saved += expansionResult.saved;
                  saveResult.skipped += expansionResult.skipped;
                  saveResult.failed += expansionResult.failed;
                  console.log(`[import-start] Expansion: saved ${expansionResult.saved}, skipped ${expansionResult.skipped}, failed ${expansionResult.failed}`);
                }
              }
            } catch (expansionErr) {
              console.warn(`[import-start] Expansion search failed: ${expansionErr.message}`);
              // Continue without expansion results
            }
          }

          const elapsed = Date.now() - startTime;
          const timedOut = isOutOfTime();

          // Write a completion marker so import-progress knows this session is done
          try {
            const container = getCompaniesCosmosContainer();
            if (container) {
              const completionDoc = timedOut
                ? {
                    id: `_import_timeout_${sessionId}`,
                    ...buildImportControlDocBase(sessionId),
                    completed_at: new Date().toISOString(),
                    elapsed_ms: elapsed,
                    reason: "max_processing_time_exceeded",
                  }
                : {
                    id: `_import_complete_${sessionId}`,
                    ...buildImportControlDocBase(sessionId),
                    completed_at: new Date().toISOString(),
                    elapsed_ms: elapsed,
                    reason: "completed_normally",
                    saved: saveResult.saved,
                  };

              const result = await upsertItemWithPkCandidates(container, completionDoc);
              if (!result.ok) {
                console.warn(
                  `[import-start] request_id=${requestId} session=${sessionId} failed to upsert completion marker: ${result.error}`
                );
              } else if (timedOut) {
                console.log(`[import-start] request_id=${requestId} session=${sessionId} timeout signal written`);
              } else {
                console.log(
                  `[import-start] request_id=${requestId} session=${sessionId} completion marker written (saved=${saveResult.saved})`
                );
              }
            }
          } catch (e) {
            console.warn(
              `[import-start] request_id=${requestId} session=${sessionId} error writing completion marker: ${e?.message || String(e)}`
            );
          }

          return jsonWithRequestId(
            {
              ok: true,
              session_id: sessionId,
              request_id: requestId,
              company_name: contextInfo.company_name,
              website_url: contextInfo.website_url,
              companies: enriched,
              meta: {
                mode: "direct",
                expanded: xaiPayload.expand_if_few && (saveResult.saved + saveResult.failed) < minThreshold,
                timedOut: timedOut,
                elapsedMs: elapsed,
              },
              saved: saveResult.saved,
              skipped: saveResult.skipped,
              failed: saveResult.failed,
              ...(debugOutput ? { debug: debugOutput } : {}),
            },
            200
          );
        } else {
          console.error(`[import-start] XAI error status: ${xaiResponse.status}`);
          return respondError(new Error(`XAI returned ${xaiResponse.status}`), {
            status: 502,
            details: {
              code: xaiResponse.status === 404 ? "IMPORT_START_UPSTREAM_NOT_FOUND" : "IMPORT_START_UPSTREAM_FAILED",
              message:
                xaiResponse.status === 404
                  ? "XAI endpoint returned 404 (not found). Check XAI_EXTERNAL_BASE configuration."
                  : `XAI returned ${xaiResponse.status}`,
              xai_status: xaiResponse.status,
              xai_url: xaiUrl,
            },
          });
        }
      } catch (xaiError) {
        const elapsed = Date.now() - startTime;
        console.error(`[import-start] session=${sessionId} xai call failed: ${xaiError.message}`);
        console.error(`[import-start] session=${sessionId} error code: ${xaiError.code}`);
        if (xaiError.response) {
          console.error(`[import-start] session=${sessionId} xai error status: ${xaiError.response.status}`);
          console.error(`[import-start] session=${sessionId} xai error data:`, JSON.stringify(xaiError.response.data).substring(0, 200));
        }

        // Write timeout signal if this took too long
        if (isOutOfTime() || (xaiError.code === 'ECONNABORTED' || xaiError.message.includes('timeout'))) {
          try {
            console.log(
              `[import-start] request_id=${requestId} session=${sessionId} timeout detected during XAI call, writing timeout signal`
            );
            const container = getCompaniesCosmosContainer();
            if (container) {
              const timeoutDoc = {
                id: `_import_timeout_${sessionId}`,
                ...buildImportControlDocBase(sessionId),
                failed_at: new Date().toISOString(),
                elapsed_ms: elapsed,
                error: toErrorString(xaiError),
              };
              const result = await upsertItemWithPkCandidates(container, timeoutDoc);
              if (!result.ok) {
                console.warn(
                  `[import-start] request_id=${requestId} session=${sessionId} failed to upsert timeout signal: ${result.error}`
                );
              } else {
                console.log(`[import-start] request_id=${requestId} session=${sessionId} timeout signal written`);
              }
            }
          } catch (e) {
            console.warn(
              `[import-start] request_id=${requestId} session=${sessionId} failed to write timeout signal: ${e?.message || String(e)}`
            );
          }
        }

        const upstreamStatus = xaiError?.response?.status || null;
        const upstreamErrorCode =
          upstreamStatus === 404
            ? "IMPORT_START_UPSTREAM_NOT_FOUND"
            : upstreamStatus === 401 || upstreamStatus === 403
              ? "IMPORT_START_UPSTREAM_UNAUTHORIZED"
              : "IMPORT_START_UPSTREAM_FAILED";

        const upstreamMessage =
          upstreamStatus === 404
            ? "XAI endpoint returned 404 (not found). Check XAI_EXTERNAL_BASE configuration."
            : upstreamStatus === 401 || upstreamStatus === 403
              ? "XAI endpoint rejected the request (unauthorized). Check XAI_EXTERNAL_KEY / authorization settings."
              : `XAI call failed: ${toErrorString(xaiError)}`;

        return respondError(new Error(`XAI call failed: ${toErrorString(xaiError)}`), {
          status: 502,
          details: {
            code: upstreamErrorCode,
            message: upstreamMessage,
            xai_code: xaiError?.code || null,
            xai_status: upstreamStatus,
            xai_url: xaiUrl,
          },
        });
      }
      } catch (e) {
        return respondError(e, { status: 500 });
      }
    } catch (e) {
      console.error("[import-start] Top-level error:", e?.message || e);
      return json(
        {
          ok: false,
          stage: "fatal",
          session_id: "",
          request_id: requestId,
          error: {
            code: "IMPORT_START_FATAL",
            message: `Fatal error: ${e?.message || "Unknown error"}`,
            request_id: requestId,
            step: "fatal",
          },
          legacy_error: `Fatal error: ${e?.message || "Unknown error"}`,
          ...getBuildInfo(),
        },
        500,
        responseHeaders
      );
    }
  };

app.http("import-start", {
  route: "import/start",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: importStartHandler,
});

module.exports = {
  _test: {
    readJsonBody,
    readQueryParam,
    importStartHandler,
  },
};
