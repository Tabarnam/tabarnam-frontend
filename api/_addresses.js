// Structured address capture for company docs.
//
// Introduced alongside the "capture what we see, don't fetch extra" pass:
// when an extractor (JSON-LD scraper, xAI enrichment, admin edit) has a
// structured address, we store it on `company.addresses` as a normalized
// array. The existing `headquarters_location` / `manufacturing_locations`
// normalized strings are load-bearing (pins index, place scope, country
// resolution) and are NOT touched by this module.
//
// Public visibility follows the same per-entity `is_public: boolean` pattern
// as reviews and admin notes. At stamp time we set `is_public` from a
// trusted-source allowlist: if the entry's `source_url` host is a known
// public directory (coffeeroasternearme.com, localhoneymap.com, …), the
// address is already public information elsewhere and we default it to
// visible; anything else stays private until admin flips it.

"use strict";

const TRUSTED_ADDRESS_SOURCE_HOSTS = new Set([
  "coffeeroasternearme.com",
  "localhoneymap.com",
]);

const VALID_TYPES = new Set(["hq", "manufacturing"]);

function asString(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function trimOrEmpty(v) {
  return asString(v).trim();
}

function hostOf(url) {
  const raw = trimOrEmpty(url);
  if (!raw) return "";
  try {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(withScheme).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isTrustedAddressSource(url) {
  const host = hostOf(url);
  if (!host) return false;
  if (TRUSTED_ADDRESS_SOURCE_HOSTS.has(host)) return true;
  // Match subdomains of trusted hosts too (e.g. www.coffeeroasternearme.com
  // is already handled by the www-strip, but a real subdomain like
  // us.example.com should also count when example.com is trusted).
  for (const trusted of TRUSTED_ADDRESS_SOURCE_HOSTS) {
    if (host.endsWith(`.${trusted}`)) return true;
  }
  return false;
}

function coerceType(raw, fallback) {
  const t = trimOrEmpty(raw).toLowerCase();
  if (VALID_TYPES.has(t)) return t;
  const fb = trimOrEmpty(fallback).toLowerCase();
  if (VALID_TYPES.has(fb)) return fb;
  return "hq";
}

function coerceIso(raw, nowIso) {
  const s = trimOrEmpty(raw);
  if (s && !Number.isNaN(Date.parse(s))) return new Date(s).toISOString();
  return nowIso;
}

// Normalize one incoming address entry to the canonical shape. Only entries
// with at least one identifying part (street/locality/postal_code) survive;
// empty/junk entries return null.
function normalizeAddressEntry(raw, opts) {
  if (!raw || typeof raw !== "object") return null;
  const defaultType = opts && opts.defaultType;
  const nowIso = (opts && opts.nowIso) || new Date().toISOString();

  const street = trimOrEmpty(raw.street ?? raw.streetAddress);
  const locality = trimOrEmpty(raw.locality ?? raw.city ?? raw.addressLocality);
  const region = trimOrEmpty(raw.region ?? raw.state ?? raw.addressRegion);
  const postal_code = trimOrEmpty(raw.postal_code ?? raw.postalCode ?? raw.zip);
  const country = trimOrEmpty(raw.country ?? raw.addressCountry);
  const source_url = trimOrEmpty(raw.source_url ?? raw.sourceUrl ?? raw.src);
  const fetched_at = coerceIso(raw.fetched_at ?? raw.fetchedAt, nowIso);
  const type = coerceType(raw.type, defaultType);

  // Require at least one identifying part. Bare country / bare region isn't
  // an address; it's a location we can already store in the normalized
  // string fields.
  if (!street && !locality && !postal_code) return null;

  const is_public = raw.is_public === true || raw.is_public === false
    ? raw.is_public
    : isTrustedAddressSource(source_url);

  return { street, locality, region, postal_code, country, type, source_url, fetched_at, is_public };
}

function normalizeAddresses(rawArray, opts) {
  if (!Array.isArray(rawArray) || rawArray.length === 0) return [];
  const out = [];
  for (const raw of rawArray) {
    const entry = normalizeAddressEntry(raw, opts);
    if (entry) out.push(entry);
  }
  return dedupeAddresses(out);
}

// Two entries are "the same address" if their street + locality + postal_code
// AND type match case-insensitively (blank fields still have to match blank).
// This is intentionally strict — merging distinct entries by anything looser
// would silently collapse siblings that just happen to share a city.
//
// 2026-08-16 — `type` IS now part of the identity. Small wineries and single-
// facility producers routinely have IDENTICAL HQ and Manufacturing addresses
// (one building, both roles). Before this change, dedupeAddresses collapsed
// them first-wins to a single hq entry — the Henri Giraud paste (71 Boulevard
// Charles de Gaulle, both roles) landed only the hq entry with no way to
// represent the manufacturing side. Including type keeps them as two
// coexisting entries so the admin editor and public projection can show them
// as distinct rows.
//
// Trade-off (accepted): mergeAddresses used to preserve an admin-corrected
// type on re-import via the without-type key match. With type in the key, a
// re-import that says type=hq for an entry the admin previously flipped to
// type=manufacturing produces a duplicate (both stored) rather than silently
// keeping the admin's correction. Admin can delete the duplicate — a small
// UX cost for the more common gain of same-address dual-type support.
function addressKey(entry) {
  return [
    trimOrEmpty(entry.street).toLowerCase(),
    trimOrEmpty(entry.locality).toLowerCase(),
    trimOrEmpty(entry.postal_code).toLowerCase(),
    trimOrEmpty(entry.type).toLowerCase(),
  ].join("|");
}

function dedupeAddresses(arr) {
  if (!Array.isArray(arr) || arr.length <= 1) return arr;
  const seen = new Map();
  for (const entry of arr) {
    const key = addressKey(entry);
    if (!seen.has(key)) seen.set(key, entry);
  }
  return Array.from(seen.values());
}

// Merge incoming addresses onto an existing set. Rules:
//  - Existing entries are always preserved (a re-import that returns nothing
//    must NOT wipe previously captured addresses).
//  - When an incoming entry matches an existing one by key, the existing
//    entry's admin-editable fields win — specifically `is_public` and `type`
//    (admin may have corrected these) — and other fields are refreshed from
//    the new value only when the new value is non-empty.
//  - New incoming entries with a distinct key are appended.
function mergeAddresses(existing, incoming) {
  const ex = Array.isArray(existing) ? existing : [];
  const inc = Array.isArray(incoming) ? incoming : [];

  const byKey = new Map();
  for (const entry of ex) {
    const norm = normalizeAddressEntry(entry, {});
    if (norm) byKey.set(addressKey(norm), norm);
  }

  for (const rawIncoming of inc) {
    const incNorm = normalizeAddressEntry(rawIncoming, {});
    if (!incNorm) continue;
    const key = addressKey(incNorm);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, incNorm);
      continue;
    }
    const refreshed = { ...prev };
    for (const field of ["street", "locality", "region", "postal_code", "country", "source_url"]) {
      if (trimOrEmpty(incNorm[field])) refreshed[field] = incNorm[field];
    }
    if (incNorm.fetched_at) refreshed.fetched_at = incNorm.fetched_at;
    byKey.set(key, refreshed);
  }

  return Array.from(byKey.values());
}

module.exports = {
  TRUSTED_ADDRESS_SOURCE_HOSTS,
  isTrustedAddressSource,
  normalizeAddressEntry,
  normalizeAddresses,
  mergeAddresses,
  addressKey,
};
