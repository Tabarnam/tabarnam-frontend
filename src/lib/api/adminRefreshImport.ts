import { apiFetch } from "../api";

export interface AdminRefreshImportPayload {
  company_id: string;
  normalized_domain?: string;
  company_name?: string;
  timeout_ms?: number;
  fresh_reviews?: any[];
  delta?: any;
  tagline?: string;
  description?: string;
  industries?: string[];
  product_keywords?: string[] | string;
  website_url?: string;
  canonical_website?: string;
  headquarters_location?: string;
  manufacturing_locations?: string[] | string;
  location_sources?: any[];
  social?: Record<string, any>;
  amazon_url?: string;
}

export interface AdminRefreshImportSummary {
  updated_field_count: number;
  new_review_count: number;
}

export interface AdminRefreshImportResponse {
  ok: boolean;
  company: any;
  summary: AdminRefreshImportSummary;
  trace_id?: string;
  route?: string;
  elapsed_ms?: number;
}

export async function refreshCompanyImport(
  payload: AdminRefreshImportPayload
): Promise<AdminRefreshImportResponse> {
  const res = await apiFetch("/xadmin-api-refresh-import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const json = (await res.json().catch(() => ({}))) as Partial<AdminRefreshImportResponse> & {
    error?: string;
    message?: string;
    detail?: string;
  };

  if (!res.ok || json.ok === false) {
    const baseMessage =
      json.error ||
      json.message ||
      (typeof json.detail === "string" && json.detail.trim()) ||
      `Refresh import failed (${res.status})`;

    const meta: string[] = [];
    if (json.route) meta.push(`route=${json.route}`);
    if (json.trace_id) meta.push(`trace_id=${json.trace_id}`);

    throw new Error(meta.length ? `${baseMessage} (${meta.join(", ")})` : baseMessage);
  }

  return {
    ok: Boolean(json.ok),
    company: json.company,
    summary: json.summary || { updated_field_count: 0, new_review_count: 0 },
    trace_id: json.trace_id,
    route: json.route,
    elapsed_ms: json.elapsed_ms,
  };
}
