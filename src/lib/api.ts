// src/lib/api.ts
// Single source of truth for the front-end API base.
// Architecture:
// - Production: Always use relative /api paths (routed through Azure Static Web Apps to backend)
// - Local dev: Uses relative /api paths (proxied via vite.config.js)
// - Never use absolute URLs to avoid cross-origin issues

const getAPIBase = () => {
  const base = import.meta.env.VITE_API_BASE?.trim();
  const isDev = import.meta.env.MODE === "development";

  // In production, never use absolute URLs - always route through same origin
  // Azure Static Web Apps routes /api/* to the linked backend function app
  if (!base) {
    return "/api";
  }

  // If VITE_API_BASE is set but is an absolute URL (contains :// or starts with http),
  // reject it and use relative path instead. This prevents cross-origin issues.
  if (base.includes("://") || base.startsWith("http")) {
    // Only warn in development - in production this is expected behavior
    if (isDev && typeof console !== "undefined" && console.warn) {
      console.warn(
        `[API Config] VITE_API_BASE is set to an absolute URL: ${base}. ` +
        `Using relative /api path instead. ` +
        `Absolute URLs cause CORS issues and should not be used in production.`
      );
    }
    return "/api";
  }

  // If it's a relative path, use it (for local dev scenarios)
  return base;
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
