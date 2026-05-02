// src/lib/searchCompanies.ts
import { apiFetch } from "./api";
import { parseQuery } from "./queryNormalizer";

type Sort = "recent" | "name" | "manu" | "stars";

function asStr(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function normalizeSort(s: unknown): Sort {
  const m = asStr(s).toLowerCase();
  if (m === "name") return "name";
  if (m === "manu" || m === "manufacturing" || m === "manufacturing_first") return "manu";
  if (m === "stars" || m === "highest" || m === "rating") return "stars";
  return "recent";
}

export interface SearchOptions {
  q: unknown;
  sort?: Sort | string | number;
  take?: number;
  skip?: number;
  country?: unknown;
  state?: unknown;
  city?: unknown;
  lat?: unknown;
  lng?: unknown;
  amazon?: boolean;
  hqCountry?: string;
  mfgCountry?: string;
  quick?: boolean;
}

export interface Company {
  id: string;
  company_id: string;
  company_name: string;
  display_name?: string;
  name?: string;
  website_url?: string;
  normalized_domain?: string;
  amazon_url?: string;
  logo_url?: string;
  industries?: string[];
  manufacturing_locations?: Array<string | { address?: string; formatted?: string; full_address?: string; lat?: number; lng?: number; geocode_status?: string }>;
  headquarters_location?: string;
  product_keywords?: string;
  keywords?: string[];
  review_count?: number | null;
  curated_reviews?: any[];
  review_cursor?: any;
  reviews_last_updated_at?: string;
  hq_unknown?: boolean;
  hq_unknown_reason?: string;
  mfg_unknown?: boolean;
  mfg_unknown_reason?: string;
  limited_manufacturing?: boolean;
  unknown_manufacturing?: boolean;
  unknown_hq?: boolean;
  red_flag?: boolean;
  red_flag_reason?: string;
  location_confidence?: "high" | "medium" | "low";
  tagline?: string;
  stars?: number | null;
  reviews_count?: number | null;
}

export async function searchCompanies(opts: SearchOptions) {
  const q = asStr(opts.q).trim();
  const latNum = Number(asStr(opts.lat));
  const lngNum = Number(asStr(opts.lng));
  const hasCoords = Number.isFinite(latNum) && Number.isFinite(lngNum) && (latNum !== 0 || lngNum !== 0);
  const hasLocation = !!(asStr(opts.country).trim() || asStr(opts.state).trim() || asStr(opts.city).trim()) || hasCoords;
  if (!q && !hasLocation) throw new Error("Please enter a search term, choose a location, or enter a postal/ZIP code.");

  const sort = normalizeSort(opts.sort);
  const take = Math.max(1, Math.min(Number(opts.take ?? 25) || 25, 200));
  const skip = Math.max(0, Number(opts.skip ?? 0) || 0);

  // Parse query into raw, normalized, and compact forms (skip if no text query)
  let q_raw = "", q_norm = "", q_compact = "";
  let q_concepts: string[] = [];
  if (q) {
    const parsed = parseQuery(q);
    q_raw = parsed.q_raw;
    q_norm = parsed.q_norm;
    q_compact = parsed.q_compact;
    q_concepts = parsed.q_concepts;
  }

  const params = new URLSearchParams({ raw: q_raw, norm: q_norm, compact: q_compact, sort, take: String(take) });
  if (skip > 0) params.set("skip", String(skip));
  // Only send concepts when there are 2+ — single-concept queries use existing
  // soft-AND scoring. Pipe-separated to avoid extra URL encoding of commas.
  if (q_concepts.length >= 2) params.set("concepts", q_concepts.join("|"));
  const country = asStr(opts.country).trim();
  const state = asStr(opts.state).trim();
  const city = asStr(opts.city).trim();
  if (country) params.set("country", country);
  if (state) params.set("state", state);
  if (city) params.set("city", city);
  if (opts.amazon) params.set("amazon", "1");
  if (opts.hqCountry) params.set("hqCountry", opts.hqCountry);
  if (opts.mfgCountry) params.set("mfgCountry", opts.mfgCountry);
  if (opts.quick) params.set("quick", "1");

  const latStr = asStr(opts.lat);
  const lngStr = asStr(opts.lng);
  if (latStr !== "" && lngStr !== "") {
    const lat = Number(latStr);
    const lng = Number(lngStr);
    if (Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0)) {
      params.set("lat", String(lat));
      params.set("lng", String(lng));
    }
  }

  try {
    const r = await apiFetch(`/search-companies?${params.toString()}`, { headers: { accept: "application/json" } });
    if (!r.ok) {
      const msg = await readError(r);
      throw new Error(`search-companies failed (${r.status}): ${msg}`);
    }
    const data = await r.json();
    const rawItems: any[] = Array.isArray(data?.items) ? data.items : [];
    const items: Company[] = rawItems
      .filter((it) => it && typeof it === "object")
      .map((it) => {
        const cid = asStr(it.company_id || it.companyId || it.id).trim();
        const logo_url =
          asStr(it.logo_url).trim() ||
          asStr(it.logoUrl).trim() ||
          asStr(it.logoURL).trim() ||
          (it.logo && typeof it.logo === "object" ? asStr(it.logo.url).trim() : asStr(it.logo).trim()) ||
          "";

        const reviewCount = typeof it.review_count === "number" ? it.review_count : typeof it.reviews_count === "number" ? it.reviews_count : null;

        return {
          ...it,
          logo_url,
          company_id: cid,
          id: asStr(it.id || cid).trim(),
          review_count: reviewCount,
          // Back-compat for older UI that expects reviews_count.
          reviews_count: typeof it.reviews_count === "number" ? it.reviews_count : reviewCount,
        } as Company;
      });

    return {
      items,
      count: Number(data?.count) || items.length,
      hasMore: data?.hasMore === true,
      meta: data?.meta ?? { q: q_raw, sort },
    };
  } catch (e) {
    console.warn("Search API failed:", e?.message);
    throw new Error(e?.message || "API unavailable, try later");
  }
}

