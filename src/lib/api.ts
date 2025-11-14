// src/lib/api.ts
// Single source of truth for the front-end API base.
// Uses relative path /api so it works with:
// - Local dev: proxied to func start --port 7073
// - Deployed: SWA managed API at /api
// - Environment override: VITE_API_BASE env variable

const getAPIBase = () => {
  // Always use relative /api so SWA can proxy to Azure Functions and avoid CORS issues
  return "/api";
};

export const API_BASE = getAPIBase();

// Small helpers
export function join(base: string, path: string) {
  if (!base.endsWith('/')) base += '/';
  return base + path.replace(/^\//, '');
}

export async function apiFetch(path: string, init?: RequestInit) {
  const url = join(API_BASE, path);
  try {
    const response = await fetch(url, init);
    if (!response.ok) {
      console.warn(`API ${url} returned ${response.status}:`, response.statusText);
    }
    return response;
  } catch (e) {
    console.error(`API fetch failed for ${url}:`, e?.message);
    // Return a fake 503 error response instead of throwing
    return new Response(JSON.stringify({ error: 'API unavailable', detail: e?.message }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// Health check (optional)
export async function ping() {
  const r = await apiFetch('/ping');
  return r.json();
}
