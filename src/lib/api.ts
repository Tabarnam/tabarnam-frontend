// src/lib/api.ts
// Single source of truth for the front-end API base.
// Architecture:
// - Production: Always use relative /api paths (routed through Azure Static Web Apps to backend)
// - Local dev: Uses relative /api paths (proxied via vite.config.js)
// - Never use absolute URLs to avoid cross-origin issues

type JsonRecord = Record<string, unknown>;

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
  if (!base.endsWith("/")) base += "/";
  return base + path.replace(/^\//, "");
}

function safeLower(s: unknown) {
  return typeof s === "string" ? s.toLowerCase() : "";
}

function safeJsonParse(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeHeaderValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

export function getResponseRequestId(res: Response): string {
  const headers = res?.headers;
  const rid =
    normalizeHeaderValue(headers?.get?.("x-request-id")) ||
    normalizeHeaderValue(headers?.get?.("X-Request-ID")) ||
    normalizeHeaderValue(headers?.get?.("x-ms-middleware-request-id")) ||
    normalizeHeaderValue(headers?.get?.("x-ms-request-id"));
  return rid;
}

export async function readJsonOrText(res: Response): Promise<unknown> {
  let cloned: Response;
  try {
    cloned = res.clone();
  } catch {
    cloned = res;
  }

  const contentType = normalizeHeaderValue(cloned.headers?.get?.("content-type")).toLowerCase();
  const isJson = contentType.includes("application/json") || contentType.includes("+json");

  const text = await cloned.text().catch(() => "");
  if (text) {
    const parsed = safeJsonParse(text);
    if (parsed !== null) return parsed;
  }

  if (isJson) {
    return text ? { error: "Invalid JSON", text } : { error: "Invalid JSON" };
  }

  return text ? { text } : {};
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.clone().text();
  } catch {
    return "";
  }
}

async function safeReadJson(res: Response): Promise<JsonRecord | null> {
  try {
    const data = await res.clone().json();
    if (data && typeof data === "object") return data as JsonRecord;
    return null;
  } catch {
    return null;
  }
}

export async function isCosmosNotConfiguredResponse(res: Response): Promise<boolean> {
  if (res.status !== 503) return false;

  const data = await safeReadJson(res);
  const err = safeLower(data?.error);
  if (err.includes("cosmos db not configured")) return true;

  const text = safeLower(await safeReadText(res));
  return text.includes("cosmos db not configured");
}

export async function getUserFacingConfigMessage(res: Response): Promise<string | null> {
  if (!(await isCosmosNotConfiguredResponse(res))) return null;
  return "Backend configuration incomplete: Cosmos DB environment variables are missing.";
}

export async function apiFetch(path: string, init?: RequestInit) {
  const url = join(API_BASE, path);

  try {
    const response = await fetch(url, init);

    if (!response.ok) {
      const configMsg = await getUserFacingConfigMessage(response);
      if (!configMsg) {
        console.error(`API ${url} returned ${response.status}:`, response.statusText);
      }
    }

    return response;
  } catch (e: any) {
    console.error(`API fetch failed for ${url}:`, e?.message);
    // Return a fake 503 error response instead of throwing
    return new Response(JSON.stringify({ error: "API unavailable", detail: e?.message }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// Health check (optional)
export async function ping() {
  const r = await apiFetch("/ping");
  return r.json();
}
