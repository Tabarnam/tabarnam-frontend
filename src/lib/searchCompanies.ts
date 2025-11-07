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
  country?: unknown;
  state?: unknown;
  city?: unknown;
}

export interface Company {
  id: string;
  company_name: string;
  industries?: string[];
  url?: string;
  amazon_url?: string;
  normalized_domain?: string;
  manufacturing_locations?: string[];
}

const STUB_DATA: Company[] = [
  {
    id: "apple-inc",
    company_name: "Apple Inc.",
    industries: ["Electronics", "Technology", "Consumer Electronics"],
    url: "https://www.apple.com",
    amazon_url: "https://www.amazon.com/s?k=apple",
    normalized_domain: "apple.com",
  },
  {
    id: "samsung-electronics",
    company_name: "Samsung Electronics",
    industries: ["Electronics", "Technology", "Semiconductor"],
    url: "https://www.samsung.com",
    amazon_url: "https://www.amazon.com/s?k=samsung",
    normalized_domain: "samsung.com",
  },
  {
    id: "sony-corporation",
    company_name: "Sony Corporation",
    industries: ["Electronics", "Entertainment", "Technology"],
    url: "https://www.sony.com",
    amazon_url: "https://www.amazon.com/s?k=sony",
    normalized_domain: "sony.com",
  },
  {
    id: "nike-inc",
    company_name: "Nike Inc.",
    industries: ["Apparel", "Footwear", "Sports Equipment"],
    url: "https://www.nike.com",
    amazon_url: "https://www.amazon.com/s?k=nike",
    normalized_domain: "nike.com",
  },
  {
    id: "amazon-com",
    company_name: "Amazon.com Inc.",
    industries: ["E-commerce", "Cloud Computing", "Technology"],
    url: "https://www.amazon.com",
    amazon_url: "https://www.amazon.com",
    normalized_domain: "amazon.com",
  },
];

function matchesQuery(company: Company, q: string): boolean {
  const queryLower = q.toLowerCase();
  return (
    company.company_name?.toLowerCase().includes(queryLower) ||
    company.industries?.some((ind) => ind.toLowerCase().includes(queryLower)) ||
    company.normalized_domain?.toLowerCase().includes(queryLower)
  );
}

export async function searchCompanies(opts: SearchOptions) {
  const q = asStr(opts.q).trim();
  if (!q) throw new Error("Please enter a search term.");

  const sort = normalizeSort(opts.sort);
  const take = Math.max(1, Math.min(Number(opts.take ?? 25) || 25, 200));

  const params = new URLSearchParams({ q, sort, take: String(take) });
  const country = asStr(opts.country).trim();
  const state = asStr(opts.state).trim();
  const city = asStr(opts.city).trim();
  if (country) params.set("country", country);
  if (state) params.set("state", state);
  if (city) params.set("city", city);

  try {
    const r = await apiFetch(`/search-companies?${params.toString()}`, { headers: { accept: "application/json" } });
    if (!r.ok) {
      const msg = await readError(r);
      throw new Error(`search-companies failed (${r.status}): ${msg}`);
    }
    const data = await r.json();
    const items: Company[] = Array.isArray(data?.items) ? data.items : [];
    return {
      items,
      count: Number(data?.count) || items.length,
      meta: data?.meta ?? { q, sort },
    };
  } catch (e) {
    // If API is unavailable, try stub data
    console.warn("Search API unavailable, using stub data:", e?.message);
    const stubMatches = STUB_DATA.filter((c) => matchesQuery(c, q)).slice(0, take);

    if (stubMatches.length > 0) {
      return {
        items: stubMatches,
        count: stubMatches.length,
        meta: { q, sort, usingStubData: true },
      };
    }

    return {
      items: [],
      count: 0,
      meta: { q, sort, error: e?.message || "Search API unavailable" },
    };
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
      id: i.id,
    }));
  } catch (e) {
    console.warn("Failed to get suggestions:", e?.message);
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
