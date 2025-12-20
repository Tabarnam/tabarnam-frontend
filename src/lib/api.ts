// src/lib/api.ts
// Single source of truth for client-side API routing.
//
// Preferred configuration:
// - VITE_XAI_FUNCTIONS_BASE: Base origin for the Functions host (e.g. "" for same-origin, or "https://tabarnam.com").
//
// Notes:
// - We still allow legacy VITE_API_BASE for backwards compatibility.
// - API_BASE is always computed as "{FUNCTIONS_BASE}/api" (or "/api" when same-origin).
// - If you set an absolute FUNCTIONS_BASE to a different origin, CORS may be required.

type JsonRecord = Record<string, unknown>;

function trimSlashes(value: string) {
  return value.replace(/\/+$/, "");
}

function looksLikeAbsoluteUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

function normalizeFunctionsBase(value: string) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  // Allow users to accidentally include /api; normalize it out.
  const withoutTrailing = trimSlashes(raw);
  if (withoutTrailing === "/api") return "";
  if (withoutTrailing.endsWith("/api")) return withoutTrailing.slice(0, -4);

  return withoutTrailing;
}

function computeApiBase(functionsBase: string) {
  const base = functionsBase ? trimSlashes(functionsBase) : "";
  return base ? `${base}/api` : "/api";
}

function getFunctionsBaseFromEnv() {
  const raw =
    import.meta.env.VITE_XAI_FUNCTIONS_BASE?.trim() ||
    import.meta.env.VITE_API_BASE?.trim() ||
    "";

  const normalized = normalizeFunctionsBase(raw);

  // Keep the console signal from the previous implementation (dev-only).
  const isDev = import.meta.env.MODE === "development";
  if (isDev && raw && looksLikeAbsoluteUrl(raw) && typeof console !== "undefined" && console.warn) {
    console.warn(
      `[API Config] Using absolute VITE_XAI_FUNCTIONS_BASE/VITE_API_BASE: ${raw}. ` +
        `If this is a different origin than the frontend, you may need CORS on the backend.`
    );
  }

  return normalized;
}

export const FUNCTIONS_BASE = getFunctionsBaseFromEnv();
export const API_BASE = computeApiBase(FUNCTIONS_BASE);

export function toErrorString(err: unknown): string {
  try {
    const anyErr: any = err as any;
    const message = anyErr?.message ?? anyErr?.error;
    if (message != null) return String(message);

    if (anyErr instanceof Error && anyErr.message) return String(anyErr.message);

    if (err != null && typeof err === "object") {
      try {
        return String(JSON.stringify(err));
      } catch {
        return String(err);
      }
    }

    return String(err ?? "");
  } catch {
    return "";
  }
}

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
