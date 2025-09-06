// src/lib/searchCompanies.ts
const API_BASE =
  (import.meta.env.VITE_API_BASE?.trim()) ||
  (import.meta.env.VITE_FUNCTIONS_URL?.trim()) ||
  "http://127.0.0.1:7071";

type SearchParams = {
  query?: string;
  limit?: number;
  debug?: boolean;
  raw?: boolean;
};

export async function searchCompanies({ query = "", limit = 50, debug = false, raw = false }: SearchParams = {}) {
  const res = await fetch(`${API_BASE}/api/search-companies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit, debug, raw }),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`search-companies failed (${res.status}): ${msg}`);
  }
  return res.json(); // { companies } or debug payload
}

// Lightweight suggestions from current data (companies/industries/keywords)
export async function getSuggestions(prefix: string, take = 8): Promise<Array<{ value: string; type: string }>> {
  const q = String(prefix || "").trim();
  if (!q) return [];
  const data = await searchCompanies({ query: q, limit: 32, debug: false, raw: false });
  const set = new Map<string, string>();

  const add = (v: string | undefined, t: string) => {
    if (!v) return;
    const s = v.trim();
    if (!s) return;
    if (!s.toLowerCase().includes(q.toLowerCase())) return; // simple prefix bias
    if (!set.has(s.toLowerCase())) set.set(s.toLowerCase(), JSON.stringify({ value: s, type: t }));
  };

  for (const c of (data?.companies || [])) {
    add(c.company_name, "company");
    if (Array.isArray(c.industries)) c.industries.forEach((i: string) => add(i, "industry"));
    String(c.product_keywords || "")
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean)
      .forEach((k: string) => add(k, "keyword"));
  }

  return Array.from(set.values()).slice(0, take).map(s => JSON.parse(s));
}
