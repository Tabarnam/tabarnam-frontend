// Slug → company lookup for /company/<slug> pages.
//
// The slug is assigned server-side during the pins-index rebuild (see
// api/_companySlug.js) because uniqueness is a property of the whole catalog.
// The client just reads it, so there is no derivation here to drift from the
// server's.
import { fetchPinsIndex } from "@/components/results/map/pinsIndexClient";

let _promise = null;

/**
 * Map(slug → entry) plus Map(domain → entry), over the whole catalog.
 * Shares the module-cached pins fetch with the map and made-in surfaces.
 */
export function getCompanyRegistry() {
  if (_promise) return _promise;
  _promise = fetchPinsIndex()
    .then((byId) => {
      const bySlug = new Map();
      const byDomain = new Map();
      for (const entry of byId.values()) {
        if (entry.slug) bySlug.set(entry.slug, entry);
        // First writer wins, matching the server: on a duplicated domain the
        // older record holds the bare slug.
        if (entry.domain && !byDomain.has(entry.domain)) byDomain.set(entry.domain, entry);
      }
      return { bySlug, byDomain };
    })
    .catch((err) => {
      _promise = null; // allow a retry rather than caching the failure
      throw err;
    });
  return _promise;
}

/**
 * Distinct manufacturing places for one company, in payload order.
 * Mirrors manufacturingPlaces() in api/_companyRender.js — the two render the
 * same list, and a mismatch would visibly rewrite the page when React mounts.
 */
export function manufacturingPlaces(entry) {
  const seen = new Set();
  const out = [];
  for (const pin of entry?.mfg || []) {
    if (!Array.isArray(pin)) continue;
    const label = typeof pin[5] === "string" ? pin[5] : "";
    const cc = typeof pin[3] === "string" ? pin[3] : "";
    const region = typeof pin[4] === "string" ? pin[4] : "";
    const key = `${label}|${cc}|${region}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, cc, region });
  }
  return out;
}

/** Prose list: "A", "A and B", "A, B and C". */
export function joinProse(items) {
  if (items.length <= 1) return items[0] || "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
