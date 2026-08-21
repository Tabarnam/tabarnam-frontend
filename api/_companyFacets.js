/**
 * Company facets — industries, product terms, and rating — as a precomputed
 * blob, mirroring _pinsIndex.js.
 *
 * Why a SEPARATE blob rather than more columns on the pins index: pins is
 * ~3.9MB and every consumer map surface downloads it. Industries and product
 * terms add roughly 600 bytes per company, which would take that payload past
 * 12MB and make every /results map view pay for data only the company pages
 * use. Splitting keeps the map light and lets this age out on its own, slower
 * schedule — geography moves when a company is re-geocoded, facets only when
 * an import rewrites its keywords.
 *
 * Why precomputed at all: /company/<slug> is ~14.5k pages. Reading the Cosmos
 * document per request would put a cross-partition query in front of every
 * crawler hit on a serverless account. One scan per rebuild, then a point read
 * of the blob, keeps a full crawl close to free.
 *
 * The RU cost is a second full scan on top of the pins scan. That is the
 * deliberate trade: BLOB_MAX_AGE_MS is a week rather than pins' day, and the
 * import path rebuilds both together, so in practice this scans about as often
 * as imports land.
 */

const { BlobServiceClient } = require("@azure/storage-blob");

const BLOB_CONTAINER = "config";
const BLOB_NAME = "company_facets.json";
const PAYLOAD_VERSION = 1;
const CACHE_TTL_MS = 15 * 60 * 1000;
// A week, not a day: facets move only when an import rewrites a company's
// keywords, and every age-out costs a full scan.
const BLOB_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Page-level caps. A company can carry 90 product keywords — mostly SKU-level
// variants ("Avengers Storm Soap", "Wood Barrel Bourbon Soap") — and printing
// all of them across 14.5k pages is the textbook shape of keyword stuffing.
// Twenty covers the terms people actually search without the page reading as a
// keyword dump.
const PRODUCT_MAX = 20;
const INDUSTRY_MAX = 12;
const TERM_MAX_CHARS = 60;

let _cache = null;
let _cacheAt = 0;
let _inFlight = null;
let _lastError = null;

function env(k, d = "") {
  const v = process.env[k];
  return (v == null ? d : String(v)).trim();
}

function getBlobClient() {
  const conn = env("AZURE_STORAGE_CONNECTION_STRING");
  if (!conn) return null;
  try {
    return BlobServiceClient.fromConnectionString(conn)
      .getContainerClient(BLOB_CONTAINER)
      .getBlockBlobClient(BLOB_NAME);
  } catch {
    return null;
  }
}

// ── normalisation ───────────────────────────────────────────────────────────

/**
 * Clean a list of free-text terms: trim, drop empties and over-long strings,
 * dedupe case-insensitively (keeping the first spelling seen), cap.
 *
 * `drop` removes terms that merely restate the company name — "Dr. Squatch"
 * as a product of Dr. Squatch is noise on the page and dilutes the real terms.
 */
function cleanTerms(list, limit, drop = "") {
  const dropKey = String(drop || "").trim().toLowerCase();
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (typeof raw !== "string") continue;
    const term = raw.trim().replace(/\s+/g, " ");
    if (!term || term.length > TERM_MAX_CHARS) continue;
    const key = term.toLowerCase();
    if (key === dropKey || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= limit) break;
  }
  return out;
}

function toFiniteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * One facets row, or null when a company has nothing worth storing.
 * Shape: [id, industries[], products[], stars|null, reviewCount]
 */
function buildFacetEntry(company) {
  if (!company || typeof company !== "object") return null;
  const id = String(company.company_id ?? company.id ?? "").trim();
  if (!id || id.startsWith("_") || id.startsWith("refresh_job_")) return null;
  if (company.is_deleted === true) return null;
  if (company.type === "import_control") return null;

  const name = String(company.display_name || company.company_name || company.name || "").trim();
  const industries = cleanTerms(company.industries, INDUSTRY_MAX, name);
  // `keywords` and `product_keywords` are the same list on current documents;
  // read either so an older record still contributes.
  const products = cleanTerms(
    Array.isArray(company.product_keywords) && company.product_keywords.length
      ? company.product_keywords
      : company.keywords,
    PRODUCT_MAX,
    name
  );

  const stars = toFiniteNumber(company.stars ?? company.star_rating);
  // The visible count is what the page can honestly cite: pending reviews are
  // admin-gated and not public yet.
  const reviews = toFiniteNumber(company.visible_review_count ?? company.review_count) || 0;

  // Nothing to say → no row. Keeps the blob to companies that actually add
  // something to their page.
  if (!industries.length && !products.length && stars == null && !reviews) return null;

  return [id, industries, products, stars, reviews];
}

function packPayload(entries) {
  return {
    version: PAYLOAD_VERSION,
    generated_at: new Date().toISOString(),
    count: entries.length,
    companies: entries,
  };
}

// ── scan / blob ─────────────────────────────────────────────────────────────

