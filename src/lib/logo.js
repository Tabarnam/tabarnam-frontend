// src/lib/logo.js
export async function fetchCompanyLogo(input) {
  // input: { url } or { domain }
  const r = await fetch("/api/logo-scrape", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  const data = await r.json();
  if (!r.ok || !data.ok) return null;
  return data.logo_url || null;
}
