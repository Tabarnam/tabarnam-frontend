// src/lib/logo.js
import { apiFetch } from "@/lib/api";

export async function fetchCompanyLogo(input) {
  // input: { url } or { domain }
  const r = await apiFetch("/logo-scrape", {
    method: "POST",
    body: input,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) return null;
  return data.logo_url || null;
}
