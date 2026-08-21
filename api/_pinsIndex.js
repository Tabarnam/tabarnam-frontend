/**
 * Pins index — a precomputed slim map dataset of every public company:
 * id, display name, truncated tagline, normalized_domain, HQ lat/lng, and
 * manufacturing geocode lat/lngs. Powers the consumer map surfaces
 * (/api/map-pins → results-map all-match pins + the /map explore route).
 *
 * Mirrors the typo-dictionary precompute pattern (_typoCorrection.js): full
 * scan is expensive, so build once, persist, and stale-while-revalidate in the
 * worker. Storage differs deliberately — Azure BLOB, not a Cosmos doc:
 *   - 12.7k companies × ~200B ≈ 2-3MB raw, over Cosmos's 2MB item ceiling
 *     (the typo dict survives only by packing strings under its own 1.5MB
 *     guard; pins can't shrink that far).
 *   - Cosmos point-read RU scales with doc size; blob reads don't.
 *   - search-companies' softDeleteFilter does NOT exclude `_index_*` docs, so
 *     a pins doc in the companies container would enter the retrieval pool.
 *
 * Freshness model (timers do NOT execute on this Flex app):
 *   - request path: 15-min SWR worker cache over the blob, 24h age check on
 *     the blob itself (age-out → background rescan+persist).
 *   - import completion: throttled rebuild (see rebuildMapPins callers).
 *   - company save: upsertPinsForCompanies patches just the saved companies
 *     into the blob (ETag-conditional, one retry) so an admin edit shows on
 *     the map immediately; the periodic rebuild is the consistency backstop.
 */

const { BlobServiceClient } = require("@azure/storage-blob");
const { resolveLocationCountry } = require("./_countryResolve");
const { resolveLocationRegion } = require("./_regionResolve");
const { assignSlugs } = require("./_companySlug");

const BLOB_CONTAINER = "config";
const BLOB_NAME = "map_pins.json";
// v2: entries carry hqCC + mfgCCs country attribution (made-in pages).
// v3: adds hqRegion + mfgRegions (ISO 3166-2, e.g. "US-CA") for state pages.
// v4: each mfg pin carries its OWN cc + region, so a place-scoped map plots
//     only the pins actually in that place (a company that manufactures in
//     California and Italy must not drop an Italy pin on the California page).
// v5: short place labels (hqLabel + a label per mfg pin) so hover cards can
//     name the location instead of showing a bare "Manufacturing".
// v6: canonical company-page slug per row. Assigned here, not derived at
//     request time, because uniqueness is a global property of the whole
//     catalog — see _companySlug.js. Both the server renderer and the React
//     route read it, so there is no derivation to keep in sync.
const PAYLOAD_VERSION = 6;
const CACHE_TTL_MS = 15 * 60 * 1000;
const BLOB_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TAGLINE_MAX = 80;

// Same precision semantics as the frontend's markerData.js — keep in sync.
const LOW_PRECISION_VALUES = new Set(["country", "administrative_area"]);
const LOW_PRECISION_SOURCES = new Set(["country_center", "state_center"]);

let _cache = null; // { payload, body, etag, generatedAt, source }
let _cacheAt = 0;
let _inFlight = null;
let _lastError = null;

function env(k, d = "") {
  const v = process.env[k];
  return (v == null ? d : String(v)).trim();
}

function getBlobClient() {
  const cs = env("AZURE_STORAGE_CONNECTION_STRING", "");
  if (!cs) return null;
  try {
    return BlobServiceClient.fromConnectionString(cs)
      .getContainerClient(BLOB_CONTAINER)
      .getBlockBlobClient(BLOB_NAME);
  } catch {
    return null;
  }
}

function toFiniteNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// 4 decimals ≈ 11m — matches the frontend's same-coordinate stacking key, and
// shorter numbers are most of the payload's byte budget.
function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function statusOk(entry) {
  const status = entry?.geocode_status;
  if (status == null || status === "") return true;
  return String(status).toLowerCase() === "ok";
}

function isLowPrecision(entry) {
  const precision = String(entry?.geocode_precision || "").toLowerCase();
  const source = String(entry?.geocode_source || "").toLowerCase();
  return LOW_PRECISION_VALUES.has(precision) || LOW_PRECISION_SOURCES.has(source);
}

/**
 * A compact "City, Region" label for a hover card. Full formatted addresses
 * ("Brea, CA, USA" / "Milan, Metropolitan City of Milan, Italy") are too long
 * for the card and repeat the country the page already implies, so keep the
 * first two comma segments and cap the length.
 */
function shortPlace(entry) {
  if (entry == null) return null;
  const raw =
    typeof entry === "string"
      ? entry
      : entry.formatted || entry.geocode_formatted_address || entry.full_address || entry.address || "";
  const text = String(raw || "").trim();
  if (!text) return null;
  const parts = text.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const label = parts.length >= 2 ? `${parts[0]}, ${parts[1]}` : parts[0];
  return label.length > 42 ? `${label.slice(0, 41)}…` : label;
}

