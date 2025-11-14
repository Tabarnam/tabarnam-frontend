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
    product_keywords: "smartphones, computers, tablets, watches, headphones",
    headquarters_location: "Cupertino, California, USA",
    hq_lat: 37.3382,
    hq_lng: -122.0086,
    manufacturing_locations: ["Shenzhen, China", "Shanghai, China", "Taipei, Taiwan"],
    manufacturing_geocodes: [
      { city: "Shenzhen", country: "China", lat: 22.5431, lng: 114.0579, formatted_address: "Shenzhen, China" },
      { city: "Shanghai", country: "China", lat: 31.2304, lng: 121.4737, formatted_address: "Shanghai, China" },
      { city: "Taipei", country: "Taiwan", lat: 25.0330, lng: 121.5654, formatted_address: "Taipei, Taiwan" }
    ],
    star_score: 4.8,
    company_tagline: "Think Different",
  },
  {
    id: "samsung-electronics",
    company_name: "Samsung Electronics",
    industries: ["Electronics", "Technology", "Semiconductor"],
    url: "https://www.samsung.com",
    amazon_url: "https://www.amazon.com/s?k=samsung",
    normalized_domain: "samsung.com",
    product_keywords: "smartphones, televisions, refrigerators, washing machines",
    headquarters_location: "Seoul, South Korea",
    hq_lat: 37.4979,
    hq_lng: 127.0276,
    manufacturing_locations: ["Suwon, South Korea", "Giheung, South Korea", "Kaohsiung, Taiwan"],
    manufacturing_geocodes: [
      { city: "Suwon", country: "South Korea", lat: 37.2636, lng: 127.0084, formatted_address: "Suwon, South Korea" },
      { city: "Giheung", country: "South Korea", lat: 37.2947, lng: 127.1132, formatted_address: "Giheung, South Korea" },
      { city: "Kaohsiung", country: "Taiwan", lat: 22.6171, lng: 120.3014, formatted_address: "Kaohsiung, Taiwan" }
    ],
    star_score: 4.5,
    company_tagline: "Inspiring Innovation",
  },
  {
    id: "sony-corporation",
    company_name: "Sony Corporation",
    industries: ["Electronics", "Entertainment", "Technology"],
    url: "https://www.sony.com",
    amazon_url: "https://www.amazon.com/s?k=sony",
    normalized_domain: "sony.com",
    product_keywords: "cameras, televisions, gaming, audio equipment",
    headquarters_location: "Tokyo, Japan",
    hq_lat: 35.6762,
    hq_lng: 139.6503,
    manufacturing_locations: ["Sendai, Japan", "Saitama, Japan", "Penang, Malaysia"],
    manufacturing_geocodes: [
      { city: "Sendai", country: "Japan", lat: 38.2688, lng: 140.8720, formatted_address: "Sendai, Japan" },
      { city: "Saitama", country: "Japan", lat: 35.8617, lng: 139.6455, formatted_address: "Saitama, Japan" },
      { city: "Penang", country: "Malaysia", lat: 5.3667, lng: 100.3069, formatted_address: "Penang, Malaysia" }
    ],
    star_score: 4.4,
    company_tagline: "Make.Believe.",
  },
  {
    id: "nike-inc",
    company_name: "Nike Inc.",
    industries: ["Apparel", "Footwear", "Sports Equipment"],
    url: "https://www.nike.com",
    amazon_url: "https://www.amazon.com/s?k=nike",
    normalized_domain: "nike.com",
    product_keywords: "shoes, apparel, athletic wear, sports equipment",
    headquarters_location: "Beaverton, Oregon, USA",
    hq_lat: 45.5202,
    hq_lng: -122.7702,
    manufacturing_locations: ["Jakarta, Indonesia", "Hanoi, Vietnam", "Taichung, Taiwan"],
    manufacturing_geocodes: [
      { city: "Jakarta", country: "Indonesia", lat: -6.2088, lng: 106.8456, formatted_address: "Jakarta, Indonesia" },
      { city: "Hanoi", country: "Vietnam", lat: 21.0285, lng: 105.8542, formatted_address: "Hanoi, Vietnam" },
      { city: "Taichung", country: "Taiwan", lat: 24.1372, lng: 120.6736, formatted_address: "Taichung, Taiwan" }
    ],
    star_score: 4.3,
    company_tagline: "Just Do It",
  },
  {
    id: "amazon-com",
    company_name: "Amazon.com Inc.",
    industries: ["E-commerce", "Cloud Computing", "Technology"],
    url: "https://www.amazon.com",
    amazon_url: "https://www.amazon.com",
    normalized_domain: "amazon.com",
    product_keywords: "online retail, cloud services, web hosting, marketplace",
    headquarters_location: "Seattle, Washington, USA",
    hq_lat: 47.6205,
    hq_lng: -122.3493,
    manufacturing_locations: ["Seattle, Washington, USA", "Arlington, Virginia, USA"],
    manufacturing_geocodes: [
      { city: "Seattle", country: "USA", lat: 47.6062, lng: -122.3321, formatted_address: "Seattle, Washington, USA" },
      { city: "Arlington", country: "USA", lat: 38.8816, lng: -77.1043, formatted_address: "Arlington, Virginia, USA" }
    ],
    star_score: 4.2,
    company_tagline: "Work Hard. Have Fun. Make History.",
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
  const skip = Math.max(0, Number(opts.skip ?? 0) || 0);

  const params = new URLSearchParams({ q, sort, take: String(take) });
  if (skip > 0) params.set("skip", String(skip));
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
        meta: {
          q,
          sort,
          usingStubData: true,
          error: e?.message || "Search API unavailable",
        },
      };
    }

    return {
      items: [],
      count: 0,
      meta: {
        q,
        sort,
        error: e?.message || "Search API unavailable",
      },
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
