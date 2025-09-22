// Calls your proxy-xai endpoint with the shape your proxy expects.
type Center = { lat: number; lng: number } | undefined;

export async function xaiImport(params: {
  queryType?: string;          // e.g., "product_keyword", "industry", "company_name"
  query?: string;              // the search text
  limit?: number;              // how many companies to fetch
  center?: Center;             // { lat, lng } to guide geo expansion
  expand_if_few?: boolean;     // default true
  timeout_ms?: number;         // optional
}) {
  const base = (import.meta as any).env?.VITE_FUNCTIONS_URL?.trim() || "";
  const url  = base ? `${base}/api/proxy-xai` : "/api/proxy-xai";

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({
      queryType: params.queryType ?? "product_keyword",
      query: params.query ?? "",
      limit: params.limit ?? 10,
      center: params.center,
      expand_if_few: params.expand_if_few ?? true,
      timeout_ms: params.timeout_ms
    })
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error || `xaiImport failed (${res.status})`;
    throw new Error(msg);
  }
  return json as {
    companies: any[];
    meta?: any;
  };
}