/** Full cross-partition scan → facet entries. Same predicate as the pins scan. */
async function buildFacetsFromScan(container) {
  const sql = {
    query:
      "SELECT c.id, c.company_id, c.company_name, c.display_name, c.name, " +
      "c.industries, c.product_keywords, c.keywords, c.stars, c.star_rating, " +
      "c.review_count, c.visible_review_count, c.is_deleted, c.type " +
      "FROM c WHERE NOT STARTSWITH(c.id, '_') " +
      "AND (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted = false) " +
      "AND (NOT IS_DEFINED(c.type) OR c.type != 'import_control')",
  };
  const iterator = container.items.query(sql, { maxItemCount: 200 });

  const entries = [];
  let requestCharge = 0;
  let pages = 0;
  let scanned = 0;
  for await (const page of iterator.getAsyncIterator()) {
    const resources = page?.resources || [];
    requestCharge += Number(page?.requestCharge) || 0;
    pages += 1;
    scanned += resources.length;
    for (const company of resources) {
      const entry = buildFacetEntry(company);
      if (entry) entries.push(entry);
    }
  }
  return { entries, requestCharge, pages, scanned };
}

async function streamToString(readableStream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readableStream.on("data", (d) => chunks.push(d.toString("utf8")));
    readableStream.on("end", () => resolve(chunks.join("")));
    readableStream.on("error", reject);
  });
}

/** Read the blob. Returns { payload, body, etag } or null (missing/stale). */
async function readFacetsBlob({ log, ignoreAge = false } = {}) {
  const blob = getBlobClient();
  if (!blob) return null;
  try {
    const resp = await blob.download(0);
    const body = await streamToString(resp.readableStreamBody);
    const payload = JSON.parse(body);
    if (!payload || !Array.isArray(payload.companies)) return null;
    if (!ignoreAge) {
      // Version-aware staleness, same reasoning as the pins index: a payload
      // from an older build lacks whatever fields the current one adds, and
      // treating it as missing makes the first request after a deploy rebuild
      // it with no admin action.
      if (Number(payload.version) !== PAYLOAD_VERSION) {
        log?.(`[company-facets] blob is v${payload.version}, current is v${PAYLOAD_VERSION} — will rescan`);
        return null;
      }
      const age = Date.now() - Date.parse(payload.generated_at || 0);
      if (!Number.isFinite(age) || age > BLOB_MAX_AGE_MS) {
        log?.(`[company-facets] blob stale (age=${Math.round(age / 3600000)}h) — will rescan`);
        return null;
      }
    }
    return { payload, body, etag: resp.etag };
  } catch (err) {
    if (err?.statusCode !== 404) log?.(`[company-facets] blob read failed: ${err?.message || err}`);
    return null;
  }
}

/** Persist the payload. Best-effort; failures never break serving. */
async function writeFacetsBlob(payload, { log, conditions } = {}) {
  const blob = getBlobClient();
  if (!blob) return { persisted: false, error: "no storage connection string" };
  try {
    const body = JSON.stringify(payload);
    const parent = BlobServiceClient.fromConnectionString(env("AZURE_STORAGE_CONNECTION_STRING"))
      .getContainerClient(BLOB_CONTAINER);
    await parent.createIfNotExists();
    const opts = {
      blobHTTPHeaders: { blobContentType: "application/json" },
      ...(conditions ? { conditions } : {}),
    };
    const res = await blob.upload(body, Buffer.byteLength(body), opts);
    log?.(`[company-facets] persisted ${payload.count} companies, ${Buffer.byteLength(body)}B`);
    return { persisted: true, bytes: Buffer.byteLength(body), body, etag: res.etag };
  } catch (err) {
    log?.(`[company-facets] persist failed (non-fatal): ${err?.message || err}`);
    return { persisted: false, error: err?.message || String(err), statusCode: err?.statusCode };
  }
}

function _installCache(payload, body, source) {
  _cache = {
    payload,
    body: body || JSON.stringify(payload),
    generatedAt: payload.generated_at,
    source,
  };
  _cacheAt = Date.now();
  _lastError = null;
  return _cache;
}

function _buildAndCache(container, { force = false, log = (...a) => console.log(...a) } = {}) {
  _inFlight = (async () => {
    try {
      if (!force) {
        const fromBlob = await readFacetsBlob({ log });
        if (fromBlob) return _installCache(fromBlob.payload, fromBlob.body, "blob");
      }
      if (!container || typeof container.items !== "object") {
        _lastError = "no cosmos container";
        return _cache;
      }
      const scanned = await buildFacetsFromScan(container);
      log?.(
        `[company-facets] scan: companies=${scanned.scanned} with-facets=${scanned.entries.length} ` +
          `pages=${scanned.pages} ru=${Math.round(scanned.requestCharge)}`
      );
      if (scanned.entries.length === 0) {
        _lastError = "scan returned 0 companies with facets";
        return _cache;
      }
      const payload = packPayload(scanned.entries);
      payload.build_request_charge = Math.round(scanned.requestCharge);
      const written = await writeFacetsBlob(payload, { log });
      return _installCache(payload, written.body, "scan");
    } catch (err) {
      _lastError = err?.message || String(err);
      return _cache;
    } finally {
      _inFlight = null;
    }
  })();
  return _inFlight;
}

