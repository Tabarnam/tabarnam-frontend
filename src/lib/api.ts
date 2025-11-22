// src/lib/api.ts
// Single source of truth for the front-end API base.
// Supports:
// - Local dev: proxied via vite config to http://127.0.0.1:7080
// - Deployed: uses VITE_API_BASE env variable pointing to Azure Functions
// - Fallback: relative /api path

const getAPIBase = () => {
  // Use environment variable if provided (production Azure Functions endpoint)
  if (import.meta.env.VITE_API_BASE) {
    const base = import.meta.env.VITE_API_BASE.trim();
    if (base) return base;
  }

  // Fallback to relative path for local dev with proxy
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
