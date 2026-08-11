// Pure marker derivation for the results map. No leaflet imports so it stays
// unit-testable under jsdom. Mirrors (but does not import) ResultsPage's
// getLatLng shape handling — attachDistances only populates _hqDists/_manuDists
// when a user location resolves, so raw company fields are the fallback here.

// Phase-4.31 sentinel: permitted as the final manufacturing_locations entry,
// meaning "more sources we couldn't pin down". Never geocodable; never a pin.
const SENTINEL = "other unknown locations";

const LOW_PRECISION_VALUES = new Set(["country", "administrative_area"]);
const LOW_PRECISION_SOURCES = new Set(["country_center", "state_center"]);

function toFiniteNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function getLatLng(obj) {
  if (!obj || typeof obj !== "object") return null;
  const lat = toFiniteNumber(obj.lat ?? obj.latitude);
  const lng = toFiniteNumber(obj.lng ?? obj.lon ?? obj.longitude);
  if (lat != null && lng != null) return { lat, lng };
  if (obj.location && typeof obj.location === "object") {
    const locLat = toFiniteNumber(obj.location.lat ?? obj.location.latitude);
    const locLng = toFiniteNumber(obj.location.lng ?? obj.location.lon ?? obj.location.longitude);
    if (locLat != null && locLng != null) return { lat: locLat, lng: locLng };
  }
  return null;
}

function isSentinel(value) {
  return typeof value === "string" && value.trim().toLowerCase() === SENTINEL;
}

function entryLabel(entry, company, kind) {
  if (typeof entry === "string") return entry.trim() || null;
  const label =
    (typeof entry?.formatted === "string" && entry.formatted.trim()) ||
    (typeof entry?.full_address === "string" && entry.full_address.trim()) ||
    (typeof entry?.address === "string" && entry.address.trim()) ||
    (typeof entry?.location === "string" && entry.location.trim()) ||
    "";
  if (label) return label;
  if (kind === "hq" && typeof company?.headquarters_location === "string") {
    return company.headquarters_location.trim() || null;
  }
  return null;
}

function isLowPrecision(entry) {
  if (!entry || typeof entry !== "object") return false;
  const precision = String(entry.geocode_precision || "").toLowerCase();
  const source = String(entry.geocode_source || "").toLowerCase();
  return LOW_PRECISION_VALUES.has(precision) || LOW_PRECISION_SOURCES.has(source);
}

/** geocode_status, when present, must be "ok"; legacy entries with no status pass. */
function statusOk(entry) {
  if (!entry || typeof entry !== "object") return true;
  const status = entry.geocode_status;
  if (status == null || status === "") return true;
  return String(status).toLowerCase() === "ok";
}

function hqEntries(company) {
  if (Array.isArray(company._hqDists) && company._hqDists.length) return company._hqDists;
  if (Array.isArray(company.headquarters_locations) && company.headquarters_locations.length) {
    return company.headquarters_locations;
  }
  if (Array.isArray(company.headquarters) && company.headquarters.length) {
    return company.headquarters;
  }
  const lat = toFiniteNumber(company.hq_lat);
  const lng = toFiniteNumber(company.hq_lng);
  if (lat != null && lng != null) {
    return [{ lat, lng, formatted: company.headquarters_location, geocode_status: "ok" }];
  }
  return [];
}

function mfgEntries(company) {
  if (Array.isArray(company._manuDists) && company._manuDists.length) return company._manuDists;
  if (Array.isArray(company.manufacturing_geocodes) && company.manufacturing_geocodes.length) {
    return company.manufacturing_geocodes;
  }
  if (Array.isArray(company.manufacturing_locations) && company.manufacturing_locations.length) {
    return company.manufacturing_locations;
  }
  return [];
}

/**
 * Derive the map's marker list from result objects.
 *
 * @param {Array<object>} companies - display list (post-sort, post-promote)
 * @param {"both"|"hq"|"mfg"} pinFilter
 * @returns {Array<{id, companyId, kind, lat, lng, dist, label, lowPrecision, company}>}
 */
