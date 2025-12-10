import { apiFetch } from "../api";

export interface AdminRefreshImportPayload {
  company_id: string;
  normalized_domain?: string;
  company_name?: string;
  timeout_ms?: number;
}

export interface AdminRefreshImportSummary {
  updated_field_count: number;
  new_review_count: number;
}

export interface AdminRefreshImportResponse {
  ok: boolean;
  company: any;
  summary: AdminRefreshImportSummary;
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
  };

  if (!res.ok || json.ok === false) {
    const message = json.error || json.message || `Refresh import failed (${res.status})`;
    throw new Error(message);
  }

  return {
    ok: Boolean(json.ok),
    company: json.company,
    summary: json.summary || { updated_field_count: 0, new_review_count: 0 },
  };
}
