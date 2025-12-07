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

export async function uploadLogoFile(companyId: string, file: File): Promise<{ logo_url: string }> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('companyId', companyId);

  const r = await fetch('/api/upload-logo-blob', {
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

  return { logo_url: data.logo_url };
}