// --- Suggestion cache (30s TTL) ---
const SUGGEST_CACHE_TTL = 30_000;
const suggestCache = new Map<string, { ts: number; data: any }>();

function getCached<T>(key: string): T | null {
  const entry = suggestCache.get(key);
  if (entry && Date.now() - entry.ts < SUGGEST_CACHE_TTL) return entry.data as T;
  if (entry) suggestCache.delete(key);
  return null;
}

function setCache(key: string, data: any) {
  suggestCache.set(key, { ts: Date.now(), data });
  // Evict stale entries if cache grows too large
  if (suggestCache.size > 100) {
    const now = Date.now();
    for (const [k, v] of suggestCache) {
      if (now - v.ts > SUGGEST_CACHE_TTL) suggestCache.delete(k);
    }
  }
}

export async function getSuggestions(qLike: unknown, _take?: number) {
  const q = asStr(qLike).trim();
  if (!q) return [];
  const take = _take || 8;
  const cacheKey = `co:${q.toLowerCase()}:${take}`;
  const cached = getCached<any[]>(cacheKey);
  if (cached) return cached;

  try {
    const params = new URLSearchParams({ q, take: String(take) });
    const r = await apiFetch(`/suggest-companies?${params.toString()}`, {
      headers: { accept: "application/json" },
    });
    if (!r.ok) {
      console.warn(`suggest-companies returned ${r.status}`);
      return [];
    }
    const data = await r.json();
    const suggestions = Array.isArray(data?.suggestions)
      ? data.suggestions.map((s: any) => ({
          value: String(s.value || ""),
          type: "Company" as const,
          id: s.id,
        }))
      : [];
    setCache(cacheKey, suggestions);
    return suggestions;
  } catch (e) {
    console.warn("Failed to get suggestions:", (e as any)?.message);
    return [];
  }
}

export interface RefinementSuggestion {
  value: string;
  type: "Company" | "Keyword" | "Industry" | "State" | "City";
  id?: string;
  code?: string;
  count?: number;
}

export async function getRefinements(
  qLike: unknown,
  countryCode?: string,
  stateCode?: string,
  city?: string,
  _take?: number
): Promise<RefinementSuggestion[]> {
  const q = asStr(qLike).trim();
  if (!q || q.length < 2) return [];

  const cacheKey = `ref:${q.toLowerCase()}:${countryCode || ""}:${stateCode || ""}:${city || ""}`;
  const cached = getCached<RefinementSuggestion[]>(cacheKey);
  if (cached) return cached;

  try {
    const params = new URLSearchParams({ q });
    if (countryCode) params.set("country", countryCode);
    if (stateCode) params.set("state", stateCode);
    if (city) params.set("city", city);

    const r = await apiFetch(`/suggest-refinements?${params.toString()}`, {
      headers: { accept: "application/json" },
    });

    if (!r.ok) {
      console.warn(`suggest-refinements returned ${r.status}`);
      return [];
    }

    const data = await r.json();
    const suggestions: RefinementSuggestion[] = Array.isArray(data?.suggestions)
      ? data.suggestions.map((s: any) => ({
          value: String(s.value || ""),
          type: s.type === "Industry" ? "Industry" : s.type === "Keyword" ? "Keyword" : "Company",
          count: s.count,
        }))
      : [];

    const result = suggestions.slice(0, _take || 12);
    setCache(cacheKey, result);
    return result;
  } catch (e) {
    console.warn("Failed to get refinements:", (e as any)?.message);
    return [];
  }
}

