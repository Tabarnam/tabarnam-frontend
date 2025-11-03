// src/lib/api.ts
// Single source of truth for the front-end API base.
// Uses relative path /api so it works with:
// - Local dev: proxied to func start --port 7073
// - Deployed: SWA managed API at /api
// - Environment override: VITE_API_BASE env variable

const getAPIBase = () => {
  // Check for environment variable override (set via .env or deployment config)
  if (typeof import.meta !== 'undefined' && import.meta.env.VITE_API_BASE) {
    return import.meta.env.VITE_API_BASE;
  }
  // Default: use relative path so dev server and SWA can proxy correctly
  return '/api';
};

export const API_BASE = getAPIBase();

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
