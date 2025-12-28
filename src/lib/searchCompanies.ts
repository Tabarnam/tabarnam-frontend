// src/lib/searchCompanies.ts
import { apiFetch } from "./api";

type Sort = "recent" | "name" | "manu";

function asStr(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function normalizeSort(s: unknown): Sort {
  const m = asStr(s).toLowerCase();
  if (m === "name") return "name";
  if (m === "manu" || m === "manufacturing" || m === "manufacturing_first") return "manu";
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
  product_keywords?: string[];
  keywords?: string[];
  red_flag?: boolean;
  red_flag_reason?: string;
  location_confidence?: "high" | "medium" | "low";
  tagline?: string;
  stars?: number | null;
  reviews_count?: number | null;
}

export async function searchCompanies(opts: SearchOptions) {
  const q = asStr(opts.q).trim();
  if (!q) throw new Error("Please enter a search term.");

  const sort = normalizeSort(opts.sort);
  const take = Math.max(1, Math.min(Number(opts.take ?? 25) || 25, 200));
  const skip = Math.max(0, Number(opts.skip ?? 0) || 0);

  const params = new URLSearchParams({ q, sort, take: String(take) });
  if (skip > 0) params.set("skip", String(skip));
  const country = asStr(opts.country).trim();
  const state = asStr(opts.state).trim();
  const city = asStr(opts.city).trim();
  if (country) params.set("country", country);
  if (state) params.set("state", state);
  if (city) params.set("city", city);

  const lat = Number(asStr(opts.lat));
  const lng = Number(asStr(opts.lng));
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    params.set("lat", String(lat));
    params.set("lng", String(lng));
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

        return {
          ...it,
          logo_url,
          company_id: cid,
          id: asStr(it.id || cid).trim(),
        } as Company;
      });

    return {
      items,
      count: Number(data?.count) || items.length,
      meta: data?.meta ?? { q, sort },
    };
  } catch (e) {
    console.warn("Search API failed:", e?.message);
    throw new Error(e?.message || "API unavailabletry later");
  }
}

export async function getSuggestions(qLike: unknown, _take?: number) {
  const q = asStr(qLike).trim();
  if (!q) return [];
  const take = _take || 10;
  try {
    const out = await searchCompanies({ q, sort: "recent", take });
    return out.items.map((i) => ({
      value: i.company_name,
      type: "Company",
      id: i.company_id || i.id,
    }));
  } catch (e) {
    console.warn("Failed to get suggestions:", e?.message);
    return [];
  }
}

export interface RefinementSuggestion {
  value: string;
  type: "Company" | "Keyword" | "Industry";
  id?: string;
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

    return suggestions.slice(0, _take || 12);
  } catch (e) {
    console.warn("Failed to get refinements:", e?.message);
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
          count: s.count,
        }))
      : [];

    return suggestions;
  } catch (e) {
    console.warn("Failed to get state suggestions:", e?.message);
    return [];
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