export function buildMarkers(companies, pinFilter = "both") {
  const markers = [];
  const seen = new Set();

  for (const company of Array.isArray(companies) ? companies : []) {
    if (!company || typeof company !== "object") continue;
    const companyId = String(company.company_id ?? company.id ?? "").trim();
    if (!companyId) continue;

    const kinds = [];
    if (pinFilter !== "mfg") kinds.push(["hq", hqEntries(company)]);
    if (pinFilter !== "hq") kinds.push(["mfg", mfgEntries(company)]);

    for (const [kind, entries] of kinds) {
      entries.forEach((entry, idx) => {
        if (isSentinel(entry)) return;
        if (!statusOk(entry)) return;
        const coords = getLatLng(entry);
        if (!coords) return;
        const label = entryLabel(entry, company, kind);
        if (isSentinel(label)) return;
        const key = `${companyId}|${kind}|${coords.lat}|${coords.lng}`;
        if (seen.has(key)) return;
        seen.add(key);
        markers.push({
          id: `${companyId}:${kind}:${idx}`,
          companyId,
          kind,
          lat: coords.lat,
          lng: coords.lng,
          dist: toFiniteNumber(entry?.dist),
          label,
          lowPrecision: isLowPrecision(entry),
          company,
        });
      });
    }
  }

  return markers;
}

// ── Pins-index (whole-catalog) support ──────────────────────────────────────
// /api/map-pins serves compact array entries (v2):
//   [id, name, tagline, domain, hqLat|null, hqLng|null,
//    [[mLat, mLng, lowPrec01], ...], hqCC|null, [mfgCC, ...]]
// hqCC/mfgCCs are ISO country attributions (absent on v1 payloads — decode
// tolerates both). decodePinsPayload turns the payload into an id-keyed Map;
// buildIndexMarkers derives lighter "index pin" markers for matched companies
// that are NOT on the loaded results page.

/** @returns {Map<string, {id, name, tagline, domain, hqLat, hqLng, mfg, hqCC, mfgCCs}>} */
export function decodePinsPayload(payload) {
  const byId = new Map();
  const rows = Array.isArray(payload?.companies) ? payload.companies : [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 7) continue;
    const [id, name, tagline, domain, hqLat, hqLng, mfg, hqCC, mfgCCs] = row;
    const key = String(id ?? "").trim();
    if (!key) continue;
    byId.set(key, {
      id: key,
      name: String(name ?? ""),
      tagline: String(tagline ?? ""),
      domain: String(domain ?? ""),
      hqLat: toFiniteNumber(hqLat),
      hqLng: toFiniteNumber(hqLng),
      mfg: Array.isArray(mfg) ? mfg : [],
      hqCC: typeof hqCC === "string" && hqCC ? hqCC : null,
      mfgCCs: Array.isArray(mfgCCs) ? mfgCCs.filter((c) => typeof c === "string" && c) : [],
    });
  }
  return byId;
}

/**
 * Markers for matched companies beyond the loaded page, joined from the pins
 * index. Same marker shape as buildMarkers plus `index: true` (lighter
 * rendering, domain-flow click-through) and a synthetic `company` object with
 * just the fields the hover card reads.
 */
export function buildIndexMarkers(pinsById, matchIds, excludeIds, pinFilter = "both") {
  const markers = [];
  if (!(pinsById instanceof Map)) return markers;
  const exclude = excludeIds instanceof Set ? excludeIds : new Set(excludeIds || []);
  for (const rawId of Array.isArray(matchIds) ? matchIds : []) {
    const id = String(rawId ?? "").trim();
    if (!id || exclude.has(id)) continue;
    const entry = pinsById.get(id);
    if (!entry) continue;
    const company = {
      company_id: id,
      id,
      display_name: entry.name,
      tagline: entry.tagline,
      normalized_domain: entry.domain,
    };
    if (pinFilter !== "mfg" && entry.hqLat != null && entry.hqLng != null) {
      markers.push({
        id: `${id}:hq:x`,
        companyId: id,
        kind: "hq",
        lat: entry.hqLat,
        lng: entry.hqLng,
        dist: null,
        label: null,
        lowPrecision: false,
        index: true,
        company,
      });
    }
    if (pinFilter !== "hq") {
      entry.mfg.forEach((m, i) => {
        const lat = toFiniteNumber(m?.[0]);
        const lng = toFiniteNumber(m?.[1]);
        if (lat == null || lng == null) return;
        markers.push({
          id: `${id}:mfg:x${i}`,
          companyId: id,
          kind: "mfg",
          lat,
          lng,
          dist: null,
          label: null,
          lowPrecision: m?.[2] === 1,
          index: true,
          company,
        });
      });
    }
  }
  return markers;
}
