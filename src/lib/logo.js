// src/lib/logo.js
import { API_BASE } from "@/lib/api";

export async function fetchCompanyLogo(input) {
  // input: { url } or { domain }
  const r = await fetch(`${API_BASE}/logo-scrape`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) return null;
  return data.logo_url || null;
}