export async function getCitySuggestions(q: unknown, country?: string): Promise<RefinementSuggestion[]> {
  const query = asStr(q).trim();
  if (!query || query.length < 1) return [];

  try {
    const params = new URLSearchParams({ q: query });
    if (country) params.set("country", country);

    const r = await apiFetch(`/suggest-cities?${params.toString()}`, {
      headers: { accept: "application/json" },
    });

    if (!r.ok) {
      console.warn(`suggest-cities returned ${r.status}`);
      return [];
    }

    const data = await r.json();
    const suggestions: RefinementSuggestion[] = Array.isArray(data?.suggestions)
      ? data.suggestions.map((s: any) => ({
          value: String(s.value || ""),
          type: "City",
          count: s.count,
        }))
      : [];

    return suggestions;
  } catch (e) {
    console.warn("Failed to get city suggestions:", e?.message);
    return [];
  }
}

export async function getStateSuggestions(q: unknown, country?: string): Promise<RefinementSuggestion[]> {
  const query = asStr(q).trim();
  if (!query || query.length < 1) return [];

  try {
    const params = new URLSearchParams({ q: query });
    if (country) params.set("country", country);

    const r = await apiFetch(`/suggest-states?${params.toString()}`, {
      headers: { accept: "application/json" },
    });

    if (!r.ok) {
      console.warn(`suggest-states returned ${r.status}`);
      return [];
    }

    const data = await r.json();
    const suggestions: RefinementSuggestion[] = Array.isArray(data?.suggestions)
      ? data.suggestions.map((s: any) => ({
          value: String(s.value || ""),
          type: "State",
          code: s.code ? String(s.code) : undefined,
          count: s.count,
        }))
      : [];

    return suggestions;
  } catch (e) {
    console.warn("Failed to get state suggestions:", e?.message);
    return [];
  }
}

/**
 * Lightweight call that returns only totalCount/totalPages (no items).
 * Intended to be fired in the background after results are already displayed.
 */
export async function getSearchCount(opts: Pick<SearchOptions, "q" | "sort" | "country" | "state" | "city" | "lat" | "lng" | "amazon" | "hqCountry" | "mfgCountry"> & { take?: number }): Promise<{ totalCount: number; totalPages: number } | null> {
  const q = asStr(opts.q).trim();
  const latNum = Number(asStr(opts.lat));
  const lngNum = Number(asStr(opts.lng));
  const hasCoords = Number.isFinite(latNum) && Number.isFinite(lngNum) && (latNum !== 0 || lngNum !== 0);
  const hasLocation = !!(asStr(opts.country).trim() || asStr(opts.state).trim() || asStr(opts.city).trim()) || hasCoords;
  if (!q && !hasLocation) return null;

  const sort = normalizeSort(opts.sort);
  const take = Math.max(1, Math.min(Number(opts.take ?? 50) || 50, 200));

  let q_raw = "", q_norm = "", q_compact = "";
  if (q) {
    const parsed = parseQuery(q);
    q_raw = parsed.q_raw;
    q_norm = parsed.q_norm;
    q_compact = parsed.q_compact;
  }

  const params = new URLSearchParams({ raw: q_raw, norm: q_norm, compact: q_compact, sort, take: String(take), countOnly: "1" });
  const country = asStr(opts.country).trim();
  const state = asStr(opts.state).trim();
  const city = asStr(opts.city).trim();
  if (country) params.set("country", country);
  if (state) params.set("state", state);
  if (city) params.set("city", city);
  if (opts.amazon) params.set("amazon", "1");
  if (opts.hqCountry) params.set("hqCountry", opts.hqCountry);
  if (opts.mfgCountry) params.set("mfgCountry", opts.mfgCountry);

  const latStr = asStr(opts.lat);
  const lngStr = asStr(opts.lng);
  if (latStr !== "" && lngStr !== "") {
    const lat = Number(latStr);
    const lng = Number(lngStr);
    if (Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0)) {
      params.set("lat", String(lat));
      params.set("lng", String(lng));
    }
  }

  try {
    const r = await apiFetch(`/search-companies?${params.toString()}`, { headers: { accept: "application/json" } });
    if (!r.ok) return null;
    const data = await r.json();
    return {
      totalCount: Number(data?.totalCount) || 0,
      totalPages: Number(data?.totalPages) || 1,
    };
  } catch {
    return null;
  }
}

async function readError(resp: Response) {
  try {
    const t = await resp.text();
    try {
      const j = JSON.parse(t);
      return j?.error || t;
    } catch {
      return t;
    }
  } catch {
    return "unknown error";
  }
}
