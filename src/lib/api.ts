// src/lib/api.ts
// Single source of truth for client-side API routing.
//
// Preferred configuration:
// - VITE_XAI_FUNCTIONS_BASE: API base URL (recommended: "/api" for same-origin).
//
// Notes:
// - We still allow legacy VITE_API_BASE for backwards compatibility.
// - API_BASE always falls back to same-origin "/api" when VITE_* is missing or invalid.
// - If you set an absolute API_BASE to a different origin, CORS may be required.

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

function normalizeBuildIdString(value: unknown): string {
  const s = String(value || "").trim();
  if (!s) return "";
  const m = s.match(/[0-9a-f]{7,40}/i);
  return m ? m[0] : s;
}

export function getResponseBuildId(res: Response): string {
  const headers = res?.headers;
  const bid =
    normalizeHeaderValue(headers?.get?.("x-api-build-id")) ||
    normalizeHeaderValue(headers?.get?.("X-Api-Build-Id")) ||
    normalizeHeaderValue(headers?.get?.("x-build-id")) ||
    normalizeHeaderValue(headers?.get?.("X-Build-Id"));
  return normalizeBuildIdString(bid);
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
    full: string;
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
      full: body,
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
    // Client-only explain: allow `?explain=1` to reach the server.
    return parsed.searchParams.get("explain_client") === "1";
  } catch {
    return false;
  }
}

function getMethodFromInit(init?: RequestInit): string {
  const m = typeof init?.method === "string" && init.method.trim() ? init.method.trim().toUpperCase() : "GET";
  return m;
}

function getResponseHeadersSubset(res: Response): {
  "content-type": string;
  "x-request-id": string;
  "x-ms-request-id": string;
  "x-functions-execution-id": string;
} {
  const h = res?.headers;

  const contentType = normalizeHeaderValue(h?.get?.("content-type"));
  const xRequestId =
    normalizeHeaderValue(h?.get?.("x-request-id")) ||
    normalizeHeaderValue(h?.get?.("xai-request-id")) ||
    normalizeHeaderValue(h?.get?.("request-id"));

  const xMsRequestId = normalizeHeaderValue(h?.get?.("x-ms-request-id"));
  const xFunctionsExecutionId =
    normalizeHeaderValue(h?.get?.("x-functions-execution-id")) ||
    normalizeHeaderValue(h?.get?.("x-functions-executionid"));

  return {
    "content-type": contentType,
    "x-request-id": xRequestId,
    "x-ms-request-id": xMsRequestId,
    "x-functions-execution-id": xFunctionsExecutionId,
  };
}

