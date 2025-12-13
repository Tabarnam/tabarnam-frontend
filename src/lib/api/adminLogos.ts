import { apiFetch } from '../api';

export async function setLogoUrl(companyId: string, logoUrl: string): Promise<{ logo_url: string }> {
  const r = await apiFetch(`/xadmin-api-logos/${encodeURIComponent(companyId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ logo_url: logoUrl })
  });
  if (!r.ok) throw new Error(`setLogoUrl failed: ${r.status}`);
  return r.json();
}

export interface UploadCompanyLogoResult {
  ok: boolean;
  hasLogoUrl: boolean;
  logoUrl?: string;
}

export interface RetryLogoImportResult {
  ok: boolean;
  company_id: string;
  logo_import_status: "imported" | "missing" | "failed";
  logo_source_url?: string | null;
  logo_url?: string | null;
  logo_error?: string;
}

export async function retryLogoImport(companyId: string): Promise<RetryLogoImportResult> {
  const r = await apiFetch('/retry-logo-import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ company_id: companyId }),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data?.ok) {
    throw new Error(data?.error || `retryLogoImport failed: ${r.status}`);
  }

  return data;
}

export async function uploadCompanyLogo(companyId: string, file: File): Promise<UploadCompanyLogoResult> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('companyId', companyId);

  const r = await apiFetch('/upload-logo-blob', {
    method: 'POST',
    body: formData,
  });

  if (!r.ok) {
    const errorData = await r.json().catch(() => ({}));
    throw new Error(errorData.error || `Upload failed with status ${r.status}`);
  }

  const data = await r.json();
  if (!data.ok) {
    throw new Error(data.error || 'Upload failed');
  }

  return {
    ok: data.ok,
    hasLogoUrl: !!data.logo_url,
    logoUrl: data.logo_url,
  };
}
