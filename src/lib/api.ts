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

function looksLikeAbsoluteUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

function resolveApiBaseFromEnv() {
  // Canonical resolution logic (must match behavior exactly):
  //
  // const rawBase =
  //   import.meta.env.VITE_XAI_FUNCTIONS_BASE ??
  //   import.meta.env.VITE_API_BASE ??
  //   "";
  //
  // const isValidBase =
  //   typeof rawBase === "string" &&
  //   rawBase.length > 0 &&
  //   rawBase !== "https://" &&
  //   rawBase !== "http://" &&
  //   (rawBase.startsWith("/") || rawBase.startsWith("http"));
  //
  // const API_BASE = isValidBase ? rawBase : "/api";

  const rawBase = import.meta.env.VITE_XAI_FUNCTIONS_BASE ?? import.meta.env.VITE_API_BASE ?? "";

  const isValidBase =
    typeof rawBase === "string" &&
    rawBase.length > 0 &&
    rawBase !== "https://" &&
    rawBase !== "http://" &&
    (rawBase.startsWith("/") || rawBase.startsWith("http://") || rawBase.startsWith("https://"));

  // Keep the console signal from the previous implementation (dev-only).
  const isDev = import.meta.env.MODE === "development";
  if (isDev && isValidBase && looksLikeAbsoluteUrl(rawBase) && typeof console !== "undefined" && console.warn) {
    console.warn(
      `[API Config] Using absolute VITE_XAI_FUNCTIONS_BASE/VITE_API_BASE: ${rawBase}. ` +
        `If this is a different origin than the frontend, you may need CORS on the backend.`
    );
  }

  return isValidBase ? rawBase : "/api";
}

export const API_BASE = resolveApiBaseFromEnv();

// Backwards-compatible label used by admin debug UIs.
export const FUNCTIONS_BASE = API_BASE === "/api" ? "" : API_BASE;

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

type ApiRequestExplain = {
  url: string;
  method: string;
  headers: Record<string, string>;
  contentType: string;
  bodyTypeof: string;
  bodyString?: {
    length: number;
    preview: string;
  };
  bodyNonString?: {
    tag: string;
    keys?: string[];
  };
};

let lastApiRequestExplain: ApiRequestExplain | null = null;
export function getLastApiRequestExplain() {
  return lastApiRequestExplain;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    headers.forEach((value, key) => {
      out[key] = value;
    });
  } catch {
    // ignore
  }
  return out;
}

function looksLikeJsonString(value: string) {
  const s = value.trim();
  if (!s) return false;
  if (!(s.startsWith("{") || s.startsWith("["))) return false;
  return safeJsonParse(s) != null;
}

function buildApiRequestExplain(url: string, init: RequestInit, originalBody: unknown): ApiRequestExplain {
  const method = typeof init?.method === "string" && init.method.trim() ? init.method.trim().toUpperCase() : "GET";
  const headers = new Headers(init?.headers || undefined);
  const headersObj = headersToRecord(headers);
  const contentType = normalizeHeaderValue(headers.get("content-type"));

  const body = (init as any)?.body;
  const bodyTypeof = typeof body;

  const explain: ApiRequestExplain = {
    url,
    method,
    headers: headersObj,
    contentType,
    bodyTypeof,
  };

  if (typeof body === "string") {
    explain.bodyString = {
      length: body.length,
      preview: body.slice(0, 120),
    };
  } else if (body != null) {
    const tag = Object.prototype.toString.call(body);

    const keys =
      originalBody && typeof originalBody === "object" && !Array.isArray(originalBody)
        ? Object.keys(originalBody as Record<string, unknown>)
        : undefined;

    explain.bodyNonString = keys ? { tag, keys } : { tag };
  }

  return explain;
}

function normalizeRequestInit(init?: RequestInit) {
  const nextInit: RequestInit = { ...(init || {}) };
  const headers = new Headers(nextInit.headers || undefined);

  const originalBody: unknown = (nextInit as any).body;

  // Normalize body encoding in one place.
  if (originalBody === undefined) {
    delete (nextInit as any).body;
  } else if (typeof originalBody === "string") {
    (nextInit as any).body = originalBody;
    if (!headers.has("content-type") && looksLikeJsonString(originalBody)) {
      headers.set("Content-Type", "application/json");
    }
  } else if (
    typeof FormData !== "undefined" &&
    originalBody instanceof FormData
  ) {
    (nextInit as any).body = originalBody as any;
    // Do not set Content-Type for FormData; the browser will set boundary.
  } else if (
    typeof URLSearchParams !== "undefined" &&
    originalBody instanceof URLSearchParams
  ) {
    (nextInit as any).body = originalBody as any;
  } else if (
    typeof Blob !== "undefined" &&
    originalBody instanceof Blob
  ) {
    (nextInit as any).body = originalBody as any;
  } else if (
    typeof ArrayBuffer !== "undefined" &&
    originalBody instanceof ArrayBuffer
  ) {
    (nextInit as any).body = originalBody as any;
  } else {
    // Treat anything else as a JSON-able payload.
    const json = JSON.stringify(originalBody);
    (nextInit as any).body = json;
    if (!headers.has("content-type")) {
      headers.set("Content-Type", "application/json");
    }
  }

  nextInit.headers = headers;

  return { init: nextInit, originalBody };
}

function shouldExplainClientRequest(url: string) {
  try {
    if (typeof window === "undefined") return false;
    const parsed = new URL(url, window.location.origin);
    return parsed.searchParams.get("explain") === "1";
  } catch {
    return false;
  }
}

export async function apiFetch(path: string, init?: RequestInit) {
  const url = join(API_BASE, path);

  const { init: normalizedInit, originalBody } = normalizeRequestInit(init);
  const explain = buildApiRequestExplain(url, normalizedInit, originalBody);
  lastApiRequestExplain = explain;

  // Temporary UI-only debug path: /import/start?explain=1 (and fallback /import-start?explain=1)
  if (shouldExplainClientRequest(url) && /\/import(-start|\/start)\b/i.test(path)) {
    return new Response(JSON.stringify({ ok: true, explain }, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const response = await fetch(url, normalizedInit);

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
