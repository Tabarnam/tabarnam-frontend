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
