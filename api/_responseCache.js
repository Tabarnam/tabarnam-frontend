/**
 * In-worker response cache for /api/search-companies.
 *
 * Goal: when N users issue the same query in quick succession, only the
 * first request pays the full Cosmos round-trip cost. Subsequent requests
 * return the previously-computed response from memory in ~1ms.
 *
 * This is a per-WORKER cache (each Function worker keeps its own Map).
 * With alwaysReady=1 keeping at least one worker pinned, the cache
 * accumulates across hours of traffic. Under bursty load the platform
 * may scale to 2-3 workers — each one warms independently, which is
 * acceptable for a small LRU.
 *
 * Cross-user: yes. Cache key is the query + params, never user identity.
 * The search response is identical for any two anonymous users with the
 * same query/sort/filters/page (location is computed FRONTEND-side from
 * the manufacturing geocodes in the payload, so two users in different
 * cities still get the same backend response).
 *
 * Invalidation: TTL only. Data churn in the companies container takes
 * up to TTL_MS to surface for cached queries. With a 5-minute TTL that's
 * fine — admin edits ripple within minutes.
 */

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Map-based LRU with per-entry TTL. JavaScript Maps preserve insertion
 * order, so the oldest-inserted key is `data.keys().next().value`. On
 * `get`, we re-insert the entry to mark it most-recently-used.
 */
class TTLCache {
  constructor({ maxEntries = DEFAULT_MAX_ENTRIES, ttlMs = DEFAULT_TTL_MS } = {}) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.data = new Map();
    this._hits = 0;
    this._misses = 0;
    this._evictions = 0;
    this._expirations = 0;
  }

  get(key) {
    const entry = this.data.get(key);
    if (!entry) {
      this._misses++;
      return null;
    }
    if (Date.now() - entry.at > this.ttlMs) {
      this.data.delete(key);
      this._expirations++;
      this._misses++;
      return null;
    }
    // Mark as most recently used by deleting and re-inserting.
    this.data.delete(key);
    this.data.set(key, entry);
    this._hits++;
    return entry.value;
  }

  set(key, value) {
    if (this.data.has(key)) this.data.delete(key);
    this.data.set(key, { value, at: Date.now() });
    while (this.data.size > this.maxEntries) {
      const oldest = this.data.keys().next().value;
      this.data.delete(oldest);
      this._evictions++;
    }
  }

  delete(key) {
    return this.data.delete(key);
  }

  clear() {
    this.data.clear();
  }

  size() {
    return this.data.size;
  }

  stats() {
    const total = this._hits + this._misses;
    return {
      size: this.data.size,
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
      hits: this._hits,
      misses: this._misses,
      evictions: this._evictions,
      expirations: this._expirations,
      hitRate: total > 0 ? Math.round((this._hits / total) * 1000) / 1000 : null,
    };
  }
}

/**
 * Build a canonical cache key from a request URL. Identical query
 * semantics → identical key.
 *
 * Normalisation:
 *   - Lowercase the value of `q` / `raw` / `norm` / `compact` so case
 *     doesn't fragment the cache (`Candle` and `candle` share an entry)
 *   - Bucket lat/lng to 2 decimals (~1km) so users within a small radius
 *     share cache entries. This is important: every search ships
 *     user-location-derived lat/lng, and if we keyed on full precision
 *     no two users would ever share an entry.
 *   - Drop meaningless cache-busting params (`_`, `t`, `nocache`)
 *   - Sort the remaining params alphabetically for stable ordering
 *
 * Returns null if the request is non-cacheable (POST/OPTIONS, has
 * `nocache=1`, has no params at all and would just return the default).
 */
const STRIPPED_PARAMS = new Set(["_", "t", "nocache"]);
const LOWERCASE_VALUE_PARAMS = new Set(["q", "raw", "norm", "compact", "sort", "country", "state", "city", "hqcountry", "mfgcountry"]);
const COORD_BUCKETS = 2; // 2 decimals = ~1.1km

function buildCacheKey(url, method = "GET") {
  if (typeof url !== "string") return null;
  if (method && method.toUpperCase() !== "GET") return null;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const params = parsed.searchParams;
  if (params.get("nocache") === "1") return null;

  // Collect the non-stripped params with normalised values.
  const entries = [];
  for (const [k, v] of params.entries()) {
    const key = k.toLowerCase();
    if (STRIPPED_PARAMS.has(key)) continue;
    let value = v;
    if (LOWERCASE_VALUE_PARAMS.has(key)) {
      value = String(value || "").toLowerCase().trim();
    }
    if (key === "lat" || key === "lng") {
      const n = Number(value);
      if (Number.isFinite(n)) {
        value = n.toFixed(COORD_BUCKETS);
      }
    }
    entries.push([key, value]);
  }

  if (entries.length === 0) return null; // nothing distinguishes this request

  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  // Use a delimiter that can't appear in URL-encoded values.
  return entries.map(([k, v]) => `${k}=${v}`).join("|");
}

module.exports = {
  TTLCache,
  buildCacheKey,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_TTL_MS,
};