/**
 * SWR accessor. Fresh cache → return; stale → return now + refresh behind;
 * cold → await the build.
 *
 * Facets are ENRICHMENT: a company page renders fine without them, so callers
 * should treat null as "no extra detail", never as a failure.
 */
async function getFacets(container) {
  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_TTL_MS) return _cache;
  if (_cache) {
    if (!_inFlight) {
      const refresh = _buildAndCache(container);
      if (refresh && typeof refresh.catch === "function") refresh.catch(() => {});
    }
    return _cache;
  }
  if (_inFlight) return _inFlight;
  return _buildAndCache(container);
}

/** Force a rescan + persist (admin endpoint / import completion). */
async function rebuildAndPersistFacets(container, { log } = {}) {
  if (!container || typeof container.items !== "object") {
    return { ok: false, error: "no container" };
  }
  const startedAt = Date.now();
  _inFlight = null; // never join a non-forced build
  const cache = await _buildAndCache(container, { force: true, log });
  if (!cache || !cache.payload) {
    return { ok: false, error: _lastError || "build produced nothing", build_ms: Date.now() - startedAt };
  }
  return {
    ok: true,
    count: cache.payload.count,
    bytes: Buffer.byteLength(cache.body),
    generated_at: cache.generatedAt,
    build_request_charge: cache.payload.build_request_charge,
    build_ms: Date.now() - startedAt,
  };
}

/** Age of the persisted blob, for throttling import-triggered rebuilds. */
async function getFacetsBlobAgeMs() {
  const fromBlob = await readFacetsBlob({ ignoreAge: true });
  if (!fromBlob) return null;
  const age = Date.now() - Date.parse(fromBlob.payload.generated_at || 0);
  return Number.isFinite(age) ? age : null;
}

/**
 * Patch specific companies into the blob after an admin save, so an edit shows
 * on the company page immediately instead of waiting for the weekly rebuild.
 * ETag-conditional with one retry; the periodic rebuild is the backstop.
 */
async function upsertFacetsForCompanies(companies, { logger = console } = {}) {
  const log = typeof logger?.log === "function" ? logger.log.bind(logger) : console.log;
  const list = (Array.isArray(companies) ? companies : [companies]).filter(Boolean);
  if (!list.length) return { ok: true, updated: 0, skipped: "no companies" };

  for (let attempt = 0; attempt < 2; attempt++) {
    const fromBlob = await readFacetsBlob({ log, ignoreAge: true });
    if (!fromBlob) return { ok: true, updated: 0, skipped: "no blob yet (first rebuild will include them)" };

    const byId = new Map(fromBlob.payload.companies.map((e) => [e[0], e]));
    let changed = 0;
    for (const company of list) {
      const id = String(company?.company_id ?? company?.id ?? "").trim();
      if (!id) continue;
      const entry = buildFacetEntry(company);
      if (entry) {
        const prev = byId.get(id);
        if (!prev || JSON.stringify(prev) !== JSON.stringify(entry)) {
          byId.set(id, entry);
          changed++;
        }
      } else if (byId.delete(id)) {
        changed++;
      }
    }
    if (!changed) return { ok: true, updated: 0 };

    const payload = {
      ...fromBlob.payload,
      version: PAYLOAD_VERSION,
      generated_at: new Date().toISOString(),
      count: byId.size,
      companies: [...byId.values()],
    };
    const written = await writeFacetsBlob(payload, { log, conditions: { ifMatch: fromBlob.etag } });
    if (written.persisted) {
      _installCache(payload, written.body, "upsert");
      log?.(`[company-facets] upserted ${changed} compan${changed === 1 ? "y" : "ies"}`);
      return { ok: true, updated: changed };
    }
    // 412 = someone else wrote between our read and write — retry once fresh.
    if (written.statusCode !== 412 && written.statusCode !== 409) {
      return { ok: false, error: written.error };
    }
  }
  return { ok: false, error: "etag conflict twice — leaving to the periodic rebuild" };
}

function getCacheInfo() {
  return {
    cached: !!_cache,
    generated_at: _cache?.generatedAt || null,
    count: _cache?.payload?.count ?? null,
    source: _cache?.source || null,
    age_ms: _cache ? Date.now() - _cacheAt : null,
    last_error: _lastError,
  };
}

module.exports = {
  getFacets,
  rebuildAndPersistFacets,
  upsertFacetsForCompanies,
  getFacetsBlobAgeMs,
  buildFacetEntry,
  cleanTerms,
  getCacheInfo,
  BLOB_CONTAINER,
  BLOB_NAME,
  PRODUCT_MAX,
  INDUSTRY_MAX,
};
