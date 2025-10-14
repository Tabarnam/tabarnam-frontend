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
}

export async function getSuggestions(qLike: unknown) {
  const q = asStr(qLike).trim();
  if (!q) return [];
  const out = await searchCompanies({ q, sort: "recent", take: 10 });
  return out.items.map((i) => ({
    id: i.id,
    title: i.company_name,
    subtitle: i.normalized_domain || i.url || i.amazon_url || "",
  }));
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
