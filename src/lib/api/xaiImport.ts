// src/lib/api/xaiImport.ts
import { apiFetch } from "../api";

type Center = { lat: number; lng: number } | undefined;

export async function xaiImport(params: {
  queryType?: string;
  query?: string;
  limit?: number;
  center?: Center;
  expand_if_few?: boolean;
  timeout_ms?: number;
  session_id?: string;
}) {
  const res = await apiFetch("/import/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      queryType: params.queryType ?? "product_keyword",
      query: params.query ?? "",
      limit: Math.max(1, Math.min(Number(params.limit ?? 10), 25)),
      center: params.center,
      expand_if_few: params.expand_if_few ?? true,
      timeout_ms: params.timeout_ms ?? 600000,
      session_id: params.session_id
    }),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (json as any)?.error || `xaiImport failed (${res.status})`;
    throw new Error(msg);
  }
  // the "start" endpoint typically returns meta/session; adapt callers as needed
  return json as { meta?: any; session_id?: string };
}