export async function apiFetch(path: string, init?: RequestInit) {
  const url = join(API_BASE, path);

  const { init: normalizedInit, originalBody } = normalizeRequestInit(init);
  const explain = buildApiRequestExplain(url, normalizedInit, originalBody);
  lastApiRequestExplain = explain;

  // Temporary UI-only debug path: /import/start?explain_client=1 (and fallback /import-start?explain_client=1)
  if (shouldExplainClientRequest(url) && /\/import(-start|\/start)\b/i.test(path)) {
    return new Response(JSON.stringify({ ok: true, explain }, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const method = getMethodFromInit(normalizedInit);

  try {
    const response = await fetch(url, normalizedInit);

    if (!response.ok) {
      const responseText = await response.clone().text().catch(() => "");
      const parsedBody = responseText ? safeJsonParse(responseText) : null;

      const responseTextMax = 20_000;
      const responseTextTruncated = responseText.length > responseTextMax;
      const responseTextPreview = responseTextTruncated ? responseText.slice(0, responseTextMax) : responseText;

      const err = {
        status: response.status,
        url,
        method,
        build_id: getResponseBuildId(response) || null,
        response_body: parsedBody,
        response_text: responseTextPreview,
        response_text_preview: responseTextPreview,
        response_text_truncated: responseTextTruncated,
        response_headers: getResponseHeadersSubset(response),
      };

      // Attach best-effort diagnostics without changing the response contract.
      try {
        (response as any).__api_fetch_error = err;
      } catch {
        // ignore
      }

      const configMsg = await getUserFacingConfigMessage(response);
      console.error("[apiFetch] Non-2xx response", {
        ...err,
        ...(configMsg ? { user_facing_config_message: configMsg } : {}),
      });
    }

    return response;
  } catch (e: any) {
    const errorMessage = e?.message ? String(e.message) : "fetch_failed";
    const errorStackPreview =
      typeof e?.stack === "string" && e.stack.trim()
        ? e.stack.length > 2000
          ? e.stack.slice(0, 2000)
          : e.stack
        : "";

    console.error("[apiFetch] Network error", {
      url,
      method,
      error_message: errorMessage,
      error_stack_preview: errorStackPreview,
    });

    // Production hardening: some deployments (CDNs/WAF) can intermittently block or reset
    // connections to /api/*, while allowing the same backend via an alternate route.
    // Our SWA config supports /xapi/* -> /api/{*path} rewrites.
    const canRetryViaXapi =
      API_BASE === "/api" &&
      typeof path === "string" &&
      !/^\s*https?:\/\//i.test(path) &&
      !/^\s*\/xapi\//i.test(path);

    if (canRetryViaXapi) {
      const fallbackUrl = join("/xapi", path);

      try {
        console.warn("[apiFetch] Retrying via /xapi after network error", {
          original_url: url,
          fallback_url: fallbackUrl,
          method,
        });

        const response = await fetch(fallbackUrl, normalizedInit);

        if (!response.ok) {
          const responseText = await response.clone().text().catch(() => "");
          const parsedBody = responseText ? safeJsonParse(responseText) : null;

          const responseTextMax = 20_000;
          const responseTextTruncated = responseText.length > responseTextMax;
          const responseTextPreview = responseTextTruncated ? responseText.slice(0, responseTextMax) : responseText;

          const err = {
            status: response.status,
            url: fallbackUrl,
            method,
            build_id: getResponseBuildId(response) || null,
            response_body: parsedBody,
            response_text: responseTextPreview,
            response_text_preview: responseTextPreview,
            response_text_truncated: responseTextTruncated,
            response_headers: getResponseHeadersSubset(response),
            fallback_from: url,
          };

          try {
            (response as any).__api_fetch_error = err;
          } catch {
            // ignore
          }

          const configMsg = await getUserFacingConfigMessage(response);
          console.error("[apiFetch] Non-2xx response (fallback /xapi)", {
            ...err,
            ...(configMsg ? { user_facing_config_message: configMsg } : {}),
          });
        }

        return response;
      } catch (e2: any) {
        const fallbackMessage = e2?.message ? String(e2.message) : "fetch_failed";
        const fallbackStackPreview =
          typeof e2?.stack === "string" && e2.stack.trim() ? (e2.stack.length > 2000 ? e2.stack.slice(0, 2000) : e2.stack) : "";

        console.error("[apiFetch] Network error (fallback /xapi)", {
          original_url: url,
          fallback_url: fallbackUrl,
          method,
          error_message: fallbackMessage,
          error_stack_preview: fallbackStackPreview,
        });

        return new Response(
          JSON.stringify(
            {
              error: "API unavailable",
              url,
              method,
              build_id: getCachedBuildId() || null,
              build_id_source: getCachedBuildIdSource() || null,
              error_message: errorMessage,
              error_stack_preview: errorStackPreview,
              fallback_url_attempted: fallbackUrl,
              fallback_error_message: fallbackMessage,
              fallback_error_stack_preview: fallbackStackPreview,
            },
            null,
            2
          ),
          {
            status: 503,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    // Return a fake 503 error response instead of throwing
    return new Response(
      JSON.stringify(
        {
          error: "API unavailable",
          url,
          method,
          build_id: getCachedBuildId() || null,
          build_id_source: getCachedBuildIdSource() || null,
          error_message: errorMessage,
          error_stack_preview: errorStackPreview,
        },
        null,
        2
      ),
      {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

let cachedBuildId = "";
let cachedBuildIdSource = "";
let cachedBuildIdPromise: Promise<string> | null = null;

export function getCachedBuildId(): string {
  return cachedBuildId;
}

export function getCachedBuildIdSource(): string {
  return cachedBuildIdSource;
}

async function fetchStaticBuildIdFile(): Promise<string> {
  try {
    const res = await fetch("/__build_id.txt", { cache: "no-store" });
    if (!res.ok) return "";
    return normalizeBuildIdString(await res.text());
  } catch {
    return "";
  }
}

export async function ensureBuildId(): Promise<string> {
  if (cachedBuildId) return cachedBuildId;

  if (!cachedBuildIdPromise) {
    cachedBuildIdPromise = (async () => {
      try {
        await ping();
      } catch {
        // ignore
      }

      if (!cachedBuildId) {
        const staticBuild = await fetchStaticBuildIdFile();
        if (staticBuild) {
          cachedBuildId = staticBuild;
          cachedBuildIdSource = cachedBuildIdSource || "STATIC_BUILD_ID_FILE";
        }
      }

      return cachedBuildId;
    })();
  }

  return cachedBuildIdPromise;
}

// Health check (optional)
export async function ping() {
  const r = await apiFetch("/ping");
  const data = await r.json().catch(() => ({}));

  const bid =
    normalizeBuildIdString((data as any)?.build_id) ||
    getResponseBuildId(r) ||
    normalizeBuildIdString((data as any)?.id);

  if (bid) {
    cachedBuildId = bid;
    cachedBuildIdSource = String((data as any)?.build_id_source || (data as any)?.source || "PING").trim() || "PING";
  }

  return data;
}
