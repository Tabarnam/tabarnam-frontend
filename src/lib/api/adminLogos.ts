import { apiFetch } from '../api';

export async function setLogoUrl(companyId: string, logoUrl: string): Promise<{ logo_url: string }> {
  const r = await apiFetch(`/admin/logos/${encodeURIComponent(companyId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ logo_url: logoUrl })
  });
  if (!r.ok) throw new Error(`setLogoUrl failed: ${r.status}`);
  return r.json();
}

// keep the local preview behavior for now, or switch to real upload when ready
export async function uploadLogoFile(companyId: string, file: File): Promise<{ logo_url: string }> {
  // TODO: swap to your real upload flow (presigned URL, then PUT to blob, then POST logo URL)
  const objectUrl = URL.createObjectURL(file);
  await new Promise((r) => setTimeout(r, 400));
  return { logo_url: objectUrl };
}