/**
 * Build one company's pins entry:
 *   [id, name, tagline, domain, hqLat|null, hqLng|null,
 *    [[mLat, mLng, lowPrec01, cc|null, region|null, label|null], ...],
 *    hqCC|null, [mfgCC, ...], hqRegion|null, [mfgRegion, ...], hqLabel|null]
 * hqCC / mfgCCs are ISO 3166-1 alpha-2 attributions and hqRegion / mfgRegions
 * are ISO 3166-2 subdivisions ("US-CA") resolved from the location entries
 * (see _countryResolve.js / _regionResolve.js) — they power the /made-in
 * pages' whole-catalog per-country and per-state counts and lists.
 * Returns null when the company is not publicly mappable (deleted, control
 * doc, or no finite coordinates at all) — callers treat null as "remove".
 */
function buildCompanyEntry(company) {
  if (!company || typeof company !== "object") return null;
  const id = String(company.company_id ?? company.id ?? "").trim();
  if (!id || id.startsWith("_") || id.startsWith("refresh_job_")) return null;
  if (company.is_deleted === true) return null;
  if (company.type === "import_control") return null;

  const name = String(company.display_name || company.company_name || company.name || "").trim();
  if (!name) return null;
  let tagline = typeof company.tagline === "string" ? company.tagline.trim() : "";
  if (tagline.length > TAGLINE_MAX) tagline = `${tagline.slice(0, TAGLINE_MAX - 1)}…`;
  const domain = String(company.normalized_domain || "").trim().toLowerCase();

  const hqLat = toFiniteNumber(company.hq_lat);
  const hqLng = toFiniteNumber(company.hq_lng);
  const hasHq = hqLat != null && hqLng != null;

  const mfg = [];
  const mfgCCs = new Set();
  const mfgRegions = new Set();
  const geocodes = Array.isArray(company.manufacturing_geocodes) ? company.manufacturing_geocodes : [];
  const seen = new Set();
  for (const g of geocodes) {
    // Country attribution considers every entry (a text-only location still
    // means the company manufactures there); coordinates gate only the pin.
    const cc = resolveLocationCountry(g);
    let region = null;
    if (cc) {
      mfgCCs.add(cc);
      region = resolveLocationRegion(g, cc);
      if (region) mfgRegions.add(region);
    }
    if (!statusOk(g)) continue;
    const lat = toFiniteNumber(g?.lat);
    const lng = toFiniteNumber(g?.lng);
    if (lat == null || lng == null) continue;
    const key = `${round4(lat)},${round4(lng)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Per-pin cc/region: a place-scoped map filters on these so it never
    // shows a company's other-country pins.
    mfg.push([round4(lat), round4(lng), isLowPrecision(g) ? 1 : 0, cc, region, shortPlace(g)]);
  }

  // HQ country + region: structured headquarters entries first, then the
  // flat string.
  let hqCC = null;
  let hqRegion = null;
  const hqEntries = [
    ...(Array.isArray(company.headquarters_locations) ? company.headquarters_locations : []),
    ...(Array.isArray(company.headquarters) ? company.headquarters : []),
    company.headquarters_location,
  ];
  let hqLabel = null;
  for (const h of hqEntries) {
    hqCC = resolveLocationCountry(h);
    if (hqCC) {
      hqRegion = resolveLocationRegion(h, hqCC);
      hqLabel = shortPlace(h) || shortPlace(company.headquarters_location);
      break;
    }
  }

  if (!hasHq && mfg.length === 0) return null;
  return [
    id,
    name,
    tagline,
    domain,
    hasHq ? round4(hqLat) : null,
    hasHq ? round4(hqLng) : null,
    mfg,
    hqCC,
    [...mfgCCs],
    hqRegion,
    [...mfgRegions],
    hqLabel,
  ];
}

function packPayload(entries) {
  return {
    version: PAYLOAD_VERSION,
    generated_at: new Date().toISOString(),
    count: entries.length,
    // Slugs are assigned over the WHOLE set — a name is only free if no other
    // company claims it — so this has to happen here rather than inside
    // buildCompanyEntry, which sees one company at a time.
    companies: assignSlugs(entries),
  };
}

/**
 * Full cross-partition scan → pins entries. Same predicate the typo-dict scan
 * uses; projection is only the geometry/display fields.
 */
async function buildPinsFromScan(container) {
  const sql = {
    query:
      "SELECT c.id, c.company_id, c.company_name, c.display_name, c.name, c.tagline, " +
      "c.normalized_domain, c.hq_lat, c.hq_lng, c.manufacturing_geocodes, " +
      "c.headquarters_locations, c.headquarters, c.headquarters_location, c.is_deleted, c.type " +
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
      const entry = buildCompanyEntry(company);
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

/** Read the blob. Returns { payload, body, etag } or null (missing/stale/unparsable). */
async function readPinsBlob({ log, ignoreAge = false } = {}) {
  const blob = getBlobClient();
  if (!blob) return null;
  try {
    const resp = await blob.download(0);
    const body = await streamToString(resp.readableStreamBody);
    const payload = JSON.parse(body);
    if (!payload || !Array.isArray(payload.companies)) return null;
    if (!ignoreAge) {
      // Version-aware staleness. A payload written by an older build lacks
      // whatever fields the current one adds (v2 has no regions, v1 has no
      // countries), and those pages would silently render empty until the 24h
      // age-out. Treating an old version as missing makes the first request
      // after a deploy rebuild it — no admin action required.
      if (Number(payload.version) !== PAYLOAD_VERSION) {
        log?.(`[pins-index] blob is v${payload.version}, current is v${PAYLOAD_VERSION} — will rescan`);
        return null;
      }
      const age = Date.now() - Date.parse(payload.generated_at || 0);
      if (!Number.isFinite(age) || age > BLOB_MAX_AGE_MS) {
        log?.(`[pins-index] blob stale (age=${Math.round(age / 3600000)}h) — will rescan`);
        return null;
      }
    }
    return { payload, body, etag: resp.etag };
  } catch (err) {
    if (err?.statusCode !== 404) log?.(`[pins-index] blob read failed: ${err?.message || err}`);
    return null;
  }
}

/** Persist the payload. Best-effort; failures never break serving. */
async function writePinsBlob(payload, { log, conditions } = {}) {
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
    log?.(`[pins-index] persisted ${payload.count} companies, ${Buffer.byteLength(body)}B`);
    return { persisted: true, bytes: Buffer.byteLength(body), body, etag: res.etag };
  } catch (err) {
    log?.(`[pins-index] persist failed (non-fatal): ${err?.message || err}`);
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
        const fromBlob = await readPinsBlob({ log });
        if (fromBlob) return _installCache(fromBlob.payload, fromBlob.body, "blob");
      }
      if (!container || typeof container.items !== "object") {
        _lastError = "no cosmos container";
        return _cache;
      }
      const scanned = await buildPinsFromScan(container);
      log?.(
        `[pins-index] scan: companies=${scanned.scanned} mappable=${scanned.entries.length} ` +
          `pages=${scanned.pages} ru=${Math.round(scanned.requestCharge)}`
      );
      if (scanned.entries.length === 0) {
        _lastError = "scan returned 0 mappable companies";
        return _cache;
      }
      const payload = packPayload(scanned.entries);
      payload.build_request_charge = Math.round(scanned.requestCharge);
      const written = await writePinsBlob(payload, { log });
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
 * SWR accessor for the serving path. Fresh cache → return; stale cache →
 * return immediately + refresh in background; cold → await build.
 */
async function getPins(container) {
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
async function rebuildAndPersistPins(container, { log } = {}) {
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
async function getPinsBlobAgeMs() {
  const fromBlob = await readPinsBlob({ ignoreAge: true });
  if (!fromBlob) return null;
  const age = Date.now() - Date.parse(fromBlob.payload.generated_at || 0);
  return Number.isFinite(age) ? age : null;
}

/**
 * Patch just the given companies into the persisted blob so a company edit
 * shows on the map immediately (product decision 2026-08-11). ETag-conditional
 * with one retry; every failure mode is silent-best-effort — the periodic
 * rebuild reconciles anything missed. A company that is no longer mappable
 * (soft-deleted, coordinates removed) has its entry REMOVED.
 */
async function upsertPinsForCompanies(companies, { logger = console } = {}) {
  const log = typeof logger?.log === "function" ? logger.log.bind(logger) : console.log;
  const list = (Array.isArray(companies) ? companies : [companies]).filter(Boolean);
  if (!list.length) return { ok: true, updated: 0, skipped: "no companies" };

  for (let attempt = 0; attempt < 2; attempt++) {
    const fromBlob = await readPinsBlob({ log, ignoreAge: true });
    if (!fromBlob) return { ok: true, updated: 0, skipped: "no blob yet (first rebuild will include them)" };

    const byId = new Map(fromBlob.payload.companies.map((e) => [e[0], e]));
    let changed = 0;
    for (const company of list) {
      const id = String(company?.company_id ?? company?.id ?? "").trim();
      if (!id) continue;
      const entry = buildCompanyEntry(company);
      if (entry) {
        const prev = byId.get(id);
        // Compare only the fields buildCompanyEntry produces. The stored row
        // carries a slug at index 12 that it does not, so comparing the whole
        // array would report a difference on every save and rewrite the blob
        // each time.
        if (!prev || JSON.stringify(prev.slice(0, entry.length)) !== JSON.stringify(entry)) {
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
      // Re-run over the whole set: a renamed company needs a new slug, and a
      // newly added one needs any slug at all. Assignment is deterministic and
      // preserves incumbents, so this converges with a full rebuild.
      companies: assignSlugs([...byId.values()]),
    };
    const written = await writePinsBlob(payload, {
      log,
      conditions: { ifMatch: fromBlob.etag },
    });
    if (written.persisted) {
      _installCache(payload, written.body, "upsert");
      log?.(`[pins-index] upserted ${changed} compan${changed === 1 ? "y" : "ies"} into pins blob`);
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
  getPins,
  rebuildAndPersistPins,
  upsertPinsForCompanies,
  getPinsBlobAgeMs,
  buildCompanyEntry,
  getCacheInfo,
  BLOB_CONTAINER,
  BLOB_NAME,
};
