// src/lib/searchCompanies.ts
const FUNCTIONS_BASE =
  import.meta.env.VITE_FUNCTIONS_BASE ?? "http://localhost:7071";

type Sort = "recent" | "name" | "manu";

function asStr(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function normalizeSort(s: unknown): Sort {
  const m = asStr(s).toLowerCase();
  if (m === "name") return "name";
  if (m === "manu" || m === "manufacturing" || m === "manufacturing_first") return "manu";
  // Any number or unknown value falls back to recent
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
  // intentionally omit created_at from the public shape
}

export async function searchCompanies(opts: SearchOptions) {
  const q = asStr(opts.q).trim();
  if (!q) throw new Error("Please enter a search term.");

  const sort = normalizeSort(opts.sort);
  const take = Math.max(1, Math.min(Number(opts.take ?? 25) || 25, 200));

  const params = new URLSearchParams({
    q,
    sort,
    take: String(take),
  });

  const country = asStr(opts.country).trim();
  const state = asStr(opts.state).trim();
  const city = asStr(opts.city).trim();
  if (country) params.set("country", country);
  if (state) params.set("state", state);
  if (city) params.set("city", city);

  const url = `${FUNCTIONS_BASE}/api/search-companies?${params.toString()}`;
  const resp = await fetch(url, { headers: { accept: "application/json" } });

  if (!resp.ok) {
    const msg = await readError(resp);
    throw new Error(`search-companies failed (${resp.status}): ${msg}`);
  }

  const data = await resp.json();
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
