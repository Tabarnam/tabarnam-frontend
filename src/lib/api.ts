// src/lib/api.ts
// Single source of truth for the front-end API base.
// DEV:   Vite dev server can proxy or call local functions
// PROD:  Use the SWA managed API at /api

const DEV_BASE = '/api';   // works with "swa start" or no-proxy setup
const PROD_BASE = '/api';  // <— key change: use /api directly, not /xapi

export const API_BASE = "https://tabarnam-xai-externalapi.azurewebsites.net/api";

// Small helpers
export function join(base: string, path: string) {
  if (!base.endsWith('/')) base += '/';
  return base + path.replace(/^\//, '');
}

export async function apiFetch(path: string, init?: RequestInit) {
  const url = join(API_BASE, path);
  return fetch(url, init);
}

// Health check (optional)
export async function ping() {
  const r = await apiFetch('/ping');
  return r.json();
}
