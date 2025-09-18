// Placeholder API client for admin logo actions.
// Wire these to your real backend when ready.

export async function setLogoUrl(companyId: string, logoUrl: string): Promise<{ logo_url: string }> {
  // TODO: Replace with real API call, e.g.:
  // await fetch(`/api/admin/logos/${companyId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ logo_url: logoUrl }) });
  // For now, mimic success:
  await new Promise((r) => setTimeout(r, 400));
  return { logo_url: logoUrl };
}

export async function uploadLogoFile(companyId: string, file: File): Promise<{ logo_url: string }> {
  // TODO: Replace with real upload (e.g., presigned URL to Azure Blob, then PUT, then save URL).
  // For now, create an object URL so you can see it immediately in the UI:
  const objectUrl = URL.createObjectURL(file);
  await new Promise((r) => setTimeout(r, 400));
  return { logo_url: objectUrl };
}
