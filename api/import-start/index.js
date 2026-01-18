let app;
try {
  ({ app } = require("@azure/functions"));
} catch {
  app = { http() {} };
}
const axios = require("axios");
let CosmosClient;
try {
  ({ CosmosClient } = require("@azure/cosmos"));
} catch {
  CosmosClient = null;
}
let randomUUID;
let createHash;
try {
  ({ randomUUID, createHash } = require("crypto"));
} catch {
  randomUUID = null;
  createHash = null;
}
const {
  getContainerPartitionKeyPath,
  buildPartitionKeyCandidates,
  getValueAtPath,
} = require("../_cosmosPartitionKey");
const { getXAIEndpoint, getXAIKey, getResolvedUpstreamMeta } = require("../_shared");
const { startBudget } = require("../_budget");
function requireImportCompanyLogo() {
  const mod = require("../_logoImport");
  if (!mod || typeof mod.importCompanyLogo !== "function") {
    throw new Error("importCompanyLogo is not available");
  }
  return mod.importCompanyLogo;
}
const { geocodeLocationArray, pickPrimaryLatLng } = require("../_geocode");
const {
  validateCuratedReviewCandidate,
  checkUrlHealthAndFetchText,
} = require("../_reviewQuality");
const { fillCompanyBaselineFromWebsite } = require("../_websiteBaseline");
const { fetchCuratedReviews: fetchCuratedReviewsGrok } = require("../_grokEnrichment");
const { computeProfileCompleteness } = require("../_profileCompleteness");
const { mergeCompanyDocsForSession: mergeCompanyDocsForSessionExternal } = require("../_companyDocMerge");
const { applyEnrichment } = require("../_applyEnrichment");
const {
  asMeaningfulString,
  normalizeStringArray,
  isRealValue,
  sanitizeIndustries,
  sanitizeKeywords,
} = require("../_requiredFields");
const { resolveReviewsStarState } = require("../_reviewsStarState");
const { getBuildInfo } = require("../_buildInfo");
const { getImportStartHandlerVersion } = require("../_handlerVersions");
const { upsertSession: upsertImportSession } = require("../_importSessionStore");
const {
  buildInternalFetchHeaders,
  buildInternalFetchRequest,
  getInternalJobSecretInfo,
  getAcceptableInternalSecretsInfo,
} = require("../_internalJobAuth");

// IMPORTANT: pure handler module only (no app.http registrations). Loaded at cold start.
const { invokeResumeWorkerInProcess } = require("../import/resume-worker/handler");

const {
  buildPrimaryJobId: buildImportPrimaryJobId,
  getJob: getImportPrimaryJob,
  upsertJob: upsertImportPrimaryJob,
} = require("../_importPrimaryJobStore");

const __importStartModuleBuildInfo = (() => {
  try {
    return getBuildInfo();
  } catch {
    return { build_id: "unknown" };
  }
})();

const __importStartModuleHandlerVersion = (() => {
  try {
    return getImportStartHandlerVersion(__importStartModuleBuildInfo);
  } catch {
    return "unknown";
  }
})();

try {
  console.log("[import-start] module_loaded", {
    handler_version: __importStartModuleHandlerVersion,
    build_id: String(__importStartModuleBuildInfo?.build_id || "unknown"),
  });
} catch {}

const DEFAULT_HARD_TIMEOUT_MS = 25_000;

// IMPORTANT: /api/* runs behind the SWA gateway. Keep upstream timeouts small and derived
// from remaining budget so we return JSON before the platform kill (~30s).
const DEFAULT_UPSTREAM_TIMEOUT_MS = 8_000;

// Per-stage upstream hard caps (must stay under SWA gateway wall-clock).
const STAGE_MAX_MS = {
  primary: 8_000,
  keywords: 8_000,
  reviews: 8_000,
  location: 7_000,
  expand: 8_000,
};

// Minimum remaining budget required to start a new network stage.
const MIN_STAGE_REMAINING_MS = 4_000;

// Safety buffer we reserve for Cosmos writes + formatting the response.
const DEADLINE_SAFETY_BUFFER_MS = 1_500;

// Extra buffer before starting any upstream call.
const UPSTREAM_TIMEOUT_MARGIN_MS = 1_200;

const XAI_SYSTEM_PROMPT =
  "You are a precise assistant. Follow the user's instructions exactly. When asked for JSON, output ONLY valid JSON with no markdown, no prose, and no extra keys.";

const GROK_ONLY_FIELDS = new Set([
  "headquarters_location",
  "manufacturing_locations",
  "reviews",
]);

function assertNoWebsiteFallback(field) {
  if (GROK_ONLY_FIELDS.has(field)) return true;
  return false;
}

if (!globalThis.__importStartProcessHandlersInstalled) {
  globalThis.__importStartProcessHandlersInstalled = true;

  process.on("unhandledRejection", (reason) => {
    try {
      const msg = reason?.stack || reason?.message || String(reason);
      console.error("[import-start] unhandledRejection:", msg);
    } catch {
      console.error("[import-start] unhandledRejection");
    }
  });

  process.on("uncaughtException", (err) => {
    try {
      const msg = err?.stack || err?.message || String(err);
      console.error("[import-start] uncaughtException:", msg);
    } catch {
      console.error("[import-start] uncaughtException");
    }
  });
}

const HANDLER_ID = "import-start";

function json(obj, status = 200, extraHeaders) {
  const payload = obj && typeof obj === "object" && !Array.isArray(obj)
    ? { ...obj, build_id: obj.build_id || String(__importStartModuleBuildInfo?.build_id || "") }
    : obj;

  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers":
        "content-type,authorization,x-functions-key,x-request-id,x-correlation-id,x-session-id,x-client-request-id,x-tabarnam-internal,x-internal-secret,x-internal-job-secret,x-job-kind",
      "Access-Control-Expose-Headers": "x-request-id,x-correlation-id,x-session-id,X-Api-Handler,X-Api-Build-Id",
      "X-Api-Handler": HANDLER_ID,
      "X-Api-Build-Id": String(__importStartModuleBuildInfo?.build_id || ""),
      ...(extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {}),
    },
    body: JSON.stringify(payload),
  };
}

class AcceptedResponseError extends Error {
  constructor(response, message = "Accepted") {
    super(message);
    this.name = "AcceptedResponseError";
    this.response = response;
  }
}

function logImportStartMeta(meta) {
  try {
    const m = meta && typeof meta === "object" ? meta : {};

    const out = {
      handler_version: String(m.handler_version || ""),
      stage: String(m.stage || ""),
      queryTypes: Array.isArray(m.queryTypes) ? m.queryTypes.map((t) => String(t || "").trim()).filter(Boolean) : [],
      query_len: Number.isFinite(Number(m.query_len)) ? Number(m.query_len) : 0,
      prompt_len: Number.isFinite(Number(m.prompt_len)) ? Number(m.prompt_len) : 0,
      messages_len: Number.isFinite(Number(m.messages_len)) ? Number(m.messages_len) : 0,
      has_system_message: Boolean(m.has_system_message),
      has_user_message: Boolean(m.has_user_message),
      user_message_len: Number.isFinite(Number(m.user_message_len)) ? Number(m.user_message_len) : 0,
      elapsedMs: Number.isFinite(Number(m.elapsedMs)) ? Number(m.elapsedMs) : 0,
      upstream_status:
        m.upstream_status === null || m.upstream_status === undefined || m.upstream_status === ""
          ? null
          : Number.isFinite(Number(m.upstream_status))
            ? Number(m.upstream_status)
            : null,
    };

    if (m.request_id) out.request_id = String(m.request_id);
    if (m.session_id) out.session_id = String(m.session_id);

    console.log(JSON.stringify(out));
  } catch {
    console.log("[import-start] meta_log_failed");
  }
}

function safeJsonParse(text) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

class InvalidJsonBodyError extends Error {
  constructor(message = "Invalid JSON body", options) {
    super(message);
    this.name = "InvalidJsonBodyError";
    this.code = "INVALID_JSON_BODY";

    const parseError = options?.parseError;
    this.parse_error =
      parseError && typeof parseError === "object"
        ? String(parseError.message || parseError.name || "")
        : parseError
          ? String(parseError)
          : null;

    this.content_type =
      typeof options?.contentType === "string" && options.contentType.trim() ? options.contentType.trim() : null;

    this.body_type = typeof options?.bodyType === "string" && options.bodyType.trim() ? options.bodyType.trim() : null;

    this.is_body_object = typeof options?.isBodyObject === "boolean" ? options.isBodyObject : null;

    this.body_source =
      typeof options?.bodySource === "string" && options.bodySource.trim() ? options.bodySource.trim() : null;

    this.body_source_detail =
      typeof options?.bodySourceDetail === "string" && options.bodySourceDetail.trim() ? options.bodySourceDetail.trim() : null;

    this.raw_text_preview =
      typeof options?.rawTextPreview === "string" && options.rawTextPreview.trim() ? options.rawTextPreview.trim() : null;

    this.raw_text_hex_preview =
      typeof options?.rawTextHexPreview === "string" && options.rawTextHexPreview.trim() ? options.rawTextHexPreview.trim() : null;

    // Back-compat fields.
    this.first_bytes_preview =
      typeof options?.firstBytesPreview === "string" && options.firstBytesPreview.trim()
        ? options.firstBytesPreview.trim()
        : this.raw_text_hex_preview;

    this.raw_body_preview =
      typeof options?.rawBodyPreview === "string" && options.rawBodyPreview.trim()
        ? options.rawBodyPreview.trim()
        : this.raw_text_preview;
  }
}

function isBinaryBody(value) {
  return (
    Buffer.isBuffer(value) ||
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer
  );
}

function binaryBodyToString(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value)).toString("utf8");
  return "";
}

function parseJsonBodyStrict(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return { ok: true, value: parsed };
    return { ok: true, value: {} };
  } catch (error) {
    return { ok: false, error };
  }
}

function sanitizeTextPreview(text) {
  let s = typeof text === "string" ? text : String(text ?? "");
  if (!s) return "";

  s = s.replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
  s = s.replace(/x-functions-key\s*[:=]\s*[^\s"']+/gi, "x-functions-key: [REDACTED]");
  s = s.replace(/api[_-]?key\s*[:=]\s*[^\s"']+/gi, "api_key: [REDACTED]");

  return s;
}

function toTextPreview(value, maxChars = 500) {
  if (value == null) return "";

  let raw = "";
  if (typeof value === "string") {
    raw = value;
  } else {
    try {
      raw = JSON.stringify(value);
    } catch {
      raw = String(value);
    }
  }

  raw = sanitizeTextPreview(raw).trim();
  if (!raw) return "";
  return raw.length > maxChars ? raw.slice(0, maxChars) : raw;
}

function buildFirstBytesPreview(value, maxBytes = 50) {
  try {
    const buf = Buffer.isBuffer(value)
      ? value
      : value instanceof Uint8Array
        ? Buffer.from(value)
        : value instanceof ArrayBuffer
          ? Buffer.from(new Uint8Array(value))
          : typeof value === "string"
            ? Buffer.from(value, "utf8")
            : Buffer.from(String(value ?? ""), "utf8");

    if (!buf.length) return "";

    const slice = buf.subarray(0, Math.max(0, Math.min(maxBytes, buf.length)));
    const hex = slice.toString("hex");
    let ascii = slice.toString("utf8");
    ascii = ascii.replace(/[^\x20-\x7E]/g, ".");
    ascii = sanitizeTextPreview(ascii);

    return `hex:${hex} ascii:${ascii}`;
  } catch {
    return "";
  }
}

function buildHexPreview(value, maxBytes = 50) {
  try {
    const buf = Buffer.isBuffer(value)
      ? value
      : value instanceof Uint8Array
        ? Buffer.from(value)
        : value instanceof ArrayBuffer
          ? Buffer.from(new Uint8Array(value))
          : typeof value === "string"
            ? Buffer.from(value, "utf8")
            : Buffer.from(String(value ?? ""), "utf8");

    if (!buf.length) return "";
    const slice = buf.subarray(0, Math.max(0, Math.min(maxBytes, buf.length)));
    return slice.toString("hex");
  } catch {
    return "";
  }
}

function readQueryParam(req, name) {
  if (!req || !name) return undefined;

  const query = req.query;
  if (query) {
    if (typeof query.get === "function") {
      try {
        const v = query.get(name);
        if (v !== null && v !== undefined) return v;
      } catch {}
    }

    const direct = query[name] ?? query[name.toLowerCase()] ?? query[name.toUpperCase()];
    if (direct !== null && direct !== undefined) return direct;
  }

  const rawUrl = typeof req.url === "string" ? req.url : "";
  if (rawUrl) {
    try {
      const u = new URL(rawUrl, "http://localhost");
      const v = u.searchParams.get(name);
      if (v !== null && v !== undefined) return v;
    } catch {}
  }

  return undefined;
}

function getBodyType(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Buffer.isBuffer(value)) return "Buffer";
  if (value instanceof Uint8Array) return "Uint8Array";
  if (value instanceof ArrayBuffer) return "ArrayBuffer";
  if (typeof value === "object" && value?.constructor?.name) return value.constructor.name;
  return typeof value;
}

function getBodyLen(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return value.length;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value.length;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (typeof value === "object") {
    try {
      return Object.keys(value).length;
    } catch {
      return 0;
    }
  }
  return 0;
}

function getBodyKeysPreview(value, maxKeys = 20) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    return Object.keys(value).slice(0, Math.max(0, Math.trunc(maxKeys)));
  } catch {
    return null;
  }
}

function isProbablyStreamBody(value) {
  return !!(
    value &&
    typeof value === "object" &&
    (typeof value.getReader === "function" ||
      typeof value.pipeTo === "function" ||
      typeof value.on === "function" ||
      typeof value[Symbol.asyncIterator] === "function")
  );
}

function parseJsonFromStringOrBinary(value, meta) {
  const text = typeof value === "string" ? value : binaryBodyToString(value);
  const result = parseJsonBodyStrict(text);
  if (!result.ok) {
    const rawTextPreview = toTextPreview(text, 200);
    const rawTextHexPreview = buildHexPreview(value || text, 80);

    throw new InvalidJsonBodyError("Invalid JSON body", {
      parseError: result.error,
      rawTextPreview,
      rawTextHexPreview,
      firstBytesPreview: buildFirstBytesPreview(value || text),
      rawBodyPreview: rawTextPreview,
      bodySource: meta?.body_source || null,
      bodySourceDetail: meta?.body_source_detail || null,
    });
  }
  return result.value;
}

function toBufferChunk(chunk) {
  if (chunk == null) return null;
  if (Buffer.isBuffer(chunk)) return chunk;

  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (chunk instanceof ArrayBuffer) return Buffer.from(new Uint8Array(chunk));
  if (typeof ArrayBuffer !== "undefined" && typeof ArrayBuffer.isView === "function" && ArrayBuffer.isView(chunk)) {
    try {
      return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    } catch {
      return Buffer.from(String(chunk), "utf8");
    }
  }

  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");

  if (Array.isArray(chunk)) {
    try {
      return Buffer.from(chunk);
    } catch {
      return Buffer.from(String(chunk), "utf8");
    }
  }

  if (typeof chunk === "object") {
    const maybe = chunk;
    if (maybe && maybe.type === "Buffer" && Array.isArray(maybe.data)) {
      try {
        return Buffer.from(maybe.data);
      } catch {}
    }
    if (maybe && Array.isArray(maybe.data)) {
      try {
        return Buffer.from(maybe.data);
      } catch {}
    }
    if (maybe && maybe.buffer instanceof ArrayBuffer) {
      try {
        const view = new Uint8Array(maybe.buffer, maybe.byteOffset || 0, maybe.byteLength || undefined);
        return Buffer.from(view);
      } catch {}
    }
  }

  return Buffer.from(String(chunk), "utf8");
}

async function readStreamLikeToBuffer(streamLike) {
  if (!streamLike) return Buffer.alloc(0);

  const hasWebStreamSignals =
    typeof streamLike.getReader === "function" || typeof streamLike.pipeTo === "function" || typeof streamLike.tee === "function";

  if (hasWebStreamSignals && typeof Response === "function") {
    try {
      if (typeof streamLike.tee === "function") {
        const [a, b] = streamLike.tee();
        try {
          const ab = await new Response(a).arrayBuffer();
          return Buffer.from(new Uint8Array(ab));
        } catch (err) {
          streamLike = b;
        }
      }

      const ab = await new Response(streamLike).arrayBuffer();
      return Buffer.from(new Uint8Array(ab));
    } catch {
      // Fall through.
    }
  }

  if (typeof streamLike.getReader === "function") {
    const reader = streamLike.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = toBufferChunk(value);
      if (buf && buf.length) chunks.push(buf);
    }
    return chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
  }

  if (typeof streamLike[Symbol.asyncIterator] === "function") {
    const chunks = [];
    for await (const chunk of streamLike) {
      const buf = toBufferChunk(chunk);
      if (buf && buf.length) chunks.push(buf);
    }
    return chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
  }

  if (typeof streamLike.on === "function") {
    return await new Promise((resolve, reject) => {
      const chunks = [];
      let settled = false;

      const cleanup = () => {
        try {
          streamLike.off?.("data", onData);
          streamLike.off?.("end", onEnd);
          streamLike.off?.("error", onError);
        } catch {}
      };

      const onData = (chunk) => {
        const buf = toBufferChunk(chunk);
        if (buf && buf.length) chunks.push(buf);
      };

      const onEnd = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0));
      };

      const onError = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      try {
        streamLike.on("data", onData);
        streamLike.on("end", onEnd);
        streamLike.on("error", onError);
      } catch (e) {
        reject(e);
      }
    });
  }

  return Buffer.alloc(0);
}

async function parseJsonFromStreamLike(value, meta) {
  const buf = await readStreamLikeToBuffer(value);
  if (!buf || !buf.length) return {};
  return parseJsonFromStringOrBinary(buf, meta);
}

function isJsonContentType(value) {
  const v = String(value || "").toLowerCase();
  return v.includes("application/json") || v.includes("+json");
}

async function readJsonBody(req) {
  if (!req) {
    return { body: {}, body_source: "unknown", body_source_detail: "no_req" };
  }

  const rawBody = req.rawBody;
  const body = req.body;
  const bufferBody = req.bufferBody;

  const contentType = getHeader(req, "content-type") || "";
  const prefersBodyObject = isJsonContentType(contentType);

  const isStreamBody = isProbablyStreamBody(rawBody) || isProbablyStreamBody(body) || isProbablyStreamBody(bufferBody);

  const decorateInvalidJsonError = (err, meta) => {
    if (!err || err.code !== "INVALID_JSON_BODY") return err;

    const bodyType = typeof req?.body;
    const isBodyObject = Boolean(req?.body && typeof req.body === "object" && !Array.isArray(req.body));
    const bodyKeysPreview = getBodyKeysPreview(req?.body);

    err.content_type ||= contentType || null;
    err.body_type ||= bodyType || null;
    err.is_body_object = typeof err.is_body_object === "boolean" ? err.is_body_object : isBodyObject;
    err.body_keys_preview ||= bodyKeysPreview;

    err.body_source ||= meta?.body_source || null;
    err.body_source_detail ||= meta?.body_source_detail || null;

    return err;
  };

  try {
    console.log("[import-start] body_sources", {
      hasRawBody: rawBody !== undefined && rawBody !== null,
      rawBodyType: getBodyType(rawBody),
      rawBodyLen: getBodyLen(rawBody),
      bodyType: getBodyType(body),
      bodyLen: getBodyLen(body),
      hasBufferBody: bufferBody !== undefined && bufferBody !== null,
      bufferBodyLen: getBodyLen(bufferBody),
      isStreamBody,
    });
  } catch {
    console.log("[import-start] body_sources");
  }

  const bodyIsNonNullObject = body !== null && typeof body === "object" && !Array.isArray(body);
  const bodyIsPlainObject = bodyIsNonNullObject && !isBinaryBody(body) && !isProbablyStreamBody(body);
  const bodyKeysLen = bodyIsPlainObject ? getBodyLen(body) : 0;
  const bodyIsEmptyObject = bodyIsPlainObject && bodyKeysLen === 0;

  if (prefersBodyObject && bodyIsPlainObject && bodyKeysLen > 0) {
    const keysPreview = getBodyKeysPreview(body);
    try {
      console.log(
        "[import-start] readJsonBody: using req.body object branch (json content-type)",
        JSON.stringify({ keys: keysPreview })
      );
    } catch {
      console.log("[import-start] readJsonBody: using req.body object branch (json content-type)");
    }

    return { body, body_source: "req.body", body_source_detail: "req.body" };
  }

  if (bodyIsPlainObject && bodyKeysLen > 0) {
    const keysPreview = getBodyKeysPreview(body);
    try {
      console.log(
        "[import-start] readJsonBody: using req.body object branch",
        JSON.stringify({ keys: keysPreview })
      );
    } catch {
      console.log("[import-start] readJsonBody: using req.body object branch");
    }

    return { body, body_source: "req.body", body_source_detail: "req.body" };
  }

  // Prefer explicit raw body fields (common in Azure Functions).
  if (getBodyLen(rawBody) > 0) {
    try {
      if (typeof rawBody === "string" || isBinaryBody(rawBody)) {
        const meta = {
          body_source: "req.rawBody",
          body_source_detail: typeof rawBody === "string" ? "req.rawBody:text" : "req.rawBody:binary",
        };

        const rawText = binaryBodyToString(rawBody);
        return {
          body: parseJsonFromStringOrBinary(rawBody, meta),
          raw_text_preview: toTextPreview(rawText, 200) || null,
          raw_text_starts_with_brace: /^\s*\{/.test(rawText),
          ...meta,
        };
      }

      if (isProbablyStreamBody(rawBody)) {
        const meta = { body_source: "req.rawBody", body_source_detail: "req.rawBody:stream" };
        const buf = await readStreamLikeToBuffer(rawBody);
        const rawText = buf && buf.length ? buf.toString("utf8") : "";
        return {
          body: buf && buf.length ? parseJsonFromStringOrBinary(buf, meta) : {},
          raw_text_preview: toTextPreview(rawText, 200) || null,
          raw_text_starts_with_brace: /^\s*\{/.test(rawText),
          ...meta,
        };
      }
    } catch (err) {
      throw decorateInvalidJsonError(err, { body_source: "req.rawBody", body_source_detail: "req.rawBody" });
    }
  }

  // Prefer the platform's raw text reader when available (closest to bytes-on-the-wire).
  if (typeof req.text === "function") {
    const meta = { body_source: "req.text", body_source_detail: "req.text" };
    try {
      const rawVal = await req.text();
      if (rawVal && typeof rawVal === "object" && !Array.isArray(rawVal)) {
        const rawText = (() => {
          try {
            return JSON.stringify(rawVal);
          } catch {
            return "";
          }
        })();
        return {
          body: rawVal,
          raw_text_preview: toTextPreview(rawText, 200) || null,
          raw_text_starts_with_brace: /^\s*\{/.test(rawText),
          body_source: "req.text",
          body_source_detail: "req.text:object",
        };
      }

      const rawText = typeof rawVal === "string" ? rawVal : "";
      if (rawText && rawText.trim()) {
        return {
          body: parseJsonFromStringOrBinary(rawText, meta),
          raw_text_preview: toTextPreview(rawText, 200) || null,
          raw_text_starts_with_brace: /^\s*\{/.test(rawText),
          ...meta,
        };
      }
    } catch (err) {
      if (err?.code === "INVALID_JSON_BODY") throw decorateInvalidJsonError(err, meta);
      // Otherwise, fall through (body may already be consumed or unreadable via this API).
    }
  }

  if (typeof req.arrayBuffer === "function") {
    const meta = { body_source: "req.arrayBuffer", body_source_detail: "req.arrayBuffer" };
    try {
      const ab = await req.arrayBuffer();
      if (ab) {
        const rawText = binaryBodyToString(ab);
        return {
          body: parseJsonFromStringOrBinary(ab, meta),
          raw_text_preview: toTextPreview(rawText, 200) || null,
          raw_text_starts_with_brace: /^\s*\{/.test(rawText),
          ...meta,
        };
      }
    } catch (err) {
      if (err?.code === "INVALID_JSON_BODY") throw decorateInvalidJsonError(err, meta);
      // Otherwise, fall through.
    }
  }

  // Then fall back to body/bufferBody if they look like raw strings/buffers.
  try {
    if (typeof body === "string" || isBinaryBody(body)) {
      const meta = {
        body_source: typeof body === "string" ? "req.text" : "req.arrayBuffer",
        body_source_detail: "req.body",
      };
      return { body: parseJsonFromStringOrBinary(body, meta), ...meta };
    }

    if (isProbablyStreamBody(body)) {
      const meta = { body_source: "unknown", body_source_detail: "req.body:stream" };
      return { body: await parseJsonFromStreamLike(body, meta), ...meta };
    }

    if (getBodyLen(bufferBody) > 0) {
      if (typeof bufferBody === "string" || isBinaryBody(bufferBody)) {
        const meta = {
          body_source: typeof bufferBody === "string" ? "req.text" : "req.arrayBuffer",
          body_source_detail: "req.bufferBody",
        };
        return { body: parseJsonFromStringOrBinary(bufferBody, meta), ...meta };
      }
    }

    if (isProbablyStreamBody(bufferBody)) {
      const meta = { body_source: "unknown", body_source_detail: "req.bufferBody:stream" };
      return { body: await parseJsonFromStreamLike(bufferBody, meta), ...meta };
    }
  } catch (err) {
    throw decorateInvalidJsonError(err, { body_source: "unknown", body_source_detail: "fallback" });
  }

  // As a last resort, try the runtime JSON parser.
  if (typeof req.json === "function") {
    try {
      const val = await req.json();
      if (val && typeof val === "object") {
        return { body: val, body_source: "unknown", body_source_detail: "req.json" };
      }
    } catch {
      // Fall through.
    }
  }

  // If body is a plain object but empty, return it only when we have no other body sources.
  if (body && typeof body === "object" && !Array.isArray(body) && !isBinaryBody(body) && !isProbablyStreamBody(body)) {
    const otherLen = getBodyLen(rawBody) + getBodyLen(bufferBody);
    if (otherLen === 0) {
      return { body, body_source: "req.body", body_source_detail: "req.body" };
    }
  }

  return { body: {}, body_source: "unknown", body_source_detail: "empty" };
}

function toErrorString(err) {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;
  if (typeof err.message === "string" && err.message.trim()) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function getHeader(req, name) {
  if (!req || !name) return null;
  const headers = req.headers;
  if (headers && typeof headers.get === "function") {
    try {
      const v = headers.get(name);
      return typeof v === "string" && v.trim() ? v.trim() : null;
    } catch {
      return null;
    }
  }
  const h = headers && typeof headers === "object" ? headers : {};
  const v = h[name] ?? h[name.toLowerCase()] ?? h[name.toUpperCase()];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function isDebugDiagnosticsEnabled(req) {
  const raw = getHeader(req, "x-debug");
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function buildBodyDiagnostics(req, extra) {
  const rawBody = req?.rawBody;
  const body = req?.body;
  const bufferBody = req?.bufferBody;

  const base = {
    body_sources: {
      rawBodyType: getBodyType(rawBody),
      rawBodyLen: getBodyLen(rawBody),
      bodyType: getBodyType(body),
      bodyLen: getBodyLen(body),
      bufferBodyType: getBodyType(bufferBody),
      bufferBodyLen: getBodyLen(bufferBody),
      isStreamBody:
        isProbablyStreamBody(rawBody) || isProbablyStreamBody(body) || isProbablyStreamBody(bufferBody),
    },
    body_keys_preview: getBodyKeysPreview(body),
    headers_subset: {
      "content-type": getHeader(req, "content-type"),
      "content-length": getHeader(req, "content-length"),
      "transfer-encoding": getHeader(req, "transfer-encoding"),
      expect: getHeader(req, "expect"),
      "user-agent": getHeader(req, "user-agent"),
      "x-ms-middleware-request-id": getHeader(req, "x-ms-middleware-request-id"),
    },
  };

  if (extra && typeof extra === "object") return { ...base, ...extra };
  return base;
}

function buildRequestDetails(
  req,
  { body_source = "unknown", body_source_detail = "", raw_text_preview = null, raw_text_starts_with_brace = false } = {}
) {
  const contentType = getHeader(req, "content-type") || "";
  const contentLengthHeader = getHeader(req, "content-length") || "";

  const body = req?.body;
  const isBodyNonNullObject = body !== null && typeof body === "object" && !Array.isArray(body);
  const isBodyPlainObject = isBodyNonNullObject && !isBinaryBody(body) && !isProbablyStreamBody(body);
  const bodyKeysLen = isBodyPlainObject ? getBodyLen(body) : 0;

  const details = {
    body_source: String(body_source || "unknown"),
    ...(body_source_detail ? { body_source_detail: String(body_source_detail) } : {}),
    content_type: contentType,
    content_length_header: contentLengthHeader,
    body_keys_preview: getBodyKeysPreview(body),
    body_is_empty_object: Boolean(isBodyPlainObject && bodyKeysLen === 0),
    raw_available: {
      has_rawBody: req?.rawBody !== undefined && req?.rawBody !== null,
      has_text_reader: typeof req?.text === "function",
      has_arrayBuffer_reader: typeof req?.arrayBuffer === "function",
    },
    raw_text_starts_with_brace: Boolean(raw_text_starts_with_brace),
  };

  const rawPreview = typeof raw_text_preview === "string" ? raw_text_preview.trim() : "";
  if (rawPreview) {
    details.raw_text_preview = rawPreview.length > 200 ? rawPreview.slice(0, 200) : rawPreview;
  }

  return details;
}

function generateRequestId(req) {
  const existing =
    getHeader(req, "x-request-id") ||
    getHeader(req, "x-correlation-id") ||
    getHeader(req, "x-client-request-id");
  if (existing) return existing;
  if (typeof randomUUID === "function") return randomUUID();
  return `rid_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function makeErrorId() {
  if (typeof randomUUID === "function") return randomUUID();
  return `err_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function toStackFirstLine(err) {
  try {
    const stack = typeof err?.stack === "string" ? err.stack : "";
    const line = stack.split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";
    return line.length > 300 ? line.slice(0, 300) : line;
  } catch {
    return "";
  }
}

function logImportStartErrorLine({ error_id, stage_beacon, root_cause, err }) {
  try {
    const line = {
      error_id: String(error_id || ""),
      stage_beacon: String(stage_beacon || ""),
      root_cause: String(root_cause || ""),
      stack_first_line: toStackFirstLine(err),
    };
    console.error("[import-start] error", JSON.stringify(line));
  } catch {
    console.error("[import-start] error");
  }
}

function extractXaiRequestId(headers) {
  const h = headers || {};
  const get = (k) => {
    const v = h[k] ?? h[k.toLowerCase()] ?? h[k.toUpperCase()];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  return (
    get("x-request-id") ||
    get("xai-request-id") ||
    get("x-correlation-id") ||
    get("x-ms-request-id") ||
    get("request-id") ||
    null
  );
}

function tryParseUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  try {
    return new URL(s);
  } catch {
    try {
      return new URL(`https://${s}`);
    } catch {
      return null;
    }
  }
}

function looksLikeCompanyUrlQuery(raw) {
  const u = tryParseUrl(raw);
  if (!u) return false;
  const host = String(u.hostname || "").toLowerCase();
  if (!host || !host.includes(".")) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  const parts = host.split(".").filter(Boolean);
  if (parts.length < 2) return false;
  const tld = parts[parts.length - 1];
  if (!tld || tld.length < 2) return false;
  return true;
}

function isAzureWebsitesUrl(rawUrl) {
  const u = tryParseUrl(rawUrl);
  if (!u) return false;
  return /\.azurewebsites\.net$/i.test(String(u.hostname || ""));
}

function joinUrlPath(basePath, suffixPath) {
  const a = String(basePath || "").trim();
  const b = String(suffixPath || "").trim();
  if (!a) return b.startsWith("/") ? b : `/${b}`;
  if (!b) return a;

  const left = a.endsWith("/") ? a.slice(0, -1) : a;
  const right = b.startsWith("/") ? b : `/${b}`;

  return `${left}${right}`.replace(/\/{2,}/g, "/");
}

function toHostPathOnlyForLog(rawUrl) {
  const u = tryParseUrl(rawUrl);
  if (u) return `${u.host}${u.pathname}`;

  const raw = String(rawUrl || "").trim();
  if (!raw) return "";

  // Best effort: strip scheme + query.
  const noQuery = raw.split("?")[0];
  const noScheme = noQuery.replace(/^https?:\/\//i, "");
  return noScheme;
}

function redactUrlQueryAndHash(rawUrl) {
  const u = tryParseUrl(rawUrl);
  if (u) {
    u.search = "";
    u.hash = "";
    return u.toString();
  }

  const raw = String(rawUrl || "").trim();
  if (!raw) return "";
  return raw.split("?")[0].split("#")[0];
}

function getHostPathFromUrl(rawUrl) {
  const u = tryParseUrl(rawUrl);
  if (!u) return { host: null, path: null };
  return {
    host: typeof u.host === "string" && u.host.trim() ? u.host : null,
    path: typeof u.pathname === "string" && u.pathname.trim() ? u.pathname : null,
  };
}

function buildUpstreamResolutionSnapshot({ url, authHeaderValue, timeoutMsUsed, executionPlan }) {
  const { host, path } = getHostPathFromUrl(url);
  const authVal = typeof authHeaderValue === "string" ? authHeaderValue : "";
  const prefix = authVal.toLowerCase().startsWith("bearer ") ? "Bearer" : null;

  return {
    resolved_upstream_url_redacted: redactUrlQueryAndHash(url) || null,
    resolved_upstream_host: host,
    resolved_upstream_path: path,
    auth_header_present: Boolean(authVal),
    auth_header_prefix: prefix,
    timeout_ms_used: Number.isFinite(Number(timeoutMsUsed)) ? Number(timeoutMsUsed) : null,
    execution_plan: Array.isArray(executionPlan) ? executionPlan : [],
  };
}

function buildXaiExecutionPlan(xaiPayload) {
  const plan = ["xai_primary_fetch", "xai_keywords_fetch", "xai_reviews_fetch", "xai_location_refinement_fetch"];
  if (xaiPayload && xaiPayload.expand_if_few) plan.push("xai_expand_fetch");
  return plan;
}

function resolveXaiEndpointForModel(rawEndpoint, model) {
  let raw = String(rawEndpoint || "").trim();

  // Normalize missing scheme so diagnostics always show a full URL.
  // Only apply when the value looks like a hostname (avoid breaking proxies/relative paths).
  if (raw && !/^https?:\/\//i.test(raw) && /^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(\/.*)?$/i.test(raw)) {
    raw = `https://${raw}`;
  }

  const u = tryParseUrl(raw);
  if (!u) return raw;

  const pathLower = String(u.pathname || "").toLowerCase();
  if (pathLower.includes("/proxy-xai") || pathLower.includes("/api/xai")) return u.toString();

  const alreadyChat = /\/v1\/chat\/completions\/?$/i.test(u.pathname || "");
  const alreadyResponses = /\/v1\/responses\/?$/i.test(u.pathname || "");
  if (alreadyChat || alreadyResponses) return u.toString();

  const m = String(model || "").toLowerCase();
  const wantsResponses = m.includes("vision") || m.includes("image") || m.includes("audio");
  const desiredSuffix = wantsResponses ? "/v1/responses" : "/v1/chat/completions";

  // If the URL was set to a base like https://api.x.ai or https://api.x.ai/v1, normalize it.
  let basePath = String(u.pathname || "").replace(/\/+$/, "");

  // Prevent common misconfiguration: https://api.x.ai/api (xAI does not use /api).
  // Only apply this normalization to the real xAI hostname so we don't break proxies.
  if (String(u.hostname || "").toLowerCase() === "api.x.ai") {
    const lower = basePath.toLowerCase();
    if (lower === "/api") basePath = "";
    else if (lower.endsWith("/api")) basePath = basePath.slice(0, -4);
    else if (lower.endsWith("/api/v1")) basePath = basePath.slice(0, -7);
  }

  if (basePath.toLowerCase().endsWith("/v1")) basePath = basePath.slice(0, -3);
  u.pathname = joinUrlPath(basePath || "", desiredSuffix);

  return u.toString();
}

function safeParseJsonObject(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function buildXaiPayloadMetaSnapshotFromOutboundBody(outboundBodyJsonText, { handler_version, build_id }) {
  const parsed = safeParseJsonObject(outboundBodyJsonText);

  const modelRaw = parsed && typeof parsed.model === "string" ? parsed.model.trim() : "";
  const model = modelRaw ? modelRaw : null;

  const messages = parsed && Array.isArray(parsed.messages) ? parsed.messages : [];

  const content_lens = messages.map((m) => {
    if (!m || typeof m !== "object") return 0;
    const c = m.content;
    return typeof c === "string" ? c.length : 0;
  });

  const has_empty_trimmed_content = messages.some((m) => {
    if (!m || typeof m !== "object") return true;
    const c = m.content;
    if (typeof c !== "string") return true;
    return c.trim().length === 0;
  });

  const system_count = messages.filter((m) => m && typeof m === "object" && m.role === "system").length;
  const user_count = messages.filter((m) => m && typeof m === "object" && m.role === "user").length;

  return {
    handler_version: String(handler_version || ""),
    build_id: String(build_id || ""),
    model,
    messages_len: messages.length,
    system_count,
    user_count,
    content_lens,
    has_empty_trimmed_content,
  };
}

function ensureValidOutboundXaiBodyOrThrow(payloadMeta) {
  if (!payloadMeta || typeof payloadMeta !== "object") {
    throw new Error("Invalid outbound payload meta");
  }

  if (!Number.isFinite(Number(payloadMeta.messages_len)) || Number(payloadMeta.messages_len) < 2) {
    throw new Error("Bad data: Messages cannot be empty");
  }

  if (Number(payloadMeta.system_count) < 1 || Number(payloadMeta.user_count) < 1) {
    throw new Error("Bad data: Missing system or user message");
  }

  if (payloadMeta.has_empty_trimmed_content) {
    throw new Error("Bad data: Message content cannot be empty");
  }
}

async function postJsonWithTimeout(url, { headers, body, timeoutMs }) {
  const u = String(url || "").trim();
  if (!u) throw new Error("Missing URL");

  const ms = Number.isFinite(Number(timeoutMs)) ? Math.max(1, Number(timeoutMs)) : 30_000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    try {
      controller.abort();
    } catch {}
  }, ms);

  try {
    const res = await fetch(u, {
      method: "POST",
      headers: headers && typeof headers === "object" ? headers : {},
      body: typeof body === "string" ? body : "",
      signal: controller.signal,
    });

    const text = await res.text().catch(() => "");
    const data = safeParseJsonObject(text) || (text ? { text } : {});

    const headersObj = {};
    try {
      for (const [k, v] of res.headers.entries()) headersObj[k] = v;
    } catch {}

    return { status: res.status, headers: headersObj, data };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e || "fetch failed"));
    if (String(err.name || "").toLowerCase().includes("abort")) {
      err.code = "ECONNABORTED";
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}


function isProxyExplicitlyDisabled(value) {
  if (value === false) return true;
  if (value === 0) return true;
  if (value === null) return false;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (!v) return false;
    return v === "false" || v === "0" || v === "no" || v === "off";
  }
  return false;
}

function isProxyExplicitlyEnabled(value) {
  if (value === true) return true;
  if (value === 1) return true;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (!v) return false;
    return v === "true" || v === "1" || v === "yes" || v === "on";
  }
  return false;
}

function buildCounts({ enriched, debugOutput }) {
  const candidates_found = Array.isArray(enriched) ? enriched.length : 0;

  const keywords_generated = Array.isArray(debugOutput?.keywords_debug)
    ? debugOutput.keywords_debug.reduce((sum, k) => sum + (Number(k?.generated_count) || 0), 0)
    : 0;

  let reviews_valid = 0;
  let reviews_rejected = 0;

  if (Array.isArray(debugOutput?.reviews_debug)) {
    for (const entry of debugOutput.reviews_debug) {
      const candidates = Array.isArray(entry?.candidates) ? entry.candidates : [];
      for (const c of candidates) {
        if (c?.is_valid === true) reviews_valid += 1;
        else reviews_rejected += 1;
      }
    }
  }

  return {
    candidates_found,
    reviews_valid,
    reviews_rejected,
    keywords_generated,
  };
}

// Helper: normalize industries array
function normalizeIndustries(input) {
  if (Array.isArray(input))
    return [...new Set(input.map((s) => String(s).trim()).filter(Boolean))];
  if (typeof input === "string")
    return [
      ...new Set(
        input
          .split(/[,;|]/)
          .map((s) => s.trim())
          .filter(Boolean)
      ),
    ];
  return [];
}

function toBrandTokenFromWebsiteUrl(websiteUrl) {
  try {
    const raw = String(websiteUrl || "").trim();
    if (!raw) return "";
    const u = raw.includes("://") ? new URL(raw) : new URL(`https://${raw}`);
    let h = u.hostname.toLowerCase();
    if (h.startsWith("www.")) h = h.slice(4);
    const parts = h.split(".").filter(Boolean);
    return parts[0] || "";
  } catch {
    return "";
  }
}

function normalizeKeywordList(value) {
  const raw = value;
  const items = [];

  if (Array.isArray(raw)) {
    for (const v of raw) items.push(String(v));
  } else if (typeof raw === "string") {
    items.push(raw);
  }

  const split = items
    .flatMap((s) => String(s).split(/[,;|\n]/))
    .map((s) => s.trim())
    .filter(Boolean);

  const seen = new Set();
  const out = [];
  for (const k of split) {
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out;
}

function normalizeProductKeywords(value, { companyName, websiteUrl } = {}) {
  const list = normalizeKeywordList(value);
  const name = String(companyName || "").trim();
  const nameNorm = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const brandToken = toBrandTokenFromWebsiteUrl(websiteUrl);

  return list
    .map((k) => k.trim())
    .filter(Boolean)
    .filter((k) => {
      const kl = k.toLowerCase();
      if (nameNorm && kl.includes(nameNorm)) return false;
      if (brandToken && (kl === brandToken || kl.includes(brandToken))) return false;
      return true;
    })
    .slice(0, 25);
}

function keywordListToString(list) {
  return (Array.isArray(list) ? list : []).join(", ");
}

// Helper: get safe number
const safeNum = (n) => (Number.isFinite(Number(n)) ? Number(n) : undefined);

// Helper: parse center coordinates
function safeCenter(c) {
  const lat = safeNum(c?.lat),
    lng = safeNum(c?.lng);
  return lat !== undefined && lng !== undefined ? { lat, lng } : undefined;
}

// Helper: get normalized domain
const toNormalizedDomain = (s = "") => {
  try {
    const u = s.startsWith("http") ? new URL(s) : new URL(`https://${s}`);
    let h = u.hostname.toLowerCase();
    if (h.startsWith("www.")) h = h.slice(4);
    return h || "unknown";
  } catch {
    return "unknown";
  }
};

// Helper: enrich company data with location fields
function enrichCompany(company, center) {
  const c = { ...(company || {}) };
  c.industries = normalizeIndustries(c.industries);

  const websiteUrl = c.website_url || c.canonical_url || c.url || c.amazon_url || "";
  const companyName = c.company_name || c.name || "";

  const productKeywords = normalizeProductKeywords(c.product_keywords, {
    companyName,
    websiteUrl,
  });

  c.keywords = productKeywords;
  c.product_keywords = keywordListToString(productKeywords);

  const urlForDomain = c.canonical_url || c.website_url || c.url || c.amazon_url || "";
  c.normalized_domain = toNormalizedDomain(urlForDomain);

  // Ensure location fields are present
  c.headquarters_location = String(c.headquarters_location || "").trim();

  // Handle manufacturing_locations - accept country-only entries like "United States", "China", etc.
  if (Array.isArray(c.manufacturing_locations)) {
    c.manufacturing_locations = c.manufacturing_locations
      .map(l => String(l).trim())
      .filter(l => l.length > 0);
  } else if (typeof c.manufacturing_locations === 'string') {
    // If it's a single string, wrap it in an array
    const trimmed = String(c.manufacturing_locations || "").trim();
    c.manufacturing_locations = trimmed ? [trimmed] : [];
  } else {
    c.manufacturing_locations = [];
  }

  // Handle location_sources - structured data with source attribution
  if (!Array.isArray(c.location_sources)) {
    c.location_sources = [];
  }

  // Ensure each location_source has required fields
  c.location_sources = c.location_sources
    .filter(s => s && s.location)
    .map(s => ({
      location: String(s.location || "").trim(),
      source_url: String(s.source_url || "").trim(),
      source_type: s.source_type || "other",
      location_type: s.location_type || "other",
    }));

  // Handle tagline
  c.tagline = String(c.tagline || "").trim();

  c.red_flag = Boolean(c.red_flag);
  c.red_flag_reason = String(c.red_flag_reason || "").trim();
  c.location_confidence = (c.location_confidence || "medium").toString().toLowerCase();

  return c;
}

function toFiniteNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function normalizeLocationEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => {
      if (typeof entry === "string") {
        const address = entry.trim();
        return address ? { address } : null;
      }
      if (entry && typeof entry === "object") return entry;
      return null;
    })
    .filter(Boolean);
}

function buildImportLocations(company) {
  const headquartersBase =
    Array.isArray(company.headquarters) && company.headquarters.length > 0
      ? company.headquarters
      : Array.isArray(company.headquarters_locations) && company.headquarters_locations.length > 0
        ? company.headquarters_locations
        : company.headquarters_location && String(company.headquarters_location).trim()
          ? [{ address: String(company.headquarters_location).trim() }]
          : [];

  const manufacturingBase =
    Array.isArray(company.manufacturing_geocodes) && company.manufacturing_geocodes.length > 0
      ? company.manufacturing_geocodes
      : Array.isArray(company.manufacturing_locations) && company.manufacturing_locations.length > 0
        ? company.manufacturing_locations
        : [];

  return {
    headquartersBase: normalizeLocationEntries(headquartersBase),
    manufacturingBase: normalizeLocationEntries(manufacturingBase),
  };
}

async function geocodeCompanyLocations(company, { timeoutMs = 5000 } = {}) {
  const c = { ...(company || {}) };

  const { headquartersBase, manufacturingBase } = buildImportLocations(c);

  const settled = await Promise.allSettled([
    geocodeLocationArray(headquartersBase, { timeoutMs, concurrency: 4 }),
    geocodeLocationArray(manufacturingBase, { timeoutMs, concurrency: 4 }),
  ]);

  const headquarters = settled[0]?.status === "fulfilled" ? settled[0].value : [];
  const manufacturing_geocodes = settled[1]?.status === "fulfilled" ? settled[1].value : [];

  if (settled[0]?.status === "rejected") {
    console.warn(`[import-start] geocode HQ rejected: ${settled[0]?.reason?.message || String(settled[0]?.reason || "")}`);
  }
  if (settled[1]?.status === "rejected") {
    console.warn(
      `[import-start] geocode manufacturing rejected: ${settled[1]?.reason?.message || String(settled[1]?.reason || "")}`
    );
  }

  const primary = pickPrimaryLatLng(headquarters);

  const hq_lat = primary ? primary.lat : toFiniteNumber(c.hq_lat);
  const hq_lng = primary ? primary.lng : toFiniteNumber(c.hq_lng);

  const manufacturing_locations = manufacturing_geocodes
    .map((loc) => {
      if (typeof loc === "string") return loc.trim();
      if (loc && typeof loc === "object") {
        return String(loc.formatted || loc.full_address || loc.address || "").trim();
      }
      return "";
    })
    .filter((s) => s.length > 0);

  return {
    ...c,
    headquarters,
    headquarters_locations: headquarters,
    manufacturing_locations,
    manufacturing_geocodes,
    hq_lat,
    hq_lng,
  };
}

async function geocodeHQLocation(address, { timeoutMs = 5000 } = {}) {
  const list = [{ address: String(address || "").trim() }].filter((x) => x.address);
  if (!list.length) return { hq_lat: undefined, hq_lng: undefined };

  const results = await geocodeLocationArray(list, { timeoutMs, concurrency: 1 });
  const primary = pickPrimaryLatLng(results);
  return {
    hq_lat: primary ? primary.lat : undefined,
    hq_lng: primary ? primary.lng : undefined,
  };
}

// Check if company already exists by normalized domain / company name.
// IMPORTANT: Dedupe only against active companies (ignore soft-deleted rows).
async function findExistingCompany(container, normalizedDomain, companyName, canonicalUrl) {
  if (!container) return null;

  const domain = String(normalizedDomain || "").trim();
  const nameValue = String(companyName || "").trim().toLowerCase();

  const notDeletedClause = "(NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true)";

  try {
    if (domain && domain !== "unknown") {
      const query = `
        SELECT TOP 1 c.id, c.normalized_domain, c.partition_key, c.canonical_url, c.website_url, c.url, c.import_missing_fields, c.seed_ready, c.source, c.source_stage
        FROM c
        WHERE ${notDeletedClause}
          AND c.normalized_domain = @domain
      `;

      const parameters = [{ name: "@domain", value: domain }];

      const { resources } = await container.items
        .query({ query, parameters }, { enableCrossPartitionQuery: true })
        .fetchAll();

      if (Array.isArray(resources) && resources[0]) {
        return {
          ...resources[0],
          duplicate_match_key: "normalized_domain",
          duplicate_match_value: domain,
        };
      }
    }

    const canonicalRaw = String(canonicalUrl || "").trim();
    const canonicalTrimmed = canonicalRaw.replace(/\/+$/, "");

    let canonicalHost = "";
    try {
      const parsed = canonicalTrimmed
        ? canonicalTrimmed.includes("://")
          ? new URL(canonicalTrimmed)
          : new URL(`https://${canonicalTrimmed}`)
        : null;
      canonicalHost = parsed ? String(parsed.hostname || "").toLowerCase().replace(/^www\./, "") : "";
    } catch {
      canonicalHost = "";
    }

    const canonicalVariants = (() => {
      if (!canonicalHost) return [];
      const variants = [
        `https://${canonicalHost}/`,
        `https://${canonicalHost}`,
        `http://${canonicalHost}/`,
        `http://${canonicalHost}`,
      ];
      return Array.from(new Set(variants.map((v) => String(v).trim()).filter(Boolean)));
    })();

    if (canonicalVariants.length > 0) {
      const params = canonicalVariants.map((value, idx) => ({ name: `@canon${idx}`, value }));
      const clause = canonicalVariants.map((_, idx) => `@canon${idx}`).join(", ");

      const query = `
        SELECT TOP 1 c.id, c.normalized_domain, c.partition_key, c.canonical_url, c.website_url, c.url, c.import_missing_fields, c.seed_ready, c.source, c.source_stage
        FROM c
        WHERE ${notDeletedClause}
          AND (
            c.canonical_url IN (${clause})
            OR c.website_url IN (${clause})
            OR c.url IN (${clause})
          )
      `;

      const { resources } = await container.items
        .query({ query, parameters: params }, { enableCrossPartitionQuery: true })
        .fetchAll();

      if (Array.isArray(resources) && resources[0]) {
        return {
          ...resources[0],
          duplicate_match_key: "canonical_url",
          duplicate_match_value: canonicalVariants[0],
        };
      }
    }

    if (nameValue) {
      const query = `
        SELECT TOP 1 c.id, c.normalized_domain, c.partition_key, c.canonical_url, c.website_url, c.url, c.import_missing_fields, c.seed_ready, c.source, c.source_stage
        FROM c
        WHERE ${notDeletedClause}
          AND LOWER(c.company_name) = @name
      `;

      const parameters = [{ name: "@name", value: nameValue }];

      const { resources } = await container.items
        .query({ query, parameters }, { enableCrossPartitionQuery: true })
        .fetchAll();

      if (Array.isArray(resources) && resources[0]) {
        return {
          ...resources[0],
          duplicate_match_key: "company_name",
          duplicate_match_value: nameValue,
        };
      }
    }

    return null;
  } catch (e) {
    console.warn(`[import-start] Error checking for existing company: ${e.message}`);
    return null;
  }
}

// Helper: import logo (discover -> fetch w/ retries -> rasterize SVG -> upload to blob)
async function fetchLogo({ companyId, companyName, domain, websiteUrl, existingLogoUrl, budgetMs }) {
  const existing = String(existingLogoUrl || "").trim();
  const budget = Number.isFinite(Number(budgetMs)) ? Math.max(0, Math.trunc(Number(budgetMs))) : null;

  const looksLikeCompanyLogoBlobUrl = (u) => {
    const s = String(u || "");
    return s.includes(".blob.core.windows.net") && s.includes("/company-logos/");
  };

  const headCheck = async (u) => {
    const controller = new AbortController();
    const timeoutMs = (() => {
      if (budget == null) return 6000;
      // If the budget is tight, don't burn the whole thing on the HEAD probe.
      return Math.max(900, Math.min(6000, Math.trunc(budget * 0.4)));
    })();

    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(u, {
        method: "HEAD",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          Accept: "image/svg+xml,image/png,image/jpeg,image/*,*/*",
          "User-Agent": "Mozilla/5.0 (compatible; TabarnamBot/1.0; +https://tabarnam.com)",
        },
      });

      const contentType = String(res.headers.get("content-type") || "");
      const contentLengthRaw = String(res.headers.get("content-length") || "");
      const contentLength = Number.isFinite(Number(contentLengthRaw)) ? Number(contentLengthRaw) : null;

      if (!res.ok) return { ok: false, reason: `head_status_${res.status}` };
      if (!contentType.toLowerCase().startsWith("image/")) return { ok: false, reason: `non_image_${contentType || "unknown"}` };
      if (contentLength != null && contentLength <= 5 * 1024) return { ok: false, reason: `too_small_${contentLength}_bytes` };
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e?.message || "head_failed" };
    } finally {
      clearTimeout(timeout);
    }
  };

  // Only accept an existing logo URL if it's a previously uploaded blob AND it actually exists.
  // Never persist arbitrary / synthetic URLs as logo_url.
  if (existing && looksLikeCompanyLogoBlobUrl(existing)) {
    if (budget != null && budget < 900) {
      return {
        ok: true,
        logo_status: "imported",
        logo_import_status: "imported",
        logo_stage_status: "ok",
        logo_source_url: null,
        logo_source_type: "existing_blob_unverified",
        logo_url: existing,
        logo_error: "",
        logo_discovery_strategy: "existing_blob_unverified",
        logo_discovery_page_url: "",
        logo_telemetry: {
          budget_ms: budget,
          elapsed_ms: 0,
          discovery_ok: null,
          candidates_total: 0,
          candidates_tried: 0,
          tiers: [],
          rejection_reasons: {},
          time_budget_exhausted: true,
        },
      };
    }

    const verified = await headCheck(existing);
    if (verified.ok) {
      return {
        ok: true,
        logo_status: "imported",
        logo_import_status: "imported",
        logo_stage_status: "ok",
        logo_source_url: null,
        logo_source_type: "existing_blob",
        logo_url: existing,
        logo_error: "",
        logo_discovery_strategy: "existing_blob",
        logo_discovery_page_url: "",
        logo_telemetry: {
          budget_ms: budget,
          elapsed_ms: 0,
          discovery_ok: null,
          candidates_total: 0,
          candidates_tried: 0,
          tiers: [{ tier: "existing_blob", attempted: 1, rejected: 0, ok: true, selected_url: existing, selected_content_type: "" }],
          rejection_reasons: {},
          time_budget_exhausted: false,
        },
      };
    }
  }

  if (!domain || domain === "unknown") {
    return {
      ok: true,
      logo_status: "not_found_on_site",
      logo_import_status: "missing",
      logo_source_url: null,
      logo_source_location: null,
      logo_source_domain: null,
      logo_source_type: null,
      logo_url: null,
      logo_error: "missing domain",
      logo_discovery_strategy: "",
      logo_discovery_page_url: "",
    };
  }

  if (budget != null && budget < 900) {
    return {
      ok: true,
      logo_status: "not_found_on_site",
      logo_import_status: "missing",
      logo_stage_status: "budget_exhausted",
      logo_source_url: null,
      logo_source_location: null,
      logo_source_domain: null,
      logo_source_type: null,
      logo_url: null,
      logo_error: "Skipped logo import due to low remaining time budget",
      logo_discovery_strategy: "",
      logo_discovery_page_url: "",
      logo_telemetry: {
        budget_ms: budget,
        elapsed_ms: 0,
        discovery_ok: null,
        candidates_total: 0,
        candidates_tried: 0,
        tiers: [],
        rejection_reasons: { budget_exhausted: 1 },
        time_budget_exhausted: true,
      },
    };
  }

  const importCompanyLogo = requireImportCompanyLogo();
  return importCompanyLogo({ companyId, domain, websiteUrl, companyName }, console, { budgetMs: budget });
}

function normalizeUrlForCompare(s) {
  const raw = typeof s === "string" ? s.trim() : s == null ? "" : String(s).trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    u.hash = "";
    const host = String(u.hostname || "").toLowerCase().replace(/^www\./, "");
    const path = String(u.pathname || "").replace(/\/+$/, "");
    const search = u.searchParams.toString();
    return `${u.protocol}//${host}${path}${search ? `?${search}` : ""}`;
  } catch {
    return raw.toLowerCase();
  }
}

function computeReviewDedupeKey(review) {
  const r = review && typeof review === "object" ? review : {};
  const normUrl = normalizeUrlForCompare(r.source_url || r.url || "");
  const title = String(r.title || "").trim().toLowerCase();
  const author = String(r.author || "").trim().toLowerCase();
  const date = String(r.date || "").trim();
  const rating = r.rating == null ? "" : String(r.rating);
  const excerpt = String(r.excerpt || r.abstract || "").trim().toLowerCase().slice(0, 160);

  const base = [normUrl, title, author, date, rating, excerpt].filter(Boolean).join("|");
  if (!base) return "";

  try {
    return crypto.createHash("sha1").update(base).digest("hex");
  } catch {
    return base;
  }
}

function dedupeCuratedReviews(reviews) {
  const list = Array.isArray(reviews) ? reviews : [];
  const out = [];
  const seen = new Set();

  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    const k = String(r._dedupe_key || "").trim() || computeReviewDedupeKey(r);
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ ...r, _dedupe_key: k });
  }

  return out;
}

function buildReviewCursor({ nowIso, count, exhausted, last_error, prev_cursor }) {
  const n = Math.max(0, Math.trunc(Number(count) || 0));
  const exhaustedBool = typeof exhausted === "boolean" ? exhausted : false;
  const errObj =
    last_error && typeof last_error === "object" ? last_error : last_error ? { message: String(last_error) } : null;

  const prev = prev_cursor && typeof prev_cursor === "object" ? prev_cursor : null;
  const prevSuccessAt =
    typeof prev?.last_success_at === "string" && prev.last_success_at.trim() ? prev.last_success_at.trim() : null;

  // Semantics: last_success_at means "we saved at least 1 review".
  // Do not update it on failures or on 0-saved runs.
  const last_success_at = errObj == null && n > 0 ? nowIso : prevSuccessAt;

  return {
    source: "xai_reviews",
    last_offset: n,
    total_fetched: n,
    exhausted: exhaustedBool,
    last_attempt_at: nowIso,
    last_success_at,
    last_error: errObj,
  };
}

function buildReviewsUpstreamPayloadForImportStart({ reviewMessage, companyWebsiteHost } = {}) {
  const { buildSearchParameters } = require("../_buildSearchParameters");

  const searchBuild = buildSearchParameters({
    companyWebsiteHost,
    additionalExcludedHosts: [],
  });

  const role = typeof reviewMessage?.role === "string" ? reviewMessage.role.trim() : "";
  const contentRaw =
    typeof reviewMessage?.content === "string" ? reviewMessage.content : reviewMessage?.content == null ? "" : String(reviewMessage.content);

  const messageWithSpill = {
    ...(reviewMessage && typeof reviewMessage === "object" ? reviewMessage : { role: "user" }),
    role: role || "user",
    content: `${contentRaw.trim()}${searchBuild.prompt_exclusion_text || ""}`,
  };

  const reviewPayload = {
    model: "grok-4-latest",
    messages: [
      { role: "system", content: XAI_SYSTEM_PROMPT },
      messageWithSpill,
    ],
    search_parameters: searchBuild.search_parameters,
    temperature: 0.2,
    stream: false,
  };

  return { reviewPayload, searchBuild };
}

// Fetch editorial reviews for a company using XAI
async function fetchEditorialReviews(company, xaiUrl, xaiKey, timeout, debugCollector, stageCtx, warn) {
  const { extractJsonFromText, normalizeUpstreamReviewsResult } = require("../_curatedReviewsXai");
  const {
    normalizeHttpStatus,
    extractUpstreamRequestId,
    safeBodyPreview,
    redactReviewsUpstreamPayloadForLog,
    classifyUpstreamFailure,
    bumpUpstreamFailureBucket,
  } = require("../_upstreamReviewsDiagnostics");

  const companyName = String(company?.company_name || company?.name || "").trim();
  const websiteUrl = String(company?.website_url || company?.url || "").trim();

  const normalizeHttpUrlOrNull = (input) => {
    const raw = typeof input === "string" ? input.trim() : input == null ? "" : String(input).trim();
    if (!raw) return null;

    try {
      const u = raw.includes("://") ? new URL(raw) : new URL(`https://${raw}`);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      u.hash = "";
      return u.toString();
    } catch {
      return null;
    }
  };

  const isDisallowedReviewSourceUrl = (url) => {
    const raw = typeof url === "string" ? url.trim() : "";
    if (!raw) return true;

    try {
      const u = new URL(raw);
      const host = String(u.hostname || "").toLowerCase().replace(/^www\./, "");

      // Amazon (disallowed)
      if (host === "amzn.to" || host.endsWith(".amzn.to")) return true;
      if (host === "amazon.com" || host.endsWith(".amazon.com")) return true;
      if (host.endsWith(".amazon") || host.includes("amazon.")) return true;

      // Google (disallowed) — but allow YouTube
      if (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be") return false;
      if (host === "g.co" || host.endsWith(".g.co") || host === "goo.gl" || host.endsWith(".goo.gl")) return true;
      if (host === "google.com" || host.endsWith(".google.com") || host.endsWith(".google")) return true;

      return false;
    } catch {
      return true;
    }
  };

  const inferSourceNameFromUrl = (url) => {
    const raw = typeof url === "string" ? url.trim() : "";
    if (!raw) return "";
    try {
      const u = new URL(raw);
      return String(u.hostname || "").replace(/^www\./i, "");
    } catch {
      return "";
    }
  };

  const getRemainingMs =
    stageCtx && typeof stageCtx.getRemainingMs === "function" ? stageCtx.getRemainingMs : null;
  const deadlineSafetyBufferMs =
    stageCtx && Number.isFinite(Number(stageCtx.deadlineSafetyBufferMs)) ? Number(stageCtx.deadlineSafetyBufferMs) : 0;
  const minValidationWindowMs = 9000;

  if (!companyName || !websiteUrl) {
    if (debugCollector) {
      debugCollector.push({
        company_name: companyName,
        website_url: websiteUrl,
        candidates: [],
        kept: 0,
        reason: "missing company_name or website_url",
      });
    }

    if (typeof warn === "function") {
      warn({
        stage: "reviews",
        root_cause: "client_bad_request",
        retryable: false,
        upstream_status: null,
        company_name: companyName,
        website_url: websiteUrl,
        message: "Missing company_name or website_url",
      });
    }

    const out = [];
    out._fetch_ok = false;
    out._fetch_error = "missing company_name or website_url";
    out._fetch_error_code = "MISSING_COMPANY_INPUT";
    out._stage_status = "client_bad_request";
    out._fetch_error_detail = {
      root_cause: "client_bad_request",
      message: "Missing company_name or website_url",
    };
    return out;
  }

  const debug = {
    company_name: companyName,
    website_url: websiteUrl,
    candidates: [],
    kept: 0,
  };

  const telemetry = {
    stage_status: "unknown",
    review_candidates_fetched_count: 0,
    review_candidates_considered_count: 0,
    review_candidates_rejected_count: 0,
    review_candidates_rejected_reasons: {
      disallowed_source: 0,
      self_domain: 0,
      duplicate_host_deferred: 0,
      link_not_found: 0,
      validation_timeout: 0,
      validation_brand_mismatch: 0,
      validation_fetch_blocked: 0,
      validation_error_other: 0,
      missing_fields: 0,
    },
    upstream_failure_buckets: {
      upstream_4xx: 0,
      upstream_5xx: 0,
      upstream_rate_limited: 0,
      upstream_unreachable: 0,
    },
    review_validated_count: 0,
    review_saved_count: 0,
    duplicate_host_used_as_fallback: false,
    time_budget_exhausted: false,
    upstream_status: null,
    upstream_error_code: null,
    upstream_error_message: null,
  };

  const incReason = (key) => {
    const k = String(key || "").trim();
    if (!k) return;
    if (!telemetry.review_candidates_rejected_reasons[k]) {
      telemetry.review_candidates_rejected_reasons[k] = 0;
    }
    telemetry.review_candidates_rejected_reasons[k] += 1;
    telemetry.review_candidates_rejected_count += 1;
  };

  const classifyValidationRejection = (v, errMessage) => {
    const linkStatus = String(v?.link_status || "").trim();
    const fetchStatus = Number.isFinite(Number(v?.fetch_status)) ? Number(v.fetch_status) : null;
    const reason = String(v?.reason_if_rejected || errMessage || "").toLowerCase();

    if (linkStatus === "not_found") return "link_not_found";
    if (fetchStatus === 403 || fetchStatus === 429) return "validation_fetch_blocked";

    if (reason.includes("timeout") || reason.includes("timed out") || reason.includes("abort")) return "validation_timeout";
    if (reason.includes("brand/company not mentioned") || reason.includes("not mentioned")) return "validation_brand_mismatch";

    // Many blocked cases don't include a fetch status; keep these separate from brand mismatches.
    if (linkStatus === "blocked" && (reason.includes("not accessible") || reason.includes("blocked"))) {
      return "validation_fetch_blocked";
    }

    return "validation_error_other";
  };

  const looksLikeReviewUrl = (u) => {
    const s = String(u || "").toLowerCase();
    return (
      s.includes("/review") ||
      s.includes("/reviews") ||
      s.includes("hands-on") ||
      s.includes("tested") ||
      s.includes("verdict")
    );
  };

  const isSameDomain = (a, b) => {
    const ah = String(a || "").toLowerCase().replace(/^www\./, "");
    const bh = String(b || "").toLowerCase().replace(/^www\./, "");
    if (!ah || !bh) return false;
    return ah === bh || ah.endsWith(`.${bh}`) || bh.endsWith(`.${ah}`);
  };

  try {
    const reviewMessage = {
      role: "user",
      content: `Find independent reviews about this company (or its products/services).

Company: ${companyName}
Website: ${websiteUrl}
Industries: ${Array.isArray(company.industries) ? company.industries.join(", ") : ""}

Return EXACTLY a single JSON object with this shape:
{
  "reviews": [ ... ],
  "next_offset": number,
  "exhausted": boolean
}

Rules:
- Return up to 10 review objects in "reviews".
  - We will validate and keep at most 2.
  - Provide extra candidates in case some links are broken (404/page not found) or disallowed.
  - Prefer different source domains (avoid duplicates when possible).
- Use offset=0.
- If there are no results, set exhausted=true and return reviews: [].
- Reviews MUST be independent (do NOT use the company website domain).
- Reviews MUST NOT be sourced from Amazon or Google.
  - Exclude amazon.* domains, amzn.to
  - Exclude google.* domains, g.co, goo.gl
  - YouTube is allowed.
- Prefer magazines, blogs, news sites, YouTube, X (Twitter), and Facebook posts/pages.
- Each review must be an object with keys:
  - source_name (string, optional)
  - source_url (string, REQUIRED) — direct link to the specific article/video/post
  - date (string, optional; prefer YYYY-MM-DD if known)
  - excerpt (string, REQUIRED) — short excerpt/quote (1-2 sentences)
- Output JSON only (no markdown).`,
    };

    const companyHostForSearch = inferSourceNameFromUrl(websiteUrl).toLowerCase().replace(/^www\./, "");

    const websiteHostForValidation = (() => {
      try {
        const u = new URL(websiteUrl);
        return String(u.hostname || "").trim();
      } catch {
        return "";
      }
    })();

    if (!websiteHostForValidation) {
      telemetry.upstream_error_code = "CLIENT_BAD_REQUEST";
      telemetry.upstream_error_message = "Invalid website_url (must be a valid URL with a hostname)";
      telemetry.stage_status = "client_bad_request";

      if (typeof warn === "function") {
        warn({
          stage: "reviews",
          root_cause: "client_bad_request",
          retryable: false,
          upstream_status: null,
          company_name: companyName,
          website_url: websiteUrl,
          message: telemetry.upstream_error_message,
        });
      }

      const out = [];
      out._fetch_ok = false;
      out._fetch_error = telemetry.upstream_error_message;
      out._fetch_error_code = telemetry.upstream_error_code;
      out._stage_status = telemetry.stage_status;
      out._telemetry = telemetry;
      out._fetch_error_detail = {
        root_cause: telemetry.stage_status,
        retryable: false,
        upstream_status: null,
      };
      return out;
    }

    const { reviewPayload, searchBuild } = buildReviewsUpstreamPayloadForImportStart({
      reviewMessage,
      companyWebsiteHost: companyHostForSearch,
    });

    if (searchBuild?.telemetry && typeof searchBuild.telemetry === "object") {
      telemetry.excluded_websites_original_count = searchBuild.telemetry.excluded_websites_original_count;
      telemetry.excluded_websites_used_count = searchBuild.telemetry.excluded_websites_used_count;
      telemetry.excluded_websites_truncated = searchBuild.telemetry.excluded_websites_truncated;
      telemetry.excluded_hosts_spilled_to_prompt_count = searchBuild.telemetry.excluded_hosts_spilled_to_prompt_count;
    }

    const payload_shape_for_log = redactReviewsUpstreamPayloadForLog(reviewPayload, searchBuild.telemetry);
    try {
      console.log(
        "[import-start][reviews_upstream_request] " +
          JSON.stringify({
            stage: "reviews",
            route: "import-start",
            upstream: toHostPathOnlyForLog(xaiUrl),
            payload_shape: payload_shape_for_log,
          })
      );
    } catch {
      // ignore
    }

    console.log(
      `[import-start] Fetching editorial reviews for ${companyName} (upstream=${toHostPathOnlyForLog(xaiUrl)})`
    );

    const response =
      stageCtx && typeof stageCtx.postXaiJsonWithBudget === "function"
        ? await stageCtx.postXaiJsonWithBudget({
            stageKey: "reviews",
            stageBeacon: "xai_reviews_fetch_start",
            body: JSON.stringify(reviewPayload),
            stageCapMsOverride: timeout,
          })
        : await postJsonWithTimeout(xaiUrl, {
            headers: (() => {
              const headers = {
                "Content-Type": "application/json",
              };

              if (isAzureWebsitesUrl(xaiUrl)) {
                headers["x-functions-key"] = xaiKey;
              } else {
                headers["Authorization"] = `Bearer ${xaiKey}`;
              }

              return headers;
            })(),
            body: JSON.stringify(reviewPayload),
            timeoutMs: timeout,
          });

    if (!(response.status >= 200 && response.status < 300)) {
      const upstream_status = normalizeHttpStatus(response.status);
      telemetry.upstream_status = upstream_status;
      telemetry.upstream_error_code = "UPSTREAM_HTTP_ERROR";
      telemetry.upstream_error_message = `Upstream HTTP ${response.status}`;

      const classification = classifyUpstreamFailure({ upstream_status });
      telemetry.stage_status = classification.stage_status;
      bumpUpstreamFailureBucket(telemetry, telemetry.stage_status);

      const xai_request_id = extractUpstreamRequestId(response.headers);
      const upstream_error_body = safeBodyPreview(response.data, { maxLen: 6000 });
      const payload_shape = redactReviewsUpstreamPayloadForLog(reviewPayload, searchBuild.telemetry);

      try {
        console.error(
          "[import-start][reviews_upstream_error] " +
            JSON.stringify({
              stage: "reviews",
              route: "import-start",
              root_cause: telemetry.stage_status,
              retryable: classification.retryable,
              upstream_status,
              xai_request_id,
              upstream_error_body,
              payload_shape,
            })
        );
      } catch {
        // ignore
      }

      console.warn(`[import-start] Failed to fetch reviews for ${companyName}: status ${response.status}`);
      if (debugCollector) debugCollector.push({ ...debug, reason: `xai_status_${response.status}` });

      if (typeof warn === "function") {
        warn({
          stage: "reviews",
          root_cause: telemetry.stage_status,
          retryable: classification.retryable,
          upstream_status,
          company_name: companyName,
          website_url: websiteUrl,
          message: `Upstream HTTP ${response.status}`,
          upstream_error_body,
          xai_request_id,
          payload_shape,
        });
      }

      const out = [];
      out._fetch_ok = false;
      out._fetch_error = `Upstream HTTP ${response.status}`;
      out._fetch_error_code = "REVIEWS_UPSTREAM_HTTP";
      out._stage_status = telemetry.stage_status;
      out._telemetry = telemetry;
      out._fetch_error_detail = {
        root_cause: telemetry.stage_status,
        retryable: classification.retryable,
        upstream_status,
        xai_request_id,
        upstream_error_body,
        payload_shape,
      };
      return out;
    }

    const responseText =
      response.data?.choices?.[0]?.message?.content ||
      response.data?.choices?.[0]?.text ||
      response.data?.output_text ||
      response.data?.text ||
      (typeof response.data === "string" ? response.data : response.data ? JSON.stringify(response.data) : "");

    console.log(`[import-start] Review response preview for ${companyName}: ${String(responseText).substring(0, 80)}...`);

    const parsedAny = extractJsonFromText(responseText);
    const normalized = normalizeUpstreamReviewsResult(parsedAny, { fallbackOffset: 0 });

    const parseError = normalized.parse_error;
    const upstreamReviews = Array.isArray(normalized.reviews) ? normalized.reviews : [];

    if (parseError) {
      console.warn(`[import-start] Failed to parse reviews for ${companyName}: ${parseError}`);

      if (typeof warn === "function") {
        warn({
          stage: "reviews",
          root_cause: "parse_error",
          retryable: true,
          upstream_status: null,
          company_name: companyName,
          website_url: websiteUrl,
          message: `Parse error: ${parseError}`,
        });
      }
    }

    const candidatesUpstream = upstreamReviews.filter((r) => r && typeof r === "object");
    const candidates = candidatesUpstream.slice(0, 10);
    const upstreamCandidateCount = candidatesUpstream.length;

    telemetry.review_candidates_fetched_count = upstreamCandidateCount;
    telemetry.review_candidates_considered_count = candidates.length;
    telemetry.stage_status = parseError ? "upstream_unreachable" : "ok";

    const nowIso = new Date().toISOString();
    const curated = [];
    const keptHosts = new Set();
    const deferredDuplicates = [];
    const companyHost = inferSourceNameFromUrl(websiteUrl).toLowerCase().replace(/^www\./, "");

    let rejectedCount = 0;

    const loopStart = Date.now();

    for (const r of candidates) {
      // Stay inside the overall handler budget; better to return 0–2 than time out.
      if (getRemainingMs && getRemainingMs() < deadlineSafetyBufferMs + minValidationWindowMs) {
        telemetry.time_budget_exhausted = true;
        telemetry.stage_status = "timed_out";
        break;
      }

      // Secondary guard for cases where we don't have a shared remaining-time tracker.
      if (!getRemainingMs && Date.now() - loopStart > Math.max(5000, timeout - 2000)) {
        telemetry.time_budget_exhausted = true;
        telemetry.stage_status = "timed_out";
        break;
      }
      const sourceUrlRaw = String(r?.source_url || r?.url || "").trim();
      const excerptRaw = String(r?.excerpt || r?.text || r?.abstract || r?.summary || "").trim();
      const titleRaw = String(r?.title || r?.headline || r?.headline_text || r?.name || "").trim();
      const sourceNameRaw = String(r?.source_name || r?.source || "").trim();
      const dateRaw = String(r?.date || "").trim();

      if (!sourceUrlRaw || !excerptRaw) {
        rejectedCount += 1;
        incReason("missing_fields");
        debug.candidates.push({
          url: sourceUrlRaw,
          title_raw: titleRaw,
          excerpt_preview: excerptRaw ? excerptRaw.slice(0, 200) : "",
          rejection_bucket: "missing_fields",
          link_status: "missing_fields",
          fetch_status: null,
          final_url: null,
          is_valid: false,
          matched_brand_terms: [],
          match_confidence: 0,
          evidence_snippets_count: 0,
          reason_if_rejected: "Missing source_url or excerpt",
        });
        continue;
      }

      const normalizedCandidateUrl = normalizeHttpUrlOrNull(sourceUrlRaw);
      if (!normalizedCandidateUrl || isDisallowedReviewSourceUrl(normalizedCandidateUrl)) {
        rejectedCount += 1;
        incReason("disallowed_source");
        debug.candidates.push({
          url: sourceUrlRaw,
          title_raw: titleRaw,
          excerpt_preview: excerptRaw ? excerptRaw.slice(0, 200) : "",
          rejection_bucket: "disallowed_source",
          link_status: "disallowed_url",
          fetch_status: null,
          final_url: null,
          is_valid: false,
          matched_brand_terms: [],
          match_confidence: 0,
          evidence_snippets_count: 0,
          reason_if_rejected: "Disallowed or invalid source_url",
        });
        continue;
      }

      if (stageCtx?.setStage) {
        stageCtx.setStage("validateReviews", {
          company_name: companyName,
          website_url: websiteUrl,
          normalized_domain: String(company?.normalized_domain || ""),
          review_url: normalizedCandidateUrl,
        });
      }

      const v = await validateCuratedReviewCandidate(
        {
          companyName,
          websiteUrl,
          normalizedDomain: company.normalized_domain || "",
          url: normalizedCandidateUrl,
          title: titleRaw,
          excerpt: excerptRaw,
        },
        { timeoutMs: 8000, maxBytes: 60000, maxSnippets: 2, minWords: 10, maxWords: 25 }
      ).catch((e) => ({
        is_valid: false,
        link_status: "blocked",
        final_url: null,
        matched_brand_terms: [],
        evidence_snippets: [],
        match_confidence: 0,
        last_checked_at: nowIso,
        reason_if_rejected: e?.message || "validation error",
      }));

      const evidenceCount = Array.isArray(v?.evidence_snippets) ? v.evidence_snippets.length : 0;
      const rejectionBucket = v?.is_valid === true ? null : classifyValidationRejection(v);

      debug.candidates.push({
        url: normalizedCandidateUrl,
        title_raw: titleRaw,
        excerpt_preview: excerptRaw ? excerptRaw.slice(0, 200) : "",
        rejection_bucket: rejectionBucket,
        link_status: v?.link_status,
        fetch_status: Number.isFinite(Number(v?.fetch_status)) ? Number(v.fetch_status) : null,
        final_url: v?.final_url,
        is_valid: Boolean(v?.is_valid),
        matched_brand_terms: v?.matched_brand_terms || [],
        match_confidence: v?.match_confidence,
        evidence_snippets_count: evidenceCount,
        reason_if_rejected: v?.reason_if_rejected,
      });

      // Only persist validated reviews.
      if (v?.is_valid !== true) {
        rejectedCount += 1;
        incReason(rejectionBucket || "validation_error_other");
        continue;
      }

      telemetry.review_validated_count += 1;

      const finalUrl = normalizeHttpUrlOrNull(v?.final_url || normalizedCandidateUrl) || normalizedCandidateUrl;
      if (isDisallowedReviewSourceUrl(finalUrl)) {
        rejectedCount += 1;
        incReason("disallowed_source");
        continue;
      }

      const reviewHost = inferSourceNameFromUrl(finalUrl).toLowerCase().replace(/^www\./, "");
      if (companyHost && reviewHost && isSameDomain(reviewHost, companyHost)) {
        rejectedCount += 1;
        incReason("self_domain");
        continue;
      }

      if (reviewHost && keptHosts.has(reviewHost)) {
        // Prefer unique sources, but don't fail the import if a company only has
        // one credible source with multiple relevant mentions.
        if (curated.length >= 1) {
          const sourceName = sourceNameRaw || inferSourceNameFromUrl(finalUrl) || "Unknown Source";
          rejectedCount += 1;
          incReason("duplicate_host_deferred");
          deferredDuplicates.push({
            id: `xai_auto_${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.trunc(Math.random() * 1e6)}`,
            source_name: sourceName,
            source: sourceName,
            source_url: finalUrl,
            excerpt: excerptRaw,
            title_raw: titleRaw,
            date: dateRaw || null,
            created_at: nowIso,
            last_updated_at: nowIso,
            imported_via: "xai_import",
            show_to_users: true,
            is_public: true,
            _match_confidence: typeof v?.match_confidence === "number" ? v.match_confidence : null,
            _looks_like_review_url: looksLikeReviewUrl(finalUrl),
          });
          continue;
        }
      }

      const sourceName = sourceNameRaw || inferSourceNameFromUrl(finalUrl) || "Unknown Source";

      curated.push({
        id: `xai_auto_${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.trunc(Math.random() * 1e6)}`,
        source_name: sourceName,
        source: sourceName,
        source_url: finalUrl,
        excerpt: excerptRaw,
        date: dateRaw || null,
        created_at: nowIso,
        last_updated_at: nowIso,
        imported_via: "xai_import",
        show_to_users: true,
        is_public: true,
      });

      if (reviewHost) keptHosts.add(reviewHost);
      if (curated.length >= 2) break;
    }

    if (curated.length < 2 && deferredDuplicates.length > 0) {
      const sorted = deferredDuplicates
        .slice()
        .sort((a, b) => {
          const aReview = a?._looks_like_review_url ? 1 : 0;
          const bReview = b?._looks_like_review_url ? 1 : 0;
          if (aReview !== bReview) return bReview - aReview;

          const aScore = typeof a?._match_confidence === "number" ? a._match_confidence : 0;
          const bScore = typeof b?._match_confidence === "number" ? b._match_confidence : 0;
          if (aScore !== bScore) return bScore - aScore;

          return 0;
        });

      const best = sorted[0];
      if (best) {
        const { _match_confidence, _looks_like_review_url, ...clean } = best;
        curated.push(clean);
        telemetry.duplicate_host_used_as_fallback = true;
      }
    }

    debug.kept = curated.length;

    telemetry.review_saved_count = curated.length;

    if (telemetry.stage_status === "unknown" || telemetry.stage_status === "ok") {
      telemetry.stage_status =
        curated.length === 0 && upstreamCandidateCount > 0 ? "no_valid_reviews_found" : "ok";
    }

    // Keep rejectedCount as the canonical, cheap-to-read number (telemetry holds the breakdown).
    telemetry.review_candidates_rejected_count = rejectedCount;

    console.log(
      "[import-start][reviews_telemetry] " +
        JSON.stringify({
          company_name: companyName,
          website_url: websiteUrl,
          stage_status: telemetry.stage_status,
          fetched: telemetry.review_candidates_fetched_count,
          considered: telemetry.review_candidates_considered_count,
          validated: telemetry.review_validated_count,
          saved: telemetry.review_saved_count,
          rejected: telemetry.review_candidates_rejected_count,
          rejected_reasons: telemetry.review_candidates_rejected_reasons,
          duplicate_host_used_as_fallback: telemetry.duplicate_host_used_as_fallback,
          time_budget_exhausted: telemetry.time_budget_exhausted,
          upstream_status: telemetry.upstream_status,

          excluded_websites_original_count: telemetry.excluded_websites_original_count,
          excluded_websites_used_count: telemetry.excluded_websites_used_count,
          excluded_websites_truncated: telemetry.excluded_websites_truncated,
          excluded_hosts_spilled_to_prompt_count: telemetry.excluded_hosts_spilled_to_prompt_count,
        })
    );

    console.log(
      `[import-start][reviews] company=${companyName} upstream_candidates=${upstreamCandidateCount} considered=${candidates.length} kept=${curated.length} rejected=${rejectedCount} parse_error=${parseError || ""}`
    );

    if (debugCollector) {
      debugCollector.push({ ...debug, telemetry });
    }

    curated._candidate_count = upstreamCandidateCount;
    curated._candidate_count_considered = candidates.length;
    curated._rejected_count = rejectedCount;

    curated._fetch_ok = !parseError;
    curated._fetch_error = parseError ? String(parseError) : null;
    curated._fetch_error_code = parseError ? "REVIEWS_PARSE_ERROR" : null;
    curated._stage_status = telemetry.stage_status;
    curated._telemetry = telemetry;

    // Keep per-candidate debug lightweight; mostly useful when saved_count=0.
    curated._candidates_debug = Array.isArray(debug.candidates) ? debug.candidates.slice(0, 10) : [];

    return curated;
  } catch (e) {
    if (e instanceof AcceptedResponseError) throw e;

    const upstream_status = normalizeHttpStatus(e?.status || e?.response?.status || null);
    const code = typeof e?.code === "string" && e.code.trim() ? e.code.trim() : "REVIEWS_EXCEPTION";

    telemetry.upstream_status = upstream_status;
    telemetry.upstream_error_code = code;
    telemetry.upstream_error_message = e?.message || String(e);

    const classification = classifyUpstreamFailure({ upstream_status, err_code: code });
    telemetry.stage_status = classification.stage_status;
    bumpUpstreamFailureBucket(telemetry, telemetry.stage_status);

    const xai_request_id = extractUpstreamRequestId(e?.response?.headers);
    const upstream_error_body = safeBodyPreview(e?.response?.data, { maxLen: 6000 });

    console.warn(`[import-start] Error fetching reviews for ${companyName}: ${telemetry.upstream_error_message}`);
    if (debugCollector) debugCollector.push({ ...debug, reason: e?.message || String(e) });

    if (typeof warn === "function") {
      warn({
        stage: "reviews",
        root_cause: telemetry.stage_status,
        retryable: classification.retryable,
        upstream_status,
        company_name: companyName,
        website_url: websiteUrl,
        message: telemetry.upstream_error_message,
        upstream_error_body,
        xai_request_id,
      });
    }

    const out = [];
    out._fetch_ok = false;
    out._fetch_error = telemetry.upstream_error_message;
    out._fetch_error_code = code;
    out._stage_status = telemetry.stage_status;
    out._telemetry = telemetry;
    out._fetch_error_detail = {
      root_cause: telemetry.stage_status,
      retryable: classification.retryable,
      upstream_status,
      xai_request_id,
      upstream_error_body,
    };
    return out;
  }
}

let cosmosCompaniesClient = null;
let companiesPkPathPromise;

function getCompaniesCosmosContainer() {
  try {
    const endpoint = (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim();
    const key = (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim();
    const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
    const containerId = (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();

    if (!endpoint || !key) return null;
    if (!CosmosClient) return null;

    cosmosCompaniesClient ||= new CosmosClient({ endpoint, key });
    return cosmosCompaniesClient.database(databaseId).container(containerId);
  } catch {
    return null;
  }
}

async function getCompaniesPartitionKeyPath(companiesContainer) {
  if (!companiesContainer) return "/normalized_domain";
  companiesPkPathPromise ||= getContainerPartitionKeyPath(companiesContainer, "/normalized_domain");
  try {
    return await companiesPkPathPromise;
  } catch {
    return "/normalized_domain";
  }
}

let companiesCosmosTargetPromise;

function redactHostForDiagnostics(value) {
  const host = typeof value === "string" ? value.trim() : "";
  if (!host) return "";
  if (host.length <= 12) return host;
  return `${host.slice(0, 8)}…${host.slice(-8)}`;
}

async function getCompaniesCosmosTargetDiagnostics() {
  companiesCosmosTargetPromise ||= (async () => {
    const endpoint = (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim();
    const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
    const containerId = (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();

    let host = "";
    try {
      host = endpoint ? new URL(endpoint).host : "";
    } catch {
      host = "";
    }

    const container = getCompaniesCosmosContainer();
    const pkPath = await getCompaniesPartitionKeyPath(container);

    return {
      cosmos_account_host_redacted: redactHostForDiagnostics(host),
      cosmos_db_name: databaseId,
      cosmos_container_name: containerId,
      cosmos_container_partition_key_path: pkPath,
    };
  })();

  try {
    return await companiesCosmosTargetPromise;
  } catch {
    return {
      cosmos_account_host_redacted: "",
      cosmos_db_name: (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim(),
      cosmos_container_name: (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim(),
      cosmos_container_partition_key_path: "/normalized_domain",
    };
  }
}

async function verifySavedCompaniesReadAfterWrite(saveResult) {
  const result = saveResult && typeof saveResult === "object" ? saveResult : {};

  const savedIds = Array.isArray(result.saved_ids)
    ? result.saved_ids.map((id) => String(id || "").trim()).filter(Boolean)
    : [];

  const persisted = Array.isArray(result.persisted_items) ? result.persisted_items : [];
  const domainById = new Map();
  for (const item of persisted) {
    const id = String(item?.id || "").trim();
    if (!id) continue;
    const normalizedDomain = String(item?.normalized_domain || "").trim();
    if (normalizedDomain) domainById.set(id, normalizedDomain);
  }

  const container = getCompaniesCosmosContainer();
  if (!container) {
    return {
      verified_ids: [],
      unverified_ids: savedIds,
      verified_persisted_items: [],
    };
  }

  const BATCH_SIZE = 4;
  const verified = [];
  const unverified = [];

  for (let i = 0; i < savedIds.length; i += BATCH_SIZE) {
    const batch = savedIds.slice(i, i + BATCH_SIZE);
    const reads = await Promise.all(
      batch.map(async (companyId) => {
        const normalizedDomain = domainById.get(companyId) || "unknown";
        const doc = await readItemWithPkCandidates(container, companyId, {
          id: companyId,
          normalized_domain: normalizedDomain,
          partition_key: normalizedDomain,
        }).catch(() => null);

        const missingFields = Array.isArray(doc?.import_missing_fields) ? doc.import_missing_fields : [];
        const complete = Boolean(doc) && missingFields.length === 0;

        return { companyId, ok: Boolean(doc), complete };
      })
    );

    for (const r of reads) {
      if (r.complete) verified.push(r.companyId);
      else unverified.push(r.companyId);
    }
  }

  const verifiedSet = new Set(verified);
  const verifiedPersistedItems = persisted.filter((it) => verifiedSet.has(String(it?.id || "").trim()));

  return {
    verified_ids: verified,
    unverified_ids: unverified,
    verified_persisted_items: verifiedPersistedItems,
  };
}

function applyReadAfterWriteVerification(saveResult, verification) {
  const result = saveResult && typeof saveResult === "object" ? { ...saveResult } : {};

  const writeCount = Number(result.saved || 0) || 0;
  const writeIds = Array.isArray(result.saved_ids) ? result.saved_ids : [];

  const verifiedIds = Array.isArray(verification?.verified_ids)
    ? verification.verified_ids.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  const unverifiedIds = Array.isArray(verification?.unverified_ids)
    ? verification.unverified_ids.map((id) => String(id || "").trim()).filter(Boolean)
    : [];

  const verifiedCount = verifiedIds.length;

  return {
    ...result,
    saved_write_count: writeCount,
    saved_ids_write: writeIds,
    saved_company_ids_verified: verifiedIds,
    saved_company_ids_unverified: unverifiedIds,
    saved_verified_count: verifiedCount,
    saved: verifiedCount,
    saved_ids: verifiedIds,
    persisted_items: Array.isArray(verification?.verified_persisted_items) ? verification.verified_persisted_items : result.persisted_items,
  };
}

async function readItemWithPkCandidates(container, id, docForCandidates) {
  if (!container || !id) return null;
  const containerPkPath = await getCompaniesPartitionKeyPath(container);

  const candidates = buildPartitionKeyCandidates({
    doc: docForCandidates,
    containerPkPath,
    requestedId: id,
  });

  let lastErr = null;
  for (const partitionKeyValue of candidates) {
    try {
      const item =
        partitionKeyValue !== undefined
          ? container.item(id, partitionKeyValue)
          : container.item(id);
      const { resource } = await item.read();
      return resource || null;
    } catch (e) {
      lastErr = e;
      if (e?.code === 404) return null;
    }
  }

  if (lastErr && lastErr.code !== 404) {
    console.warn(`[import-start] readItem failed id=${id} pkPath=${containerPkPath}: ${lastErr.message}`);
  }
  return null;
}

async function upsertItemWithPkCandidates(container, doc) {
  if (!container || !doc) return { ok: false, error: "no_container" };
  const id = String(doc.id || "").trim();
  if (!id) return { ok: false, error: "missing_id" };

  const containerPkPath = await getCompaniesPartitionKeyPath(container);
  const pkValue = getValueAtPath(doc, containerPkPath);
  const candidates = buildPartitionKeyCandidates({ doc, containerPkPath, requestedId: id });

  let lastErr = null;
  for (const partitionKeyValue of candidates) {
    try {
      if (partitionKeyValue !== undefined) {
        await container.items.upsert(doc, { partitionKey: partitionKeyValue });
      } else if (pkValue !== undefined) {
        await container.items.upsert(doc, { partitionKey: pkValue });
      } else {
        await container.items.upsert(doc);
      }
      return { ok: true };
    } catch (e) {
      lastErr = e;
    }
  }

  return { ok: false, error: lastErr?.message || "upsert_failed" };
}

function buildImportControlDocBase(sessionId) {
  return {
    session_id: sessionId,
    normalized_domain: "import",
    partition_key: "import",
    type: "import_control",
    updated_at: new Date().toISOString(),
  };
}

async function upsertCosmosImportSessionDoc({ sessionId, requestId, patch }) {
  try {
    const sid = String(sessionId || "").trim();
    if (!sid) return { ok: false, error: "missing_session_id" };

    const container = getCompaniesCosmosContainer();
    if (!container) return { ok: false, error: "no_container" };

    const id = `_import_session_${sid}`;

    const existing = await readItemWithPkCandidates(container, id, {
      id,
      ...buildImportControlDocBase(sid),
      created_at: "",
    });

    const createdAt = existing?.created_at || new Date().toISOString();
    const existingRequest = existing?.request && typeof existing.request === "object" ? existing.request : null;

    // IMPORTANT: This doc is upserted many times during a session (progress, resume errors, etc).
    // Never drop previously-written fields (e.g. saved ids), otherwise /import/status loses its
    // source of truth and the UI appears "stalled" even though we wrote earlier.
    const sessionDoc = {
      ...(existing && typeof existing === "object" ? existing : {}),
      id,
      ...buildImportControlDocBase(sid),
      created_at: createdAt,
      request_id: requestId,
      ...(existingRequest ? { request: existingRequest } : {}),
      ...(patch && typeof patch === "object" ? patch : {}),
    };

    return await upsertItemWithPkCandidates(container, sessionDoc);
  } catch (e) {
    return { ok: false, error: e?.message || String(e || "session_upsert_failed") };
  }
}

// Check if a session has been stopped
async function checkIfSessionStopped(sessionId) {
  try {
    const container = getCompaniesCosmosContainer();
    if (!container) return false;

    const stopDocId = `_import_stop_${sessionId}`;
    const resource = await readItemWithPkCandidates(container, stopDocId, {
      id: stopDocId,
      ...buildImportControlDocBase(sessionId),
      stopped_at: "",
    });
    return !!resource;
  } catch (e) {
    console.warn(`[import-start] Error checking stop status: ${e?.message || String(e)}`);
    return false;
  }
}

// Save companies to Cosmos DB (skip duplicates)
async function saveCompaniesToCosmos({
  companies,
  sessionId,
  requestId,
  sessionCreatedAt,
  axiosTimeout,
  saveStub = false,
  getRemainingMs,
}) {
  try {
    const list = Array.isArray(companies) ? companies : [];
    const sid = String(sessionId || "").trim();

    const importRequestId = typeof requestId === "string" && requestId.trim() ? requestId.trim() : null;
    const importCreatedAt =
      typeof sessionCreatedAt === "string" && sessionCreatedAt.trim() ? sessionCreatedAt.trim() : new Date().toISOString();
    const endpoint = (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim();
    const key = (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim();
    const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
    const containerId = (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();

    if (!endpoint || !key) {
      console.warn("[import-start] Cosmos DB not configured, skipping save");
      return { saved: 0, failed: 0, skipped: 0 };
    }

    if (!CosmosClient) {
      console.warn("[import-start] Cosmos client module unavailable, skipping save");
      return { saved: 0, failed: 0, skipped: 0 };
    }

    const client = new CosmosClient({ endpoint, key });
    const database = client.database(databaseId);
    const container = database.container(containerId);

    let saved = 0;
    let failed = 0;
    let skipped = 0;

    const saved_ids = [];
    const skipped_ids = [];
    const skipped_duplicates = [];
    const failed_items = [];
    const persisted_items = [];

    // Process companies in batches for better concurrency
    const BATCH_SIZE = 4;

    for (let batchStart = 0; batchStart < list.length; batchStart += BATCH_SIZE) {
      // Check if import was stopped
      if (batchStart > 0) {
        const stopped = await checkIfSessionStopped(sid);
        if (stopped) {
          console.log(`[import-start] Import stopped by user after ${saved} companies`);
          break;
        }
      }

      const batch = list.slice(batchStart, Math.min(batchStart + BATCH_SIZE, list.length));

      // Process batch in parallel
      const batchResults = await Promise.all(
        batch.map(async (company, batchIndex) => {
          const companyIndex = batchStart + batchIndex;
          const companyName = company.company_name || company.name || "";

          try {
            const normalizedDomain = toNormalizedDomain(
              company.website_url ||
                company.canonical_url ||
                company.url ||
                company.amazon_url ||
                company.normalized_domain ||
                ""
            );

            const finalNormalizedDomain =
              normalizedDomain && normalizedDomain !== "unknown" ? normalizedDomain : "unknown";

            // If a stub company was saved earlier in the same session, we must UPDATE it (not skip)
            // so enrichment fields get persisted atomically.
            const canonicalUrlForDedupe = String(company.canonical_url || company.website_url || company.url || "").trim();

            const existing = await findExistingCompany(container, normalizedDomain, companyName, canonicalUrlForDedupe);
            let existingDoc = null;
            let shouldUpdateExisting = false;

            if (existing && existing.id) {
              const existingPkCandidate = String(existing.partition_key || existing.normalized_domain || finalNormalizedDomain || "").trim();

              existingDoc = await readItemWithPkCandidates(container, existing.id, {
                id: existing.id,
                normalized_domain: existingPkCandidate || finalNormalizedDomain,
                partition_key: existingPkCandidate || finalNormalizedDomain,
              }).catch(() => null);

              const existingSessionId = String(existingDoc?.import_session_id || existingDoc?.session_id || "").trim();

              const existingMissingFields = Array.isArray(existingDoc?.import_missing_fields) ? existingDoc.import_missing_fields : [];
              const existingLooksLikeSeed =
                Boolean(existingDoc?.seed_ready) ||
                String(existingDoc?.source || "").trim() === "company_url_shortcut" ||
                String(existingDoc?.source_stage || "").trim() === "seed";

              const existingIncomplete = existingLooksLikeSeed || existingMissingFields.length > 0;

              // Reconcile: if the existing record is incomplete (common for seed_fallback), update it instead of creating
              // or leaving behind additional seed rows.
              shouldUpdateExisting = Boolean((existingSessionId && existingSessionId === sid) || existingIncomplete);

              if (!shouldUpdateExisting) {
                console.log(`[import-start] Skipping duplicate company: ${companyName} (${normalizedDomain})`);
                return {
                  type: "skipped",
                  index: companyIndex,
                  company_name: companyName,
                  duplicate_of_id: existing?.id || null,
                  duplicate_match_key: existing?.duplicate_match_key || null,
                  duplicate_match_value: existing?.duplicate_match_value || null,
                };
              }
            }

            // Normalize first so we can decide whether this is worth persisting.
            const industriesNormalized = normalizeIndustries(company.industries);

            const keywordsNormalized = normalizeProductKeywords(company?.keywords || company?.product_keywords, {
              companyName,
              websiteUrl: company.website_url || company.canonical_url || company.url || "",
            }).slice(0, 25);

            const headquartersLocation = String(company.headquarters_location || "").trim();
            const headquartersMeaningful = (() => {
              if (!headquartersLocation) return false;
              const lower = headquartersLocation.toLowerCase();
              if (lower === "unknown" || lower === "n/a" || lower === "na" || lower === "none") return false;
              return true;
            })();

            const manufacturingLocationsNormalized = Array.isArray(company.manufacturing_locations)
              ? company.manufacturing_locations
                  .map((loc) => {
                    if (typeof loc === "string") return loc.trim();
                    if (loc && typeof loc === "object") {
                      return String(loc.formatted || loc.address || loc.location || "").trim();
                    }
                    return "";
                  })
                  .filter(Boolean)
              : [];

            const curatedReviewsNormalized = Array.isArray(company.curated_reviews)
              ? company.curated_reviews.filter((r) => r && typeof r === "object")
              : [];

            const reviewCountNormalized = Number.isFinite(Number(company.review_count))
              ? Number(company.review_count)
              : curatedReviewsNormalized.length;

            const headquartersAttempted =
              headquartersMeaningful ||
              Boolean(
                company?.hq_unknown &&
                  String(company?.hq_unknown_reason || company?.red_flag_reason || "").trim()
              );

            const manufacturingAttempted =
              manufacturingLocationsNormalized.length > 0 ||
              Boolean(
                company?.mfg_unknown &&
                  String(company?.mfg_unknown_reason || company?.red_flag_reason || "").trim()
              );

            const reviewsAttempted =
              curatedReviewsNormalized.length > 0 ||
              reviewCountNormalized > 0 ||
              Boolean(
                company?.review_cursor &&
                  typeof company.review_cursor === "object" &&
                  (company.review_cursor.exhausted || company.review_cursor.last_error)
              );

            const hasMeaningfulEnrichment =
              industriesNormalized.length > 0 ||
              keywordsNormalized.length > 0 ||
              headquartersAttempted ||
              manufacturingAttempted ||
              reviewsAttempted;

            const source = String(company?.source || "").trim();
            const isUrlShortcut = source === "company_url_shortcut";

            // Hard guarantee: never persist a URL shortcut stub unless it has meaningful enrichment.
            // The save_stub flag must NOT override this.
            if (!hasMeaningfulEnrichment && (isUrlShortcut || !saveStub)) {
              return {
                type: "skipped_stub",
                index: companyIndex,
                company_name: companyName,
                normalized_domain: finalNormalizedDomain,
                reason: "missing_enrichment",
              };
            }

            // Fetch + upload logo for the company (uses existing blob if present)
            const companyId = shouldUpdateExisting && existingDoc?.id
              ? String(existingDoc.id)
              : `company_${Date.now()}_${Math.random().toString(36).slice(2)}`;

            const remainingForLogo =
              typeof getRemainingMs === "function"
                ? Number(getRemainingMs())
                : Number.isFinite(Number(axiosTimeout))
                  ? Number(axiosTimeout)
                  : DEFAULT_UPSTREAM_TIMEOUT_MS;

            const logoBudgetMs = Math.max(
              0,
              Math.min(
                8000,
                Math.trunc(remainingForLogo - DEADLINE_SAFETY_BUFFER_MS - UPSTREAM_TIMEOUT_MARGIN_MS)
              )
            );

            const logoImport = await fetchLogo({
              companyId,
              companyName,
              domain: finalNormalizedDomain,
              websiteUrl: company.website_url || company.canonical_url || company.url || "",
              existingLogoUrl: company.logo_url || existingDoc?.logo_url || null,
              budgetMs: logoBudgetMs,
            });

            // Calculate default rating based on company data
            const hasManufacturingLocations =
              Array.isArray(company.manufacturing_locations) && company.manufacturing_locations.length > 0;
            const hasHeadquarters = !!(company.headquarters_location && company.headquarters_location.trim());

            // Check for reviews from curated_reviews or legacy fields
            const hasCuratedReviews = Array.isArray(company.curated_reviews) && company.curated_reviews.length > 0;
            const hasEditorialReviews =
              (company.editorial_review_count || 0) > 0 ||
              (Array.isArray(company.reviews) && company.reviews.length > 0) ||
              hasCuratedReviews;

            const defaultRatingWithReviews = {
              star1: { value: hasManufacturingLocations ? 1.0 : 0.0, notes: [] },
              star2: { value: hasHeadquarters ? 1.0 : 0.0, notes: [] },
              star3: { value: hasEditorialReviews ? 1.0 : 0.0, notes: [] },
              star4: { value: 0.0, notes: [] },
              star5: { value: 0.0, notes: [] },
            };

            const reviewsStarState = resolveReviewsStarState({
              ...company,
              curated_reviews: curatedReviewsNormalized,
              review_count: reviewCountNormalized,
              public_review_count: Math.max(0, Math.trunc(Number(company.public_review_count) || 0)),
              private_review_count: Math.max(0, Math.trunc(Number(company.private_review_count) || 0)),
              rating: defaultRatingWithReviews,
            });

            const nowIso = new Date().toISOString();

            const productKeywordsString = keywordListToString(keywordsNormalized);

            const reviewsLastUpdatedAt =
              typeof company.reviews_last_updated_at === "string" && company.reviews_last_updated_at.trim()
                ? company.reviews_last_updated_at.trim()
                : nowIso;

            const incomingCursor = company.review_cursor && typeof company.review_cursor === "object" ? company.review_cursor : null;

            // Default: NEVER mark the cursor exhausted just because review_count is 0.
            // Exhaustion should be a deliberate signal from an upstream fetch attempt.
            const cursorExhausted =
              incomingCursor && typeof incomingCursor.exhausted === "boolean" ? incomingCursor.exhausted : false;

            const reviewCursorNormalized = incomingCursor
              ? { ...incomingCursor, exhausted: cursorExhausted }
              : buildReviewCursor({
                  nowIso,
                  count: reviewCountNormalized,
                  exhausted: cursorExhausted,
                  last_error: null,
                });

            const doc = {
              id: companyId,
              company_name: companyName,
              name: company.name || companyName,
              url: company.url || company.website_url || company.canonical_url || "",
              website_url: company.website_url || company.canonical_url || company.url || "",
              canonical_url:
                finalNormalizedDomain && finalNormalizedDomain !== "unknown"
                  ? `https://${finalNormalizedDomain}/`
                  : company.canonical_url || company.website_url || company.url || "",
              industries: industriesNormalized,
              product_keywords: productKeywordsString,
              keywords: keywordsNormalized,
              normalized_domain: finalNormalizedDomain,
              partition_key: finalNormalizedDomain,
              logo_url: logoImport.logo_url || null,
              logo_source_url: logoImport.logo_source_url || null,
              logo_source_location: logoImport.logo_source_location || null,
              logo_source_domain: logoImport.logo_source_domain || null,
              logo_source_type: logoImport.logo_source_type || null,
              logo_status: logoImport.logo_status || (logoImport.logo_url ? "imported" : "not_found_on_site"),
              logo_import_status: logoImport.logo_import_status || "missing",
              logo_stage_status:
                typeof logoImport.logo_stage_status === "string" && logoImport.logo_stage_status.trim()
                  ? logoImport.logo_stage_status.trim()
                  : logoImport.logo_url
                    ? "ok"
                    : "not_found_on_site",
              logo_error: logoImport.logo_error || "",
              logo_telemetry: logoImport.logo_telemetry && typeof logoImport.logo_telemetry === "object" ? logoImport.logo_telemetry : null,
              tagline: company.tagline || "",
              location_sources: Array.isArray(company.location_sources) ? company.location_sources : [],
              show_location_sources_to_users: Boolean(company.show_location_sources_to_users),
              hq_lat: company.hq_lat,
              hq_lng: company.hq_lng,
              headquarters_location: headquartersLocation,
              hq_unknown: Boolean(company.hq_unknown),
              hq_unknown_reason: String(company.hq_unknown_reason || "").trim(),
              headquarters_locations: company.headquarters_locations || [],
              headquarters: Array.isArray(company.headquarters)
                ? company.headquarters
                : Array.isArray(company.headquarters_locations)
                  ? company.headquarters_locations
                  : [],
              manufacturing_locations: manufacturingLocationsNormalized,
              mfg_unknown: Boolean(company.mfg_unknown),
              mfg_unknown_reason: String(company.mfg_unknown_reason || "").trim(),
              manufacturing_geocodes: Array.isArray(company.manufacturing_geocodes) ? company.manufacturing_geocodes : [],
              curated_reviews: curatedReviewsNormalized,
              review_count: reviewCountNormalized,
              reviews_last_updated_at: reviewsLastUpdatedAt,
              review_cursor: reviewCursorNormalized,
              reviews_stage_status: (() => {
                const explicit = typeof company.reviews_stage_status === "string" ? company.reviews_stage_status.trim() : "";
                if (explicit) return explicit;

                const cursorStatus =
                  reviewCursorNormalized && typeof reviewCursorNormalized.reviews_stage_status === "string"
                    ? reviewCursorNormalized.reviews_stage_status.trim()
                    : "";
                if (cursorStatus) return cursorStatus;

                if (reviewCursorNormalized && reviewCursorNormalized.last_error) return "upstream_unreachable";
                if (reviewCursorNormalized && reviewCursorNormalized.exhausted) {
                  return reviewCountNormalized > 0 ? "ok" : "no_valid_reviews_found";
                }

                return "pending";
              })(),
              reviews_upstream_status:
                typeof company.reviews_upstream_status === "number"
                  ? company.reviews_upstream_status
                  : reviewCursorNormalized && typeof reviewCursorNormalized.upstream_status === "number"
                    ? reviewCursorNormalized.upstream_status
                    : null,
              red_flag: Boolean(company.red_flag),
              red_flag_reason: company.red_flag_reason || "",
              location_confidence: company.location_confidence || "medium",
              social: company.social || {},
              amazon_url: company.amazon_url || "",
              rating_icon_type: "star",
              reviews_star_value: reviewsStarState.next_value,
              reviews_star_source: reviewsStarState.next_source,
              rating: reviewsStarState.next_rating,
              source: "xai_import",
              session_id: sid,
              import_session_id: sid,
              import_request_id: importRequestId,
              import_created_at: importCreatedAt,
              created_at:
                shouldUpdateExisting && existingDoc && typeof existingDoc.created_at === "string" && existingDoc.created_at.trim()
                  ? existingDoc.created_at.trim()
                  : nowIso,
              updated_at: nowIso,
            };

            // Canonical import contract:
            // - No required field should be absent/undefined after persistence
            // - If we cannot resolve a value, persist a deterministic placeholder + structured warning
            try {
              const asMeaningful = asMeaningfulString;

              const import_missing_fields = [];
              const import_missing_reason = {};
              const import_warnings = [];

              const LOW_QUALITY_MAX_ATTEMPTS = 3;

              const applyLowQualityPolicy = (field, reason) => {
                const f = String(field || "").trim();
                const r = String(reason || "").trim();
                if (!f) return { missing_reason: r || "missing", retryable: true, attemptCount: 0 };

                // We cap repeated attempts for both low_quality and not_found so resume-worker can
                // terminalize these fields and let the session complete.
                const supportsTerminalization = r === "low_quality" || r === "not_found";
                if (!supportsTerminalization) return { missing_reason: r || "missing", retryable: true, attemptCount: 0 };

                const terminalReason = r === "low_quality" ? "low_quality_terminal" : "not_found_terminal";

                // If we previously terminalized this field, keep it terminal.
                const prev = String(import_missing_reason[f] || doc?.import_missing_reason?.[f] || "").trim();
                if (prev === "low_quality_terminal" || prev === "not_found_terminal") {
                  return { missing_reason: prev, retryable: false, attemptCount: LOW_QUALITY_MAX_ATTEMPTS };
                }

                const attemptsObj =
                  doc.import_low_quality_attempts &&
                  typeof doc.import_low_quality_attempts === "object" &&
                  !Array.isArray(doc.import_low_quality_attempts)
                    ? { ...doc.import_low_quality_attempts }
                    : {};

                const metaObj =
                  doc.import_low_quality_attempts_meta &&
                  typeof doc.import_low_quality_attempts_meta === "object" &&
                  !Array.isArray(doc.import_low_quality_attempts_meta)
                    ? { ...doc.import_low_quality_attempts_meta }
                    : {};

                const currentRequestId = String(importRequestId || doc.import_request_id || "").trim();
                const lastRequestId = String(metaObj[f] || "").trim();

                if (currentRequestId && lastRequestId !== currentRequestId) {
                  attemptsObj[f] = (Number(attemptsObj[f]) || 0) + 1;
                  metaObj[f] = currentRequestId;
                }

                doc.import_low_quality_attempts = attemptsObj;
                doc.import_low_quality_attempts_meta = metaObj;

                const attemptCount = Number(attemptsObj[f]) || 0;

                if (attemptCount >= LOW_QUALITY_MAX_ATTEMPTS) {
                  return { missing_reason: terminalReason, retryable: false, attemptCount };
                }

                return { missing_reason: r, retryable: true, attemptCount };
              };

              const ensureMissing = (field, reason, stage, message, retryable = true, source_attempted = "xai") => {
                const f = String(field || "").trim();
                if (!f) return;

                const missing_reason = String(reason || "missing");
                const terminal =
                  missing_reason === "not_disclosed" ||
                  missing_reason === "low_quality_terminal" ||
                  missing_reason === "not_found_terminal";

                if (!import_missing_fields.includes(f)) import_missing_fields.push(f);

                // Prefer final, terminal decisions over earlier seed placeholders.
                // This prevents "seed_from_company_url" from surviving after extractors run.
                const prevReason = String(import_missing_reason[f] || "").trim();
                if (!prevReason || terminal || prevReason === "seed_from_company_url") {
                  import_missing_reason[f] = missing_reason;
                }

                const entry = {
                  field: f,
                  missing_reason,
                  stage: String(stage || "unknown"),
                  source_attempted: String(source_attempted || ""),
                  retryable: Boolean(retryable),
                  terminal,
                  message: String(message || "missing"),
                };

                const existingIndex = import_warnings.findIndex((w) => w && typeof w === "object" && w.field === f);
                if (existingIndex >= 0) import_warnings[existingIndex] = entry;
                else import_warnings.push(entry);
              };

              // company_name (required)
              if (!String(doc.company_name || "").trim()) {
                doc.company_name = "Unknown";
                doc.company_name_unknown = true;
                ensureMissing("company_name", "missing", "primary", "company_name missing; set to placeholder 'Unknown'", false);
              }

              // website_url (required)
              if (!String(doc.website_url || "").trim()) {
                doc.website_url = "Unknown";
                doc.website_url_unknown = true;
                if (!String(doc.normalized_domain || "").trim()) doc.normalized_domain = "unknown";
                if (!String(doc.partition_key || "").trim()) doc.partition_key = doc.normalized_domain;
                ensureMissing("website_url", "missing", "primary", "website_url missing; set to placeholder 'Unknown'", false);
              }

              // industries (required) — quality gate
              const industriesRaw = Array.isArray(doc.industries) ? doc.industries : [];
              const industriesSanitized = sanitizeIndustries(industriesRaw);

              if (industriesSanitized.length === 0) {
                const hadAny = normalizeStringArray(industriesRaw).length > 0;
                doc.industries = ["Unknown"];
                doc.industries_unknown = true;

                const policy = applyLowQualityPolicy("industries", hadAny ? "low_quality" : "not_found");
                const messageBase = hadAny
                  ? "Industries present but low-quality (navigation/marketplace buckets); set to placeholder ['Unknown']"
                  : "Industries missing; set to placeholder ['Unknown']";

                const message =
                  policy.missing_reason === "low_quality_terminal"
                    ? `${messageBase} (terminal after ${policy.attemptCount || LOW_QUALITY_MAX_ATTEMPTS} attempts)`
                    : messageBase;

                ensureMissing("industries", policy.missing_reason, "extract_industries", message, policy.retryable);
              } else {
                doc.industries = industriesSanitized;
              }

              // keywords/product_keywords (required) — sanitize + quality gate
              if (!Array.isArray(doc.keywords)) doc.keywords = [];

              const keywordStats = sanitizeKeywords({
                product_keywords: doc.product_keywords,
                keywords: doc.keywords,
              });

              const meetsKeywordQuality = keywordStats.total_raw >= 20 && keywordStats.product_relevant_count >= 10;

              if (meetsKeywordQuality) {
                doc.keywords = keywordStats.sanitized;
                doc.product_keywords = keywordStats.sanitized.join(", ");
                doc.product_keywords_unknown = false;
              } else {
                const hadAny = keywordStats.total_raw > 0;
                doc.keywords = keywordStats.sanitized;
                doc.product_keywords = "Unknown";
                doc.product_keywords_unknown = true;

                const policy = applyLowQualityPolicy("product_keywords", hadAny ? "low_quality" : "not_found");
                const messageBase = hadAny
                  ? `product_keywords low quality (raw=${keywordStats.total_raw}, sanitized=${keywordStats.product_relevant_count}); set to placeholder 'Unknown'`
                  : "product_keywords missing; set to placeholder 'Unknown'";

                const message =
                  policy.missing_reason === "low_quality_terminal"
                    ? `${messageBase} (terminal after ${policy.attemptCount || LOW_QUALITY_MAX_ATTEMPTS} attempts)`
                    : messageBase;

                ensureMissing("product_keywords", policy.missing_reason, "extract_keywords", message, policy.retryable);
              }

              // tagline (required)
              const taglineMeaningful = asMeaningful(doc.tagline);
              if (!taglineMeaningful) {
                doc.tagline = "Unknown";
                doc.tagline_unknown = true;
                ensureMissing("tagline", "not_found", "extract_tagline", "tagline missing; set to placeholder 'Unknown'");
              }

              // headquarters_location (required)
              if (!isRealValue("headquarters_location", doc.headquarters_location, doc)) {
                const hqReasonRaw = String(doc.hq_unknown_reason || "unknown").trim().toLowerCase();
                const hqValueRaw = String(doc.headquarters_location || "").trim().toLowerCase();
                const hqNotDisclosed =
                  hqReasonRaw === "not_disclosed" || hqValueRaw === "not disclosed" || hqValueRaw === "not_disclosed";

                doc.hq_unknown = true;

                if (hqNotDisclosed) {
                  doc.headquarters_location = "Not disclosed";
                  doc.hq_unknown_reason = "not_disclosed";
                  ensureMissing(
                    "headquarters_location",
                    "not_disclosed",
                    "extract_hq",
                    "headquarters_location missing; recorded as terminal sentinel 'Not disclosed'",
                    false
                  );
                } else {
                  doc.headquarters_location = "Not disclosed";
                  doc.hq_unknown_reason = "not_disclosed";
                  ensureMissing(
                    "headquarters_location",
                    "not_disclosed",
                    "extract_hq",
                    "headquarters_location missing; recorded as terminal sentinel 'Not disclosed'",
                    false
                  );
                }
              }

              // manufacturing_locations (required)
              // Ordering fix: decide the final terminal sentinel first ("Not disclosed") and then generate warnings from that.
              // Never emit "seed_from_company_url" after extractors have run.
              {
                const rawList = Array.isArray(doc.manufacturing_locations)
                  ? doc.manufacturing_locations
                  : doc.manufacturing_locations == null
                    ? []
                    : [doc.manufacturing_locations];

                const normalized = rawList
                  .map((loc) => {
                    if (typeof loc === "string") return String(loc).trim().toLowerCase();
                    if (loc && typeof loc === "object") {
                      return String(loc.formatted || loc.full_address || loc.address || loc.location || "")
                        .trim()
                        .toLowerCase();
                    }
                    return "";
                  })
                  .filter(Boolean);

                const hasNotDisclosed = normalized.length > 0 && normalized.every((v) => v === "not disclosed" || v === "not_disclosed");
                const hasUnknownPlaceholder = normalized.length > 0 && normalized.every((v) => v === "unknown");

                const hasRealMfg =
                  isRealValue("manufacturing_locations", doc.manufacturing_locations, doc) && !hasNotDisclosed && !hasUnknownPlaceholder;

                if (!hasRealMfg) {
                  doc.manufacturing_locations = ["Not disclosed"];
                  doc.manufacturing_locations_reason = "not_disclosed";
                  doc.mfg_unknown = true;
                  doc.mfg_unknown_reason = "not_disclosed";

                  ensureMissing(
                    "manufacturing_locations",
                    "not_disclosed",
                    "extract_mfg",
                    "manufacturing_locations missing; recorded as terminal sentinel ['Not disclosed']",
                    false
                  );
                }
              }

              // reviews (required fields can be empty, but must be explicitly set)
              if (!Array.isArray(doc.curated_reviews)) doc.curated_reviews = [];
              if (!Number.isFinite(Number(doc.review_count))) doc.review_count = doc.curated_reviews.length;
              if (!(doc.review_cursor && typeof doc.review_cursor === "object")) {
                doc.review_cursor = reviewCursorNormalized;
              }
              if (!String(doc.reviews_last_updated_at || "").trim()) doc.reviews_last_updated_at = nowIso;
              if (!(typeof doc.reviews_stage_status === "string" && doc.reviews_stage_status.trim())) {
                doc.reviews_stage_status = "pending";
              }

              // logo (required: ok OR explicit not_found)
              if (!String(doc.logo_url || "").trim()) {
                doc.logo_url = null;
                if (!String(doc.logo_status || "").trim()) doc.logo_status = "not_found_on_site";
                if (!String(doc.logo_import_status || "").trim()) doc.logo_import_status = "missing";
                if (!String(doc.logo_stage_status || "").trim()) doc.logo_stage_status = "not_found_on_site";
                ensureMissing("logo", String(doc.logo_status || "not_found"), "logo", "logo_url missing; persisted as explicit not_found");
              }

              // A compact checklist used by import-status (resume detection + UI).
              doc.import_missing_fields = import_missing_fields;
              doc.import_missing_reason = import_missing_reason;
              doc.import_warnings = import_warnings;

              // Back-compat field used by some tooling.
              doc.missing_fields = import_missing_fields
                .map((f) => {
                  if (f === "headquarters_location") return "hq";
                  if (f === "manufacturing_locations") return "mfg";
                  if (f === "website_url") return "website_url";
                  return f;
                })
                .filter(Boolean);
              doc.missing_fields_updated_at = nowIso;
            } catch {}

            try {
              const completeness = computeProfileCompleteness(doc);
              doc.profile_completeness = completeness.profile_completeness;
              doc.profile_completeness_version = completeness.profile_completeness_version;
              doc.profile_completeness_meta = completeness.profile_completeness_meta;
            } catch {}

            if (!doc.company_name && !doc.url) {
              return {
                type: "failed",
                index: companyIndex,
                company_name: companyName,
                error: "Missing company_name and url",
              };
            }

            if (shouldUpdateExisting && existingDoc) {
              const mergedDoc = mergeCompanyDocsForSessionExternal({
                existingDoc,
                incomingDoc: doc,
                finalNormalizedDomain,
              });

              const expectedPk = String(existingDoc?.normalized_domain || existingDoc?.partition_key || "").trim() || undefined;

              const enriched = await applyEnrichment({
                container,
                company_id: String(existingDoc.id),
                expected_partition_key: expectedPk,
                patch: mergedDoc,
                meta: {
                  stage: "save_companies_merge",
                  upstream: {
                    provider: "import-start",
                    summary: "mergeCompanyDocsForSession",
                  },
                },
              });

              if (!enriched?.ok) {
                try {
                  await upsertCosmosImportSessionDoc({
                    sessionId: sid,
                    requestId,
                    patch: {
                      enrichment_last_write_error: {
                        at: new Date().toISOString(),
                        company_id: String(existingDoc.id),
                        stage: "save_companies_merge",
                        root_cause: enriched?.root_cause || "enrichment_write_failed",
                        retryable: Boolean(enriched?.retryable),
                        expected_partition_key: enriched?.expected_partition_key || null,
                        actual_partition_key: enriched?.actual_partition_key || null,
                        error: enriched?.error || null,
                      },
                    },
                  }).catch(() => null);
                } catch {}

                throw new Error(enriched?.error || enriched?.root_cause || "enrichment_write_failed");
              }

              return {
                type: "updated",
                index: companyIndex,
                id: String(existingDoc.id),
                company_name: companyName,
                normalized_domain: String(existingDoc?.normalized_domain || finalNormalizedDomain || ""),
              };
            }

            // Seed write: include an enrichment event so the persisted company doc always contains
            // a durable trace even if later stages cannot run.
            doc.enrichment_version = 1;
            doc.enrichment_updated_at = nowIso;
            doc.enrichment_events = [
              {
                stage: "seed_save",
                started_at: nowIso,
                ended_at: nowIso,
                ok: true,
                root_cause: null,
                retryable: false,
                fields_written: [
                  "company_name",
                  "website_url",
                  "normalized_domain",
                  "logo_url",
                  "headquarters_location",
                  "manufacturing_locations",
                  "industries",
                  "product_keywords",
                  "tagline",
                  "curated_reviews",
                  "review_count",
                  "import_missing_fields",
                ],
              },
            ];

            const upsertRes = await upsertItemWithPkCandidates(container, doc);
            if (!upsertRes?.ok) {
              throw new Error(upsertRes?.error || "upsert_failed");
            }

            return {
              type: "saved",
              index: companyIndex,
              id: companyId,
              company_name: companyName,
              normalized_domain: finalNormalizedDomain,
            };
          } catch (e) {
            const statusCode = Number(e?.code || e?.statusCode || e?.status || 0);
            if (statusCode === 409) {
              return {
                type: "skipped",
                index: companyIndex,
                company_name: companyName,
                duplicate_of_id: null,
                duplicate_match_key: null,
                duplicate_match_value: null,
              };
            }

            return {
              type: "failed",
              index: companyIndex,
              company_name: companyName,
              error: e?.message ? String(e.message) : String(e || "save_failed"),
            };
          }
        })
      );

      // Process batch results
      for (const result of batchResults) {
        if (!result || typeof result !== "object") continue;

        if (result.type === "skipped_stub") {
          skipped++;
          skipped_duplicates.push({
            index: Number.isFinite(Number(result.index)) ? Number(result.index) : null,
            company_name: String(result.company_name || ""),
            duplicate_of_id: null,
            duplicate_match_key: "skipped_stub",
            duplicate_match_value: result.reason || "missing_enrichment",
          });
          continue;
        }

        if (result.type === "skipped") {
          skipped++;
          if (result.duplicate_of_id) skipped_ids.push(result.duplicate_of_id);
          skipped_duplicates.push({
            index: Number.isFinite(Number(result.index)) ? Number(result.index) : null,
            company_name: String(result.company_name || ""),
            duplicate_of_id: result.duplicate_of_id || null,
            duplicate_match_key: result.duplicate_match_key || null,
            duplicate_match_value: result.duplicate_match_value || null,
          });
          continue;
        }

        if (result.type === "saved" || result.type === "updated") {
          saved++;
          if (result.id) {
            saved_ids.push(result.id);
            persisted_items.push({
              type: result.type,
              index: Number.isFinite(Number(result.index)) ? Number(result.index) : null,
              id: String(result.id),
              company_name: String(result.company_name || ""),
              normalized_domain: String(result.normalized_domain || ""),
            });
          }
          continue;
        }

        if (result.type === "failed") {
          failed++;
          failed_items.push({
            index: Number.isFinite(Number(result.index)) ? Number(result.index) : null,
            company_name: result.company_name || "",
            error: result.error || "save_failed",
          });
          console.warn(`[import-start] Failed to save company: ${result.error || "save_failed"}`);
        }
      }
    }

    return { saved, failed, skipped, saved_ids, skipped_ids, skipped_duplicates, failed_items, persisted_items };
  } catch (e) {
    console.error("[import-start] Error in saveCompaniesToCosmos:", e.message);
    return {
      saved: 0,
      failed: Array.isArray(companies) ? companies.length : 0,
      skipped: 0,
      saved_ids: [],
      skipped_ids: [],
      skipped_duplicates: [],
      failed_items: [{ index: null, company_name: "", error: e?.message || String(e || "save_failed") }],
    };
  }
}

// Max time to spend processing (5 minutes)
const MAX_PROCESSING_TIME_MS = 5 * 60 * 1000;

const importStartHandlerInner = async (req, context) => {
    const requestId = generateRequestId(req);
    const responseHeaders = { "x-request-id": requestId };

    const buildInfo = getBuildInfo();
    const handlerVersion = getImportStartHandlerVersion(buildInfo);

    const internalSecretInfo = (() => {
      try {
        return getInternalJobSecretInfo();
      } catch {
        return { secret: "", secret_source: null };
      }
    })();

    const acceptableSecretsInfo = (() => {
      try {
        return getAcceptableInternalSecretsInfo();
      } catch {
        return [];
      }
    })();

    // internal_auth_configured should be true if ANY accepted secret exists
    // (e.g. X_INTERNAL_JOB_SECRET OR FUNCTION_KEY), not only when the secret source is X_INTERNAL_JOB_SECRET.
    const internalAuthConfigured = Array.isArray(acceptableSecretsInfo) && acceptableSecretsInfo.length > 0;

    const gatewayKeyConfigured = Boolean(String(process.env.FUNCTION_KEY || "").trim());
    const internalJobSecretConfigured = Boolean(String(process.env.X_INTERNAL_JOB_SECRET || "").trim());

    const buildResumeAuthDiagnostics = () => ({
      gateway_key_configured: gatewayKeyConfigured,
      internal_job_secret_configured: internalJobSecretConfigured,
      acceptable_secret_sources: Array.isArray(acceptableSecretsInfo) ? acceptableSecretsInfo.map((c) => c.source) : [],
      internal_secret_source: internalSecretInfo?.secret_source || null,
    });

    const buildResumeStallError = () => {
      const missingGatewayKey = !gatewayKeyConfigured;
      const missingInternalSecret = !internalJobSecretConfigured;

      const root_cause = missingGatewayKey
        ? missingInternalSecret
          ? "missing_gateway_key_and_internal_secret"
          : "missing_gateway_key"
        : "missing_internal_secret";

      const message = missingGatewayKey
        ? "Missing FUNCTION_KEY; Azure gateway auth (x-functions-key) is not configured, so resume-worker calls can be rejected before JS runs."
        : "Missing X_INTERNAL_JOB_SECRET; internal handler auth is not configured for resume-worker calls.";

      return {
        code: missingGatewayKey
          ? missingInternalSecret
            ? "resume_worker_gateway_401_missing_gateway_key_and_internal_secret"
            : "resume_worker_gateway_401_missing_gateway_key"
          : "resume_worker_gateway_401_missing_internal_secret",
        root_cause,
        missing_gateway_key: missingGatewayKey,
        missing_internal_secret: missingInternalSecret,
        message,
      };
    };

    const jsonWithRequestId = (obj, status = 200) => {
      const payload =
        obj && typeof obj === "object" && !Array.isArray(obj)
          ? { handler_version: handlerVersion, ...obj }
          : { handler_version: handlerVersion, value: obj };

      if (typeof sessionId === "string" && sessionId.trim()) {
        if (!Object.prototype.hasOwnProperty.call(payload, "session_id")) {
          payload.session_id = sessionId;
        }
        responseHeaders["x-session-id"] = sessionId;
      }

      if (sessionIdOverride && typeof sessionIdOriginal === "string") {
        payload.session_id_override = true;
        payload.session_id_original = sessionIdOriginal;
        payload.session_id_canonical = sessionId;
      }

      return json(payload, status, responseHeaders);
    };

    const diagnosticsEnabled = isDebugDiagnosticsEnabled(req);
    const stageTrace = [{ stage: "init", ts: new Date().toISOString() }];
    const contextInfo = {
      company_name: "",
      website_url: "",
      normalized_domain: "",
      xai_request_id: null,
    };

    let sessionId = "";
    let sessionIdOriginal = "";
    let sessionIdOverride = false;

    let stage = "init";
    let debugEnabled = false;
    let debugOutput = null;
    let enrichedForCounts = [];
    let primaryXaiOutboundBody = "";

    let sessionCreatedAtIso = null;

    // If we successfully write at least one company but a later stage fails,
    // we return 200 with warnings instead of a hard 500.
    let saveReport = null;

    const warningKeys = new Set();
    const warnings_detail = {};
    const warnings_v2 = [];

    const addWarning = (key, detail) => {
      const warningKey = String(key || "").trim();
      if (!warningKey) return;
      warningKeys.add(warningKey);

      const d = detail && typeof detail === "object" ? detail : { message: String(detail || "") };

      if (!warnings_detail[warningKey]) {
        warnings_detail[warningKey] = {
          stage: String(d.stage || warningKey),
          root_cause: String(d.root_cause || "unknown"),
          retryable: typeof d.retryable === "boolean" ? d.retryable : true,
          upstream_status: d.upstream_status ?? null,
          message: String(d.message || "").trim(),
          company_name: d.company_name ? String(d.company_name) : undefined,
          website_url: d.website_url ? String(d.website_url) : undefined,
        };
      }

      warnings_v2.push({
        stage: String(d.stage || ""),
        root_cause: String(d.root_cause || "unknown"),
        retryable: typeof d.retryable === "boolean" ? d.retryable : true,
        upstream_status: d.upstream_status ?? null,
        message: String(d.message || "").trim(),
        company_name: d.company_name ? String(d.company_name) : undefined,
        website_url: d.website_url ? String(d.website_url) : undefined,
      });
    };

    const warnReviews = (detail) => addWarning("reviews_failed", detail);

    let stage_beacon = "init";
    let stage_reached = null;

    const mark = (s) => {
      stage_beacon = String(s || "unknown") || "unknown";

      if (/_done$/.test(stage_beacon)) {
        stage_reached = `after_${stage_beacon.replace(/_done$/, "")}`;
      }

      try {
        upsertImportSession({
          session_id: sessionId,
          request_id: requestId,
          status: "running",
          stage_beacon,
          companies_count: Array.isArray(enrichedForCounts) ? enrichedForCounts.length : 0,
        });
      } catch {}

      try {
        console.log("[import-start] stage", { stage: stage_beacon, request_id: requestId, session_id: sessionId });
      } catch {
        console.log("[import-start] stage", { stage: stage_beacon });
      }
    };

    console.log(`[import-start] request_id=${requestId} Function handler invoked`);

    try {
      const method = String(req.method || "").toUpperCase();
      if (method === "OPTIONS") {
        return {
          status: 200,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            "Access-Control-Allow-Headers":
              "content-type,authorization,x-functions-key,x-request-id,x-correlation-id,x-session-id,x-client-request-id",
            "Access-Control-Expose-Headers": "x-request-id,x-correlation-id,x-session-id",
            ...responseHeaders,
          },
        };
      }

      const pingRaw = readQueryParam(req, "ping");
      if (String(pingRaw || "").trim() === "1") {
        const route = (() => {
          try {
            const rawUrl = typeof req.url === "string" ? req.url : "";
            const pathname = rawUrl ? new URL(rawUrl, "http://localhost").pathname : "";
            const normalized = pathname.replace(/^\/+/, "");
            if (normalized.endsWith("import-start")) return "import-start";
            return "import/start";
          } catch {
            return "import/start";
          }
        })();

        return json(
          {
            ok: true,
            route,
            handler_version: handlerVersion,
            build_id: String(buildInfo?.build_id || "unknown"),
          },
          200,
          responseHeaders
        );
      }

      if (method === "GET") {
        return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405, responseHeaders);
      }

      let payload;
      let body_source = "unknown";
      let body_source_detail = "";
      let raw_text_preview = null;
      let raw_text_starts_with_brace = false;
      let requestDetails = null;

      try {
        const parsed = await readJsonBody(req);
        payload = parsed.body;
        body_source = parsed.body_source || "unknown";
        body_source_detail = parsed.body_source_detail || "";
        raw_text_preview = typeof parsed?.raw_text_preview === "string" ? parsed.raw_text_preview : null;
        raw_text_starts_with_brace = Boolean(parsed?.raw_text_starts_with_brace);
        requestDetails = buildRequestDetails(req, {
          body_source,
          body_source_detail,
          raw_text_preview,
          raw_text_starts_with_brace,
        });
      } catch (err) {
        if (err?.code === "INVALID_JSON_BODY") {
          const rawPreview = String(err?.raw_text_preview || err?.raw_body_preview || "");
          const extractedSessionId = (() => {
            if (!rawPreview) return "";
            const match = rawPreview.match(/"session_id"\s*:\s*"([^"]+)"/);
            return match && match[1] ? String(match[1]) : "";
          })();

          sessionIdOriginal = extractedSessionId;
          const canonicalCandidate = String(extractedSessionId || "").trim();
          if (sessionIdOriginal && canonicalCandidate !== sessionIdOriginal) sessionIdOverride = true;
          sessionId = canonicalCandidate || `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          if (sessionIdOriginal && !canonicalCandidate) sessionIdOverride = true;

          responseHeaders["x-session-id"] = sessionId;

          const buildInfo = getBuildInfo();

          body_source = err?.body_source || "unknown";
          body_source_detail = err?.body_source_detail || "";

          try {
            console.error(
              "[import-start] INVALID_JSON_BODY",
              JSON.stringify({
                request_id: requestId,
                content_type: err?.content_type || getHeader(req, "content-type") || null,
                body_type: err?.body_type || typeof req?.body,
                is_body_object:
                  typeof err?.is_body_object === "boolean"
                    ? err.is_body_object
                    : Boolean(req?.body && typeof req.body === "object" && !Array.isArray(req.body)),
                body_keys_preview: err?.body_keys_preview || getBodyKeysPreview(req?.body),
                body_source,
                body_source_detail,
                raw_text_preview: err?.raw_text_preview || err?.raw_body_preview || null,
                raw_text_hex_preview: err?.raw_text_hex_preview || null,
              })
            );
          } catch {
            console.error("[import-start] INVALID_JSON_BODY");
          }

          const error_id = makeErrorId();
          logImportStartErrorLine({
            error_id,
            stage_beacon: "validate_request",
            root_cause: "invalid_request",
            err,
          });

          return jsonWithRequestId(
            {
              ok: false,
              stage: "validate_request",
              stage_beacon: "validate_request",
              root_cause: "invalid_request",
              retryable: false,
              http_status: 400,
              error_id,
              session_id: sessionId,
              request_id: requestId,
              error: {
                code: "INVALID_JSON_BODY",
                message: "Invalid JSON body",
                request_id: requestId,
                step: "validate_request",
              },
              legacy_error: "Invalid JSON body",
              ...buildInfo,
              company_name: "",
              website_url: "",
              normalized_domain: "",
              xai_request_id: null,
              details: {
                ...buildRequestDetails(req, {
                  body_source,
                  body_source_detail,
                  raw_text_preview: err?.raw_text_preview || err?.raw_body_preview || null,
                  raw_text_starts_with_brace: /^\s*\{/.test(String(err?.raw_text_preview || err?.raw_body_preview || "")),
                }),
                code: "INVALID_JSON_BODY",
                message: "Invalid JSON body",
                body_type: err?.body_type || typeof req?.body,
                is_body_object:
                  typeof err?.is_body_object === "boolean"
                    ? err.is_body_object
                    : Boolean(req?.body && typeof req.body === "object" && !Array.isArray(req.body)),
                raw_text_hex_preview: err?.raw_text_hex_preview || null,

                // Back-compat.
                raw_body_preview: err?.raw_text_preview || err?.raw_body_preview || null,
              },
              ...(diagnosticsEnabled
                ? {
                    diagnostics: {
                      handler_reached: true,
                      stage_trace: stageTrace,
                      ...buildBodyDiagnostics(req, {
                        body_source,
                        ...(body_source_detail ? { body_source_detail } : {}),
                        parse_error: err?.parse_error || null,
                        first_bytes_preview: err?.first_bytes_preview || null,
                        raw_text_preview: err?.raw_text_preview || err?.raw_body_preview || null,
                        raw_text_hex_preview: err?.raw_text_hex_preview || null,
                        raw_body_preview: err?.raw_text_preview || err?.raw_body_preview || null,
                      }),
                    },
                  }
                : {}),
            },
            200
          );
        }
        throw err;
      }

      const proxyQuery = readQueryParam(req, "proxy");
      if (!Object.prototype.hasOwnProperty.call(payload || {}, "proxy") && proxyQuery !== undefined) {
        payload.proxy = proxyQuery;
      }

      const bodyObj = payload && typeof payload === "object" ? payload : {};

      const hasBodySessionId = Boolean(bodyObj && typeof bodyObj === "object" && Object.prototype.hasOwnProperty.call(bodyObj, "session_id"));
      const bodySessionIdValue = hasBodySessionId ? bodyObj.session_id : undefined;

      const parsedSessionIdFromText = (() => {
        if (typeof payload !== "string" || !payload) return "";
        const match = payload.match(/"session_id"\s*:\s*"([^"]+)"/);
        return match && match[1] ? String(match[1]) : "";
      })();

      const headerSessionIdRaw = String(getHeader(req, "x-session-id") || "");

      if (hasBodySessionId) {
        sessionIdOriginal = String(bodySessionIdValue ?? "");
      } else if (parsedSessionIdFromText) {
        sessionIdOriginal = parsedSessionIdFromText;
      } else if (headerSessionIdRaw) {
        sessionIdOriginal = headerSessionIdRaw;
      } else {
        sessionIdOriginal = "";
      }

      const canonicalCandidate = String(sessionIdOriginal || "").trim();
      if (sessionIdOriginal && canonicalCandidate !== sessionIdOriginal) sessionIdOverride = true;
      if (hasBodySessionId && !canonicalCandidate) sessionIdOverride = true;

      sessionId = canonicalCandidate || `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      responseHeaders["x-session-id"] = sessionId;
      bodyObj.session_id = sessionId;

      try {
        upsertImportSession({
          session_id: sessionId,
          request_id: requestId,
          status: "running",
          stage_beacon,
          companies_count: 0,
        });
      } catch {}

      const hasQueryTypeField =
        Object.prototype.hasOwnProperty.call(bodyObj, "queryType") || Object.prototype.hasOwnProperty.call(bodyObj, "query_type");
      const hasQueryTypesField =
        Object.prototype.hasOwnProperty.call(bodyObj, "queryTypes") || Object.prototype.hasOwnProperty.call(bodyObj, "query_types");
      const ambiguousQueryTypeFields = hasQueryTypeField && hasQueryTypesField;

      const rawQueryTypes =
        bodyObj.queryTypes !== undefined ? bodyObj.queryTypes : bodyObj.query_types !== undefined ? bodyObj.query_types : undefined;
      const rawQueryType =
        bodyObj.queryType !== undefined ? bodyObj.queryType : bodyObj.query_type !== undefined ? bodyObj.query_type : undefined;

      const startTime = Date.now();

      const normalizedQuery = String(bodyObj.query || "").trim();
      const normalizedLocation = String(bodyObj.location || "").trim();
      const normalizedLimit = Math.max(1, Math.min(25, Math.trunc(Number(bodyObj.limit) || 1)));

      const queryTypesProvided = rawQueryTypes !== undefined && rawQueryTypes !== null;
      const queryTypesRaw = Array.isArray(rawQueryTypes) ? rawQueryTypes : [];

      const queryTypes = queryTypesRaw
        .map((t) => String(t || "").trim())
        .filter(Boolean)
        .slice(0, 10);

      const queryLooksLikeUrl = looksLikeCompanyUrlQuery(normalizedQuery);

      let normalizedQueryType = String(rawQueryType || queryTypes[0] || "product_keyword").trim() || "product_keyword";
      if (queryLooksLikeUrl && queryTypes.includes("company_url")) {
        normalizedQueryType = "company_url";
      }

      bodyObj.query = normalizedQuery;
      bodyObj.location = normalizedLocation || "";
      bodyObj.limit = normalizedLimit;
      bodyObj.queryType = normalizedQueryType;
      bodyObj.queryTypes = queryTypes.length > 0 ? queryTypes : [normalizedQueryType];

      const existingRequestId = String(bodyObj.request_id || bodyObj.requestId || "").trim();
      bodyObj.request_id = existingRequestId || requestId;
      bodyObj.requestId = bodyObj.request_id;

      if (queryLooksLikeUrl && bodyObj.queryTypes.includes("company_url")) {
        bodyObj.queryType = "company_url";
      }

      console.log(
        `[import-start] request_id=${requestId} session=${sessionId} normalized_request=` +
          JSON.stringify({
            session_id: sessionId,
            query_len: normalizedQuery.length,
            queryType: bodyObj.queryType,
            queryTypes: bodyObj.queryTypes,
            location_len: normalizedLocation.length,
            limit: normalizedLimit,
            proxy: Object.prototype.hasOwnProperty.call(bodyObj, "proxy") ? bodyObj.proxy : undefined,
          })
      );

      debugEnabled = bodyObj.debug === true || bodyObj.debug === "true";
      debugOutput = debugEnabled
        ? {
            xai: {
              payload: null,
              prompt_len: 0,
              raw_response: null,
              parse_error: null,
              parsed_companies: 0,
            },
            keywords_debug: [],
            reviews_debug: [],
            stages: [],
          }
        : null;

      contextInfo.company_name = String(payload?.company_name ?? "").trim();
      contextInfo.website_url = String(payload?.website_url ?? "").trim();
      contextInfo.normalized_domain = String(payload?.normalized_domain ?? "").trim();
      contextInfo.xai_request_id = null;
      enrichedForCounts = [];

      const setStage = (nextStage, extra = {}) => {
        stage = String(nextStage || "unknown");

        if (extra && typeof extra === "object") {
          if (typeof extra.company_name === "string") contextInfo.company_name = extra.company_name;
          if (typeof extra.website_url === "string") contextInfo.website_url = extra.website_url;
          if (typeof extra.normalized_domain === "string") contextInfo.normalized_domain = extra.normalized_domain;
          if (typeof extra.xai_request_id === "string") contextInfo.xai_request_id = extra.xai_request_id;
        }

        if (diagnosticsEnabled) {
          stageTrace.push({ stage, ts: new Date().toISOString(), ...extra });
        }

        if (debugOutput) {
          debugOutput.stages.push({ stage, ts: new Date().toISOString(), ...extra });
        }

        try {
          const extraKeys = extra && typeof extra === "object" ? Object.keys(extra) : [];
          if (extraKeys.length > 0) {
            console.log(
              `[import-start] request_id=${requestId} session=${sessionId} stage=${stage} extra=` +
                JSON.stringify(extra)
            );
          } else {
            console.log(`[import-start] request_id=${requestId} session=${sessionId} stage=${stage}`);
          }
        } catch {
          console.log(`[import-start] request_id=${requestId} session=${sessionId} stage=${stage}`);
        }
      };

      const noUpstreamMode = String(readQueryParam(req, "no_upstream") || "").trim() === "1";
      const noCosmosMode = String(readQueryParam(req, "no_cosmos") || "").trim() === "1";
      const cosmosEnabled = !noCosmosMode;

      let cosmosTargetDiagnostics = null;
      if (cosmosEnabled) {
        cosmosTargetDiagnostics = await getCompaniesCosmosTargetDiagnostics().catch(() => null);

        if (debugOutput && cosmosTargetDiagnostics) {
          debugOutput.cosmos_target = cosmosTargetDiagnostics;
        }

        if (cosmosTargetDiagnostics) {
          try {
            console.log("[import-start] cosmos_target", {
              request_id: requestId,
              session_id: sessionId,
              ...cosmosTargetDiagnostics,
            });
          } catch {}
        }
      }

      const inline_budget_ms = Number(STAGE_MAX_MS?.primary) || DEFAULT_UPSTREAM_TIMEOUT_MS;

      const requestedDeadlineRaw = readQueryParam(req, "deadline_ms");
      const requested_deadline_ms_number =
        Number.isFinite(Number(requestedDeadlineRaw)) && Number(requestedDeadlineRaw) > 0
          ? Number(requestedDeadlineRaw)
          : null;

      const requested_deadline_ms = requested_deadline_ms_number
        ? Math.max(5_000, Math.min(requested_deadline_ms_number, DEFAULT_HARD_TIMEOUT_MS))
        : DEFAULT_HARD_TIMEOUT_MS;

      const budget = startBudget({
        hardCapMs: DEFAULT_HARD_TIMEOUT_MS,
        clientDeadlineMs: requested_deadline_ms,
        startedAtMs: Date.now(),
      });

      const deadlineMs = budget.deadlineMs;

      const stageMsPrimaryRaw = readQueryParam(req, "stage_ms_primary");
      const requested_stage_ms_primary =
        Number.isFinite(Number(stageMsPrimaryRaw)) && Number(stageMsPrimaryRaw) > 0 ? Number(stageMsPrimaryRaw) : null;

      const requested_stage_ms_primary_effective = requested_stage_ms_primary
        ? Math.max(5_000, Math.min(requested_stage_ms_primary, requested_deadline_ms))
        : requested_deadline_ms;

      const allowedStages = ["primary", "keywords", "reviews", "location", "expand"];
      const stageOrder = new Map(allowedStages.map((s, i) => [s, i]));

      const parseStageParam = (raw) => {
        const v = String(raw || "").trim().toLowerCase();
        if (!v) return null;
        return allowedStages.includes(v) ? v : "__invalid__";
      };

      const maxStageRaw = readQueryParam(req, "max_stage");
      const skipStagesRaw = readQueryParam(req, "skip_stages");

      const dryRunRaw =
        Object.prototype.hasOwnProperty.call(bodyObj, "dry_run")
          ? bodyObj.dry_run
          : Object.prototype.hasOwnProperty.call(bodyObj, "dryRun")
            ? bodyObj.dryRun
            : readQueryParam(req, "dry_run");

      const dryRunRequested =
        dryRunRaw === true ||
        dryRunRaw === 1 ||
        dryRunRaw === "1" ||
        String(dryRunRaw || "")
          .trim()
          .toLowerCase() === "true";

      bodyObj.dry_run = dryRunRequested;
      bodyObj.dryRun = dryRunRequested;

      try {
        console.log("[import-start] received_query_params", {
          deadline_ms: requested_deadline_ms_number,
          stage_ms_primary: requested_stage_ms_primary,
          max_stage: typeof maxStageRaw === "string" ? maxStageRaw : null,
          skip_stages: typeof skipStagesRaw === "string" ? skipStagesRaw : null,
          dry_run: dryRunRequested,
        });
      } catch {}

      const maxStageParsed = parseStageParam(maxStageRaw);
      const skipStagesList = String(skipStagesRaw || "")
        .split(",")
        .map((s) => String(s || "").trim().toLowerCase())
        .filter(Boolean);

      if (maxStageParsed === "__invalid__") {
        const error_id = makeErrorId();
        logImportStartErrorLine({
          error_id,
          stage_beacon,
          root_cause: "invalid_request",
          err: new Error("Invalid max_stage"),
        });

        return jsonWithRequestId(
          {
            ok: false,
            stage: "import_start",
            root_cause: "invalid_request",
            retryable: false,
            http_status: 400,
            error_id,
            session_id: sessionId,
            request_id: requestId,
            stage_beacon,
            error_message: "Invalid max_stage. Expected one of: primary,keywords,reviews,location,expand",
          },
          200
        );
      }

      const skipStages = new Set();
      for (const s of skipStagesList) {
        const parsed = parseStageParam(s);
        if (parsed === "__invalid__") {
          const error_id = makeErrorId();
          logImportStartErrorLine({
            error_id,
            stage_beacon,
            root_cause: "invalid_request",
            err: new Error("Invalid skip_stages"),
          });

          return jsonWithRequestId(
            {
              ok: false,
              stage: "import_start",
              root_cause: "invalid_request",
              retryable: false,
              http_status: 400,
              error_id,
              session_id: sessionId,
              request_id: requestId,
              stage_beacon,
              error_message: "Invalid skip_stages. Expected comma-separated list from: primary,keywords,reviews,location,expand",
            },
            200
          );
        }
        if (parsed) skipStages.add(parsed);
      }

      const maxStage = maxStageParsed;

      try {
        console.log("[import-start] normalized_effective_request", {
          request_id: requestId,
          session_id: sessionId,
          query: normalizedQuery,
          queryTypes: Array.isArray(bodyObj.queryTypes) ? bodyObj.queryTypes : [],
          location: bodyObj.location,
          limit: bodyObj.limit,
          max_stage: maxStage,
          skip_stages: Array.from(skipStages),
          dry_run: dryRunRequested,
          companies_seeded: Array.isArray(bodyObj.companies) ? bodyObj.companies.length : 0,
        });
      } catch {}

      const providedCompaniesRaw = Array.isArray(bodyObj.companies) ? bodyObj.companies : [];
      const providedCompanies = providedCompaniesRaw.filter((c) => c && typeof c === "object");

      const isMeaningfulString = (raw) => {
        const s = String(raw ?? "").trim();
        if (!s) return false;
        const lower = s.toLowerCase();
        if (lower === "unknown" || lower === "n/a" || lower === "na" || lower === "none") return false;
        return true;
      };

      const hasMeaningfulSeedEnrichment = (c) => {
        if (!c || typeof c !== "object") return false;

        const industries = Array.isArray(c.industries) ? c.industries.filter(Boolean) : [];

        const keywordsRaw = c.keywords ?? c.product_keywords ?? c.keyword_list;
        const keywords =
          typeof keywordsRaw === "string"
            ? keywordsRaw.split(/\s*,\s*/g).filter(Boolean)
            : Array.isArray(keywordsRaw)
              ? keywordsRaw.filter(Boolean)
              : [];

        const manufacturingLocations = Array.isArray(c.manufacturing_locations)
          ? c.manufacturing_locations
              .map((loc) => {
                if (typeof loc === "string") return loc.trim();
                if (loc && typeof loc === "object") return String(loc.formatted || loc.address || loc.location || "").trim();
                return "";
              })
              .filter(Boolean)
          : [];

        const curatedReviews = Array.isArray(c.curated_reviews) ? c.curated_reviews.filter((r) => r && typeof r === "object") : [];
        const reviewCount = Number.isFinite(Number(c.review_count)) ? Number(c.review_count) : curatedReviews.length;

        return (
          industries.length > 0 ||
          keywords.length > 0 ||
          isMeaningfulString(c.headquarters_location) ||
          manufacturingLocations.length > 0 ||
          curatedReviews.length > 0 ||
          reviewCount > 0
        );
      };

      const isValidSeedCompany = (c) => {
        if (!c || typeof c !== "object") return false;

        const companyName = String(c.company_name || c.name || "").trim();
        const websiteUrl = String(c.website_url || c.url || c.canonical_url || "").trim();
        if (!companyName || !websiteUrl) return false;

        const id = String(c.id || c.company_id || c.companyId || "").trim();

        // Rule: if we already persisted a company doc (id exists), we can resume enrichment for it.
        if (id && !id.startsWith("_import_")) return true;

        const source = String(c.source || "").trim();

        // Critical: company_url_shortcut is NEVER a valid resume seed unless it already contains meaningful enrichment
        // (keywords/industries/HQ/MFG/reviews) or carries an explicit seed_ready marker.
        if (source === "company_url_shortcut") {
          if (c.seed_ready === true) return true;
          return hasMeaningfulSeedEnrichment(c);
        }

        if (source) return true;

        // Fallback: allow explicit markers that the seed came from primary.
        if (c.primary_candidate === true) return true;
        if (c.seed === true) return true;
        if (String(c.source_stage || "").trim() === "primary") return true;

        return false;
      };

      const validSeedCompanies = providedCompanies.filter(isValidSeedCompany);

      // If we're skipping primary, we must have at least one VALID seed company.
      const skipsPrimaryWithoutAnyCompanies = skipStages.has("primary") && providedCompanies.length === 0;
      const skipsPrimaryWithoutValidSeed = skipStages.has("primary") && providedCompanies.length > 0 && validSeedCompanies.length === 0;

      if (skipsPrimaryWithoutAnyCompanies) {
        const error_id = makeErrorId();
        logImportStartErrorLine({
          error_id,
          stage_beacon,
          root_cause: "missing_seed_companies",
          err: new Error("skip_stages includes primary but no companies were provided"),
        });

        // Guardrail: never proceed past primary unless we have a seeded companies list.
        return jsonWithRequestId(
          {
            ok: false,
            stage: "import_start",
            stage_beacon,
            root_cause: "missing_seed_companies",
            retryable: true,
            http_status: 409,
            error_id,
            message: "skip_stages includes primary but no companies were provided",
            session_id: sessionId,
            request_id: requestId,
          },
          200
        );
      }

      if (skipsPrimaryWithoutValidSeed) {
        const error_id = makeErrorId();
        logImportStartErrorLine({
          error_id,
          stage_beacon,
          root_cause: "invalid_seed_companies",
          err: new Error("resume requested but seed companies are not valid"),
        });

        return jsonWithRequestId(
          {
            ok: false,
            stage: "import_start",
            stage_beacon,
            root_cause: "invalid_seed_companies",
            retryable: true,
            http_status: 409,
            error_id,
            message: "resume requested but seed companies are not valid; wait for primary candidates",
            session_id: sessionId,
            request_id: requestId,
            seed_counts: {
              provided: providedCompanies.length,
              valid: validSeedCompanies.length,
            },
          },
          200
        );
      }

      // If we have seeded companies, prefer a cleaned list when resuming.
      if (skipStages.has("primary") && validSeedCompanies.length > 0) {
        bodyObj.companies = validSeedCompanies;
      }

      const stopsBeforeSave = Boolean(maxStage && maxStage !== "expand" && maxStage !== "primary");

      if (!dryRunRequested && stopsBeforeSave) {
        return jsonWithRequestId(
          {
            ok: false,
            session_id: sessionId,
            request_id: requestId,
            stage_beacon,
            error_message:
              "This config cannot persist. Set dry_run=true or remove stage overrides (max_stage/skip_stages) that prevent saving.",
            details: {
              dry_run: dryRunRequested,
              max_stage: maxStage,
              skip_stages: Array.from(skipStages),
              companies_seeded: providedCompanies.length,
            },
          },
          400
        );
      }

      const shouldRunStage = (stageKey) => {
        if (!stageKey) return true;
        if (skipStages.has(stageKey)) return false;
        if (!maxStage) return true;
        return stageOrder.get(stageKey) <= stageOrder.get(maxStage);
      };

      const shouldStopAfterStage = (stageKey) => {
        if (!maxStage) return false;
        if (maxStage === stageKey) return true;
        if (skipStages.has(stageKey) && maxStage === stageKey) return true;
        return false;
      };

      const safeCheckIfSessionStopped = async (sid) => {
        if (!cosmosEnabled) return false;
        return await checkIfSessionStopped(sid);
      };

      const respondError = async (err, { status = 500, details = {} } = {}) => {
        const baseDetails =
          requestDetails ||
          buildRequestDetails(req, {
            body_source,
            body_source_detail,
            raw_text_preview,
            raw_text_starts_with_brace,
          });

        const detailsObj = {
          ...(baseDetails && typeof baseDetails === "object" ? baseDetails : {}),
          ...(details && typeof details === "object" ? details : {}),
          body_source,
          ...(body_source_detail ? { body_source_detail } : {}),
        };

        if (!detailsObj.content_type) {
          detailsObj.content_type = getHeader(req, "content-type") || null;
        }
        if (!detailsObj.content_length_header) {
          detailsObj.content_length_header = getHeader(req, "content-length") || null;
        }

        const errorStage = stage_beacon || stage;

        const shouldReturnWarnings =
          status >= 500 &&
          saveReport &&
          typeof saveReport === "object" &&
          Number.isFinite(Number(saveReport.saved)) &&
          Number(saveReport.saved) > 0;

        if (shouldReturnWarnings) {
          const upstreamStatus =
            Number.isFinite(Number(detailsObj?.upstream_status))
              ? Number(detailsObj.upstream_status)
              : Number.isFinite(Number(detailsObj?.xai_status))
                ? Number(detailsObj.xai_status)
                : null;

          const upstreamUrlRaw =
            (typeof detailsObj?.upstream_url === "string" && detailsObj.upstream_url.trim())
              ? detailsObj.upstream_url.trim()
              : (typeof detailsObj?.xai_url === "string" && detailsObj.xai_url.trim())
                ? detailsObj.xai_url.trim()
                : "";

          const upstreamUrlRedacted = upstreamUrlRaw ? redactUrlQueryAndHash(upstreamUrlRaw) : null;

          const root_cause = (() => {
            if (status === 504) return "timeout";
            const code = String(detailsObj?.code || "").toLowerCase();
            if (code.includes("timeout")) return "timeout";
            if (Number.isFinite(Number(upstreamStatus))) {
              if (upstreamStatus >= 400 && upstreamStatus < 500) return "upstream_4xx";
              if (upstreamStatus >= 500) return "upstream_5xx";
            }
            if (String(errorStage || "").toLowerCase().includes("cosmos")) return "cosmos_write_error";
            return "parse_error";
          })();

          const warningKey = (() => {
            const s = String(errorStage || "").toLowerCase();
            if (s.includes("reviews")) return "reviews_failed";
            if (s.includes("expand")) return "expand_failed";
            if (s.includes("keywords")) return "keywords_failed";
            if (s.includes("location")) return "location_failed";
            return "saved_with_warnings";
          })();

          const rawPartialMessage =
            (typeof detailsObj?.message === "string" && detailsObj.message.trim())
              ? detailsObj.message.trim()
              : (typeof detailsObj?.error_message === "string" && detailsObj.error_message.trim())
                ? detailsObj.error_message.trim()
                : toErrorString(err) || "";

          const partialMessage = (() => {
            const m = asString(rawPartialMessage).trim();
            const lower = m.toLowerCase();
            const statusLabel = Number.isFinite(Number(upstreamStatus)) ? `HTTP ${Number(upstreamStatus)}` : "";
            const specifics = [warningKey, root_cause, statusLabel].filter(Boolean).join(", ");

            if (!m) return specifics ? `Saved with warnings (${specifics})` : "Saved with warnings";
            if (lower === "backend call failure" || lower === "saved with warnings") {
              return specifics ? `Saved with warnings (${specifics})` : m;
            }
            return m;
          })();

          const warningDetail = {
            stage: warningKey,
            root_cause,
            upstream_status: upstreamStatus,
            upstream_url: upstreamUrlRedacted,
            message: partialMessage,
            build_id: buildInfo?.build_id || null,
          };

          try {
            upsertImportSession({
              session_id: sessionId,
              request_id: requestId,
              status: "complete",
              stage_beacon: errorStage,
              companies_count: Array.isArray(enrichedForCounts) ? enrichedForCounts.length : 0,
            });
          } catch {}

          if (!noUpstreamMode && cosmosEnabled) {
            try {
              await upsertCosmosImportSessionDoc({
                sessionId,
                requestId,
                patch: {
                  status: "complete",
                  stage_beacon: errorStage,
                  saved: Number(saveReport.saved) || 0,
                  skipped: Number(saveReport.skipped) || 0,
                  failed: Number(saveReport.failed) || 0,
                  warnings: [warningKey],
                  warnings_detail: { [warningKey]: warningDetail },
                  completed_at: new Date().toISOString(),
                },
              });
            } catch {}
          }

          return jsonWithRequestId(
            {
              ok: true,
              session_id: sessionId,
              request_id: requestId,
              stage_beacon: errorStage,
              company_name: contextInfo.company_name,
              website_url: contextInfo.website_url,
              companies: Array.isArray(enrichedForCounts) ? enrichedForCounts : [],
              saved: Number(saveReport.saved) || 0,
              skipped: Number(saveReport.skipped) || 0,
              failed: Number(saveReport.failed) || 0,
              save_report: saveReport,
              warnings: [warningKey],
              warnings_detail: { [warningKey]: warningDetail },
              build_id: buildInfo?.build_id || null,
            },
            200
          );
        }

        try {
          upsertImportSession({
            session_id: sessionId,
            request_id: requestId,
            status: "failed",
            stage_beacon: errorStage,
            companies_count: Array.isArray(enrichedForCounts) ? enrichedForCounts.length : 0,
          });
        } catch {}

        const env_present = {
          has_xai_key: Boolean(getXAIKey()),
          has_xai_base_url: Boolean(getXAIEndpoint()),
          has_import_start_proxy_base: false,
        };

        const upstream = (() => {
          const d = detailsObj && typeof detailsObj === "object" ? detailsObj : {};
          const rawUrl = d.upstream_url || d.xai_url || d.upstream || "";
          const host_path = rawUrl ? toHostPathOnlyForLog(rawUrl) : "";
          const statusVal = d.upstream_status ?? d.xai_status ?? null;
          const body_preview =
            d.upstream_text_preview || d.upstream_body_preview
              ? toTextPreview(d.upstream_text_preview || d.upstream_body_preview)
              : "";
          const timeout_ms =
            d.upstream_timeout_ms ?? d.timeout_ms ?? (status === 504 ? d.hard_timeout_ms || null : null);
          const error_class =
            typeof d.upstream_error_class === "string" && d.upstream_error_class.trim()
              ? d.upstream_error_class.trim()
              : typeof d.error_class === "string" && d.error_class.trim()
                ? d.error_class.trim()
                : null;

          const out = {};
          if (host_path) out.host_path = host_path;
          if (Number.isFinite(Number(statusVal))) out.status = Number(statusVal);
          if (body_preview) out.body_preview = body_preview;
          if (Number.isFinite(Number(timeout_ms))) out.timeout_ms = Number(timeout_ms);
          if (error_class) out.error_class = error_class;
          return Object.keys(out).length ? out : null;
        })();

        if (status >= 500) {
          try {
            console.error(
              "[import-start] sanitized_diagnostics:",
              JSON.stringify({ request_id: requestId, session_id: sessionId, stage: errorStage, status, upstream, env_present })
            );
          } catch {}
        }

        const errorMessage = toErrorString(err);
        const code =
          (detailsObj && typeof detailsObj.code === "string" && detailsObj.code.trim() ? detailsObj.code.trim() : null) ||
          (status === 400 ? "INVALID_REQUEST" : stage === "config" ? "IMPORT_START_NOT_CONFIGURED" : "IMPORT_START_FAILED");

        const message =
          (detailsObj && typeof detailsObj.message === "string" && detailsObj.message.trim()
            ? detailsObj.message.trim()
            : errorMessage) || "Import start failed";

        console.error(
          `[import-start] request_id=${requestId} session=${sessionId} stage=${errorStage} code=${code} message=${message}`
        );
        if (err?.stack) console.error(err.stack);

        const errorObj = {
          code,
          message,
          request_id: requestId,
          step: errorStage,
        };

        const passthroughKeys = [
          "upstream_status",
          "upstream_url",
          "upstream_path",
          "upstream_text_preview",
          "upstream_error_code",
          "upstream_error_message",
          "upstream_request_id",
        ];

        if (detailsObj && typeof detailsObj === "object") {
          for (const k of passthroughKeys) {
            if (detailsObj[k] === undefined || detailsObj[k] === null) continue;
            const v = detailsObj[k];
            if (typeof v === "string" && !v.trim()) continue;
            errorObj[k] = v;
          }
        }

        if (!noUpstreamMode && cosmosEnabled) {
          try {
            const container = getCompaniesCosmosContainer();
            if (container) {
              const errorDoc = {
                id: `_import_error_${sessionId}`,
                ...buildImportControlDocBase(sessionId),
                request_id: requestId,
                stage: errorStage,
                error: errorObj,
                details: detailsObj && typeof detailsObj === "object" ? detailsObj : {},
              };
              await upsertItemWithPkCandidates(container, errorDoc);
            }
          } catch (e) {
            console.warn(
              `[import-start] request_id=${requestId} session=${sessionId} failed to write error doc: ${e?.message || String(e)}`
            );
          }
        }

        const normalizeArray = (v) => (Array.isArray(v) ? v : []);
        const metaFromDetails =
          detailsObj && typeof detailsObj.meta === "object" && detailsObj.meta ? detailsObj.meta : null;

        const currentQueryTypes = normalizeArray(bodyObj?.queryTypes)
          .map((t) => String(t || "").trim())
          .filter(Boolean);

        const metaStage = (() => {
          const explicit = String(metaFromDetails?.stage || "").trim();
          if (explicit) return explicit;
          if (stage === "validate_request") return "validate_request";
          if (stage === "build_prompt" || stage === "build_messages") return "build_prompt";
          if (stage === "searchCompanies" || stage === "worker_call") return "xai_call";
          return "unknown";
        })();

        const meta = {
          ...(metaFromDetails && typeof metaFromDetails === "object" ? metaFromDetails : {}),
          handler_version: metaFromDetails?.handler_version || handlerVersion,
          stage: metaStage,
          query_len: Number.isFinite(Number(metaFromDetails?.query_len)) ? Number(metaFromDetails.query_len) : normalizedQuery.length,
          queryTypes: normalizeArray(metaFromDetails?.queryTypes).length ? normalizeArray(metaFromDetails.queryTypes) : currentQueryTypes,
          prompt_len: Number.isFinite(Number(metaFromDetails?.prompt_len)) ? Number(metaFromDetails.prompt_len) : 0,
          messages_len: Number.isFinite(Number(metaFromDetails?.messages_len)) ? Number(metaFromDetails.messages_len) : 0,
          has_system_message:
            typeof metaFromDetails?.has_system_message === "boolean"
              ? metaFromDetails.has_system_message
              : typeof metaFromDetails?.has_system_content === "boolean"
                ? metaFromDetails.has_system_content
                : false,
          has_user_message:
            typeof metaFromDetails?.has_user_message === "boolean"
              ? metaFromDetails.has_user_message
              : typeof metaFromDetails?.has_user_content === "boolean"
                ? metaFromDetails.has_user_content
                : false,
          user_message_len: Number.isFinite(Number(metaFromDetails?.user_message_len))
            ? Number(metaFromDetails.user_message_len)
            : Number.isFinite(Number(metaFromDetails?.prompt_len))
              ? Number(metaFromDetails.prompt_len)
              : 0,
          elapsedMs: Date.now() - startTime,
          upstream_status:
            metaFromDetails?.upstream_status ??
            metaFromDetails?.xai_status ??
            detailsObj?.upstream_status ??
            detailsObj?.xai_status ??
            null,
          upstream_error_class:
            metaFromDetails?.upstream_error_class ??
            metaFromDetails?.error_class ??
            detailsObj?.upstream_error_class ??
            detailsObj?.error_class ??
            null,
        };

        const error_id = makeErrorId();
        const root_cause = status >= 500 ? "server_exception" : "invalid_request";

        logImportStartErrorLine({ error_id, stage_beacon: errorStage, root_cause, err });

        const errorPayload = {
          ok: false,
          stage: errorStage,
          stage_beacon: errorStage,
          session_id: sessionId,
          request_id: requestId,
          retryable: true,
          root_cause,
          http_status: Number.isFinite(Number(status)) ? Number(status) : null,
          error_id,
          env_present,
          upstream: upstream || {},
          meta,
          error: errorObj,
          legacy_error: message,
          ...buildInfo,
          company_name: contextInfo.company_name,
          website_url: contextInfo.website_url,
          normalized_domain: contextInfo.normalized_domain,
          xai_request_id: contextInfo.xai_request_id,
          ...(diagnosticsEnabled
            ? {
                diagnostics: {
                  handler_reached: true,
                  stage_trace: stageTrace,
                  ...buildBodyDiagnostics(req),
                },
              }
            : {}),
          ...(debugEnabled
            ? {
                stack: String(err?.stack || ""),
                counts: buildCounts({ enriched: enrichedForCounts, debugOutput }),
                debug: debugOutput,
              }
            : {}),
          ...(detailsObj && typeof detailsObj === "object" && Object.keys(detailsObj).length ? { details: detailsObj } : {}),
        };

        // Normalize error responses to HTTP 200 so Static Web Apps never masks the body.
        // The real status is carried in errorPayload.http_status.
        return jsonWithRequestId(errorPayload, 200);
      };

      if (queryTypesProvided && !Array.isArray(rawQueryTypes)) {
        setStage("build_prompt", { error: "QUERYTYPES_NOT_ARRAY" });

        const normalizedQueryTypes = Array.isArray(bodyObj.queryTypes) ? bodyObj.queryTypes : [];
        const meta = {
          queryTypes: normalizedQueryTypes,
          query_len: normalizedQuery.length,
          prompt_len: 0,
          messages_len: 0,
          has_system_content: false,
          has_user_content: false,
        };

        return respondError(new Error("queryTypes must be an array"), {
          status: 400,
          details: {
            code: "QUERYTYPES_NOT_ARRAY",
            message: "queryTypes must be an array of strings",
            queryTypes: normalizedQueryTypes,
            prompt_len: meta.prompt_len,
            meta,
          },
        });
      }

      if (ambiguousQueryTypeFields) {
        setStage("validate_request", { error: "AMBIGUOUS_QUERY_TYPE_FIELDS" });
        return respondError(new Error("Ambiguous query type fields"), {
          status: 400,
          details: {
            code: "AMBIGUOUS_QUERY_TYPE_FIELDS",
            message: "Provide only one of queryTypes (array) or queryType (string), not both.",
          },
        });
      }

      if (queryLooksLikeUrl && !bodyObj.queryTypes.includes("company_url")) {
        setStage("validate_request", { error: "INVALID_QUERY_TYPE" });
        return respondError(new Error("Query looks like a URL"), {
          status: 400,
          details: {
            code: "INVALID_QUERY_TYPE",
            message: "Query looks like a URL. Include company_url in queryTypes.",
            query: normalizedQuery,
            queryTypes: bodyObj.queryTypes,
          },
        });
      }

      const queryTypesForLog = Array.isArray(bodyObj.queryTypes)
        ? bodyObj.queryTypes
            .map((t) => String(t || "").trim())
            .filter(Boolean)
            .slice(0, 10)
        : [];

      setStage("validate_request", {
        queryTypes: queryTypesForLog,
        query_len: normalizedQuery.length,
        limit: Number(bodyObj.limit),
      });

      logImportStartMeta({
        request_id: requestId,
        session_id: sessionId,
        handler_version: handlerVersion,
        stage: "validate_request",
        queryTypes: queryTypesForLog,
        query_len: normalizedQuery.length,
        prompt_len: 0,
        messages_len: 0,
        has_system_message: false,
        has_user_message: false,
        user_message_len: 0,
        elapsedMs: Date.now() - startTime,
        upstream_status: null,
      });

      mark("validate_request_done");

      const dryRun = bodyObj.dry_run === true || bodyObj.dry_run === "true";
      if (dryRun) {
        setStage("dry_run");
        return jsonWithRequestId(
          {
            ok: true,
            stage,
            session_id: sessionId,
            request_id: requestId,
            details:
              requestDetails ||
              buildRequestDetails(req, {
                body_source,
                body_source_detail,
                raw_text_preview,
                raw_text_starts_with_brace,
              }),
            company_name: contextInfo.company_name,
            website_url: contextInfo.website_url,
            normalized_domain: contextInfo.normalized_domain,
            received: {
              query: String(bodyObj.query || ""),
              queryType: String(bodyObj.queryType || ""),
              queryTypes: Array.isArray(bodyObj.queryTypes) ? bodyObj.queryTypes : [],
              location: String(bodyObj.location || ""),
              limit: Number(bodyObj.limit) || 0,
            },
            ...buildInfo,
          },
          200
        );
      }

      if (!String(bodyObj.query || "").trim()) {
        setStage("build_prompt", { error: "MISSING_QUERY" });

        const normalizedQueryTypes = Array.isArray(bodyObj.queryTypes) ? bodyObj.queryTypes : [];
        const meta = {
          queryTypes: normalizedQueryTypes,
          query_len: 0,
          prompt_len: 0,
          messages_len: 0,
          has_system_content: false,
          has_user_content: false,
        };

        return respondError(new Error("query is required"), {
          status: 400,
          details: {
            code: "IMPORT_START_VALIDATION_FAILED",
            message: "Query is required",
            queryTypes: normalizedQueryTypes,
            prompt_len: meta.prompt_len,
            meta,
          },
        });
      }

      setStage("create_session");
      sessionCreatedAtIso ||= new Date().toISOString();
      if (!noUpstreamMode && cosmosEnabled) {
        try {
          const container = getCompaniesCosmosContainer();
          if (container) {
            const sessionDoc = {
              id: `_import_session_${sessionId}`,
              ...buildImportControlDocBase(sessionId),
              created_at: sessionCreatedAtIso,
              request_id: requestId,
              status: "running",
              stage_beacon: "create_session",
              request: {
                query: String(bodyObj.query || ""),
                queryType: String(bodyObj.queryType || ""),
                queryTypes: Array.isArray(bodyObj.queryTypes) ? bodyObj.queryTypes : [],
                location: String(bodyObj.location || ""),
                limit: Number(bodyObj.limit) || 0,
                max_stage: String(maxStage || ""),
                skip_stages: Array.from(skipStages),
                dry_run: dryRunRequested,
              },
            };
            const result = await upsertItemWithPkCandidates(container, sessionDoc);
            if (!result.ok) {
              console.warn(
                `[import-start] request_id=${requestId} session=${sessionId} failed to write session marker: ${result.error}`
              );
            }
          }
        } catch (e) {
          console.warn(
            `[import-start] request_id=${requestId} session=${sessionId} error writing session marker: ${e?.message || String(e)}`
          );
        }
      }

      // Proxying disabled: /api/import/start is the single authority for message building + validation.
      // The legacy `proxy` flag is still parsed for backward compatibility, but is ignored.
      const proxyRaw =
        Object.prototype.hasOwnProperty.call(bodyObj || {}, "proxy")
          ? bodyObj.proxy
          : readQueryParam(req, "proxy");

      const proxyRequested =
        !isProxyExplicitlyDisabled(proxyRaw) && isProxyExplicitlyEnabled(proxyRaw);

      if (proxyRequested && debugOutput) {
        debugOutput.proxy_warning = {
          message: "Proxying is disabled for /api/import/start; request handled locally.",
        };
      }

      // Budget is the single source of truth (SWA gateway kills are not catchable).
      const isOutOfTime = () => budget.isExpired();

      const shouldAbort = () => {
        if (isOutOfTime()) {
          try {
            console.warn("[import-start] TIMEOUT: request budget exhausted", {
              request_id: requestId,
              session_id: sessionId,
              elapsed_ms: budget.getElapsedMs(),
              total_ms: budget.totalMs,
            });
          } catch {}
          return true;
        }
        return false;
      };

      const respondAcceptedBeforeGatewayTimeout = (nextStageBeacon, reason, extra) => {
        const beacon = String(nextStageBeacon || stage_beacon || stage || "unknown") || "unknown";
        mark(beacon);

        const normalizedReason = String(reason || "deadline_budget_guard") || "deadline_budget_guard";

        try {
          upsertImportSession({
            session_id: sessionId,
            request_id: requestId,
            status: "running",
            stage_beacon: beacon,
            companies_count: Array.isArray(enrichedForCounts) ? enrichedForCounts.length : 0,
          });
        } catch {}

        // Fire-and-forget: persist an acceptance marker so status can explain what happened even if the
        // start handler had to return early.
        if (!noUpstreamMode && cosmosEnabled) {
          (async () => {
            const container = getCompaniesCosmosContainer();
            if (!container) return;

            const acceptDoc = {
              id: `_import_accept_${sessionId}`,
              ...buildImportControlDocBase(sessionId),
              created_at: new Date().toISOString(),
              accepted_at: new Date().toISOString(),
              request_id: requestId,
              stage_beacon: beacon,
              reason: normalizedReason,
              remaining_ms:
                extra && typeof extra === "object" && Number.isFinite(Number(extra.remainingMs)) ? Number(extra.remainingMs) : null,
            };

            await upsertItemWithPkCandidates(container, acceptDoc).catch(() => null);

            await upsertCosmosImportSessionDoc({
              sessionId,
              requestId,
              patch: {
                status: "running",
                stage_beacon: beacon,
                requested_deadline_ms,
                requested_stage_ms_primary: requested_stage_ms_primary_effective,
              },
            }).catch(() => null);

            const shouldEnqueuePrimary =
              beacon === "xai_primary_fetch_start" ||
              beacon === "xai_primary_fetch_done" ||
              beacon.startsWith("xai_primary_fetch_") ||
              beacon.startsWith("primary_");

            // If we had to return early while we're still in primary, enqueue a durable primary job so
            // /api/import/status can drive it to completion.
            if (shouldEnqueuePrimary) {
              const jobDoc = {
                id: buildImportPrimaryJobId(sessionId),
                session_id: sessionId,
                job_state: "queued",
                stage: "primary",
                stage_beacon: "primary_search_started",
                request_payload: {
                  query: String(bodyObj.query || ""),
                  queryTypes: Array.isArray(bodyObj.queryTypes)
                    ? bodyObj.queryTypes
                    : [String(bodyObj.queryType || "product_keyword").trim() || "product_keyword"],
                  limit: Number(bodyObj.limit) || 0,
                  expand_if_few: bodyObj.expand_if_few ?? true,
                },
                inline_budget_ms,
                requested_deadline_ms,
                requested_stage_ms_primary: requested_stage_ms_primary_effective,
                xai_outbound_body:
                  typeof primaryXaiOutboundBody === "string" && primaryXaiOutboundBody.trim()
                    ? primaryXaiOutboundBody
                    : null,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              };

              await upsertImportPrimaryJob({ jobDoc, cosmosEnabled }).catch(() => null);

              try {
                const base = new URL(req.url);
                const triggerUrl = new URL("/api/import/primary-worker", base.origin);
                triggerUrl.searchParams.set("session_id", sessionId);
                if (!cosmosEnabled) triggerUrl.searchParams.set("no_cosmos", "1");

                setTimeout(() => {
                  fetch(triggerUrl.toString(), {
                    method: "POST",
                    headers: buildInternalFetchHeaders(),
                    body: JSON.stringify({ session_id: sessionId }),
                  }).catch(() => {});
                }, 0);
              } catch {}
            }
          })().catch(() => null);
        }

        return jsonWithRequestId(
          {
            ok: true,
            accepted: true,
            session_id: sessionId,
            request_id: requestId,
            stage_beacon: beacon,
            reason: normalizedReason,
            inline_budget_ms,
            requested_deadline_ms,
            requested_stage_ms_primary: requested_stage_ms_primary_effective,
            note: "start endpoint is inline capped; long primary runs async",
            ...(extra && typeof extra === "object" ? extra : {}),
          },
          200
        );
      };

      const checkDeadlineOrReturn = (nextStageBeacon, stageKey) => {
        const remainingMs = budget.getRemainingMs();

        // If we're too close to the SWA gateway wall-clock, stop starting new stages.
        if (remainingMs < MIN_STAGE_REMAINING_MS) {
          // Only primary is allowed to continue async.
          if (stageKey === "primary") {
            return respondAcceptedBeforeGatewayTimeout(nextStageBeacon, "remaining_budget_low", {
              remainingMs,
            });
          }
          return null;
        }

        return null;
      };

      try {
        const center = safeCenter(bodyObj.center);
        const query = String(bodyObj.query || "").trim();
        const queryTypesRaw = Array.isArray(bodyObj.queryTypes) ? bodyObj.queryTypes : [];
        const queryTypes = queryTypesRaw
          .map((t) => String(t || "").trim())
          .filter(Boolean)
          .slice(0, 10);

        const queryType = String(bodyObj.queryType || queryTypes[0] || "product_keyword").trim() || "product_keyword";
        const location = String(bodyObj.location || "").trim();

        const xaiPayload = {
          queryType: queryTypes.length > 0 ? queryTypes.join(", ") : queryType,
          queryTypes: queryTypes.length > 0 ? queryTypes : [queryType],
          query,
          location,
          limit: Math.max(1, Math.min(Number(bodyObj.limit) || 10, 25)),
          expand_if_few: bodyObj.expand_if_few ?? true,
          session_id: sessionId,
          ...(center ? { center } : {}),
        };

        if (debugOutput) {
          debugOutput.xai.payload = xaiPayload;
        }

        const deferredStages = new Set();
        let downstreamDeferredByBudget = false;

        // Client-controlled timeouts must never exceed the SWA-safe stage caps.
        const requestedTimeout = Number(bodyObj.timeout_ms) || DEFAULT_UPSTREAM_TIMEOUT_MS;
        const timeout = Math.min(requestedTimeout, DEFAULT_UPSTREAM_TIMEOUT_MS);
        console.log(`[import-start] Request timeout: ${timeout}ms (requested: ${requestedTimeout}ms)`);

        // Get XAI configuration (consolidated to use XAI_EXTERNAL_BASE primarily)
        const xaiEndpointRaw = getXAIEndpoint();
        const xaiKey = getXAIKey();
        const xaiModel = "grok-4-latest";
        const xaiUrl = resolveXaiEndpointForModel(xaiEndpointRaw, xaiModel);
        const xaiUrlForLog = toHostPathOnlyForLog(xaiUrl);

        const externalBaseSet = Boolean(
          String(
            process.env.XAI_EXTERNAL_BASE || process.env.XAI_INTERNAL_BASE || process.env.XAI_UPSTREAM_BASE || process.env.XAI_BASE || ""
          ).trim()
        );
        const legacyBaseSet = Boolean(String(process.env.XAI_BASE_URL || "").trim());
        const xai_config_source = externalBaseSet ? "external" : legacyBaseSet ? "legacy" : "external";
        const upstreamMeta = getResolvedUpstreamMeta(xaiUrl);

        console.log(`[import-start] XAI Endpoint: ${xaiEndpointRaw ? "configured" : "NOT SET"}`);
        console.log(`[import-start] XAI Key: ${xaiKey ? "configured" : "NOT SET"}`);
        console.log("[import-start] env_check", {
          has_xai_key: Boolean(xaiKey),
          xai_key_length: xaiKey ? String(xaiKey).length : 0,
          xai_config_source,
          resolved_upstream_host: upstreamMeta.resolved_upstream_host,
          resolved_upstream_path: upstreamMeta.resolved_upstream_path,
        });
        console.log("[import-start] xai_routing", {
          xai_config_source,
          resolved_upstream_host: upstreamMeta.resolved_upstream_host,
          resolved_upstream_path: upstreamMeta.resolved_upstream_path,
          xai_url: xaiUrlForLog || null,
        });
        console.log(`[import-start] XAI Request URL: ${xaiUrlForLog || "(unparseable)"}`);

        if ((!xaiUrl || !xaiKey) && !noUpstreamMode) {
          setStage("config");
          return respondError(new Error("XAI not configured"), {
            status: 500,
            details: {
              message: "Please set XAI_EXTERNAL_BASE and XAI_EXTERNAL_KEY environment variables",
            },
          });
        }

        const getRemainingMs = () => budget.getRemainingMs();

        const throwAccepted = (nextStageBeacon, reason, extra) => {
          const beacon = String(nextStageBeacon || stage_beacon || stage || "unknown") || "unknown";
          const remainingMs = getRemainingMs();

          try {
            console.log("[import-start] returning_202", {
              stage: extra && typeof extra === "object" && typeof extra.stage === "string" ? extra.stage : stage,
              stage_beacon: beacon,
              reason: String(reason || "deadline_budget_guard"),
              remainingMs,
              request_id: requestId,
              session_id: sessionId,
            });
          } catch {}

          throw new AcceptedResponseError(
            respondAcceptedBeforeGatewayTimeout(beacon, reason, {
              ...(extra && typeof extra === "object" ? extra : {}),
              remainingMs,
            })
          );
        };

        const ensureStageBudgetOrThrow = (stageKey, nextStageBeacon) => {
          const remainingMs = getRemainingMs();

          if (remainingMs < MIN_STAGE_REMAINING_MS) {
            // Only primary is allowed to continue async. Downstream stages should defer and let
            // resume-worker finish.
            if (stageKey === "primary") {
              throwAccepted(nextStageBeacon, "remaining_budget_low", { stage: stageKey, remainingMs });
            }
          }

          return remainingMs;
        };

        const postXaiJsonWithBudget = async ({ stageKey, stageBeacon, body, stageCapMsOverride }) => {
          const remainingMs = ensureStageBudgetOrThrow(stageKey, stageBeacon);
          const stageCapMsBase = Number(STAGE_MAX_MS?.[stageKey]) || DEFAULT_UPSTREAM_TIMEOUT_MS;
          const stageCapMsOverrideNumber =
            Number.isFinite(Number(stageCapMsOverride)) && Number(stageCapMsOverride) > 0 ? Number(stageCapMsOverride) : null;
          const stageCapMs = stageCapMsOverrideNumber ? Math.min(stageCapMsOverrideNumber, stageCapMsBase) : stageCapMsBase;

          // Dynamic stage timeout (SWA-safe): clamp to remaining budget and never exceed ~8s.
          const timeoutForThisStage = budget.clampStageTimeoutMs({
            remainingMs,
            minMs: 2500,
            maxMs: Math.min(8000, stageCapMs),
            safetyMarginMs: DEADLINE_SAFETY_BUFFER_MS + UPSTREAM_TIMEOUT_MARGIN_MS,
          });

          // If we can't safely run the upstream call within this request, bail out early.
          const minRequired = DEADLINE_SAFETY_BUFFER_MS + UPSTREAM_TIMEOUT_MARGIN_MS + 2500;
          if (remainingMs < minRequired) {
            if (stageKey === "primary") {
              throwAccepted(stageBeacon, "insufficient_time_for_fetch", {
                stage: stageKey,
                remainingMs,
                timeoutForThisStage,
                stageCapMs,
              });
            }

            const err = new Error("Insufficient time for upstream fetch");
            err.code = "INSUFFICIENT_TIME_FOR_FETCH";
            err.stage = stageKey;
            err.stage_beacon = stageBeacon;
            err.remainingMs = remainingMs;
            err.timeoutForThisStage = timeoutForThisStage;
            err.stageCapMs = stageCapMs;
            throw err;
          }

          const fetchStart = Date.now();

          try {
            console.log("[import-start] fetch_begin", {
              stage: stageKey,
              remainingMs,
              timeoutForThisStage,
              request_id: requestId,
              session_id: sessionId,
            });
          } catch {}

          try {
            const res = await postJsonWithTimeout(xaiUrl, {
              headers: (() => {
                const headers = {
                  "Content-Type": "application/json",
                };

                if (isAzureWebsitesUrl(xaiUrl)) {
                  headers["x-functions-key"] = xaiKey;
                } else {
                  headers["Authorization"] = `Bearer ${xaiKey}`;
                }

                return headers;
              })(),
              body: typeof body === "string" ? body : "",
              timeoutMs: timeoutForThisStage,
            });

            const elapsedMs = Date.now() - fetchStart;
            try {
              console.log("[import-start] fetch_end", {
                stage: stageKey,
                elapsedMs,
                request_id: requestId,
                session_id: sessionId,
                status: res?.status,
              });
            } catch {}

            return res;
          } catch (e) {
            const name = String(e?.name || "").toLowerCase();
            const code = String(e?.code || "").toUpperCase();
            const isAbort = code === "ECONNABORTED" || name.includes("abort");

            if (isAbort) {
              if (stageKey === "primary") {
                throwAccepted(stageBeacon, "upstream_timeout_returning_202", {
                  stage: stageKey,
                  timeoutForThisStage,
                  stageCapMs,
                });
              }

              const err = new Error("Upstream timeout");
              err.code = "UPSTREAM_TIMEOUT";
              err.stage = stageKey;
              err.stage_beacon = stageBeacon;
              err.timeoutForThisStage = timeoutForThisStage;
              err.stageCapMs = stageCapMs;
              throw err;
            }

            throw e;
          }
        };

        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

        const STAGE_RETRY_BACKOFF_MS = [0, 2000, 5000, 10000];

        const shouldRetryUpstreamStatus = (status) => {
          const s = Number(status);
          if (!Number.isFinite(s)) return true;
          if (s === 408 || s === 421 || s === 429) return true;
          return s >= 500 && s <= 599;
        };

        const postXaiJsonWithBudgetRetry = async ({ stageKey, stageBeacon, body, stageCapMsOverride }) => {
          const attempts = STAGE_RETRY_BACKOFF_MS.length;

          for (let attempt = 0; attempt < attempts; attempt += 1) {
            const delayMs = STAGE_RETRY_BACKOFF_MS[attempt] || 0;
            if (delayMs > 0) {
              const remaining = getRemainingMs();
              if (remaining < delayMs + DEADLINE_SAFETY_BUFFER_MS) {
                // Not enough budget to wait and retry.
                break;
              }
              await sleep(delayMs);
            }

            try {
              const res = await postXaiJsonWithBudget({ stageKey, stageBeacon, body, stageCapMsOverride });

              if (res && typeof res.status === "number" && shouldRetryUpstreamStatus(res.status) && attempt < attempts - 1) {
                continue;
              }

              return res;
            } catch (e) {
              if (e instanceof AcceptedResponseError) throw e;

              const code = String(e?.code || "").toUpperCase();
              const retryable = code === "UPSTREAM_TIMEOUT" || code === "INSUFFICIENT_TIME_FOR_FETCH";

              if (retryable && attempt < attempts - 1) {
                continue;
              }

              throw e;
            }
          }

          // Fall back to a final attempt (will throw on failure).
          return await postXaiJsonWithBudget({ stageKey, stageBeacon, body, stageCapMsOverride });
        };

        // Early check: if import was already stopped, return immediately
        if (!noUpstreamMode) {
          const wasAlreadyStopped = await safeCheckIfSessionStopped(sessionId);
          if (wasAlreadyStopped) {
          setStage("stopped");
          console.log(`[import-start] session=${sessionId} stop signal detected before XAI call`);
          return jsonWithRequestId(
            {
              ok: false,
              stage,
              session_id: sessionId,
              request_id: requestId,
              details:
                requestDetails ||
                buildRequestDetails(req, {
                  body_source,
                  body_source_detail,
                  raw_text_preview,
                  raw_text_starts_with_brace,
                }),
              error: {
                code: "IMPORT_STOPPED",
                message: "Import was stopped",
                request_id: requestId,
                step: stage,
              },
              legacy_error: "Import was stopped",
              ...buildInfo,
              companies: [],
              saved: 0,
            },
            200
          );
          }
        }

        let xaiCallMeta = null;

        // Build XAI request messages (never allow empty messages)
        setStage("build_prompt", { queryTypes });

        xaiCallMeta = {
          handler_version: handlerVersion,
          stage: "build_prompt",
          queryTypes,
          query_len: query.length,
          prompt_len: 0,
          messages_len: 0,
          has_system_message: false,
          has_user_message: false,
          user_message_len: 0,
          // Back-compat
          has_system_content: false,
          has_user_content: false,
        };

        if (!query) {
          return respondError(new Error("Missing query"), {
            status: 400,
            details: {
              code: "IMPORT_START_BUILD_PROMPT_FAILED",
              message: "Missing query",
              queryTypes,
              prompt_len: xaiCallMeta.prompt_len,
              meta: xaiCallMeta,
            },
          });
        }

        let promptString = "";

        if (queryTypes.includes("company_url")) {
          promptString = `You are a business research assistant specializing in manufacturing location extraction.

Company website URL: ${query}

Extract the company details represented by this URL.

Return ONLY a valid JSON array (no markdown, no prose). The array should contain 1 item.
Each item must follow this schema:
{
  "company_name": "",
  "website_url": "",
  "industries": [""],
  "product_keywords": "",
  "headquarters_location": "",
  "manufacturing_locations": [""],
  "location_sources": [
    {
      "location": "",
      "source_url": "",
      "source_type": "official_website|government_guide|b2b_directory|trade_data|packaging|media|other",
      "location_type": "headquarters|manufacturing"
    }
  ],
  "red_flag": false,
  "red_flag_reason": "",
  "tagline": "",
  "social": {
    "linkedin": "",
    "instagram": "",
    "x": "",
    "twitter": "",
    "facebook": "",
    "tiktok": "",
    "youtube": ""
  },
  "location_confidence": "high|medium|low"
}

Return strictly valid JSON only.`;
        } else {
          promptString = `You are a business research assistant specializing in manufacturing location extraction. Find and return information about ${xaiPayload.limit} DIFFERENT companies or products based on this search.

Search query: "${xaiPayload.query}"
Search type(s): ${xaiPayload.queryType}
${xaiPayload.location ? `
Location boost: "${xaiPayload.location}"
- If you can, prefer and rank higher companies whose HQ or manufacturing locations match this location.
- The location is OPTIONAL; do not block the import if it is empty.
` : ""}

CRITICAL PRIORITY #1: HEADQUARTERS & MANUFACTURING LOCATIONS (THIS IS THE TOP VALUE PROP)
These location fields are FIRST-CLASS and non-negotiable. Be AGGRESSIVE and MULTI-SOURCE in extraction - do not accept "website is vague" as final answer.

1. HEADQUARTERS LOCATION (Required, high priority):
   - Extract the company's headquarters location at minimum: city, state/region, country.
   - If no street address is available, that is acceptable - city + state/region + country is the minimum acceptable.
   - Use the company's official "Headquarters", "Head Office", or primary corporate address.
   - Check: Official website's About/Contact pages, LinkedIn company profile, Crunchbase, business directories.
   - If the website's Contact page is missing/404, use the header/footer contact info and the Terms/Privacy pages for the company address.
   - Acceptable formats: "San Francisco, CA, USA" or "London, UK" or "Tokyo, Japan"

   IMPORTANT: Government Buyer Guides and Business Directories often list headquarters with complete address.
   Examples: Yumpu (government buyers guide), Dun & Bradstreet, LinkedIn, Crunchbase, Google Business, SIC/NAICS registries.

2. MANUFACTURING LOCATIONS (Array, STRONGLY REQUIRED - be aggressive and multi-source):
   - Gather ALL identifiable manufacturing, production, factory, and plant locations from ALL available sources.
   - Return as an array of strings, each string being a location. DO NOT leave this empty unless there is truly no credible signal.
   - Acceptable detail per entry: Full address OR City + state/region + country OR country only (e.g., "United States", "China").
   - "Country only" manufacturing locations are FULLY ACCEPTABLE and PREFERRED over empty array.
   - Examples of acceptable results: ["Charlotte, NC, USA", "Shanghai, China", "Vietnam", "United States", "Mexico"]

   PRIMARY SOURCES (check ALL of these first):
   a) Official website: "Facilities", "Plants", "Manufacturing", "Where We Make", "Our Factories", "Production Sites" pages
   b) Product pages: Any "Made in X" labels or manufacturing claims on product listings and packaging photos
   c) FAQ or policy pages: "Where is this made?", "Manufacturing standards", "Supply chain" sections
   d) About/Sustainability: "Where we produce", "Supply chain transparency", "Ethical sourcing" pages
   e) Job postings: Roles mentioning "factory", "plant", "warehouse", "production", "manufacturing" reveal facility locations
   f) LinkedIn company profile: Manufacturing locations and facility information often listed in company description

   SECONDARY SOURCES - USE THESE AGGRESSIVELY WHEN PRIMARY SOURCES ARE VAGUE (these are just as credible):
   g) Government Buyer Guides & Federal Databases:
      - Yumpu government buyer guide listings (often list exact location, products, "all made in USA" claims)
      - GSA Schedules and federal procurement databases
      - State business registrations and Secretary of State records
      - These databases often capture manufacturer status and location explicitly

   h) B2B and Industrial Manufacturer Directories:
      - Thomas Register (thomasnet.com) - explicitly lists manufacturers by industry and location
      - SIC/NAICS manufacturer registries
      - Industrial manufacturer databases (SJN databases, Kompass, etc.)
      - These sources EXPLICITLY note if a company is a "Manufacturer" vs. reseller, and list facility locations

   i) Public Import/Export Records and Trade Data:
      - Customs data, shipping records, and trade databases showing origin countries
      - Alibaba, Global Sources, and other trade platform records showing source locations
      - Repeated shipments from specific countries (China, Vietnam, etc.) indicate manufacturing origin

   j) Supplier Databases and Records:
      - Known suppliers and manufacturing partners reveal facility regions
      - Supply chain data aggregators often show where goods originate

   k) Packaging and Product Labeling:
      - "Made in..." text on actual product images, packaging, inserts, or labels found online
      - Manufacturing claims in product descriptions and certifications

   l) Media, Press, and Third-Party Sources:
      - Industry articles, news, blog posts, or investigations mentioning manufacturing locations
      - Product review sites that mention where items are made
      - LinkedIn company posts discussing facilities or manufacturing

   m) Financial/Regulatory Filings:
      - SEC filings, annual reports, business registrations mentioning facilities
      - Patent filings showing inventor locations (sometimes reveals manufacturing)

   INFERENCE RULES FOR MANUFACTURING LOCATIONS:
   - If a brand shows repeated shipments from a specific region in trade records (China, Vietnam, Mexico), include that region
   - If government guides or B2B directories list the company as a "Manufacturer" with specific location, include that location
   - If packaging or product listings consistently say "Made in [X]", include X even if the brand website doesn't explicitly state it
   - If multiple independent sources consistently point to one or more countries, include those countries
   - "All made in the USA" or similar inclusive statements → manufacturing_locations: ["United States"]
   - If only country-level information is available after exhaustive checking, country-only entries are FULLY VALID and PREFERRED
   - When inferring from suppliers, customs, packaging, or government guides, set location_confidence to "medium" and note the inference source in red_flag_reason
   - Inferred manufacturing locations from secondary sources should NOT trigger red_flag: true (the flag is only for completely unknown locations)

3. CONFIDENCE AND RED FLAGS:
   - location_confidence: "high" if HQ and manufacturing are clearly stated on official site; "medium" if inferred from reliable secondary sources (government guides, B2B directories, customs, packaging); "low" if from limited sources
   - If HQ is found but manufacturing is completely unknown AFTER exhaustive checking → red_flag: true, reason: "Manufacturing location unknown, not found in official site, government guides, B2B directories, customs records, or packaging"
   - If manufacturing is inferred from government guides, B2B directories, customs data, suppliers, or packaging → red_flag: false (this is NOT a reason to flag), location_confidence: "medium"
   - If BOTH HQ and manufacturing are documented → red_flag: false, reason: ""
   - Only leave manufacturing_locations empty and red_flag: true if there is TRULY no credible signal after checking government guides, B2B directories, custom records, supplier data, packaging, and media

4. SOURCE PRIORITY FOR HQ:
   a) Official website: About, Contact, Locations, Head Office sections
   b) Government Buyer Guides and business databases (Yumpu, GSA, state registrations)
   c) B2B directories (Thomas Register, etc.) and LinkedIn company profile
   d) Crunchbase / public business directories
   e) News and public records

5. LOCATION SOURCES (Required for structured data):
   - For EVERY location (both HQ and manufacturing) you extract, provide the source information in location_sources array
   - Each entry in location_sources must have:
     a) location: the exact location string (e.g., "San Francisco, CA, USA")
     b) source_url: the URL where this location was found (or empty string if no specific URL)
     c) source_type: one of: official_website, government_guide, b2b_directory, trade_data, packaging, media, other
     d) location_type: either "headquarters" or "manufacturing"
   - This allows us to display source attribution to users and verify data quality
   - Example: { "location": "Shanghai, China", "source_url": "https://company.com/facilities", "source_type": "official_website", "location_type": "manufacturing" }

6. TAGLINE (Optional but valuable):
   - Extract the company's official tagline, mission statement, or brand slogan if available
   - Check: Company website homepage, About page, marketing materials, "Tagline" or "Slogan" field
   - If no explicit tagline found, leave empty (do NOT fabricate)
   - Example: "Tagline": "Where Quality Meets Innovation" or empty string ""

7. PRODUCT KEYWORDS (Required - MUST follow these rules strictly):
   You are extracting structured product intelligence for a consumer-facing company.
   Your task is to generate a comprehensive, concrete list of the company’s actual products and product categories.
   Rules:
   • Return up to 25 product keywords
   • Each keyword must be a real product, product line, or specific product category
   • Avoid vague marketing terms (e.g., “premium,” “high-quality,” “innovative,” “lifestyle”)
   • Prefer noun-based product names
   • Include both flagship products and secondary products
   • If exact product names are not available, infer industry-standard product types sold by the company
   • Do NOT repeat near-duplicates (e.g., “water bottle” and “bottles”)
   • Do NOT include services unless the company primarily sells services
   Output format for product_keywords field:
   • Return a comma-separated list
   • Maximum 25 items
   • No explanations or extra text

CRITICAL REQUIREMENTS FOR THIS SEARCH:
- Do NOT return empty manufacturing_locations arrays unless you have exhaustively checked government guides, B2B directories, and trade data
- Do NOT treat "not explicitly stated on website" as "manufacturing location unknown" - use secondary sources
- Always prefer country-level manufacturing locations (e.g., "United States") over empty arrays
- Government Buyer Guides (like Yumpu entries) are CREDIBLE PRIMARY sources for both HQ and manufacturing claims
- Companies listed in B2B manufacturer directories should have their listed location included
- For EACH location returned, MUST have a corresponding entry in location_sources array (this is non-negotiable)

SECONDARY: DIVERSITY & COVERAGE
- Prioritize smaller, regional, and lesser-known companies (40% small/regional/emerging, 35% mid-market, 25% major brands)
- Return DIVERSE companies - independent manufacturers, local producers, regional specialists, family-owned businesses, emerging/niche players
- Include regional and international companies
- Verify each company URL is valid

FORMAT YOUR RESPONSE AS A VALID JSON ARRAY. EACH OBJECT MUST HAVE:
- company_name (string): Exact company name
- website_url (string): Valid company website URL (must work)
- industries (array): Industry categories
- product_keywords (string): Comma-separated list of up to 25 concrete product keywords (real products/product lines/product categories; no vague marketing terms; prefer noun phrases; include flagship + secondary products; infer industry-standard product types if needed; no near-duplicates; no services unless primarily services)
- headquarters_location (string, REQUIRED): "City, State/Region, Country" format (or empty string ONLY if truly unknown after checking all sources)
- manufacturing_locations (array, REQUIRED): Array of location strings (MUST include all credible sources - official, government guides, B2B directories, suppliers, customs, packaging labels). Use country-only entries (e.g., "United States") if that's all that's known.
- location_sources (array, REQUIRED): Array of objects with structure: { "location": "City, State, Country", "source_url": "https://...", "source_type": "official_website|government_guide|b2b_directory|trade_data|packaging|media|other", "location_type": "headquarters|manufacturing" }. Include ALL sources found for both HQ and manufacturing locations.
- red_flag (boolean, REQUIRED): true only if HQ unknown or manufacturing completely unverifiable despite exhaustive checking of ALL sources including government guides and B2B directories
- red_flag_reason (string, REQUIRED): Explanation if red_flag=true, empty string if false; may note if manufacturing was inferred from secondary sources
- hq_lat (number, optional): Headquarters latitude
- hq_lng (number, optional): Headquarters longitude
- amazon_url (string, optional): Amazon storefront URL
- tagline (string, optional): Company's official tagline or mission statement (from website or marketing materials)
- social (object, optional): Social media URLs {linkedin, instagram, x, twitter, facebook, tiktok, youtube}
- location_confidence (string, optional): "high", "medium", or "low" based on data quality and sources used

IMPORTANT FINAL RULES:
1. For companies with vague or missing manufacturing info on their website, ALWAYS check government guides, B2B directories, suppliers, import records, packaging claims, and third-party sources BEFORE returning an empty manufacturing_locations array.
2. Country-only manufacturing locations (e.g., ["United States"]) are FULLY ACCEPTABLE results - do NOT treat them as incomplete.
3. If government sources (like Yumpu buyer guides) list "all made in the USA", return manufacturing_locations: ["United States"] with high confidence.
4. Only flag as red_flag: true when you have actually exhaustively checked all sources listed above and still have no credible signal.

Return ONLY the JSON array, no other text. Return at least ${Math.max(1, xaiPayload.limit)} diverse results if possible.`;
        }

        promptString = String(promptString || "").trim();
        xaiCallMeta.prompt_len = promptString.length;

        if (!promptString) {
          setStage("build_prompt", { error: "Empty prompt" });
          return respondError(new Error("Empty prompt"), {
            status: 400,
            details: {
              code: "IMPORT_START_BUILD_PROMPT_FAILED",
              message: "Empty prompt",
              queryTypes,
              prompt_len: xaiCallMeta.prompt_len,
              meta: xaiCallMeta,
            },
          });
        }

        logImportStartMeta({
          request_id: requestId,
          session_id: sessionId,
          handler_version: handlerVersion,
          stage: "build_prompt",
          queryTypes,
          query_len: query.length,
          prompt_len: xaiCallMeta.prompt_len,
          messages_len: 0,
          has_system_message: false,
          has_user_message: false,
          user_message_len: 0,
          elapsedMs: Date.now() - startTime,
          upstream_status: null,
        });

        setStage("build_messages");

        const promptInput = typeof bodyObj.prompt === "string" ? bodyObj.prompt.trim() : "";

        const SAFE_SYSTEM_PROMPT =
          typeof XAI_SYSTEM_PROMPT === "string" && XAI_SYSTEM_PROMPT.trim()
            ? XAI_SYSTEM_PROMPT
            : "You are a helpful assistant.";

        const ALLOWED_ROLES = new Set(["system", "user", "assistant", "tool"]);

        const buildFallbackPromptFromRequest = () => {
          const qt = Array.isArray(queryTypes) ? queryTypes.map((t) => String(t || "").trim()).filter(Boolean) : [];
          const limitVal = Number.isFinite(Number(xaiPayload?.limit)) ? Number(xaiPayload.limit) : 0;
          const location = typeof bodyObj.location === "string" ? bodyObj.location.trim() : "";
          const center = safeCenter(bodyObj.center);
          const centerStr = center ? `${center.lat},${center.lng}` : "";

          const lines = [];
          if (String(query || "").trim()) lines.push(`Query: ${String(query).trim()}`);
          if (qt.length) lines.push(`QueryTypes: ${qt.join(", ")}`);
          if (Number.isFinite(limitVal) && limitVal > 0) lines.push(`Limit: ${limitVal}`);
          if (location) lines.push(`Location: ${location}`);
          else if (centerStr) lines.push(`Center: ${centerStr}`);

          return lines.join("\n").trim();
        };

        const builtUserPrompt = (promptInput || promptString || buildFallbackPromptFromRequest()).trim();

        const parseAndValidateProvidedMessages = (raw) => {
          if (!Array.isArray(raw)) {
            return { ok: false, reason: "MESSAGES_NOT_ARRAY", messages: [] };
          }

          const out = [];
          for (let i = 0; i < raw.length; i += 1) {
            const m = raw[i];
            if (!m || typeof m !== "object") return { ok: false, reason: "MESSAGE_NOT_OBJECT", index: i, messages: [] };

            const role = typeof m.role === "string" ? m.role.trim() : "";
            if (!role || !ALLOWED_ROLES.has(role)) {
              return { ok: false, reason: "INVALID_ROLE", index: i, messages: [] };
            }

            if (typeof m.content !== "string") {
              return { ok: false, reason: "NON_STRING_CONTENT", index: i, messages: [] };
            }

            const content = m.content.trim();
            if (!content) {
              return { ok: false, reason: "EMPTY_CONTENT", index: i, messages: [] };
            }

            out.push({ role, content });
          }

          return { ok: true, messages: out };
        };

        const ensureSystemAndUser = (rawMessages, { userFallback }) => {
          const out = Array.isArray(rawMessages) ? [...rawMessages] : [];

          const hasSystem = out.some((m) => m?.role === "system" && typeof m.content === "string" && m.content.trim());
          const hasUser = out.some((m) => m?.role === "user" && typeof m.content === "string" && m.content.trim());

          if (!hasSystem) out.unshift({ role: "system", content: SAFE_SYSTEM_PROMPT });
          if (!hasUser) {
            const fb = typeof userFallback === "string" ? userFallback.trim() : "";
            if (fb) out.push({ role: "user", content: fb });
          }

          return out;
        };

        const buildMessageDebugFields = (msgs) => {
          const arr = Array.isArray(msgs) ? msgs : [];
          const system_count = arr.filter((m) => m?.role === "system").length;
          const user_count = arr.filter((m) => m?.role === "user").length;
          const system_content_len =
            system_count > 0
              ? (typeof arr.find((m) => m?.role === "system")?.content === "string"
                  ? arr.find((m) => m?.role === "system").content.trim().length
                  : 0)
              : 0;
          const user_content_len =
            user_count > 0
              ? (typeof arr.find((m) => m?.role === "user")?.content === "string"
                  ? arr.find((m) => m?.role === "user").content.trim().length
                  : 0)
              : 0;

          return {
            messages_len: arr.length,
            system_count,
            user_count,
            system_content_len,
            user_content_len,
            prompt_len: builtUserPrompt.length,
            handler_version: handlerVersion,
            mode: String(bodyObj.mode || "direct"),
            queryTypes,
          };
        };

        const validateMessagesForUpstream = (msgs) => {
          if (!Array.isArray(msgs) || msgs.length < 2) {
            return { ok: false, reason: "MESSAGES_TOO_SHORT" };
          }

          let system_count = 0;
          let user_count = 0;

          for (let i = 0; i < msgs.length; i += 1) {
            const m = msgs[i];
            if (!m || typeof m !== "object") return { ok: false, reason: "MESSAGE_NOT_OBJECT" };
            if (m.role === "system") system_count += 1;
            if (m.role === "user") user_count += 1;
            if (typeof m.content !== "string" || m.content.trim().length === 0) {
              return { ok: false, reason: "EMPTY_CONTENT" };
            }
          }

          if (system_count < 1 || user_count < 1) {
            return { ok: false, reason: "MISSING_SYSTEM_OR_USER" };
          }

          return { ok: true, system_count, user_count };
        };

        let messages;
        if (Object.prototype.hasOwnProperty.call(bodyObj, "messages")) {
          const raw = bodyObj.messages;

          if (Array.isArray(raw) && raw.length === 0) {
            // Builder bug recovery: if messages is [], always auto-generate from prompt/query.
            messages = [
              { role: "system", content: SAFE_SYSTEM_PROMPT },
              { role: "user", content: builtUserPrompt },
            ];
          } else {
            const parsed = parseAndValidateProvidedMessages(raw);
            if (!parsed.ok) {
              const rawArr = Array.isArray(raw) ? raw : [];
              const system_count = rawArr.filter((m) => m && typeof m === "object" && m.role === "system").length;
              const user_count = rawArr.filter((m) => m && typeof m === "object" && m.role === "user").length;
              const firstSystem = rawArr.find((m) => m && typeof m === "object" && m.role === "system");
              const firstUser = rawArr.find((m) => m && typeof m === "object" && m.role === "user");

              const debugFields = {
                messages_len: rawArr.length,
                system_count,
                user_count,
                system_content_len: typeof firstSystem?.content === "string" ? firstSystem.content.trim().length : 0,
                user_content_len: typeof firstUser?.content === "string" ? firstUser.content.trim().length : 0,
                prompt_len: typeof builtUserPrompt === "string" ? builtUserPrompt.length : 0,
                handler_version: handlerVersion,
                mode: String(bodyObj.mode || "direct"),
                queryTypes,
              };
              setStage("build_messages", { error: parsed.reason });
              return respondError(new Error("Invalid messages"), {
                status: 400,
                details: {
                  code: "EMPTY_MESSAGE_CONTENT_BUILDER_BUG",
                  message: "Invalid messages content (refusing to call upstream)",
                  ...debugFields,
                  meta: {
                    ...xaiCallMeta,
                    stage: "build_messages",
                    ...debugFields,
                    error: parsed.reason,
                  },
                },
              });
            }

            messages = ensureSystemAndUser(parsed.messages, { userFallback: builtUserPrompt });
          }
        } else {
          messages = [
            { role: "system", content: SAFE_SYSTEM_PROMPT },
            { role: "user", content: builtUserPrompt },
          ];
        }

        xaiCallMeta.prompt_input_len = promptInput.length;

        const debugFields = buildMessageDebugFields(messages);
        const validation = validateMessagesForUpstream(messages);

        xaiCallMeta.prompt_len = debugFields.prompt_len;
        xaiCallMeta.messages_len = debugFields.messages_len;
        xaiCallMeta.has_system_message = debugFields.system_count > 0;
        xaiCallMeta.has_user_message = debugFields.user_count > 0;
        xaiCallMeta.user_message_len = debugFields.user_content_len;
        xaiCallMeta.system_message_len = debugFields.system_content_len;
        xaiCallMeta.system_count = debugFields.system_count;
        xaiCallMeta.user_count = debugFields.user_count;

        if (!validation.ok) {
          setStage("build_messages", { error: validation.reason });
          return respondError(new Error("Invalid messages"), {
            status: 400,
            details: {
              code: "EMPTY_MESSAGE_CONTENT_BUILDER_BUG",
              message: "Invalid messages content (refusing to call upstream)",
              ...debugFields,
              meta: {
                ...xaiCallMeta,
                stage: "build_messages",
                ...debugFields,
                error: validation.reason,
              },
            },
          });
        }

        if (debugOutput) {
          debugOutput.xai.prompt_len = typeof builtUserPrompt === "string" ? builtUserPrompt.length : 0;
        }

        const xaiRequestPayload = {
          model: xaiModel,
          messages,
          temperature: 0.1,
          stream: false,
        };

        try {
          // Hard guard right before upstream fetch.
          const guardDebugFields = typeof buildMessageDebugFields === "function"
            ? buildMessageDebugFields(xaiRequestPayload.messages)
            : {
                messages_len: Array.isArray(xaiRequestPayload.messages) ? xaiRequestPayload.messages.length : 0,
                system_count: 0,
                user_count: 0,
                system_content_len: 0,
                user_content_len: 0,
                prompt_len: typeof builtUserPrompt === "string" ? builtUserPrompt.length : 0,
                handler_version: handlerVersion,
                mode: String(bodyObj.mode || "direct"),
                queryTypes,
              };

          const guardValidation = typeof validateMessagesForUpstream === "function"
            ? validateMessagesForUpstream(xaiRequestPayload.messages)
            : { ok: Array.isArray(xaiRequestPayload.messages) && xaiRequestPayload.messages.length >= 2 };

          if (!guardValidation.ok) {
            return respondError(new Error("Invalid messages"), {
              status: 400,
              details: {
                code: "EMPTY_MESSAGE_CONTENT_BUILDER_BUG",
                message: "Invalid messages content (refusing to call upstream)",
                ...guardDebugFields,
                meta: {
                  ...xaiCallMeta,
                  stage: "xai_call",
                  ...guardDebugFields,
                  error: guardValidation.reason || "INVALID_MESSAGES",
                },
              },
            });
          }

          if (noUpstreamMode) {
            setStage("no_upstream");
            return json(
              {
                ok: true,
                messages_len: Number(guardDebugFields?.messages_len) || 0,
                system_count: Number(guardDebugFields?.system_count) || 0,
                user_count: Number(guardDebugFields?.user_count) || 0,
                resolved_upstream_url_redacted: redactUrlQueryAndHash(xaiUrl) || null,
                auth_header_present: Boolean(xaiKey),
              },
              200,
              responseHeaders
            );
          }

          setStage("searchCompanies", {
            queryType: xaiPayload.queryType,
            limit: xaiPayload.limit,
          });

          xaiCallMeta.stage = "xai_call";
          const elapsedMs = Date.now() - startTime;

          logImportStartMeta({
            request_id: requestId,
            session_id: sessionId,
            handler_version: handlerVersion,
            stage: "xai_call",
            queryTypes,
            query_len: query.length,
            prompt_len: xaiCallMeta.prompt_len,
            messages_len: xaiCallMeta.messages_len,
            has_system_message: xaiCallMeta.has_system_message,
            has_user_message: xaiCallMeta.has_user_message,
            user_message_len: xaiCallMeta.user_message_len,
            elapsedMs,
            upstream_status: null,
          });

          const explainRaw = Object.prototype.hasOwnProperty.call(bodyObj || {}, "explain")
            ? bodyObj.explain
            : readQueryParam(req, "explain");
          const explainMode = isProxyExplicitlyEnabled(explainRaw);

          const outboundBody = JSON.stringify(xaiRequestPayload);
          primaryXaiOutboundBody = outboundBody;
          const payload_meta = buildXaiPayloadMetaSnapshotFromOutboundBody(outboundBody, {
            handler_version: handlerVersion,
            build_id: buildInfo?.build_id || "",
          });

          if (debugOutput) {
            debugOutput.xai.payload_meta = payload_meta;
          }

          try {
            ensureValidOutboundXaiBodyOrThrow(payload_meta);
          } catch (e) {
            return respondError(e instanceof Error ? e : new Error(String(e || "Invalid messages")), {
              status: 400,
              details: {
                code: "EMPTY_MESSAGE_CONTENT_BUILDER_BUG",
                message: "Invalid messages content (refusing to call upstream)",
                ...payload_meta,
              },
            });
          }

          if (explainMode) {
            setStage("explain");

            const execution_plan = buildXaiExecutionPlan(xaiPayload);
            const upstream_resolution = buildUpstreamResolutionSnapshot({
              url: xaiUrl,
              authHeaderValue: xaiKey ? "Bearer [REDACTED]" : "",
              timeoutMsUsed: timeout,
              executionPlan: execution_plan,
            });

            return jsonWithRequestId(
              {
                ok: true,
                explain: true,
                session_id: sessionId,
                request_id: requestId,
                payload_meta,
                ...upstream_resolution,
              },
              200
            );
          }

          console.log(`[import-start] Calling XAI API at: ${toHostPathOnlyForLog(xaiUrl)}`);

          let inputCompanies = (Array.isArray(bodyObj.companies) ? bodyObj.companies : [])
            .filter((it) => it && typeof it === "object")
            .slice(0, 500);

          // NOTE: company_url imports should still attempt the upstream primary call (it tends to be the
          // best source for HQ + manufacturing), but we must NOT ever return 202 for company_url.
          // If primary times out, we fall back to a local URL seed and continue downstream enrichment inline.
          function buildCompanyUrlSeedFromQuery(rawQuery) {
            const q = String(rawQuery || "").trim();

            let parsed = null;
            try {
              parsed = q.includes("://") ? new URL(q) : new URL(`https://${q}`);
            } catch {
              parsed = null;
            }

            const hostnameFromParsed = parsed ? String(parsed.hostname || "").trim() : "";
            const fallbackHost = q.replace(/^https?:\/\//i, "").split("/")[0].trim();
            const hostname = hostnameFromParsed || fallbackHost;

            const cleanHost = String(hostname || "").toLowerCase().replace(/^www\./, "");

            // If we cannot extract a hostname, do NOT seed a company doc.
            // This prevents accumulating "seed-fallback" junk rows with normalized_domain="unknown".
            if (!cleanHost) return null;

            // Required semantics:
            // - company_url + website_url should reflect the input URL (normalized to include protocol).
            // - canonical_url should be the normalized canonical host URL.
            const inputUrl = (() => {
              if (parsed) return parsed.toString();
              if (cleanHost) return `https://${cleanHost}/`;
              return q;
            })();

            const canonicalUrl = cleanHost ? `https://${cleanHost}/` : inputUrl;

            const companyName = (() => {
              const base = cleanHost ? cleanHost.split(".")[0] : "";
              if (!base) return cleanHost || canonicalUrl || inputUrl;
              return base.charAt(0).toUpperCase() + base.slice(1);
            })();

            const nowIso = new Date().toISOString();

            // NOTE: saveCompaniesToCosmos refuses to persist URL shortcuts unless they show
            // "meaningful enrichment". For a seed, we encode "attempted but unknown" markers so
            // the record can be saved and later upgraded by resume-worker.
            return {
              company_name: companyName,
              company_url: inputUrl,
              website_url: inputUrl,
              canonical_url: canonicalUrl,
              url: inputUrl,
              normalized_domain: cleanHost,
              source: "company_url_shortcut",
              candidate: false,
              source_stage: "seed",
              seed_ready: true,
              hq_unknown: true,
              hq_unknown_reason: "seed_from_company_url",
              mfg_unknown: true,
              mfg_unknown_reason: "seed_from_company_url",
              red_flag_reason: "Imported from URL; enrichment pending",
              curated_reviews: [],
              review_count: 0,
              reviews_stage_status: "pending",
              logo_stage_status: "pending",
              reviews_last_updated_at: nowIso,
              review_cursor: {
                exhausted: false,
                last_error: {
                  code: "SEED_FROM_COMPANY_URL",
                  message: "Seed created from URL; enrichment pending",
                },
              },
            };
          }

          async function respondWithCompanyUrlSeedFallback(acceptedError) {
            const seed = buildCompanyUrlSeedFromQuery(query);
            if (!seed || typeof seed !== "object") {
              const errorAt = new Date().toISOString();
              try {
                upsertImportSession({
                  session_id: sessionId,
                  request_id: requestId,
                  status: "error",
                  stage_beacon: "company_url_seed_invalid",
                  resume_needed: false,
                  resume_error: "invalid_company_url",
                  resume_error_details: {
                    root_cause: "invalid_company_url",
                    message: "company_url query did not contain a valid hostname; refusing to seed a company doc",
                    updated_at: errorAt,
                  },
                });
              } catch {}

              if (cosmosEnabled) {
                try {
                  await upsertCosmosImportSessionDoc({
                    sessionId,
                    requestId,
                    patch: {
                      status: "error",
                      stage_beacon: "company_url_seed_invalid",
                      resume_needed: false,
                      resume_error: "invalid_company_url",
                      resume_error_details: {
                        root_cause: "invalid_company_url",
                        message: "company_url query did not contain a valid hostname; refusing to seed a company doc",
                        updated_at: errorAt,
                      },
                      updated_at: errorAt,
                    },
                  }).catch(() => null);
                } catch {}
              }

              return jsonWithRequestId(
                {
                  ok: false,
                  session_id: sessionId,
                  request_id: requestId,
                  stage_beacon: "company_url_seed_invalid",
                  status: "error",
                  error: "invalid_company_url",
                  message: "company_url query did not contain a valid hostname; refusing to seed a company doc",
                },
                200
              );
            }

            const companies = [seed];

            const dryRunRequested = Boolean(bodyObj?.dry_run || bodyObj?.dryRun);

            const missing_by_company = [
              {
                company_name: seed.company_name,
                website_url: seed.website_url,
                normalized_domain: seed.normalized_domain,
                missing_fields: [
                  "industries",
                  "product_keywords",
                  "headquarters_location",
                  "manufacturing_locations",
                  "reviews",
                  "logo",
                ],
              },
            ];

            let saveResult = {
              saved: 0,
              skipped: 0,
              failed: 0,
              saved_ids: [],
              skipped_ids: [],
              skipped_duplicates: [],
              failed_items: [],
            };

            const canPersist = !dryRunRequested && cosmosEnabled;

            if (canPersist) {
              sessionCreatedAtIso ||= new Date().toISOString();

              try {
                const container = getCompaniesCosmosContainer();

                // Dedupe rule (imports): normalized_domain is the primary key; canonical_url is a secondary matcher.
                // This prevents "seed-fallback" duplicates accumulating when URL formatting differs.
                const existingRow = await findExistingCompany(
                  container,
                  seed.normalized_domain,
                  seed.company_name,
                  seed.canonical_url
                ).catch(() => null);

                const duplicateOfId = existingRow && existingRow.id ? String(existingRow.id).trim() : "";

                if (duplicateOfId && container) {
                  const existingMissing = Array.isArray(existingRow?.import_missing_fields) ? existingRow.import_missing_fields : [];
                  const existingComplete = existingMissing.length === 0;

                  const outcome = existingComplete
                    ? "duplicate_detected"
                    : "duplicate_detected_unverified_missing_required_fields";

                  saveResult = {
                    saved: existingComplete ? 1 : 0,
                    skipped: 0,
                    failed: 0,
                    saved_ids: existingComplete ? [duplicateOfId] : [],
                    skipped_ids: [],
                    skipped_duplicates: [
                      {
                        duplicate_of_id: duplicateOfId,
                        match_key: existingRow?.duplicate_match_key || "normalized_domain",
                        match_value:
                          existingRow?.duplicate_match_value ||
                          String(seed.normalized_domain || "").trim() ||
                          String(seed.canonical_url || "").trim() ||
                          null,
                      },
                    ],
                    failed_items: [],
                    saved_company_ids_verified: existingComplete ? [duplicateOfId] : [],
                    saved_company_ids_unverified: existingComplete ? [] : [duplicateOfId],
                    saved_verified_count: existingComplete ? 1 : 0,
                    saved_write_count: 0,
                    saved_ids_write: [],
                    duplicate_of_id: duplicateOfId,
                    duplicate_existing_incomplete: !existingComplete,
                    duplicate_existing_missing_fields: existingComplete ? [] : existingMissing.slice(0, 20),
                    save_outcome: outcome,
                  };
                } else {
                  const saveResultRaw = await saveCompaniesToCosmos({
                    companies,
                    sessionId,
                    requestId,
                    sessionCreatedAt: sessionCreatedAtIso,
                    axiosTimeout: Math.min(timeout, 20_000),
                    saveStub: Boolean(bodyObj?.save_stub || bodyObj?.saveStub),
                    getRemainingMs,
                  });

                  const verification = await verifySavedCompaniesReadAfterWrite(saveResultRaw).catch(() => ({
                    verified_ids: [],
                    unverified_ids: Array.isArray(saveResultRaw?.saved_ids) ? saveResultRaw.saved_ids : [],
                    verified_persisted_items: [],
                  }));

                  saveResult = applyReadAfterWriteVerification(saveResultRaw, verification);
                }
              } catch (e) {
                const errorMessage = toErrorString(e);

                addWarning("company_url_seed_save_failed", {
                  stage: "save",
                  root_cause: "seed_save_failed",
                  retryable: true,
                  message: `Failed to persist URL seed: ${errorMessage}`,
                });

                saveResult = {
                  ...saveResult,
                  saved: 0,
                  saved_ids: [],
                  failed: Math.max(1, Number(saveResult.failed || 0) || 0),
                  failed_items: [
                    {
                      index: 0,
                      company_name: seed.company_name,
                      error: errorMessage,
                    },
                  ],
                };
              }

              saveReport = saveResult;
            }

            const queryUrlForTelemetry = String(seed.company_url || seed.website_url || seed.url || "").trim();
            const normalizedDomainForTelemetry = String(seed.normalized_domain || "").trim();

            const getDuplicateOfId = (result) => {
              const dup =
                Array.isArray(result?.skipped_duplicates)
                  ? result.skipped_duplicates
                      .map((d) => String(d?.duplicate_of_id || "").trim())
                      .find(Boolean)
                  : "";
              if (dup) return dup;

              const fromSkippedIds =
                Array.isArray(result?.skipped_ids)
                  ? result.skipped_ids.map((id) => String(id || "").trim()).find(Boolean)
                  : "";
              return fromSkippedIds || "";
            };

            let save_outcome = "not_persisted";
            if (dryRunRequested) save_outcome = "dry_run";

            if (canPersist) {
              const verifiedCountPre = Number(saveResult.saved_verified_count ?? saveResult.saved ?? 0) || 0;
              const writeCountPre = Number(saveResult.saved_write_count || 0) || 0;

              if (verifiedCountPre > 0) {
                save_outcome = "saved_verified";
              } else if (getDuplicateOfId(saveResult)) {
                save_outcome = "duplicate_detected";
              } else if (
                writeCountPre > 0 &&
                Array.isArray(saveResult.saved_company_ids_unverified) &&
                saveResult.saved_company_ids_unverified.length > 0
              ) {
                save_outcome = "saved_unverified_missing_required_fields";
              } else if (writeCountPre > 0) {
                save_outcome = "read_after_write_failed";
              } else if (Number(saveResult.failed || 0) > 0) {
                save_outcome = "cosmos_write_failed";
              } else if (Number(saveResult.skipped || 0) > 0) {
                save_outcome = "validation_failed_missing_required_fields";
              } else {
                save_outcome = "cosmos_write_failed";
              }

              // If we skipped due to duplicate, treat the existing company doc as a verified saved result.
              if (
                save_outcome === "duplicate_detected" &&
                (Number(saveResult.saved_verified_count ?? saveResult.saved ?? 0) || 0) === 0
              ) {
                const duplicateOfId = getDuplicateOfId(saveResult);
                if (duplicateOfId) {
                  try {
                    const container = getCompaniesCosmosContainer();
                    const existingDoc = container
                      ? await readItemWithPkCandidates(container, duplicateOfId, {
                          id: duplicateOfId,
                          normalized_domain: normalizedDomainForTelemetry,
                          partition_key: normalizedDomainForTelemetry,
                        }).catch(() => null)
                      : null;

                    if (existingDoc) {
                      const existingMissing = Array.isArray(existingDoc?.import_missing_fields)
                        ? existingDoc.import_missing_fields
                        : [];
                      const existingComplete = existingMissing.length === 0;

                      if (!existingComplete) {
                        save_outcome = "duplicate_detected_unverified_missing_required_fields";
                      }

                      saveResult = {
                        ...saveResult,
                        saved: existingComplete ? 1 : 0,
                        skipped: 0,
                        failed: 0,
                        saved_ids: existingComplete ? [duplicateOfId] : [],
                        skipped_ids: [],
                        failed_items: [],
                        saved_company_ids_verified: existingComplete ? [duplicateOfId] : [],
                        saved_company_ids_unverified: existingComplete ? [] : [duplicateOfId],
                        saved_verified_count: existingComplete ? 1 : 0,
                        saved_write_count: 0,
                        saved_ids_write: [],
                        duplicate_of_id: duplicateOfId,
                        duplicate_existing_incomplete: !existingComplete,
                        duplicate_existing_missing_fields: existingComplete ? [] : existingMissing.slice(0, 20),
                      };
                    } else {
                      save_outcome = "read_after_write_failed";
                    }
                  } catch {
                    save_outcome = "read_after_write_failed";
                  }
                }
              }

              if (saveResult && typeof saveResult === "object") {
                saveResult.save_outcome = save_outcome;
                saveResult.seed_url = queryUrlForTelemetry || null;
                saveResult.seed_normalized_domain = normalizedDomainForTelemetry || null;
              }

              saveReport = saveResult;
            }

            const verifiedCount = Number(saveResult.saved_verified_count ?? saveResult.saved ?? 0) || 0;
            const writeCount = Number(saveResult.saved_write_count || 0) || 0;

            const resumeCompanyIds = (() => {
              const ids = [];
              if (Array.isArray(saveResult?.saved_ids_write)) ids.push(...saveResult.saved_ids_write);
              if (Array.isArray(saveResult?.saved_company_ids_verified)) ids.push(...saveResult.saved_company_ids_verified);
              if (Array.isArray(saveResult?.saved_company_ids_unverified)) ids.push(...saveResult.saved_company_ids_unverified);
              if (Array.isArray(saveResult?.saved_ids)) ids.push(...saveResult.saved_ids);

              return Array.from(
                new Set(
                  ids
                    .map((v) => String(v || "").trim())
                    .filter(Boolean)
                    .slice(0, 50)
                )
              );
            })();

            // We must resume even when we dedupe to an existing company (saved_write_count === 0)
            // because the record may still be missing required fields.
            const canResume = canPersist && resumeCompanyIds.length > 0;

            if (canResume) {
              let resumeDocPersisted = false;

              if (cosmosEnabled) {
                try {
                  const container = getCompaniesCosmosContainer();
                  if (container) {
                    const resumeDocId = `_import_resume_${sessionId}`;
                    const nowResumeIso = new Date().toISOString();

                    const resumeDoc = {
                      id: resumeDocId,
                      ...buildImportControlDocBase(sessionId),
                      created_at: nowResumeIso,
                      updated_at: nowResumeIso,
                      request_id: requestId,
                      status: "queued",
                      resume_auth: buildResumeAuthDiagnostics(),
                      saved_count: resumeCompanyIds.length,
                      saved_company_ids: resumeCompanyIds,
                      saved_company_urls: [String(seed.company_url || seed.website_url || seed.url || "").trim()].filter(Boolean),
                      missing_by_company,
                      keywords_stage_completed: false,
                      reviews_stage_completed: false,
                      location_stage_completed: false,
                    };

                    const resumeUpsert = await upsertItemWithPkCandidates(container, resumeDoc).catch(() => ({ ok: false }));
                  resumeDocPersisted = Boolean(resumeUpsert && resumeUpsert.ok);
                  }

                  const cosmosTarget = await getCompaniesCosmosTargetDiagnostics().catch(() => null);

                  const verifiedCount = Number(saveResult?.saved_verified_count ?? saveResult?.saved ?? 0) || 0;
                  const verifiedIds = Array.isArray(saveResult?.saved_company_ids_verified)
                    ? saveResult.saved_company_ids_verified
                    : Array.isArray(saveResult?.saved_ids)
                      ? saveResult.saved_ids
                      : [];

                  await upsertCosmosImportSessionDoc({
                    sessionId,
                    requestId,
                    patch: {
                      status: "running",
                      stage_beacon: "company_url_seed_fallback",
                      save_outcome,
                      saved: verifiedCount,
                      skipped: Number(saveResult.skipped || 0),
                      failed: Number(saveResult.failed || 0),
                      saved_count: verifiedCount,
                      saved_verified_count: verifiedCount,
                      saved_company_ids_verified: Array.isArray(saveResult.saved_company_ids_verified) ? saveResult.saved_company_ids_verified : verifiedIds,
                      saved_company_ids_unverified: Array.isArray(saveResult.saved_company_ids_unverified) ? saveResult.saved_company_ids_unverified : [],
                      saved_company_ids: resumeCompanyIds,
                      saved_company_urls: [String(seed.company_url || seed.website_url || seed.url || "").trim()].filter(Boolean),
                      saved_ids: resumeCompanyIds,
                      saved_write_count: Number(saveResult.saved_write_count || 0) || 0,
                      saved_ids_write: Array.isArray(saveResult.saved_ids_write) ? saveResult.saved_ids_write : [],
                      skipped_ids: Array.isArray(saveResult.skipped_ids) ? saveResult.skipped_ids : [],
                      failed_items: Array.isArray(saveResult.failed_items) ? saveResult.failed_items : [],
                      ...(cosmosTarget ? cosmosTarget : {}),
                      resume_needed: true,
                      resume_updated_at: new Date().toISOString(),
                    },
                  }).catch(() => null);
                } catch {
                  // ignore
                }
              }

              try {
                upsertImportSession({
                  session_id: sessionId,
                  request_id: requestId,
                  status: "running",
                  stage_beacon: "company_url_seed_fallback",
                  companies_count: companies.length,
                  resume_needed: true,
                });
              } catch {}

              // Auto-trigger the resume worker so missing enrichment stages get another chance.
              try {
                const resumeWorkerRequested = !(bodyObj?.auto_resume === false || bodyObj?.autoResume === false);
                const invocationIsResumeWorker = String(new URL(req.url).searchParams.get("resume_worker") || "") === "1";

                if (resumeWorkerRequested && !invocationIsResumeWorker && resumeDocPersisted) {
                  const deadlineMs = Math.max(
                    1000,
                    Math.min(Number(process.env.RESUME_WORKER_DEADLINE_MS || 20000) || 20000, 60000)
                  );
                  const batchLimit = Math.max(
                    1,
                    Math.min(Number(process.env.RESUME_WORKER_BATCH_LIMIT || 8) || 8, 50)
                  );

                  setTimeout(() => {
                    (async () => {
                      const workerRequest = buildInternalFetchRequest({
                        job_kind: "import_resume",
                      });

                      let statusCode = 0;
                      let workerOk = false;
                      let workerText = "";
                      let workerError = null;

                      let invokeRequestId = workerRequest.request_id || null;
                      let invokeGatewayKeyAttached = Boolean(workerRequest.gateway_key_attached);

                      try {
                        const invokeRes = await invokeResumeWorkerInProcess({
                          session_id: sessionId,
                          context,
                          workerRequest,
                          no_cosmos: !cosmosEnabled,
                          batch_limit: batchLimit,
                          deadline_ms: deadlineMs,
                        });

                        invokeRequestId = invokeRes.request_id || invokeRequestId;
                        invokeGatewayKeyAttached = Boolean(invokeRes.gateway_key_attached);

                        statusCode = Number(invokeRes.status || 0) || 0;
                        workerOk = Boolean(invokeRes.ok);
                        workerText = typeof invokeRes.bodyText === "string" ? invokeRes.bodyText : "";
                        workerError = invokeRes.error;
                      } catch (e) {
                        workerError = e;
                      }

                      if (workerOk) return;

                      const preview = typeof workerText === "string" && workerText ? workerText.slice(0, 2000) : "";
                      const resume_error = workerError?.message || (statusCode ? `resume_worker_in_process_${statusCode}` : "resume_worker_in_process_error");
                      const resume_error_details = {
                        invocation: "in_process",
                        http_status: statusCode,
                        response_text_preview: preview || null,
                        gateway_key_attached: Boolean(invokeGatewayKeyAttached),
                        request_id: invokeRequestId,
                      };

                      try {
                        upsertImportSession({
                          session_id: sessionId,
                          request_id: requestId,
                          status: "running",
                          stage_beacon: "company_url_seed_fallback",
                          resume_needed: true,
                          resume_error,
                          resume_error_details,
                          resume_worker_last_http_status: statusCode,
                          resume_worker_last_reject_layer: "in_process",
                        });
                      } catch {}

                      if (cosmosEnabled) {
                        const now = new Date().toISOString();
                        try {
                          await upsertCosmosImportSessionDoc({
                            sessionId,
                            requestId,
                            patch: {
                              resume_error,
                              resume_error_details,
                              resume_worker_last_http_status: statusCode,
                              resume_worker_last_reject_layer: "in_process",
                              resume_worker_last_trigger_request_id: workerRequest.request_id || null,
                              resume_worker_last_gateway_key_attached: Boolean(workerRequest.gateway_key_attached),
                              resume_error_at: now,
                              updated_at: now,
                            },
                          }).catch(() => null);
                        } catch {}
                      }
                    })().catch(() => {});
                  }, 0);
                }
              } catch {}

              const cosmosTarget = await getCompaniesCosmosTargetDiagnostics().catch(() => null);

              return jsonWithRequestId(
                {
                  ok: true,
                  session_id: sessionId,
                  request_id: requestId,
                  stage_beacon: "company_url_seed_fallback",
                  status: "running",
                  resume_needed: true,
                  resume: {
                    status: "queued",
                    internal_auth_configured: Boolean(internalAuthConfigured),
                    triggered_in_process: Boolean(resumeDocPersisted),
                    ...buildResumeAuthDiagnostics(),
                  },
                  missing_by_company,
                  company_name: seed.company_name,
                  company_url: seed.company_url || seed.website_url,
                  website_url: seed.website_url,
                  companies,
                  meta: {
                    mode: "direct",
                    seed_fallback: true,
                    accepted_reason: typeof acceptedError?.reason === "string" ? acceptedError.reason : undefined,
                  },
                  ...(cosmosTarget ? cosmosTarget : {}),
                  save_outcome,
                  saved_verified_count: Number(saveResult.saved_verified_count ?? saveResult.saved ?? 0) || 0,
                  saved_company_ids_verified: Array.isArray(saveResult.saved_company_ids_verified)
                    ? saveResult.saved_company_ids_verified
                    : Array.isArray(saveResult.saved_ids)
                      ? saveResult.saved_ids
                      : [],
                  saved_company_ids_unverified: Array.isArray(saveResult.saved_company_ids_unverified) ? saveResult.saved_company_ids_unverified : [],
                  saved: Number(saveResult.saved || 0),
                  skipped: Number(saveResult.skipped || 0),
                  failed: Number(saveResult.failed || 0),
                  save_report: {
                    saved: Number(saveResult.saved || 0),
                    saved_verified_count: Number(saveResult.saved_verified_count ?? saveResult.saved ?? 0) || 0,
                    saved_write_count: Number(saveResult.saved_write_count || 0) || 0,
                    skipped: Number(saveResult.skipped || 0),
                    failed: Number(saveResult.failed || 0),
                    save_outcome,
                    saved_ids: Array.isArray(saveResult.saved_ids) ? saveResult.saved_ids : [],
                    saved_ids_verified: Array.isArray(saveResult.saved_company_ids_verified) ? saveResult.saved_company_ids_verified : [],
                    saved_ids_unverified: Array.isArray(saveResult.saved_company_ids_unverified) ? saveResult.saved_company_ids_unverified : [],
                    saved_ids_write: Array.isArray(saveResult.saved_ids_write) ? saveResult.saved_ids_write : [],
                    skipped_ids: Array.isArray(saveResult.skipped_ids) ? saveResult.skipped_ids : [],
                    skipped_duplicates: Array.isArray(saveResult.skipped_duplicates) ? saveResult.skipped_duplicates : [],
                    failed_items: Array.isArray(saveResult.failed_items) ? saveResult.failed_items : [],
                  },
                  ...(warningKeys.size ? { warnings: Array.from(warningKeys), warnings_detail, warnings_v2 } : {}),
                  ...(debugOutput ? { debug: debugOutput } : {}),
                },
                200
              );
            }

            const seedVerifiedCount = Number(saveResult.saved_verified_count ?? saveResult.saved ?? 0) || 0;
            const seedWriteCount = Number(saveResult.saved_write_count || 0) || 0;
            const seedSaveFailed = canPersist && seedVerifiedCount === 0;

            if (seedSaveFailed) {
              const firstFailure = Array.isArray(saveResult.failed_items) && saveResult.failed_items.length > 0
                ? saveResult.failed_items[0]
                : null;

              const firstSkipped =
                Array.isArray(saveResult.skipped_duplicates) && saveResult.skipped_duplicates.length > 0
                  ? saveResult.skipped_duplicates[0]
                  : null;

              const outcome = typeof saveResult?.save_outcome === "string" ? saveResult.save_outcome.trim() : "";

              const errorMessage = (() => {
                const failedMsg = typeof firstFailure?.error === "string" && firstFailure.error.trim() ? firstFailure.error.trim() : "";
                if (failedMsg) return failedMsg;

                if (seedWriteCount > 0) {
                  return "Cosmos write reported success, but read-after-write verification could not confirm the saved document.";
                }

                if (outcome === "validation_failed_missing_required_fields") {
                  return "Seed was rejected before persistence (missing required fields or enrichment markers).";
                }

                const dupId = String(firstSkipped?.duplicate_of_id || "").trim();
                if (dupId) {
                  return `Seed was treated as a duplicate of ${dupId}, but the existing company doc could not be verified.`;
                }

                return "Failed to save company seed";
              })();

              const failureStage =
                seedWriteCount > 0
                  ? "read_after_write_failed"
                  : outcome === "validation_failed_missing_required_fields"
                    ? "validation_failed_missing_required_fields"
                    : "cosmos_write_failed";

              const last_error = {
                code:
                  failureStage === "read_after_write_failed"
                    ? "READ_AFTER_WRITE_FAILED"
                    : failureStage === "validation_failed_missing_required_fields"
                      ? "VALIDATION_FAILED"
                      : "COSMOS_SAVE_FAILED",
                message: errorMessage,
              };

              if (cosmosEnabled) {
                try {
                  const container = getCompaniesCosmosContainer();
                  if (container) {
                    const errorDoc = {
                      id: `_import_error_${sessionId}`,
                      ...buildImportControlDocBase(sessionId),
                      request_id: requestId,
                      stage: failureStage,
                      error: {
                        ...last_error,
                        request_id: requestId,
                        step: "save",
                      },
                      details: {
                        stage_beacon: "company_url_seed_fallback",
                        save_report: saveResult,
                      },
                    };

                    await upsertItemWithPkCandidates(container, errorDoc).catch(() => null);

                    await upsertCosmosImportSessionDoc({
                      sessionId,
                      requestId,
                      patch: {
                        status: "error",
                        stage_beacon: failureStage,
                        last_error,
                        save_outcome: outcome || failureStage,
                        saved: 0,
                        saved_verified_count: 0,
                        saved_company_ids_verified: [],
                        saved_company_ids_unverified: Array.isArray(saveResult.saved_company_ids_unverified)
                          ? saveResult.saved_company_ids_unverified
                          : [],
                        skipped: Number(saveResult.skipped || 0),
                        failed: Number(saveResult.failed || 0),
                        failed_items: Array.isArray(saveResult.failed_items) ? saveResult.failed_items : [],
                        completed_at: new Date().toISOString(),
                        resume_needed: false,
                      },
                    }).catch(() => null);
                  }
                } catch {
                  // ignore
                }
              }

              try {
                upsertImportSession({
                  session_id: sessionId,
                  request_id: requestId,
                  status: "error",
                  stage_beacon: failureStage,
                  companies_count: companies.length,
                  resume_needed: false,
                  last_error,
                });
              } catch {}

              const cosmosTarget = await getCompaniesCosmosTargetDiagnostics().catch(() => null);

              return jsonWithRequestId(
                {
                  ok: false,
                  session_id: sessionId,
                  request_id: requestId,
                  stage_beacon: failureStage,
                  status: "error",
                  resume_needed: false,
                  company_name: seed.company_name,
                  company_url: seed.company_url || seed.website_url,
                  website_url: seed.website_url,
                  companies,
                  meta: {
                    mode: "direct",
                    seed_fallback: true,
                    accepted_reason: typeof acceptedError?.reason === "string" ? acceptedError.reason : undefined,
                  },
                  ...(cosmosTarget ? cosmosTarget : {}),
                  last_error,
                  save_outcome: outcome || failureStage,
                  saved_verified_count: 0,
                  saved_company_ids_verified: [],
                  saved_company_ids_unverified: Array.isArray(saveResult.saved_company_ids_unverified)
                    ? saveResult.saved_company_ids_unverified
                    : [],
                  saved: 0,
                  skipped: Number(saveResult.skipped || 0),
                  failed: Number(saveResult.failed || 0),
                  save_report: {
                    saved: 0,
                    saved_verified_count: 0,
                    saved_write_count: Number(saveResult.saved_write_count || 0) || 0,
                    skipped: Number(saveResult.skipped || 0),
                    failed: Number(saveResult.failed || 0),
                    save_outcome: outcome || failureStage,
                    saved_ids: [],
                    saved_ids_verified: [],
                    saved_ids_unverified: Array.isArray(saveResult.saved_company_ids_unverified)
                      ? saveResult.saved_company_ids_unverified
                      : [],
                    saved_ids_write: Array.isArray(saveResult.saved_ids_write) ? saveResult.saved_ids_write : [],
                    skipped_ids: Array.isArray(saveResult.skipped_ids) ? saveResult.skipped_ids : [],
                    skipped_duplicates: Array.isArray(saveResult.skipped_duplicates) ? saveResult.skipped_duplicates : [],
                    failed_items: Array.isArray(saveResult.failed_items) ? saveResult.failed_items : [],
                  },
                  ...(warningKeys.size ? { warnings: Array.from(warningKeys), warnings_detail, warnings_v2 } : {}),
                  ...(debugOutput ? { debug: debugOutput } : {}),
                },
                200
              );
            }

            // If we cannot persist or cannot resume, end the session deterministically with a completion marker.
            if (canPersist) {
              try {
                const container = getCompaniesCosmosContainer();
                if (container) {
                  const completed_at = new Date().toISOString();
                  const completionDoc = {
                    id: `_import_complete_${sessionId}`,
                    ...buildImportControlDocBase(sessionId),
                    completed_at,
                    reason: "company_url_seed_fallback",
                    saved: Number(saveResult.saved || 0),
                    skipped: Number(saveResult.skipped || 0),
                    failed: Number(saveResult.failed || 0),
                    saved_ids: Array.isArray(saveResult.saved_ids) ? saveResult.saved_ids : [],
                    skipped_ids: Array.isArray(saveResult.skipped_ids) ? saveResult.skipped_ids : [],
                    failed_items: Array.isArray(saveResult.failed_items) ? saveResult.failed_items : [],
                  };

                  await upsertItemWithPkCandidates(container, completionDoc).catch(() => null);

                  await upsertCosmosImportSessionDoc({
                    sessionId,
                    requestId,
                    patch: {
                      status: "complete",
                      stage_beacon: "company_url_seed_fallback",
                      saved: completionDoc.saved,
                      skipped: completionDoc.skipped,
                      failed: completionDoc.failed,
                      completed_at,
                    },
                  }).catch(() => null);
                }
              } catch {
                // ignore
              }
            }

            try {
              upsertImportSession({
                session_id: sessionId,
                request_id: requestId,
                status: "complete",
                stage_beacon: "company_url_seed_fallback",
                companies_count: companies.length,
              });
            } catch {}

            const cosmosTarget = await getCompaniesCosmosTargetDiagnostics().catch(() => null);

            return jsonWithRequestId(
              {
                ok: true,
                session_id: sessionId,
                request_id: requestId,
                stage_beacon: "company_url_seed_fallback",
                status: "complete",
                resume_needed: false,
                company_name: seed.company_name,
                company_url: seed.company_url || seed.website_url,
                website_url: seed.website_url,
                companies,
                meta: {
                  mode: "direct",
                  seed_fallback: true,
                  accepted_reason: typeof acceptedError?.reason === "string" ? acceptedError.reason : undefined,
                },
                ...(cosmosTarget ? cosmosTarget : {}),
                saved_verified_count: Number(saveResult.saved_verified_count ?? saveResult.saved ?? 0) || 0,
                saved_company_ids_verified: Array.isArray(saveResult.saved_company_ids_verified)
                  ? saveResult.saved_company_ids_verified
                  : Array.isArray(saveResult.saved_ids)
                    ? saveResult.saved_ids
                    : [],
                saved_company_ids_unverified: Array.isArray(saveResult.saved_company_ids_unverified) ? saveResult.saved_company_ids_unverified : [],
                saved: Number(saveResult.saved || 0),
                skipped: Number(saveResult.skipped || 0),
                failed: Number(saveResult.failed || 0),
                save_report: {
                  saved: Number(saveResult.saved || 0),
                  saved_verified_count: Number(saveResult.saved_verified_count ?? saveResult.saved ?? 0) || 0,
                  saved_write_count: Number(saveResult.saved_write_count || 0) || 0,
                  skipped: Number(saveResult.skipped || 0),
                  failed: Number(saveResult.failed || 0),
                  saved_ids: Array.isArray(saveResult.saved_ids) ? saveResult.saved_ids : [],
                  saved_ids_verified: Array.isArray(saveResult.saved_company_ids_verified) ? saveResult.saved_company_ids_verified : [],
                  saved_ids_unverified: Array.isArray(saveResult.saved_company_ids_unverified) ? saveResult.saved_company_ids_unverified : [],
                  saved_ids_write: Array.isArray(saveResult.saved_ids_write) ? saveResult.saved_ids_write : [],
                  skipped_ids: Array.isArray(saveResult.skipped_ids) ? saveResult.skipped_ids : [],
                  skipped_duplicates: Array.isArray(saveResult.skipped_duplicates) ? saveResult.skipped_duplicates : [],
                  failed_items: Array.isArray(saveResult.failed_items) ? saveResult.failed_items : [],
                },
                ...(warningKeys.size ? { warnings: Array.from(warningKeys), warnings_detail, warnings_v2 } : {}),
                ...(debugOutput ? { debug: debugOutput } : {}),
              },
              200
            );
          }

          const isCompanyUrlImport =
            Array.isArray(queryTypes) &&
            queryTypes.includes("company_url") &&
            typeof query === "string" &&
            looksLikeCompanyUrlQuery(query);

          // Core rule: company_url imports must never spend the full request budget on inline enrichment.
          // Persist a deterministic seed immediately and let resume-worker do the heavy lifting.
          if (isCompanyUrlImport && !skipStages.has("primary") && maxStage !== "primary") {
            mark("company_url_seed_short_circuit");
            return await respondWithCompanyUrlSeedFallback(null);
          }

          const wantsAsyncPrimary =
            inputCompanies.length === 0 &&
            shouldRunStage("primary") &&
            !queryTypes.includes("company_url") &&
            ((Number.isFinite(Number(requested_stage_ms_primary)) &&
              Number(requested_stage_ms_primary) > inline_budget_ms) ||
              maxStage === "primary");

          if (wantsAsyncPrimary) {
            const jobId = buildImportPrimaryJobId(sessionId);
            let existingJob = null;

            try {
              existingJob = await getImportPrimaryJob({ sessionId, cosmosEnabled });
            } catch (e) {
              try {
                console.warn(
                  `[import-start] request_id=${requestId} session=${sessionId} failed to read primary job: ${e?.message || String(e)}`
                );
              } catch {}
            }

            const existingState = existingJob ? String(existingJob.job_state || "").trim() : "";

            if (existingState === "complete" && Array.isArray(existingJob.companies)) {
              inputCompanies = existingJob.companies
                .filter((it) => it && typeof it === "object")
                .slice(0, 500);

              try {
                console.log("[import-start] primary_async_cached_companies", {
                  request_id: requestId,
                  session_id: sessionId,
                  companies_count: inputCompanies.length,
                });
              } catch {}
            } else {
              const jobDoc = {
                id: jobId,
                session_id: sessionId,
                job_state: existingState === "running" ? "running" : "queued",
                stage: "primary",
                stage_beacon:
                  typeof existingJob?.stage_beacon === "string" && existingJob.stage_beacon.trim()
                    ? existingJob.stage_beacon.trim()
                    : "primary_enqueued",
                request_payload: {
                  query: String(xaiPayload.query || ""),
                  queryTypes: Array.isArray(xaiPayload.queryTypes) ? xaiPayload.queryTypes : [],
                  limit: Number(xaiPayload.limit) || 0,
                  expand_if_few: Boolean(xaiPayload.expand_if_few),
                },
                inline_budget_ms,
                requested_deadline_ms,
                requested_stage_ms_primary: requested_stage_ms_primary_effective,
                xai_outbound_body: outboundBody,
                attempt: Number.isFinite(Number(existingJob?.attempt)) ? Number(existingJob.attempt) : 0,
                companies_count: Number.isFinite(Number(existingJob?.companies_count))
                  ? Number(existingJob.companies_count)
                  : 0,
                last_error: existingJob?.last_error || null,
                created_at: existingJob?.created_at || new Date().toISOString(),
                updated_at: new Date().toISOString(),
                last_heartbeat_at: existingJob?.last_heartbeat_at || null,
              };

              const upserted = await upsertImportPrimaryJob({ jobDoc, cosmosEnabled }).catch(() => null);

              try {
                console.log("[import-start] primary_async_decision", {
                  request_id: requestId,
                  session_id: sessionId,
                  decision: "async_enqueue",
                  max_stage: maxStage,
                  skip_stages: Array.from(skipStages),
                  requested_deadline_ms,
                  requested_stage_ms_primary: requested_stage_ms_primary_effective,
                  inline_budget_ms,
                  job_storage: upserted?.job?.storage || (cosmosEnabled ? "cosmos" : "memory"),
                });
              } catch {}

              try {
                upsertImportSession({
                  session_id: sessionId,
                  request_id: requestId,
                  status: "running",
                  stage_beacon: jobDoc.stage_beacon,
                  companies_count: 0,
                });
              } catch {}

              if (!noUpstreamMode && cosmosEnabled) {
                (async () => {
                  const container = getCompaniesCosmosContainer();
                  if (!container) return;

                  const acceptDoc = {
                    id: `_import_accept_${sessionId}`,
                    ...buildImportControlDocBase(sessionId),
                    created_at: new Date().toISOString(),
                    accepted_at: new Date().toISOString(),
                    request_id: requestId,
                    stage_beacon: jobDoc.stage_beacon,
                    reason: "primary_async_enqueued",
                    remaining_ms: null,
                  };

                  await upsertItemWithPkCandidates(container, acceptDoc).catch(() => null);

                  await upsertCosmosImportSessionDoc({
                    sessionId,
                    requestId,
                    patch: {
                      status: "running",
                      stage_beacon: jobDoc.stage_beacon,
                      requested_deadline_ms,
                      requested_stage_ms_primary: requested_stage_ms_primary_effective,
                    },
                  }).catch(() => null);
                })().catch(() => null);
              }

              try {
                const base = new URL(req.url);
                const triggerUrl = new URL("/api/import/primary-worker", base.origin);
                triggerUrl.searchParams.set("session_id", sessionId);
                if (!cosmosEnabled) triggerUrl.searchParams.set("no_cosmos", "1");

                setTimeout(() => {
                  fetch(triggerUrl.toString(), {
                    method: "POST",
                    headers: buildInternalFetchHeaders(),
                    body: JSON.stringify({ session_id: sessionId }),
                  }).catch(() => {});
                }, 0);
              } catch {}

              return jsonWithRequestId(
                {
                  ok: true,
                  accepted: true,
                  session_id: sessionId,
                  request_id: requestId,
                  stage_beacon: jobDoc.stage_beacon,
                  reason: "primary_async_enqueued",
                  stage: "primary",
                  inline_budget_ms,
                  requested_deadline_ms,
                  requested_stage_ms_primary: requested_stage_ms_primary_effective,
                  stageCapMs: inline_budget_ms,
                  note: "start endpoint is inline capped; long primary runs async",
                },
                200
              );
            }
          }

          const deadlineBeforePrimary = checkDeadlineOrReturn("xai_primary_fetch_start", "primary");
          if (deadlineBeforePrimary) return deadlineBeforePrimary;

          if (!shouldRunStage("primary") && inputCompanies.length === 0) {
            mark("xai_primary_fetch_skipped");
            try {
              upsertImportSession({
                session_id: sessionId,
                request_id: requestId,
                status: "running",
                stage_beacon,
                companies_count: 0,
              });
            } catch {}

            return jsonWithRequestId(
              {
                ok: true,
                session_id: sessionId,
                request_id: requestId,
                stage_beacon,
                companies: [],
                meta: {
                  mode: "direct",
                  max_stage: maxStage,
                  skip_stages: Array.from(skipStages),
                  stopped_after_stage: "primary",
                  skipped_primary: true,
                },
              },
              200
            );
          }

          ensureStageBudgetOrThrow("primary", "xai_primary_fetch_start");
          mark("xai_primary_fetch_start");

          let xaiResponse;
          if (inputCompanies.length > 0) {
            try {
              console.log("[import-start] primary_input_companies", {
                count: inputCompanies.length,
                request_id: requestId,
                session_id: sessionId,
              });
            } catch {}

            xaiResponse = {
              status: 200,
              headers: {},
              data: {
                choices: [
                  {
                    message: {
                      content: JSON.stringify(inputCompanies),
                    },
                  },
                ],
              },
            };
          } else {
            try {
              xaiResponse = await postXaiJsonWithBudget({
                stageKey: "primary",
                stageBeacon: "xai_primary_fetch_start",
                body: outboundBody,
              });
            } catch (e) {
              const isCompanyUrlImport =
                Array.isArray(queryTypes) && queryTypes.includes("company_url") && typeof query === "string" && query.trim();

              // Critical: company_url imports must never return 202 + depend on the primary worker.
              // The primary worker explicitly skips company_url queries.
              if (isCompanyUrlImport && e instanceof AcceptedResponseError) {
                const seed = buildCompanyUrlSeedFromQuery(query);

                addWarning("primary_timeout_company_url", {
                  stage: "primary",
                  root_cause: "upstream_timeout_returning_202",
                  retryable: true,
                  message: "Primary upstream timed out for company_url. Continuing inline with URL seed.",
                  upstream_status: 202,
                  company_name: seed.company_name,
                  website_url: seed.website_url,
                });

                mark("xai_primary_fallback_company_url_seed");

                xaiResponse = {
                  status: 200,
                  headers: {},
                  data: {
                    choices: [
                      {
                        message: {
                          content: JSON.stringify([seed]),
                        },
                      },
                    ],
                  },
                };
              } else {
                throw e;
              }
            }
          }

          const elapsed = Date.now() - startTime;
        console.log(`[import-start] session=${sessionId} xai response status=${xaiResponse.status}`);

        const xaiRequestId = extractXaiRequestId(xaiResponse.headers);
        if (xaiRequestId) {
          setStage("searchCompanies", { xai_request_id: xaiRequestId });
          if (debugOutput) debugOutput.xai.request_id = xaiRequestId;
        }

        mark("xai_primary_fetch_done");

        if (xaiResponse.status >= 200 && xaiResponse.status < 300) {
          // Extract the response content
          const responseText = xaiResponse.data?.choices?.[0]?.message?.content || JSON.stringify(xaiResponse.data);
          console.log(
            `[import-start] session=${sessionId} xai response received chars=${typeof responseText === "string" ? responseText.length : 0}`
          );

          // Parse the JSON array from the response
          let companies = [];
          let parseError = null;
          try {
            const jsonMatch = responseText.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
              companies = JSON.parse(jsonMatch[0]);
              if (!Array.isArray(companies)) companies = [];
            }
          } catch (parseErr) {
            parseError = parseErr?.message || String(parseErr);
            console.warn(`[import-start] session=${sessionId} failed to parse companies from response: ${parseError}`);
            companies = [];
          }

          if (debugOutput) {
            debugOutput.xai.raw_response = responseText.length > 50000 ? responseText.slice(0, 50000) : responseText;
            debugOutput.xai.parse_error = parseError;
            debugOutput.xai.parsed_companies = Array.isArray(companies) ? companies.length : 0;
          }

          console.log(`[import-start] session=${sessionId} xai response status=${xaiResponse.status} companies=${companies.length}`);

          setStage("enrichCompany");
          const center = safeCenter(bodyObj.center);
          let enriched = companies.map((c) => enrichCompany(c, center));

          // For company_url imports, XAI can legitimately return an empty array (or parsing can fail).
          // In that case we still want to proceed with a deterministic URL seed so the session can
          // persist and resume-worker has something to enrich.
          if (enriched.length === 0 && queryTypes.includes("company_url")) {
            try {
              enriched = [buildCompanyUrlSeedFromQuery(query)];
              mark("company_url_seed_created");
            } catch {
              enriched = [buildCompanyUrlSeedFromQuery(query)];
            }
          }

          enrichedForCounts = enriched;

          // Populate a baseline profile deterministically from the company's own website.
          // This is especially important for company_url shortcut runs, where the initial company_name
          // (derived from the hostname) is often too weak to drive reviews/location enrichment.
          const downstreamStagesSkipped =
            !shouldRunStage("keywords") && !shouldRunStage("reviews") && !shouldRunStage("location");

          const baselineEligible = queryTypes.includes("company_url") || enriched.length <= 3;
          const baselineNeeded =
            baselineEligible &&
            (downstreamStagesSkipped || downstreamDeferredByBudget ||
              (queryTypes.includes("company_url") &&
                enriched.some((c) => !String(c?.tagline || "").trim())));

          if (baselineNeeded) {
            try {
              const remaining = getRemainingMs();
              if (remaining > 7000) {
                setStage("baselineWebsiteParse");

                const baselineConcurrency = queryTypes.includes("company_url") ? 1 : 2;
                enriched = await mapWithConcurrency(enriched, baselineConcurrency, async (company) => {
                  try {
                    return await fillCompanyBaselineFromWebsite(company, {
                      timeoutMs: queryTypes.includes("company_url") ? 7000 : 5000,
                      extraPageTimeoutMs: 3500,
                    });
                  } catch (e) {
                    if (e instanceof AcceptedResponseError) throw e;
                    return company;
                  }
                });

                enrichedForCounts = enriched;
              }
            } catch (e) {
              if (e instanceof AcceptedResponseError) throw e;
            }
          }

          // Early exit if no companies found
          // (For company_url runs, we always fall back to a URL seed above instead of exiting.)
          if (enriched.length === 0 && !queryTypes.includes("company_url")) {
            console.log(`[import-start] session=${sessionId} no companies found in XAI response, returning early`);

            // Write a completion marker so import-progress knows this session is done with 0 results
            if (cosmosEnabled) {
              try {
                const container = getCompaniesCosmosContainer();
                if (container) {
                  const completionDoc = {
                    id: `_import_complete_${sessionId}`,
                    ...buildImportControlDocBase(sessionId),
                    completed_at: new Date().toISOString(),
                    reason: "no_results_from_xai",
                    saved: 0,
                    skipped: 0,
                    failed: 0,
                    saved_ids: [],
                    skipped_ids: [],
                    failed_items: [],
                  };

                  const result = await upsertItemWithPkCandidates(container, completionDoc);
                  if (!result.ok) {
                    console.warn(
                      `[import-start] request_id=${requestId} session=${sessionId} failed to upsert completion marker: ${result.error}`
                    );
                  } else {
                    console.log(`[import-start] request_id=${requestId} session=${sessionId} completion marker written`);
                  }

                  await upsertCosmosImportSessionDoc({
                    sessionId,
                    requestId,
                    patch: {
                      status: "complete",
                      stage_beacon,
                      saved: 0,
                      skipped: 0,
                      failed: 0,
                      completed_at: completionDoc.completed_at,
                    },
                  }).catch(() => null);
                }
              } catch (e) {
                console.warn(
                  `[import-start] request_id=${requestId} session=${sessionId} error writing completion marker: ${e?.message || String(e)}`
                );
              }
            }

            return jsonWithRequestId(
              {
                ok: true,
                session_id: sessionId,
                request_id: requestId,
                details:
                  requestDetails ||
                  buildRequestDetails(req, {
                    body_source,
                    body_source_detail,
                    raw_text_preview,
                    raw_text_starts_with_brace,
                  }),
                company_name: contextInfo.company_name,
                website_url: contextInfo.website_url,
                companies: [],
                meta: {
                  mode: "direct",
                  expanded: false,
                  timedOut: false,
                  elapsedMs: Date.now() - startTime,
                  no_results_reason: "XAI returned empty response",
                },
                saved: 0,
                skipped: 0,
                failed: 0,
              },
              200
            );
          }

          // Ensure product keywords exist and persistable
          async function mapWithConcurrency(items, concurrency, mapper) {
            const out = new Array(items.length);
            let idx = 0;

            const workers = new Array(Math.max(1, concurrency)).fill(0).map(async () => {
              while (idx < items.length) {
                const cur = idx++;
                try {
                  out[cur] = await mapper(items[cur], cur);
                } catch {
                  out[cur] = items[cur];
                }
              }
            });

            const results = await Promise.allSettled(workers);
            for (const r of results) {
              if (r.status === "rejected") {
                console.warn(`[import-start] mapWithConcurrency worker rejected: ${r.reason?.message || String(r.reason || "")}`);
              }
            }
            return out;
          }

          async function generateProductKeywords(company, { timeoutMs }) {
            const companyName = String(company?.company_name || company?.name || "").trim();
            const websiteUrl = String(company?.website_url || company?.url || "").trim();
            const tagline = String(company?.tagline || "").trim();

            const websiteText = await (async () => {
              const h = await checkUrlHealthAndFetchText(websiteUrl, {
                timeoutMs: Math.min(8000, timeoutMs),
                maxBytes: 80000,
              }).catch(() => null);
              return h?.ok ? String(h.text || "").slice(0, 4000) : "";
            })();

            const prompt = `SYSTEM (KEYWORDS / PRODUCTS LIST)
You are generating a comprehensive product keyword list for a company to power search and filtering.
Company:
• Name: ${companyName}
• Website: ${websiteUrl}
• Short description/tagline (if available): ${tagline}
Rules:
• Output ONLY a JSON object with a single field: "keywords".
• "keywords" must be an array of 15 to 25 short product phrases the company actually sells or makes.
• Use product-level specificity (e.g., "insulated cooler", "hard-sided cooler", "travel tumbler") not vague categories (e.g., "outdoor", "quality", "premium").
• Do NOT include brand name, company name, marketing adjectives, or locations.
• Do NOT repeat near-duplicates.
• If uncertain, infer from the website content and product collections; prioritize what is most likely sold.
${websiteText ? `\nWebsite content excerpt:\n${websiteText}\n` : ""}
Output JSON only:
{ "keywords": ["...", "..."] }`;

            const payload = {
              model: "grok-4-latest",
              messages: [
                { role: "system", content: XAI_SYSTEM_PROMPT },
                { role: "user", content: prompt },
              ],
              temperature: 0.2,
              stream: false,
            };

            console.log(`[import-start] Calling XAI API (keywords) at: ${toHostPathOnlyForLog(xaiUrl)}`);
            const res = await postXaiJsonWithBudgetRetry({
              stageKey: "keywords",
              stageBeacon: "xai_keywords_fetch_start",
              body: JSON.stringify(payload),
              stageCapMsOverride: timeoutMs,
            });

            const text = res?.data?.choices?.[0]?.message?.content || "";

            let obj = null;
            try {
              const match = text.match(/\{[\s\S]*\}/);
              if (match) obj = JSON.parse(match[0]);
            } catch {
              obj = null;
            }

            const keywords = normalizeProductKeywords(obj?.keywords, {
              companyName,
              websiteUrl,
            });

            const prompt_hash = (() => {
              try {
                if (!createHash) return null;
                return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
              } catch {
                return null;
              }
            })();

            return {
              prompt,
              prompt_hash,
              source_url: websiteUrl || null,
              source_text_preview: websiteText ? websiteText.slice(0, 800) : "",
              raw_response: text.length > 20000 ? text.slice(0, 20000) : text,
              keywords,
            };
          }

          async function generateIndustries(company, { timeoutMs }) {
            const companyName = String(company?.company_name || company?.name || "").trim();
            const websiteUrl = String(company?.website_url || company?.url || "").trim();

            const keywordText = String(company?.product_keywords || "").trim();

            const prompt = `SYSTEM (INDUSTRIES)
You are classifying a company into a small set of industries for search filtering.
Company:
• Name: ${companyName}
• Website: ${websiteUrl}
• Products: ${keywordText}
Rules:
• Output ONLY valid JSON with a single field: "industries".
• "industries" must be an array of 1 to 4 short industry names.
• Use commonly understood industries (e.g., "Textiles", "Apparel", "Industrial Equipment", "Electronics", "Food & Beverage").
• Do NOT include locations.
Output JSON only:
{ "industries": ["..."] }`;

            const payload = {
              model: "grok-4-latest",
              messages: [
                { role: "system", content: XAI_SYSTEM_PROMPT },
                { role: "user", content: prompt },
              ],
              temperature: 0.1,
              stream: false,
            };

            const res = await postXaiJsonWithBudgetRetry({
              stageKey: "keywords",
              stageBeacon: "xai_industries_fetch_start",
              body: JSON.stringify(payload),
              stageCapMsOverride: timeoutMs,
            });

            const text = res?.data?.choices?.[0]?.message?.content || "";

            let obj = null;
            try {
              const match = text.match(/\{[\s\S]*\}/);
              if (match) obj = JSON.parse(match[0]);
            } catch {
              obj = null;
            }

            const industries = normalizeIndustries(obj?.industries).slice(0, 6);

            const prompt_hash = (() => {
              try {
                if (!createHash) return null;
                return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
              } catch {
                return null;
              }
            })();

            return {
              prompt,
              prompt_hash,
              source_url: websiteUrl || null,
              raw_response: text.length > 20000 ? text.slice(0, 20000) : text,
              industries,
            };
          }

          async function ensureCompanyKeywords(company) {
            const companyName = String(company?.company_name || company?.name || "").trim();
            const websiteUrl = String(company?.website_url || company?.url || "").trim();

            const initialList = normalizeProductKeywords(company?.keywords || company?.product_keywords, {
              companyName,
              websiteUrl,
            });

            let finalList = initialList.slice(0, 25);
            const debugEntry = {
              company_name: companyName,
              website_url: websiteUrl,
              initial_count: initialList.length,
              initial_keywords: initialList,
              generated: false,
              generated_count: 0,
              final_count: 0,
              final_keywords: [],
              prompt: null,
              raw_response: null,
            };

            if (finalList.length < 10 && companyName && websiteUrl) {
              try {
                const gen = await generateProductKeywords(company, { timeoutMs: Math.min(timeout, 20000) });
                debugEntry.generated = true;
                debugEntry.prompt = gen.prompt;
                debugEntry.raw_response = gen.raw_response;
                debugEntry.generated_count = gen.keywords.length;

                company.enrichment_debug = company.enrichment_debug && typeof company.enrichment_debug === "object" ? company.enrichment_debug : {};
                company.enrichment_debug.keywords = {
                  prompt_hash: gen.prompt_hash || null,
                  source_url: gen.source_url || websiteUrl || null,
                  source_text_preview: typeof gen.source_text_preview === "string" ? gen.source_text_preview : null,
                  raw_response_preview: typeof gen.raw_response === "string" ? gen.raw_response.slice(0, 1200) : null,
                  error: null,
                };

                const merged = [...finalList, ...gen.keywords];
                finalList = normalizeProductKeywords(merged, { companyName, websiteUrl }).slice(0, 25);
              } catch (e) {
                if (e instanceof AcceptedResponseError) throw e;
                debugEntry.generated = true;
                debugEntry.raw_response = e?.message || String(e);

                company.enrichment_debug = company.enrichment_debug && typeof company.enrichment_debug === "object" ? company.enrichment_debug : {};
                company.enrichment_debug.keywords = {
                  prompt_hash: null,
                  source_url: websiteUrl || null,
                  source_text_preview: null,
                  raw_response_preview: null,
                  error: e?.message || String(e),
                };
              }
            }

            company.keywords = finalList;
            company.product_keywords = keywordListToString(finalList);

            // Industries are required for a "complete enough" profile. If missing, infer them.
            const existingIndustries = normalizeIndustries(company?.industries);
            let industriesFinal = existingIndustries;

            if (industriesFinal.length === 0 && companyName && websiteUrl) {
              try {
                const inferred = await generateIndustries(company, { timeoutMs: Math.min(timeout, 15000) });
                industriesFinal = normalizeIndustries(inferred.industries);

                company.enrichment_debug = company.enrichment_debug && typeof company.enrichment_debug === "object" ? company.enrichment_debug : {};
                company.enrichment_debug.industries = {
                  prompt_hash: inferred.prompt_hash || null,
                  source_url: inferred.source_url || websiteUrl || null,
                  raw_response_preview: typeof inferred.raw_response === "string" ? inferred.raw_response.slice(0, 1200) : null,
                  industries: industriesFinal,
                  error: null,
                };

                if (debugOutput) {
                  debugOutput.keywords_debug.push({
                    company_name: companyName,
                    website_url: websiteUrl,
                    industries_generated: true,
                    industries: industriesFinal,
                    industries_prompt: inferred.prompt,
                    industries_raw_response: inferred.raw_response,
                  });
                }
              } catch (e) {
                if (e instanceof AcceptedResponseError) throw e;

                company.enrichment_debug = company.enrichment_debug && typeof company.enrichment_debug === "object" ? company.enrichment_debug : {};
                company.enrichment_debug.industries = {
                  prompt_hash: null,
                  source_url: websiteUrl || null,
                  raw_response_preview: null,
                  industries: [],
                  error: e?.message || String(e),
                };

                if (debugOutput) {
                  debugOutput.keywords_debug.push({
                    company_name: companyName,
                    website_url: websiteUrl,
                    industries_generated: true,
                    industries: [],
                    industries_error: e?.message || String(e),
                  });
                }
              }
            }

            if (industriesFinal.length === 0) {
              industriesFinal = ["Unknown"];
              company.industries_unknown = true;
            }

            company.industries = industriesFinal;

            debugEntry.final_keywords = finalList;
            debugEntry.final_count = finalList.length;

            if (debugOutput) debugOutput.keywords_debug.push(debugEntry);

            return company;
          }

          if (shouldStopAfterStage("primary")) {
            const companiesCount = Array.isArray(enriched) ? enriched.length : 0;

            try {
              upsertImportSession({
                session_id: sessionId,
                request_id: requestId,
                status: "running",
                stage_beacon,
                companies_count: companiesCount,
              });
            } catch {}

            if (!noUpstreamMode && cosmosEnabled) {
              await upsertCosmosImportSessionDoc({
                sessionId,
                requestId,
                patch: {
                  status: "running",
                  stage_beacon,
                  companies_count: companiesCount,
                },
              }).catch(() => null);
            }

            return jsonWithRequestId(
              {
                ok: true,
                session_id: sessionId,
                request_id: requestId,
                stage_beacon,
                companies: enriched,
                meta: {
                  mode: "direct",
                  max_stage: maxStage,
                  skip_stages: Array.from(skipStages),
                  stopped_after_stage: "primary",
                },
              },
              200
            );
          }

          const deadlineBeforeKeywords = checkDeadlineOrReturn("xai_keywords_fetch_start", "keywords");
          if (deadlineBeforeKeywords) return deadlineBeforeKeywords;

          let keywordStageCompleted = !shouldRunStage("keywords");

          if (shouldRunStage("keywords")) {
            const remainingBeforeKeywords = getRemainingMs();
            if (remainingBeforeKeywords < MIN_STAGE_REMAINING_MS) {
              keywordStageCompleted = false;
              downstreamDeferredByBudget = true;
              deferredStages.add("keywords");
              mark("xai_keywords_fetch_deferred_budget");
            } else {
              ensureStageBudgetOrThrow("keywords", "xai_keywords_fetch_start");
              mark("xai_keywords_fetch_start");
              setStage("generateKeywords");

              const keywordsConcurrency = 4;
              keywordStageCompleted = true;
              for (let i = 0; i < enriched.length; i += keywordsConcurrency) {
                if (getRemainingMs() < MIN_STAGE_REMAINING_MS) {
                  keywordStageCompleted = false;
                  downstreamDeferredByBudget = true;
                  deferredStages.add("keywords");
                  console.log(
                    `[import-start] session=${sessionId} keyword enrichment stopping early: remaining budget low`
                  );
                  break;
                }

                const slice = enriched.slice(i, i + keywordsConcurrency);
                const batch = await Promise.all(
                  slice.map(async (company) => {
                    try {
                      return await ensureCompanyKeywords(company);
                    } catch (e) {
                      if (e instanceof AcceptedResponseError) throw e;
                      try {
                        console.log(
                          `[import-start] session=${sessionId} keyword enrichment failed for ${company?.company_name || "(unknown)"}: ${e?.message || String(e)}`
                        );
                      } catch {}
                      return company;
                    }
                  })
                );

                for (let j = 0; j < batch.length; j++) {
                  enriched[i + j] = batch[j];
                }

                enrichedForCounts = enriched;
              }
              mark(keywordStageCompleted ? "xai_keywords_fetch_done" : "xai_keywords_fetch_partial");
            }
          } else {
            mark("xai_keywords_fetch_skipped");
          }

          if (shouldStopAfterStage("keywords")) {
            const companiesCount = Array.isArray(enriched) ? enriched.length : 0;

            try {
              upsertImportSession({
                session_id: sessionId,
                request_id: requestId,
                status: "running",
                stage_beacon,
                companies_count: companiesCount,
              });
            } catch {}

            if (!noUpstreamMode && cosmosEnabled) {
              await upsertCosmosImportSessionDoc({
                sessionId,
                requestId,
                patch: {
                  status: "running",
                  stage_beacon,
                  companies_count: companiesCount,
                },
              }).catch(() => null);
            }

            return jsonWithRequestId(
              {
                ok: true,
                session_id: sessionId,
                request_id: requestId,
                stage_beacon,
                companies: enriched,
                meta: {
                  mode: "direct",
                  max_stage: maxStage,
                  skip_stages: Array.from(skipStages),
                  stopped_after_stage: "keywords",
                },
              },
              200
            );
          }

          // Geocode and persist per-location coordinates (HQ + manufacturing)
          let geocodeStageCompleted = !shouldRunStage("location");

          if (shouldRunStage("location")) {
            const remainingBeforeGeocode = getRemainingMs();
            if (remainingBeforeGeocode < MIN_STAGE_REMAINING_MS) {
              geocodeStageCompleted = false;
              downstreamDeferredByBudget = true;
              deferredStages.add("location");
              mark("xai_location_geocode_deferred_budget");
            } else {
              ensureStageBudgetOrThrow("location", "xai_location_geocode_start");

              const deadlineBeforeGeocode = checkDeadlineOrReturn("xai_location_geocode_start", "location");
              if (deadlineBeforeGeocode) return deadlineBeforeGeocode;

              mark("xai_location_geocode_start");
              setStage("geocodeLocations");
              console.log(`[import-start] session=${sessionId} geocoding start count=${enriched.length}`);

              geocodeStageCompleted = true;
              for (let i = 0; i < enriched.length; i++) {
                if (getRemainingMs() < MIN_STAGE_REMAINING_MS) {
                  geocodeStageCompleted = false;
                  downstreamDeferredByBudget = true;
                  deferredStages.add("location");
                  console.log(
                    `[import-start] session=${sessionId} geocoding stopping early: remaining budget low`
                  );
                  break;
                }

                if (shouldAbort()) {
                  console.log(`[import-start] session=${sessionId} aborting during geocoding: time limit exceeded`);
                  break;
                }

                const stopped = await safeCheckIfSessionStopped(sessionId);
                if (stopped) {
                  console.log(`[import-start] session=${sessionId} stop signal detected, aborting during geocoding`);
                  break;
                }

                const company = enriched[i];
                try {
                  enriched[i] = await geocodeCompanyLocations(company, { timeoutMs: 5000 });
                } catch (e) {
                  console.log(
                    `[import-start] session=${sessionId} geocoding failed for ${company?.company_name || "(unknown)"}: ${e?.message || String(e)}`
                  );
                }
              }

              const okCount = enriched.filter((c) => Number.isFinite(c.hq_lat) && Number.isFinite(c.hq_lng)).length;
              console.log(`[import-start] session=${sessionId} geocoding done success=${okCount} failed=${enriched.length - okCount}`);
              mark(geocodeStageCompleted ? "xai_location_geocode_done" : "xai_location_geocode_partial");
            }
          } else {
            mark("xai_location_geocode_skipped");
          }

          // Reviews must be a first-class import stage.
          // We run the same pipeline as "Fetch more reviews" (xadmin-api-refresh-reviews),
          // and we run it AFTER the company is persisted so it can be committed.
          const usePostSaveReviews = true;

          let reviewStageCompleted = !shouldRunStage("reviews");

          if (shouldRunStage("reviews") && usePostSaveReviews) {
            // Defer until after saveCompaniesToCosmos so we have stable company_id values.
            reviewStageCompleted = false;
            mark("xai_reviews_fetch_deferred");
          } else if (shouldRunStage("reviews") && !shouldAbort() && !assertNoWebsiteFallback("reviews")) {
            ensureStageBudgetOrThrow("reviews", "xai_reviews_fetch_start");

            const deadlineBeforeReviews = checkDeadlineOrReturn("xai_reviews_fetch_start", "reviews");
            if (deadlineBeforeReviews) return deadlineBeforeReviews;

            mark("xai_reviews_fetch_start");
            setStage("fetchEditorialReviews");
            console.log(`[import-start] session=${sessionId} editorial review enrichment start count=${enriched.length}`);
            reviewStageCompleted = true;
            for (let i = 0; i < enriched.length; i++) {
              if (getRemainingMs() < MIN_STAGE_REMAINING_MS) {
                reviewStageCompleted = false;
                downstreamDeferredByBudget = true;
                deferredStages.add("reviews");
                console.log(
                  `[import-start] session=${sessionId} review enrichment stopping early: remaining budget low`
                );
                break;
              }

              // Check if import was stopped OR we're running out of time
              if (shouldAbort()) {
                console.log(`[import-start] session=${sessionId} aborting during review fetch: time limit exceeded`);
                break;
              }

              const stopped = await safeCheckIfSessionStopped(sessionId);
              if (stopped) {
                console.log(`[import-start] session=${sessionId} stop signal detected, aborting during review fetch`);
                break;
              }

              const company = enriched[i];
              setStage("fetchEditorialReviews", {
                company_name: String(company?.company_name || company?.name || ""),
                website_url: String(company?.website_url || company?.url || ""),
                normalized_domain: String(company?.normalized_domain || ""),
              });

              const effectiveWebsiteUrl = String(company?.website_url || company?.canonical_url || company?.url || "").trim();
              const nowReviewsIso = new Date().toISOString();

              if (!company.company_name || !effectiveWebsiteUrl) {
                enriched[i] = {
                  ...company,
                  curated_reviews: [],
                  review_count: 0,
                  reviews_last_updated_at: nowReviewsIso,
                  review_cursor: buildReviewCursor({
                    nowIso: nowReviewsIso,
                    count: 0,
                    exhausted: false,
                    last_error: {
                      code: "MISSING_COMPANY_INPUT",
                      message: "Missing company_name or website_url",
                    },
                    prev_cursor: company.review_cursor,
                  }),
                };
                continue;
              }

              try {
                const companyForReviews = company.website_url ? company : { ...company, website_url: effectiveWebsiteUrl };

                const grokReviews = await fetchCuratedReviewsGrok({
                  companyName: String(companyForReviews.company_name || "").trim(),
                  normalizedDomain:
                    String(companyForReviews.normalized_domain || "").trim() || toNormalizedDomain(effectiveWebsiteUrl),
                  budgetMs: Math.min(
                    12000,
                    Math.max(
                      3000,
                      (typeof getRemainingMs === "function" ? getRemainingMs() : 12000) - DEADLINE_SAFETY_BUFFER_MS
                    )
                  ),
                  xaiUrl,
                  xaiKey,
                  model: "grok-4-latest",
                });

                const reviewsStageStatus =
                  typeof grokReviews?.reviews_stage_status === "string" && grokReviews.reviews_stage_status.trim()
                    ? grokReviews.reviews_stage_status.trim()
                    : "upstream_unreachable";

                const fetchOk = reviewsStageStatus !== "upstream_unreachable";
                const fetchErrorCode = fetchOk ? null : "REVIEWS_UPSTREAM_UNREACHABLE";
                const fetchErrorMsg =
                  fetchOk ? null : typeof grokReviews?.diagnostics?.error === "string" ? grokReviews.diagnostics.error : "Reviews fetch failed";

                const curated = dedupeCuratedReviews(Array.isArray(grokReviews?.curated_reviews) ? grokReviews.curated_reviews : []);
                const candidateCount =
                  typeof grokReviews?.diagnostics?.candidate_count === "number" && Number.isFinite(grokReviews.diagnostics.candidate_count)
                    ? grokReviews.diagnostics.candidate_count
                    : Array.isArray(grokReviews?.curated_reviews)
                      ? grokReviews.curated_reviews.length
                      : 0;

                const rejectedCount = Math.max(0, candidateCount - curated.length);

                const reviewsTelemetry = {
                  stage_status: reviewsStageStatus,
                  review_candidates_fetched_count: candidateCount,
                  review_candidates_considered_count: candidateCount,
                  review_candidates_rejected_count: rejectedCount,
                  review_candidates_rejected_reasons: {},
                  review_validated_count: curated.length,
                  review_saved_count: curated.length,
                  duplicate_host_used_as_fallback: false,
                  time_budget_exhausted: false,
                  upstream_status: null,
                  upstream_error_code: fetchOk ? null : fetchErrorCode,
                  upstream_failure_buckets: {
                    upstream_4xx: 0,
                    upstream_5xx: 0,
                    upstream_rate_limited: 0,
                    upstream_unreachable: fetchOk ? 0 : 1,
                  },
                  excluded_websites_original_count:
                    typeof grokReviews?.search_telemetry?.excluded_websites_original_count === "number"
                      ? grokReviews.search_telemetry.excluded_websites_original_count
                      : null,
                  excluded_websites_used_count:
                    typeof grokReviews?.search_telemetry?.excluded_websites_used_count === "number"
                      ? grokReviews.search_telemetry.excluded_websites_used_count
                      : null,
                  excluded_websites_truncated:
                    typeof grokReviews?.search_telemetry?.excluded_websites_truncated === "boolean"
                      ? grokReviews.search_telemetry.excluded_websites_truncated
                      : null,
                  excluded_hosts_spilled_to_prompt_count:
                    typeof grokReviews?.search_telemetry?.excluded_hosts_spilled_to_prompt_count === "number"
                      ? grokReviews.search_telemetry.excluded_hosts_spilled_to_prompt_count
                      : null,
                };

                const candidatesDebug = [];

                // Only mark reviews "exhausted" when upstream returned *no candidates*.
                const cursorExhausted = fetchOk && reviewsStageStatus === "exhausted";

                const cursorError = !fetchOk
                  ? {
                      code: fetchErrorCode || "REVIEWS_FAILED",
                      message: fetchErrorMsg || "Reviews fetch failed",
                    }
                  : null;

                const cursor = buildReviewCursor({
                  nowIso: nowReviewsIso,
                  count: curated.length,
                  exhausted: cursorExhausted,
                  last_error: cursorError,
                  prev_cursor: companyForReviews.review_cursor,
                });

                // Persist candidate/rejection telemetry for retries and diagnostics.
                cursor._candidate_count = candidateCount;
                if (rejectedCount != null) cursor._rejected_count = rejectedCount;
                cursor._saved_count = curated.length;
                cursor.exhausted_reason = cursorExhausted ? "no_candidates" : "";

                cursor.reviews_stage_status = reviewsStageStatus;
                if (reviewsTelemetry) {
                  cursor.reviews_telemetry = {
                    stage_status: reviewsTelemetry.stage_status,
                    review_candidates_fetched_count: reviewsTelemetry.review_candidates_fetched_count,
                    review_candidates_considered_count: reviewsTelemetry.review_candidates_considered_count,
                    review_candidates_rejected_count: reviewsTelemetry.review_candidates_rejected_count,
                    review_candidates_rejected_reasons: reviewsTelemetry.review_candidates_rejected_reasons,
                    review_validated_count: reviewsTelemetry.review_validated_count,
                    review_saved_count: reviewsTelemetry.review_saved_count,
                    duplicate_host_used_as_fallback: reviewsTelemetry.duplicate_host_used_as_fallback,
                    time_budget_exhausted: reviewsTelemetry.time_budget_exhausted,
                    upstream_status: reviewsTelemetry.upstream_status,
                    upstream_error_code: reviewsTelemetry.upstream_error_code,
                    upstream_failure_buckets: reviewsTelemetry.upstream_failure_buckets,

                    excluded_websites_original_count: reviewsTelemetry.excluded_websites_original_count,
                    excluded_websites_used_count: reviewsTelemetry.excluded_websites_used_count,
                    excluded_websites_truncated: reviewsTelemetry.excluded_websites_truncated,
                    excluded_hosts_spilled_to_prompt_count: reviewsTelemetry.excluded_hosts_spilled_to_prompt_count,
                  };
                }

                if ((reviewsStageStatus !== "ok" || curated.length === 0) && candidatesDebug.length) {
                  cursor.review_candidates_debug = candidatesDebug;
                }

                console.log(
                  `[import-start][reviews] session=${sessionId} upstream_candidates=${candidateCount} saved=${curated.length} rejected=${rejectedCount != null ? rejectedCount : ""} exhausted=${cursorExhausted ? "true" : "false"} company=${companyForReviews.company_name}`
                );

                enriched[i] = {
                  ...companyForReviews,
                  curated_reviews: curated,
                  review_count: curated.length,
                  reviews_last_updated_at: nowReviewsIso,
                  review_cursor: cursor,
                };

                if (curated.length > 0) {
                  console.log(
                    `[import-start] session=${sessionId} fetched ${curated.length} editorial reviews for ${companyForReviews.company_name}`
                  );
                }
              } catch (e) {
                // Never allow review enrichment failures to abort the import.
                const msg = e?.message || String(e || "reviews_failed");
                warnReviews({
                  stage: "reviews",
                  root_cause: "reviews_exception",
                  retryable: true,
                  message: msg,
                  company_name: String(company?.company_name || company?.name || ""),
                  website_url: effectiveWebsiteUrl,
                });

                enriched[i] = {
                  ...company,
                  curated_reviews: Array.isArray(company.curated_reviews) ? company.curated_reviews : [],
                  review_count: typeof company.review_count === "number" ? company.review_count : 0,
                  reviews_last_updated_at: nowReviewsIso,
                  review_cursor: buildReviewCursor({
                    nowIso: nowReviewsIso,
                    count: typeof company.review_count === "number" ? company.review_count : 0,
                    exhausted: false,
                    last_error: {
                      code: "REVIEWS_EXCEPTION",
                      message: msg,
                    },
                    prev_cursor: company.review_cursor,
                  }),
                };
              }
            }

            try {
              const summary = {
                companies_total: Array.isArray(enriched) ? enriched.length : 0,
                companies_with_saved_0: 0,
                candidates_fetched_total: 0,
                candidates_considered_total: 0,
                validated_total: 0,
                saved_total: 0,
                rejected_total: 0,
                stage_status_counts: {},
                rejected_reasons_total: {},
              };

              for (const c of Array.isArray(enriched) ? enriched : []) {
                const cursor = c?.review_cursor && typeof c.review_cursor === "object" ? c.review_cursor : null;
                const stageStatus = String(cursor?.reviews_stage_status || "").trim() || "unknown";
                summary.stage_status_counts[stageStatus] = (summary.stage_status_counts[stageStatus] || 0) + 1;

                const saved = typeof c?.review_count === "number" ? c.review_count : Array.isArray(c?.curated_reviews) ? c.curated_reviews.length : 0;
                if (saved === 0) summary.companies_with_saved_0 += 1;

                const t = cursor?.reviews_telemetry && typeof cursor.reviews_telemetry === "object" ? cursor.reviews_telemetry : null;
                if (t) {
                  summary.candidates_fetched_total += Number(t.review_candidates_fetched_count) || 0;
                  summary.candidates_considered_total += Number(t.review_candidates_considered_count) || 0;
                  summary.validated_total += Number(t.review_validated_count) || 0;
                  summary.saved_total += Number(t.review_saved_count) || 0;
                  summary.rejected_total += Number(t.review_candidates_rejected_count) || 0;

                  const reasons = t.review_candidates_rejected_reasons && typeof t.review_candidates_rejected_reasons === "object" ? t.review_candidates_rejected_reasons : null;
                  if (reasons) {
                    for (const [k, v] of Object.entries(reasons)) {
                      if (!k) continue;
                      summary.rejected_reasons_total[k] = (summary.rejected_reasons_total[k] || 0) + (Number(v) || 0);
                    }
                  }
                } else {
                  summary.saved_total += saved;
                }
              }

              if (!noUpstreamMode && cosmosEnabled) {
                await upsertCosmosImportSessionDoc({
                  sessionId,
                  requestId,
                  patch: {
                    reviews_summary: summary,
                    reviews_summary_updated_at: new Date().toISOString(),
                  },
                });
              }

              console.log("[import-start][reviews_summary] " + JSON.stringify({ session_id: sessionId, request_id: requestId, ...summary }));
            } catch {}

            console.log(`[import-start] session=${sessionId} editorial review enrichment done`);
            mark(reviewStageCompleted ? "xai_reviews_fetch_done" : "xai_reviews_fetch_partial");
          } else if (!shouldRunStage("reviews")) {
            mark("xai_reviews_fetch_skipped");
          }

          if (shouldStopAfterStage("reviews")) {
            const companiesCount = Array.isArray(enriched) ? enriched.length : 0;

            try {
              upsertImportSession({
                session_id: sessionId,
                request_id: requestId,
                status: "running",
                stage_beacon,
                companies_count: companiesCount,
              });
            } catch {}

            if (!noUpstreamMode && cosmosEnabled) {
              await upsertCosmosImportSessionDoc({
                sessionId,
                requestId,
                patch: {
                  status: "running",
                  stage_beacon,
                  companies_count: companiesCount,
                },
              }).catch(() => null);
            }

            return jsonWithRequestId(
              {
                ok: true,
                session_id: sessionId,
                request_id: requestId,
                stage_beacon,
                companies: enriched,
                meta: {
                  mode: "direct",
                  max_stage: maxStage,
                  skip_stages: Array.from(skipStages),
                  stopped_after_stage: "reviews",
                },
              },
              200
            );
          }

          // Check if any companies have missing or weak location data
          // Trigger refinement if: HQ is missing, manufacturing is missing, or confidence is low (aggressive approach)
          const companiesNeedingLocationRefinement = enriched.filter(c =>
            (!c.headquarters_location || c.headquarters_location === "") ||
            (!c.manufacturing_locations || c.manufacturing_locations.length === 0) ||
            (c.location_confidence === "low")
          );

          // Location refinement pass: if too many companies have missing locations, run a refinement
          // But skip if we're running out of time
          if (shouldRunStage("location") && companiesNeedingLocationRefinement.length > 0 && enriched.length > 0 && !shouldAbort()) {
            console.log(`[import-start] ${companiesNeedingLocationRefinement.length} companies need location refinement`);

            try {
              // Build refinement prompt focusing only on HQ + manufacturing locations
              const refinementMessage = {
                role: "user",
                content: `You are a research assistant specializing in company location data.
For the following companies, you previously found some information but HQ and/or manufacturing locations were missing or unclear.
AGGRESSIVELY re-check ONLY for headquarters location and manufacturing locations using ALL available sources.

SOURCES TO CHECK (in order):
1. Official website (About, Contact, Facilities, Manufacturing, Where We Make pages)
2. Government Buyer Guides (like Yumpu entries) - often list exact headquarters and "made in USA" claims
3. B2B/Industrial Manufacturer Directories (Thomas Register, SIC/NAICS registries, manufacturer databases)
4. LinkedIn company profile and product pages
5. Public import/export records and trade data showing manufacturing origin countries
6. Supplier databases and known manufacturing partners
7. Packaging labels and product descriptions mentioning "Made in..."
8. Media articles, product reviews, and third-party sources
9. Crunchbase and other business databases

CRITICAL RULES FOR MANUFACTURING LOCATIONS:
- Government Buyer Guide entries (Yumpu, GSA, etc.) listing "all made in USA" or similar → INCLUDE "United States" in manufacturing_locations
- B2B directories explicitly noting "Manufacturer" status + location → INCLUDE that location
- Repeated origin countries in trade/customs data → INCLUDE those countries
- Packaging claims "Made in [X]" → INCLUDE X
- Do NOT return empty manufacturing_locations arrays - prefer country-only entries (e.g., "United States", "China") if that's all that's known
- Country-only manufacturing locations are FULLY ACCEPTABLE and PREFERRED

Companies needing refinement:
${companiesNeedingLocationRefinement.map(c => `- ${c.company_name} (${c.url || 'N/A'}) - missing: ${!c.headquarters_location ? 'HQ' : ''} ${!c.manufacturing_locations || c.manufacturing_locations.length === 0 ? 'Manufacturing' : ''}`).join('\n')}

For EACH company, return ONLY:
{
  "company_name": "exact name",
  "headquarters_location": "City, State/Region, Country OR empty string ONLY if truly not found after checking all sources",
  "manufacturing_locations": ["location1", "location2", ...] (MUST include countries/locations from all sources checked - never empty unless exhaustively confirmed unknown),
  "red_flag": true/false,
  "red_flag_reason": "explanation if red_flag true, empty string if false; may note inference source (e.g., 'Inferred from customs records')",
  "location_confidence": "high|medium|low"
}

IMPORTANT:
- NEVER return empty manufacturing_locations after checking government guides, B2B directories, and trade data
- ALWAYS prefer "United States" or "China" over empty array
- Inferred locations from secondary sources are valid and do NOT require red_flag: true

Focus ONLY on location accuracy. Return a JSON array with these objects.
Return ONLY the JSON array, no other text.`,
              };

              const refinementPayload = {
                model: "grok-4-latest",
                messages: [
                  { role: "system", content: XAI_SYSTEM_PROMPT },
                  refinementMessage,
                ],
                // HQ/MFG are Grok-only: enforce live search.
                search_parameters: { mode: "on" },
                temperature: 0.1,
                stream: false,
              };

              console.log(
                `[import-start] Running location refinement pass for ${companiesNeedingLocationRefinement.length} companies (upstream=${toHostPathOnlyForLog(
                  xaiUrl
                )})`
              );

              ensureStageBudgetOrThrow("location", "xai_location_refinement_fetch_start");

              const deadlineBeforeLocationRefinement = checkDeadlineOrReturn(
                "xai_location_refinement_fetch_start",
                "location"
              );
              if (deadlineBeforeLocationRefinement) return deadlineBeforeLocationRefinement;

              mark("xai_location_refinement_fetch_start");
              const refinementResponse = await postXaiJsonWithBudgetRetry({
                stageKey: "location",
                stageBeacon: "xai_location_refinement_fetch_start",
                body: JSON.stringify(refinementPayload),
                stageCapMsOverride: Math.min(timeout, 25000),
              });

              if (refinementResponse.status >= 200 && refinementResponse.status < 300) {
                const refinementText = refinementResponse.data?.choices?.[0]?.message?.content || "";
                console.log(`[import-start] Refinement response preview: ${refinementText.substring(0, 100)}...`);

                let refinedLocations = [];
                try {
                  const jsonMatch = refinementText.match(/\[[\s\S]*\]/);
                  if (jsonMatch) {
                    refinedLocations = JSON.parse(jsonMatch[0]);
                    if (!Array.isArray(refinedLocations)) refinedLocations = [];
                  }
                } catch (parseErr) {
                  console.warn(`[import-start] Failed to parse refinement response: ${parseErr.message}`);
                }

                console.log(`[import-start] Refinement returned ${refinedLocations.length} location updates`);

                // Merge refinement results back into enriched companies
                if (refinedLocations.length > 0) {
                  const refinementMap = new Map();
                  refinedLocations.forEach(rl => {
                    const name = (rl.company_name || "").toLowerCase();
                    if (name) refinementMap.set(name, rl);
                  });

                  enriched = enriched.map(company => {
                    const companyName = (company.company_name || "").toLowerCase();
                    const refinement = refinementMap.get(companyName);
                    if (refinement) {
                      // Properly handle manufacturing_locations which might be a string or array
                      let refinedMfgLocations = refinement.manufacturing_locations || company.manufacturing_locations || [];
                      if (typeof refinedMfgLocations === 'string') {
                        refinedMfgLocations = refinedMfgLocations.trim() ? [refinedMfgLocations.trim()] : [];
                      }

                      return {
                        ...company,
                        headquarters_location: refinement.headquarters_location || company.headquarters_location || "",
                        manufacturing_locations: refinedMfgLocations,
                        red_flag: refinement.red_flag !== undefined ? refinement.red_flag : company.red_flag,
                        red_flag_reason: refinement.red_flag_reason !== undefined ? refinement.red_flag_reason : company.red_flag_reason || "",
                        location_confidence: refinement.location_confidence || company.location_confidence || "medium",
                      };
                    }
                    return company;
                  });

                  // Re-geocode refined companies (HQ + manufacturing)
                  console.log(`[import-start] Re-geocoding refined companies`);
                  for (let i = 0; i < enriched.length; i++) {
                    const company = enriched[i];
                    const wasUpdated = refinedLocations.some(
                      (rl) => (rl.company_name || "").toLowerCase() === (company.company_name || "").toLowerCase()
                    );
                    if (!wasUpdated) continue;
                    try {
                      enriched[i] = await geocodeCompanyLocations(company, { timeoutMs: 5000 });
                    } catch (e) {
                      console.log(`[import-start] Re-geocoding failed for ${company?.company_name || "(unknown)"}: ${e?.message || String(e)}`);
                    }
                  }

                  console.log(`[import-start] Merged refinement data back into companies`);
                }
              }
            } catch (refinementErr) {
              if (refinementErr instanceof AcceptedResponseError) throw refinementErr;
              console.warn(`[import-start] Location refinement pass failed: ${refinementErr.message}`);
              // Continue with original data if refinement fails
            } finally {
              mark("xai_location_refinement_fetch_done");
            }
          }

          if (!shouldRunStage("location")) {
            mark("xai_location_refinement_skipped");
          }

          if (shouldStopAfterStage("location")) {
            const companiesCount = Array.isArray(enriched) ? enriched.length : 0;

            try {
              upsertImportSession({
                session_id: sessionId,
                request_id: requestId,
                status: "running",
                stage_beacon,
                companies_count: companiesCount,
              });
            } catch {}

            if (!noUpstreamMode && cosmosEnabled) {
              await upsertCosmosImportSessionDoc({
                sessionId,
                requestId,
                patch: {
                  status: "running",
                  stage_beacon,
                  companies_count: companiesCount,
                },
              }).catch(() => null);
            }

            return jsonWithRequestId(
              {
                ok: true,
                session_id: sessionId,
                request_id: requestId,
                stage_beacon,
                companies: enriched,
                meta: {
                  mode: "direct",
                  max_stage: maxStage,
                  skip_stages: Array.from(skipStages),
                  stopped_after_stage: "location",
                },
              },
              200
            );
          }

          if (shouldRunStage("location") && geocodeStageCompleted) {
            for (let i = 0; i < enriched.length; i += 1) {
              const c = enriched[i];

              const hqMeaningful = asMeaningfulString(c?.headquarters_location);
              const hasMfg = isRealValue("manufacturing_locations", c?.manufacturing_locations, c);

              if (!hqMeaningful) {
                // Terminal sentinel: we have attempted location enrichment and still found no HQ.
                const existingDebug = c?.enrichment_debug && typeof c.enrichment_debug === "object" ? c.enrichment_debug : {};
                const sources = Array.isArray(c?.location_sources) ? c.location_sources.slice(0, 10) : [];

                enriched[i] = {
                  ...c,
                  headquarters_location: "Not disclosed",
                  hq_unknown: true,
                  hq_unknown_reason: "not_disclosed",
                  red_flag: true,
                  red_flag_reason: String(c?.red_flag_reason || "Headquarters not disclosed").trim(),
                  enrichment_debug: {
                    ...existingDebug,
                    location: {
                      at: new Date().toISOString(),
                      outcome: "not_disclosed",
                      missing_hq: true,
                      missing_mfg: !hasMfg,
                      location_sources_count: Array.isArray(c?.location_sources) ? c.location_sources.length : 0,
                      location_sources: sources,
                    },
                  },
                };
              }

              if (!hasMfg && !c?.mfg_unknown) {
                // Non-retryable terminal sentinel (explicit + typed).
                const existingDebug = c?.enrichment_debug && typeof c.enrichment_debug === "object" ? c.enrichment_debug : {};
                const sources = Array.isArray(c?.location_sources) ? c.location_sources.slice(0, 10) : [];

                enriched[i] = {
                  ...(enriched[i] || c),
                  manufacturing_locations: ["Not disclosed"],
                  manufacturing_locations_reason: "not_disclosed",
                  mfg_unknown: true,
                  mfg_unknown_reason: "not_disclosed",
                  red_flag: true,
                  red_flag_reason: String(
                    (enriched[i] || c)?.red_flag_reason || "Manufacturing locations not disclosed"
                  ).trim(),
                  enrichment_debug: {
                    ...existingDebug,
                    location: {
                      at: new Date().toISOString(),
                      outcome: "not_disclosed",
                      missing_hq: !hqMeaningful,
                      missing_mfg: true,
                      location_sources_count: Array.isArray(c?.location_sources) ? c.location_sources.length : 0,
                      location_sources: sources,
                    },
                  },
                };
              }
            }

            enrichedForCounts = enriched;
          }

          // If we're deferring reviews to post-save, ensure every company already has
          // a stable reviews shape so we never finish an import with "reviews missing".
          if (shouldRunStage("reviews") && usePostSaveReviews) {
            const nowReviewsIso = new Date().toISOString();

            for (let i = 0; i < enriched.length; i += 1) {
              const c = enriched[i] && typeof enriched[i] === "object" ? enriched[i] : {};

              const curated = Array.isArray(c.curated_reviews)
                ? c.curated_reviews.filter((r) => r && typeof r === "object")
                : [];

              const reviewCount = Number.isFinite(Number(c.review_count)) ? Number(c.review_count) : curated.length;
              const cursorExisting = c.review_cursor && typeof c.review_cursor === "object" ? c.review_cursor : null;

              const cursor = cursorExisting
                ? { ...cursorExisting }
                : buildReviewCursor({
                    nowIso: nowReviewsIso,
                    count: reviewCount,
                    exhausted: false,
                    last_error: {
                      code: "REVIEWS_PENDING",
                      message: "Reviews will be fetched after company persistence",
                    },
                    prev_cursor: null,
                  });

              if (!cursor.reviews_stage_status) cursor.reviews_stage_status = "pending";

              enriched[i] = {
                ...c,
                curated_reviews: curated,
                review_count: reviewCount,
                reviews_last_updated_at: c.reviews_last_updated_at || nowReviewsIso,
                review_cursor: cursor,
                reviews_stage_status:
                  (typeof c.reviews_stage_status === "string" ? c.reviews_stage_status.trim() : "") || "pending",
                reviews_upstream_status: c.reviews_upstream_status ?? null,
              };
            }
          }

          let saveResult = { saved: 0, failed: 0, skipped: 0 };

          if (!dryRunRequested && enriched.length > 0 && cosmosEnabled) {
            const deadlineBeforeCosmosWrite = checkDeadlineOrReturn("cosmos_write_start");
            if (deadlineBeforeCosmosWrite) return deadlineBeforeCosmosWrite;

            // Enforce canonical "usable import" contract *before* persistence.
            // This ensures we never save partially undefined records.
            try {
              for (let i = 0; i < enriched.length; i += 1) {
                const base = enriched[i] && typeof enriched[i] === "object" ? enriched[i] : {};

                let company_name = String(base.company_name || base.name || "").trim();
                let website_url = String(base.website_url || base.url || base.canonical_url || "").trim();

                const import_missing_fields = Array.isArray(base.import_missing_fields)
                  ? base.import_missing_fields.map((v) => String(v || "").trim()).filter(Boolean)
                  : [];

                const import_missing_reason =
                  base.import_missing_reason && typeof base.import_missing_reason === "object" && !Array.isArray(base.import_missing_reason)
                    ? { ...base.import_missing_reason }
                    : {};

                const import_warnings = Array.isArray(base.import_warnings)
                  ? base.import_warnings.filter((w) => w && typeof w === "object")
                  : [];

                const LOW_QUALITY_MAX_ATTEMPTS = 3;

                const applyLowQualityPolicy = (field, reason) => {
                  const f = String(field || "").trim();
                  const r = String(reason || "").trim();
                  if (!f) return { missing_reason: r || "missing", retryable: true, attemptCount: 0 };

                  const supportsTerminalization = r === "low_quality" || r === "not_found";
                  if (!supportsTerminalization) return { missing_reason: r || "missing", retryable: true, attemptCount: 0 };

                  const terminalReason = r === "low_quality" ? "low_quality_terminal" : "not_found_terminal";

                  const prev = String(import_missing_reason[f] || base?.import_missing_reason?.[f] || "").trim();
                  if (prev === "low_quality_terminal" || prev === "not_found_terminal") {
                    return { missing_reason: prev, retryable: false, attemptCount: LOW_QUALITY_MAX_ATTEMPTS };
                  }

                  const attemptsObj =
                    base.import_low_quality_attempts &&
                    typeof base.import_low_quality_attempts === "object" &&
                    !Array.isArray(base.import_low_quality_attempts)
                      ? { ...base.import_low_quality_attempts }
                      : {};

                  const metaObj =
                    base.import_low_quality_attempts_meta &&
                    typeof base.import_low_quality_attempts_meta === "object" &&
                    !Array.isArray(base.import_low_quality_attempts_meta)
                      ? { ...base.import_low_quality_attempts_meta }
                      : {};

                  const currentRequestId = String(requestId || "").trim();
                  if (currentRequestId) base.import_request_id = currentRequestId;
                  const lastRequestId = String(metaObj[f] || "").trim();

                  if (currentRequestId && lastRequestId !== currentRequestId) {
                    attemptsObj[f] = (Number(attemptsObj[f]) || 0) + 1;
                    metaObj[f] = currentRequestId;
                  }

                  base.import_low_quality_attempts = attemptsObj;
                  base.import_low_quality_attempts_meta = metaObj;

                  const attemptCount = Number(attemptsObj[f]) || 0;

                  if (attemptCount >= LOW_QUALITY_MAX_ATTEMPTS) {
                    return { missing_reason: terminalReason, retryable: false, attemptCount };
                  }

                  return { missing_reason: r, retryable: true, attemptCount };
                };

                const ensureMissing = (field, reason, message, retryable = true) => {
                  const missing_reason = String(reason || "missing");
                  const terminal =
                    missing_reason === "not_disclosed" ||
                    missing_reason === "low_quality_terminal" ||
                    missing_reason === "not_found_terminal";

                  if (!import_missing_fields.includes(field)) import_missing_fields.push(field);

                  // Prefer final, terminal decisions over earlier seed placeholders.
                  const prevReason = String(import_missing_reason[field] || "").trim();
                  if (!prevReason || terminal || prevReason === "seed_from_company_url") {
                    import_missing_reason[field] = missing_reason;
                  }

                  const entry = {
                    field,
                    root_cause: field,
                    missing_reason,
                    retryable: Boolean(retryable),
                    terminal,
                    message: String(message || "missing"),
                  };

                  const existingIndex = import_warnings.findIndex((w) => w && typeof w === "object" && w.field === field);
                  if (existingIndex >= 0) import_warnings[existingIndex] = entry;
                  else import_warnings.push(entry);

                  // Session-level warning (visible in import completion doc)
                  addWarning(`import_missing_${field}_${i}`, {
                    stage: "enrich",
                    root_cause: `missing_${field}`,
                    missing_reason,
                    retryable: Boolean(retryable),
                    terminal,
                    message: String(message || "missing"),
                    company_name: company_name || undefined,
                    website_url: website_url || undefined,
                  });
                };

                // company_name
                if (!company_name) {
                  base.company_name = "Unknown";
                  base.company_name_unknown = true;
                  company_name = base.company_name;
                  ensureMissing("company_name", "missing", "company_name missing; set to placeholder 'Unknown'", false);
                }

                // website_url
                if (!website_url) {
                  base.website_url = "Unknown";
                  base.website_url_unknown = true;
                  if (!String(base.normalized_domain || "").trim()) base.normalized_domain = "unknown";
                  website_url = base.website_url;
                  ensureMissing("website_url", "missing", "website_url missing; set to placeholder 'Unknown'", false);
                }

                // industries — quality gate
                const industriesRaw = Array.isArray(base.industries) ? base.industries : [];
                const industriesSanitized = sanitizeIndustries(industriesRaw);

                if (industriesSanitized.length === 0) {
                  const hadAny = normalizeStringArray(industriesRaw).length > 0;
                  base.industries = ["Unknown"];
                  base.industries_unknown = true;

                  const policy = applyLowQualityPolicy("industries", hadAny ? "low_quality" : "not_found");
                  const messageBase = hadAny
                    ? "Industries present but low-quality (navigation/marketplace buckets); set to placeholder ['Unknown']"
                    : "Industries missing; set to placeholder ['Unknown']";

                  const message =
                    policy.missing_reason === "low_quality_terminal"
                      ? `${messageBase} (terminal after ${policy.attemptCount || LOW_QUALITY_MAX_ATTEMPTS} attempts)`
                      : messageBase;

                  ensureMissing("industries", policy.missing_reason, message, policy.retryable);
                } else {
                  base.industries = industriesSanitized;
                }

                // product keywords — sanitize + quality gate
                if (!Array.isArray(base.keywords)) base.keywords = [];

                const keywordStats = sanitizeKeywords({
                  product_keywords: base.product_keywords,
                  keywords: base.keywords,
                });

                const meetsKeywordQuality = keywordStats.total_raw >= 20 && keywordStats.product_relevant_count >= 10;

                if (meetsKeywordQuality) {
                  base.keywords = keywordStats.sanitized;
                  base.product_keywords = keywordStats.sanitized.join(", ");
                } else {
                  const hadAny = keywordStats.total_raw > 0;
                  base.keywords = keywordStats.sanitized;
                  base.product_keywords = "Unknown";

                  const policy = applyLowQualityPolicy("product_keywords", hadAny ? "low_quality" : "not_found");
                  const messageBase = hadAny
                    ? `product_keywords low quality (raw=${keywordStats.total_raw}, sanitized=${keywordStats.product_relevant_count}); set to placeholder 'Unknown'`
                    : "product_keywords missing; set to placeholder 'Unknown'";

                  const message =
                    policy.missing_reason === "low_quality_terminal"
                      ? `${messageBase} (terminal after ${policy.attemptCount || LOW_QUALITY_MAX_ATTEMPTS} attempts)`
                      : messageBase;

                  ensureMissing("product_keywords", policy.missing_reason, message, policy.retryable);
                }

                // headquarters
                if (!isRealValue("headquarters_location", base.headquarters_location, base)) {
                  const hqReasonRaw = String(base.hq_unknown_reason || "unknown").trim().toLowerCase();
                  const hqValueRaw = String(base.headquarters_location || "").trim().toLowerCase();
                  const hqNotDisclosed =
                    hqReasonRaw === "not_disclosed" || hqValueRaw === "not disclosed" || hqValueRaw === "not_disclosed";

                  base.hq_unknown = true;

                  if (hqNotDisclosed) {
                    base.headquarters_location = "Not disclosed";
                    base.hq_unknown_reason = "not_disclosed";
                    ensureMissing(
                      "headquarters_location",
                      "not_disclosed",
                      "headquarters_location missing; recorded as terminal sentinel 'Not disclosed'",
                      false
                    );
                  } else {
                    base.headquarters_location = "Not disclosed";
                    base.hq_unknown_reason = "not_disclosed";
                    ensureMissing(
                      "headquarters_location",
                      "not_disclosed",
                      "headquarters_location missing; recorded as terminal sentinel 'Not disclosed'",
                      false
                    );
                  }
                }

                // manufacturing
                // Ordering fix: decide the final terminal sentinel first ("Not disclosed") and then generate warnings from that.
                // Never emit "seed_from_company_url" after extractors have run.
                {
                  const rawList = Array.isArray(base.manufacturing_locations)
                    ? base.manufacturing_locations
                    : base.manufacturing_locations == null
                      ? []
                      : [base.manufacturing_locations];

                  const normalized = rawList
                    .map((loc) => {
                      if (typeof loc === "string") return String(loc).trim().toLowerCase();
                      if (loc && typeof loc === "object") {
                        return String(loc.formatted || loc.full_address || loc.address || loc.location || "")
                          .trim()
                          .toLowerCase();
                      }
                      return "";
                    })
                    .filter(Boolean);

                  const hasNotDisclosed = normalized.length > 0 && normalized.every((v) => v === "not disclosed" || v === "not_disclosed");
                  const hasUnknownPlaceholder = normalized.length > 0 && normalized.every((v) => v === "unknown");

                  const hasRealMfg =
                    isRealValue("manufacturing_locations", base.manufacturing_locations, base) && !hasNotDisclosed && !hasUnknownPlaceholder;

                  if (!hasRealMfg) {
                    base.manufacturing_locations = ["Not disclosed"];
                    base.manufacturing_locations_reason = "not_disclosed";
                    base.mfg_unknown = true;
                    base.mfg_unknown_reason = "not_disclosed";

                    ensureMissing(
                      "manufacturing_locations",
                      "not_disclosed",
                      "manufacturing_locations missing; recorded as terminal sentinel ['Not disclosed']",
                      false
                    );
                  }
                }

                // logo
                if (!asMeaningfulString(base.logo_url)) {
                  base.logo_url = null;
                  base.logo_status = base.logo_status || "not_found_on_site";
                  base.logo_import_status = base.logo_import_status || "missing";
                  base.logo_stage_status = base.logo_stage_status || "not_found_on_site";
                  ensureMissing("logo", base.logo_stage_status, "logo_url missing or not imported");
                }

                // curated reviews
                if (!Array.isArray(base.curated_reviews)) base.curated_reviews = [];
                if (!Number.isFinite(Number(base.review_count))) base.review_count = base.curated_reviews.length;

                if (base.curated_reviews.length === 0) {
                  ensureMissing("curated_reviews", String(base.reviews_stage_status || "none"), "curated_reviews empty (persisted as empty list)");
                }

                // Persist per-company import diagnostics.
                base.import_missing_fields = import_missing_fields;
                base.import_missing_reason = import_missing_reason;
                base.import_warnings = import_warnings;

                enriched[i] = base;
              }
            } catch {
              // Never block imports on placeholder enforcement.
            }

            mark("cosmos_write_start");
            setStage("saveCompaniesToCosmos");
            console.log(`[import-start] session=${sessionId} saveCompaniesToCosmos start count=${enriched.length}`);
            const saveResultRaw = await saveCompaniesToCosmos({
              companies: enriched,
              sessionId,
              requestId,
              sessionCreatedAt: sessionCreatedAtIso,
              axiosTimeout: timeout,
              saveStub: Boolean(bodyObj?.save_stub || bodyObj?.saveStub),
              getRemainingMs,
            });

            const verification = await verifySavedCompaniesReadAfterWrite(saveResultRaw).catch(() => ({
              verified_ids: [],
              unverified_ids: Array.isArray(saveResultRaw?.saved_ids) ? saveResultRaw.saved_ids : [],
              verified_persisted_items: [],
            }));

            saveResult = applyReadAfterWriteVerification(saveResultRaw, verification);
            saveReport = saveResult;

            const verifiedCount = Number(saveResult.saved_verified_count || 0) || 0;
            const unverifiedIds = Array.isArray(saveResult.saved_company_ids_unverified) ? saveResult.saved_company_ids_unverified : [];

            console.log(
              `[import-start] session=${sessionId} saveCompaniesToCosmos done saved_verified=${verifiedCount} saved_write=${Number(saveResult.saved_write_count || 0) || 0} skipped=${saveResult.skipped} failed=${saveResult.failed}`
            );

            if (Number(saveResult.saved_write_count || 0) > 0 && verifiedCount === 0) {
              addWarning("cosmos_read_after_write_failed", {
                stage: "save",
                root_cause: "read_after_write_failed",
                retryable: true,
                message: "Cosmos write reported success, but read-after-write verification could not read the document back.",
              });
            }

            if (unverifiedIds.length > 0) {
              addWarning("cosmos_saved_unverified", {
                stage: "save",
                root_cause: "read_after_write_partial",
                retryable: true,
                message: `Some saved company IDs could not be verified via read-after-write (${unverifiedIds.length}).`,
              });
            }

            // Critical: persist canonical saved IDs immediately so /import/status can recover even if SWA kills
            // later enrichment stages.
            try {
              const cosmosTarget = await getCompaniesCosmosTargetDiagnostics().catch(() => null);

              const savedCompanyUrls = (Array.isArray(enriched) ? enriched : [])
                .map((c) => String(c?.company_url || c?.website_url || c?.canonical_url || c?.url || "").trim())
                .filter(Boolean)
                .slice(0, 50);

              await upsertCosmosImportSessionDoc({
                sessionId,
                requestId,
                patch: {
                  saved: verifiedCount,
                  saved_count: verifiedCount,
                  saved_verified_count: verifiedCount,
                  saved_company_ids_verified: Array.isArray(saveResult.saved_company_ids_verified) ? saveResult.saved_company_ids_verified : [],
                  saved_company_ids_unverified: Array.isArray(saveResult.saved_company_ids_unverified) ? saveResult.saved_company_ids_unverified : [],
                  saved_company_ids: Array.isArray(saveResult.saved_company_ids_verified) ? saveResult.saved_company_ids_verified : [],
                  saved_company_urls: savedCompanyUrls,
                  saved_ids: Array.isArray(saveResult.saved_company_ids_verified) ? saveResult.saved_company_ids_verified : [],
                  saved_write_count: Number(saveResult.saved_write_count || 0) || 0,
                  saved_ids_write: Array.isArray(saveResult.saved_ids_write) ? saveResult.saved_ids_write : [],
                  skipped_ids: Array.isArray(saveResult.skipped_ids) ? saveResult.skipped_ids : [],
                  failed_items: Array.isArray(saveResult.failed_items) ? saveResult.failed_items : [],
                  ...(cosmosTarget ? cosmosTarget : {}),
                  stage_beacon,
                  status: "running",
                },
              }).catch(() => null);
            } catch {}
          }

          // Reviews stage MUST execute (success or classified failure) before import is considered complete.
          // When enabled, we use the exact same pipeline as the Company Dashboard "Fetch more reviews" button.
          if (!dryRunRequested && cosmosEnabled && shouldRunStage("reviews") && usePostSaveReviews) {
            const companiesContainer = getCompaniesCosmosContainer();
            const persistedItems = Array.isArray(saveResult?.persisted_items) ? saveResult.persisted_items : [];

            if (companiesContainer && persistedItems.length > 0) {
              ensureStageBudgetOrThrow("reviews", "xai_reviews_post_save_start");

              const deadlineBeforePostSaveReviews = checkDeadlineOrReturn("xai_reviews_post_save_start", "reviews");
              if (deadlineBeforePostSaveReviews) return deadlineBeforePostSaveReviews;

              mark("xai_reviews_post_save_start");
              setStage("refreshReviewsPostSave");

              const normalizeReviewsStageStatus = (doc) => {
                const d = doc && typeof doc === "object" ? doc : null;
                if (!d) return "";

                const top = typeof d.reviews_stage_status === "string" ? d.reviews_stage_status.trim() : "";
                if (top) return top;

                const cursorStatus =
                  d.review_cursor && typeof d.review_cursor === "object" && typeof d.review_cursor.reviews_stage_status === "string"
                    ? d.review_cursor.reviews_stage_status.trim()
                    : "";

                return cursorStatus;
              };

              const isTerminalReviewsStageStatus = (status) => {
                const s = typeof status === "string" ? status.trim() : "";
                return Boolean(s && s !== "pending");
              };

              let postSaveReviewsCompleted = true;

              let refreshReviewsHandler = null;
              try {
                const xadminMod = require("../xadmin-api-refresh-reviews/index.js");
                refreshReviewsHandler = xadminMod?.handler;
              } catch {
                refreshReviewsHandler = null;
              }

              for (const item of persistedItems) {
                const companyId = String(item?.id || "").trim();
                if (!companyId) continue;

                const companyIndex = Number.isFinite(Number(item?.index)) ? Number(item.index) : null;
                const companyName = String(item?.company_name || "");
                const normalizedDomain = String(item?.normalized_domain || "").trim();

                const remaining = getRemainingMs();
                const minWindowMs = DEADLINE_SAFETY_BUFFER_MS + 6000;

                // If we cannot safely run the upstream request, persist a classified failure state (never silent).
                if (remaining < minWindowMs || typeof refreshReviewsHandler !== "function") {
                  const nowIso = new Date().toISOString();
                  try {
                    const existingDoc = await readItemWithPkCandidates(companiesContainer, companyId, {
                      id: companyId,
                      normalized_domain: normalizedDomain || "unknown",
                      partition_key: normalizedDomain || "unknown",
                    }).catch(() => null);

                    if (existingDoc) {
                      const prevCursor = existingDoc.review_cursor && typeof existingDoc.review_cursor === "object" ? existingDoc.review_cursor : null;
                      const cursor = buildReviewCursor({
                        nowIso,
                        count: 0,
                        exhausted: false,
                        last_error: {
                          code: "REVIEWS_TIME_BUDGET_EXHAUSTED",
                          message: "Skipped reviews fetch during import due to low remaining time budget",
                          retryable: true,
                        },
                        prev_cursor: prevCursor,
                      });
                      cursor.reviews_stage_status = "upstream_unreachable";

                      const patched = {
                        ...existingDoc,
                        review_cursor: cursor,
                        reviews_stage_status: "upstream_unreachable",
                        reviews_upstream_status: null,
                        reviews_attempts_count: 0,
                        reviews_retry_exhausted: false,
                        updated_at: nowIso,
                      };

                      const upserted = await upsertItemWithPkCandidates(companiesContainer, patched).catch(() => null);
                      if (!upserted || upserted.ok !== true) {
                        postSaveReviewsCompleted = false;
                      }

                      if (companyIndex != null && enriched[companyIndex]) {
                        enriched[companyIndex] = {
                          ...(enriched[companyIndex] || {}),
                          curated_reviews: Array.isArray(patched.curated_reviews) ? patched.curated_reviews : [],
                          review_count: Number(patched.review_count) || 0,
                          review_cursor: patched.review_cursor,
                          reviews_stage_status: patched.reviews_stage_status,
                          reviews_upstream_status: patched.reviews_upstream_status,
                        };
                      }
                    } else {
                      postSaveReviewsCompleted = false;
                    }
                  } catch {}

                  warnReviews({
                    stage: "reviews",
                    root_cause: "upstream_unreachable",
                    retryable: true,
                    upstream_status: null,
                    message:
                      typeof refreshReviewsHandler !== "function"
                        ? "Reviews refresh handler unavailable"
                        : "Skipped reviews due to low remaining time budget",
                    company_name: companyName,
                  });
                  continue;
                }

                // Execute the refresh pipeline with a timeout clamped to remaining budget.
                const timeoutMs = Math.max(
                  5000,
                  Math.min(
                    20000,
                    timeout,
                    Math.trunc(remaining - DEADLINE_SAFETY_BUFFER_MS - UPSTREAM_TIMEOUT_MARGIN_MS)
                  )
                );

                const reqMock = {
                  method: "POST",
                  url: "https://internal/api/xadmin-api-refresh-reviews",
                  headers: new Headers(),
                  json: async () => ({ company_id: companyId, take: 2, timeout_ms: timeoutMs }),
                };

                let refreshPayload = null;
                try {
                  const res = await refreshReviewsHandler(reqMock, context, {
                    companiesContainer,
                    validate_review_urls: false,
                  });
                  refreshPayload = safeJsonParse(res?.body);
                } catch (e) {
                  refreshPayload = { ok: false, root_cause: "unhandled_exception", message: e?.message || String(e) };
                }

                if (!refreshPayload || refreshPayload.ok !== true) {
                  warnReviews({
                    stage: "reviews",
                    root_cause: String(refreshPayload?.root_cause || "unknown"),
                    retryable: typeof refreshPayload?.retryable === "boolean" ? refreshPayload.retryable : true,
                    upstream_status: refreshPayload?.upstream_status ?? null,
                    message: String(refreshPayload?.message || "Reviews stage failed"),
                    company_name: companyName,
                  });
                }

                // Best-effort: load the updated company doc so the import response is consistent with persistence.
                // Critical requirement: do not let the import finalize while reviews_stage_status is missing or still "pending".
                try {
                  let latest = await readItemWithPkCandidates(companiesContainer, companyId, {
                    id: companyId,
                    normalized_domain: normalizedDomain || "unknown",
                    partition_key: normalizedDomain || "unknown",
                  }).catch(() => null);

                  if (!latest) {
                    postSaveReviewsCompleted = false;
                  } else {
                    const latestStatus = normalizeReviewsStageStatus(latest);

                    if (!isTerminalReviewsStageStatus(latestStatus)) {
                      const nowTerminalIso = new Date().toISOString();

                      try {
                        const prevCursor =
                          latest.review_cursor && typeof latest.review_cursor === "object" ? latest.review_cursor : null;

                        const count =
                          typeof latest.review_count === "number" && Number.isFinite(latest.review_count)
                            ? latest.review_count
                            : Array.isArray(latest.curated_reviews)
                              ? latest.curated_reviews.length
                              : 0;

                        const cursor = buildReviewCursor({
                          nowIso: nowTerminalIso,
                          count,
                          exhausted: false,
                          last_error: {
                            code: "REVIEWS_POST_SAVE_DID_NOT_FINALIZE",
                            message: "Reviews stage did not reach a terminal state during import; marking as terminal for diagnostics",
                            retryable: true,
                          },
                          prev_cursor: prevCursor,
                        });
                        cursor.reviews_stage_status = "unhandled_exception";

                        const patched = {
                          ...latest,
                          review_cursor: cursor,
                          reviews_stage_status: "unhandled_exception",
                          reviews_upstream_status: null,
                          updated_at: nowTerminalIso,
                        };

                        const upserted = await upsertItemWithPkCandidates(companiesContainer, patched).catch(() => null);
                        if (upserted && upserted.ok === true) {
                          latest = patched;
                        } else {
                          postSaveReviewsCompleted = false;
                        }

                        warnReviews({
                          stage: "reviews",
                          root_cause: "unhandled_exception",
                          retryable: true,
                          upstream_status: null,
                          message: "Reviews stage did not finalize during import; marking terminal state",
                          company_name: companyName,
                        });
                      } catch {
                        postSaveReviewsCompleted = false;
                      }
                    }
                  }

                  if (latest && companyIndex != null && enriched[companyIndex]) {
                    enriched[companyIndex] = {
                      ...(enriched[companyIndex] || {}),
                      curated_reviews: Array.isArray(latest.curated_reviews) ? latest.curated_reviews : [],
                      review_count: Number(latest.review_count) || 0,
                      reviews_last_updated_at: latest.reviews_last_updated_at || (enriched[companyIndex] || {}).reviews_last_updated_at,
                      review_cursor: latest.review_cursor || (enriched[companyIndex] || {}).review_cursor,
                      reviews_stage_status:
                        typeof latest.reviews_stage_status === "string" && latest.reviews_stage_status.trim()
                          ? latest.reviews_stage_status.trim()
                          : typeof latest?.review_cursor?.reviews_stage_status === "string"
                            ? latest.review_cursor.reviews_stage_status
                            : (enriched[companyIndex] || {}).reviews_stage_status,
                      reviews_upstream_status: latest.reviews_upstream_status ?? (enriched[companyIndex] || {}).reviews_upstream_status,
                    };
                  }
                } catch {
                  postSaveReviewsCompleted = false;
                }
              }

              // Final guard: do not allow completion while any persisted company remains pending/missing.
              try {
                const pendingCompanyIds = [];

                for (const item of persistedItems) {
                  const companyId = String(item?.id || "").trim();
                  if (!companyId) continue;

                  const normalizedDomain = String(item?.normalized_domain || "").trim();

                  const latest = await readItemWithPkCandidates(companiesContainer, companyId, {
                    id: companyId,
                    normalized_domain: normalizedDomain || "unknown",
                    partition_key: normalizedDomain || "unknown",
                  }).catch(() => null);

                  const status = normalizeReviewsStageStatus(latest);
                  if (!isTerminalReviewsStageStatus(status)) {
                    pendingCompanyIds.push(companyId);
                  }
                }

                if (pendingCompanyIds.length > 0) {
                  postSaveReviewsCompleted = false;
                  warnReviews({
                    stage: "reviews",
                    root_cause: "pending",
                    retryable: true,
                    upstream_status: null,
                    message: `Reviews stage still pending for ${pendingCompanyIds.length} persisted compan${pendingCompanyIds.length === 1 ? "y" : "ies"}; import will not finalize as complete`,
                    company_name: "",
                  });
                }
              } catch {
                postSaveReviewsCompleted = false;
              }

              reviewStageCompleted = postSaveReviewsCompleted;
              mark(postSaveReviewsCompleted ? "xai_reviews_post_save_done" : "xai_reviews_post_save_partial");
            }
          }

          const effectiveResultCountForExpansion = cosmosEnabled ? saveResult.saved + saveResult.failed : enriched.length;

          // If expand_if_few is enabled and we got very few results (or all were skipped), try alternative search
          // But skip if we're running out of time
          const minThreshold = Math.max(1, Math.ceil(xaiPayload.limit * 0.6));
          if (shouldRunStage("expand") && xaiPayload.expand_if_few && effectiveResultCountForExpansion < minThreshold && companies.length > 0 && !shouldAbort()) {
            console.log(
              `[import-start] Few results found (${cosmosEnabled ? `${saveResult.saved} saved, ${saveResult.skipped} skipped` : `${enriched.length} found (no_cosmos mode)`}). Attempting expansion search.`
            );

            try {
              // Create a more general search prompt for related companies
              const expansionMessage = {
                role: "user",
                content: `You previously found companies for "${xaiPayload.query}" (${xaiPayload.queryType}).
Find ${xaiPayload.limit} MORE DIFFERENT companies that are related to "${xaiPayload.query}" (search type(s): ${xaiPayload.queryType}${xaiPayload.location ? `, location boost: ${xaiPayload.location}` : ""}) but were not in the previous results.
PRIORITIZE finding smaller, regional, and lesser-known companies that are alternatives to major brands.
Focus on independent manufacturers, craft producers, specialty companies, and regional players that serve the same market.

For EACH company, you MUST AGGRESSIVELY extract:
1. headquarters_location: City, State/Region, Country format (required - check official site, government buyer guides, B2B directories, LinkedIn, Crunchbase)
2. manufacturing_locations: Array of locations from ALL sources including:
   - Official site and product pages
   - Government Buyer Guides (Yumpu, GSA, etc.) - often list manufacturing explicitly
   - B2B/Industrial Manufacturer Directories (Thomas Register, etc.)
   - Supplier and import/export records
   - Packaging claims and "Made in..." labels
   - Media articles
   Be AGGRESSIVE in extraction - NEVER return empty without exhaustively checking all sources above
   - Country-only entries (e.g., "United States", "China") are FULLY ACCEPTABLE

Format your response as a valid JSON array with this structure:
- company_name (string)
- website_url (string)
- industries (array)
- product_keywords (string): Comma-separated list of up to 25 concrete product keywords (real products/product lines/product categories; no vague marketing terms; prefer noun phrases; include flagship + secondary products; infer industry-standard product types if needed; no near-duplicates; no services unless primarily services)
- headquarters_location (string, REQUIRED - "City, State/Region, Country" format, or empty only if truly unknown after checking all sources)
- manufacturing_locations (array, REQUIRED - must include all locations from government guides, B2B directories, suppliers, customs, packaging, media. Use country-only entries if that's all known. NEVER empty without exhaustive checking)
- red_flag (boolean, optional)
- red_flag_reason (string, optional)
- location_confidence (string, optional)
- amazon_url, social (optional)

IMPORTANT: Do not leave manufacturing_locations empty after checking government guides, B2B directories, and trade data. Prefer "United States" or "China" over empty array.

Return ONLY the JSON array, no other text.`,
              };

              const expansionPayload = {
                model: "grok-4-latest",
                messages: [
                  { role: "system", content: XAI_SYSTEM_PROMPT },
                  expansionMessage,
                ],
                // Expansion prompt asks for HQ/MFG using third-party sources; enforce live search.
                search_parameters: { mode: "on" },
                temperature: 0.3,
                stream: false,
              };

              console.log(
                `[import-start] Making expansion search for "${xaiPayload.query}" (upstream=${toHostPathOnlyForLog(xaiUrl)})`
              );

              ensureStageBudgetOrThrow("expand", "xai_expand_fetch_start");

              const deadlineBeforeExpand = checkDeadlineOrReturn("xai_expand_fetch_start", "expand");
              if (deadlineBeforeExpand) return deadlineBeforeExpand;

              mark("xai_expand_fetch_start");
              const expansionResponse = await postXaiJsonWithBudgetRetry({
                stageKey: "expand",
                stageBeacon: "xai_expand_fetch_start",
                body: JSON.stringify(expansionPayload),
                stageCapMsOverride: Math.min(timeout, 25000),
              });

              if (expansionResponse.status >= 200 && expansionResponse.status < 300) {
                const expansionText = expansionResponse.data?.choices?.[0]?.message?.content || "";
                console.log(`[import-start] Expansion response preview: ${expansionText.substring(0, 100)}...`);

                let expansionCompanies = [];
                try {
                  const jsonMatch = expansionText.match(/\[[\s\S]*\]/);
                  if (jsonMatch) {
                    expansionCompanies = JSON.parse(jsonMatch[0]);
                    if (!Array.isArray(expansionCompanies)) expansionCompanies = [];
                  }
                } catch (parseErr) {
                  console.warn(`[import-start] Failed to parse expansion companies: ${parseErr.message}`);
                }

                console.log(`[import-start] Found ${expansionCompanies.length} companies in expansion search`);

                if (expansionCompanies.length > 0) {
                  let enrichedExpansion = expansionCompanies.map((c) => enrichCompany(c, center));
                  enrichedExpansion = await mapWithConcurrency(enrichedExpansion, 4, ensureCompanyKeywords);

                  // Geocode expansion companies
                  console.log(`[import-start] Geocoding ${enrichedExpansion.length} expansion companies`);
                  for (let i = 0; i < enrichedExpansion.length; i++) {
                    const company = enrichedExpansion[i];
                    if (company.headquarters_location && company.headquarters_location.trim()) {
                      const geoResult = await geocodeHQLocation(company.headquarters_location);
                      if (geoResult.hq_lat !== undefined && geoResult.hq_lng !== undefined) {
                        enrichedExpansion[i] = { ...company, ...geoResult };
                        console.log(`[import-start] Geocoded expansion company ${company.company_name}: ${company.headquarters_location} → (${geoResult.hq_lat}, ${geoResult.hq_lng})`);
                      }
                    }
                  }

                  // Reviews are Grok-only (xAI live search) and run post-save for persisted companies.
                  if (assertNoWebsiteFallback("reviews")) {
                    console.log(
                      `[import-start] Skipping pre-save reviews for expansion companies (Grok-only post-save stage).`
                    );
                  }

                  enriched = enriched.concat(enrichedExpansion);

                  // Re-save with expansion results
                  if (cosmosEnabled) {
                    const expansionRaw = await saveCompaniesToCosmos({
                      companies: enrichedExpansion,
                      sessionId,
                      requestId,
                      sessionCreatedAt: sessionCreatedAtIso,
                      axiosTimeout: timeout,
                      saveStub: Boolean(bodyObj?.save_stub || bodyObj?.saveStub),
                      getRemainingMs,
                    });

                    const expansionVerification = await verifySavedCompaniesReadAfterWrite(expansionRaw).catch(() => ({
                      verified_ids: [],
                      unverified_ids: Array.isArray(expansionRaw?.saved_ids) ? expansionRaw.saved_ids : [],
                      verified_persisted_items: [],
                    }));

                    const expansionResult = applyReadAfterWriteVerification(expansionRaw, expansionVerification);

                    const mergeUnique = (a, b) => {
                      const out = [];
                      const seen = new Set();
                      for (const id of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
                        const key = String(id || "").trim();
                        if (!key || seen.has(key)) continue;
                        seen.add(key);
                        out.push(key);
                      }
                      return out;
                    };

                    const mergedVerifiedIds = mergeUnique(
                      Array.isArray(saveResult?.saved_company_ids_verified) ? saveResult.saved_company_ids_verified : saveResult?.saved_ids,
                      Array.isArray(expansionResult?.saved_company_ids_verified) ? expansionResult.saved_company_ids_verified : expansionResult?.saved_ids
                    );

                    const mergedUnverifiedIds = mergeUnique(
                      Array.isArray(saveResult?.saved_company_ids_unverified) ? saveResult.saved_company_ids_unverified : [],
                      Array.isArray(expansionResult?.saved_company_ids_unverified) ? expansionResult.saved_company_ids_unverified : []
                    );

                    const mergedWriteIds = mergeUnique(
                      Array.isArray(saveResult?.saved_ids_write) ? saveResult.saved_ids_write : [],
                      Array.isArray(expansionResult?.saved_ids_write) ? expansionResult.saved_ids_write : []
                    );

                    saveResult = {
                      ...(saveResult && typeof saveResult === "object" ? saveResult : {}),
                      saved: mergedVerifiedIds.length,
                      saved_verified_count: mergedVerifiedIds.length,
                      saved_company_ids_verified: mergedVerifiedIds,
                      saved_company_ids_unverified: mergedUnverifiedIds,
                      saved_ids: mergedVerifiedIds,
                      saved_write_count: (Number(saveResult?.saved_write_count || 0) || 0) + (Number(expansionResult?.saved_write_count || 0) || 0),
                      saved_ids_write: mergedWriteIds,
                      skipped: (Number(saveResult?.skipped || 0) || 0) + (Number(expansionResult?.skipped || 0) || 0),
                      failed: (Number(saveResult?.failed || 0) || 0) + (Number(expansionResult?.failed || 0) || 0),
                      persisted_items: [
                        ...(Array.isArray(saveResult?.persisted_items) ? saveResult.persisted_items : []),
                        ...(Array.isArray(expansionResult?.persisted_items) ? expansionResult.persisted_items : []),
                      ],
                    };

                    saveReport = saveResult;
                    console.log(
                      `[import-start] Expansion: saved_verified ${Number(expansionResult.saved_verified_count || 0) || 0}, saved_write ${Number(expansionResult.saved_write_count || 0) || 0}, skipped ${expansionResult.skipped}, failed ${expansionResult.failed}`
                    );
                  }
                }
              }
            } catch (expansionErr) {
              if (expansionErr instanceof AcceptedResponseError) throw expansionErr;
              console.warn(`[import-start] Expansion search failed: ${expansionErr.message}`);
              // Continue without expansion results
            } finally {
              mark("xai_expand_fetch_done");
            }
          }

          const elapsed = Date.now() - startTime;
          const timedOut = isOutOfTime();

          if (noCosmosMode) {
            try {
              upsertImportSession({
                session_id: sessionId,
                request_id: requestId,
                status: "complete",
                stage_beacon,
                companies_count: Array.isArray(enriched) ? enriched.length : 0,
              });
            } catch {}

            return jsonWithRequestId(
              {
                ok: true,
                no_cosmos: true,
                stage_reached: stage_reached || "after_xai_primary_fetch",
                stage_beacon,
                session_id: sessionId,
                request_id: requestId,
                xai_request_id: contextInfo.xai_request_id,
                resolved_upstream_url_redacted: redactUrlQueryAndHash(xaiUrl) || null,
                build_id: buildInfo?.build_id || null,
                companies: enriched,
                meta: {
                  mode: "direct",
                  expanded: xaiPayload.expand_if_few && effectiveResultCountForExpansion < minThreshold,
                  timedOut: timedOut,
                  elapsedMs: elapsed,
                  cosmos_skipped: true,
                },
              },
              200
            );
          }

          const computeEnrichmentMissingFields = (company) => {
            const c = company && typeof company === "object" ? company : {};

            // Required fields here are the ones that gate the "verified" UX.
            // Use the centralized contract (placeholders like "Unknown" do NOT count as present).
            const missing = [];
            if (!isRealValue("industries", c.industries, c)) missing.push("industries");
            if (!isRealValue("product_keywords", c.product_keywords, c)) missing.push("product_keywords");
            if (!isRealValue("headquarters_location", c.headquarters_location, c)) missing.push("headquarters_location");
            if (!isRealValue("manufacturing_locations", c.manufacturing_locations, c)) missing.push("manufacturing_locations");

            return missing;
          };

          const enrichmentMissingByCompany = (Array.isArray(enriched) ? enriched : [])
            .map((c) => {
              const missing = computeEnrichmentMissingFields(c);
              if (missing.length === 0) return null;
              return {
                company_name: String(c?.company_name || c?.name || "").trim(),
                website_url: String(c?.website_url || c?.url || "").trim(),
                normalized_domain: String(c?.normalized_domain || "").trim(),
                missing_fields: missing,
              };
            })
            .filter(Boolean);

          // Default to allowing the resume-worker (so required fields complete automatically)
          // unless the caller explicitly disables it.
          const allowResumeWorker = !(
            bodyObj?.allow_resume_worker === false ||
            bodyObj?.allowResumeWorker === false ||
            bodyObj?.allowResume === false ||
            String(readQueryParam(req, "allow_resume_worker") || "").trim() === "0" ||
            String(readQueryParam(req, "allowResumeWorker") || "").trim() === "0" ||
            String(readQueryParam(req, "allowResume") || "").trim() === "0"
          );

          const hasPersistedWrite =
            Number(saveResult.saved_write_count || 0) > 0 ||
            (Array.isArray(saveResult.saved_ids_write) && saveResult.saved_ids_write.length > 0);

          const hasMissingRequired = enrichmentMissingByCompany.length > 0;

          // Default (single-path) behavior: if we persisted anything but required enrichment fields are still missing,
          // fail deterministically rather than relying on a separate resume-worker invocation.
          if (!dryRunRequested && cosmosEnabled && hasPersistedWrite && hasMissingRequired && !allowResumeWorker) {
            mark("required_fields_missing_single_path");

            const failedAt = new Date().toISOString();

            const last_error = {
              code: "REQUIRED_FIELDS_MISSING",
              message:
                "Import incomplete: required fields missing after inline stages. Resume-worker is disabled (single-path), so failing deterministically.",
            };

            if (cosmosEnabled) {
              try {
                const container = getCompaniesCosmosContainer();
                if (container) {
                  const errorDoc = {
                    id: `_import_error_${sessionId}`,
                    ...buildImportControlDocBase(sessionId),
                    request_id: requestId,
                    stage: "required_fields_missing",
                    error: last_error,
                    details: {
                      stage_beacon,
                      deferred_stages: Array.from(deferredStages),
                      missing_by_company: enrichmentMissingByCompany,
                      saved_write_count: Number(saveResult.saved_write_count || 0) || 0,
                      saved_ids_write: Array.isArray(saveResult.saved_ids_write) ? saveResult.saved_ids_write : [],
                      saved_verified_count: Number(saveResult.saved_verified_count ?? saveResult.saved ?? 0) || 0,
                      saved_company_ids_verified: Array.isArray(saveResult.saved_company_ids_verified)
                        ? saveResult.saved_company_ids_verified
                        : [],
                      saved_company_ids_unverified: Array.isArray(saveResult.saved_company_ids_unverified)
                        ? saveResult.saved_company_ids_unverified
                        : [],
                    },
                    failed_at: failedAt,
                  };

                  await upsertItemWithPkCandidates(container, errorDoc).catch(() => null);

                  await upsertCosmosImportSessionDoc({
                    sessionId,
                    requestId,
                    patch: {
                      status: "error",
                      stage_beacon: "required_fields_missing",
                      last_error,
                      save_outcome: typeof saveResult?.save_outcome === "string" ? saveResult.save_outcome : null,
                      saved: Number(saveResult.saved || 0) || 0,
                      skipped: Number(saveResult.skipped || 0) || 0,
                      failed: Number(saveResult.failed || 0) || 0,
                      saved_count: Number(saveResult.saved_write_count || 0) || Number(saveResult.saved || 0) || 0,
                      saved_verified_count: Number(saveResult.saved_verified_count ?? saveResult.saved ?? 0) || 0,
                      saved_company_ids_verified: Array.isArray(saveResult.saved_company_ids_verified)
                        ? saveResult.saved_company_ids_verified
                        : [],
                      saved_company_ids_unverified: Array.isArray(saveResult.saved_company_ids_unverified)
                        ? saveResult.saved_company_ids_unverified
                        : [],
                      saved_company_ids: Array.isArray(saveResult.saved_ids_write)
                        ? saveResult.saved_ids_write
                        : Array.isArray(saveResult.saved_ids)
                          ? saveResult.saved_ids
                          : [],
                      saved_company_urls: (Array.isArray(enriched) ? enriched : [])
                        .map((c) => String(c?.company_url || c?.website_url || c?.canonical_url || c?.url || "").trim())
                        .filter(Boolean)
                        .slice(0, 50),
                      deferred_stages: Array.from(deferredStages),
                      resume_needed: false,
                      resume_updated_at: failedAt,
                      updated_at: failedAt,
                    },
                  }).catch(() => null);
                }
              } catch {}
            }

            try {
              upsertImportSession({
                session_id: sessionId,
                request_id: requestId,
                status: "error",
                stage_beacon: "required_fields_missing",
                companies_count: Array.isArray(enriched) ? enriched.length : 0,
                resume_needed: false,
                last_error,
                saved: Number(saveResult.saved || 0) || 0,
                saved_verified_count: Number(saveResult.saved_verified_count ?? saveResult.saved ?? 0) || 0,
                saved_company_ids_verified: Array.isArray(saveResult.saved_company_ids_verified)
                  ? saveResult.saved_company_ids_verified
                  : [],
                saved_company_ids_unverified: Array.isArray(saveResult.saved_company_ids_unverified)
                  ? saveResult.saved_company_ids_unverified
                  : [],
              });
            } catch {}

            const cosmosTarget = cosmosEnabled ? await getCompaniesCosmosTargetDiagnostics().catch(() => null) : null;

            return jsonWithRequestId(
              {
                ok: false,
                session_id: sessionId,
                request_id: requestId,
                status: "error",
                stage_beacon: "required_fields_missing",
                resume_needed: false,
                last_error,
                deferred_stages: Array.from(deferredStages),
                missing_by_company: enrichmentMissingByCompany,
                ...(cosmosTarget ? cosmosTarget : {}),
                saved_verified_count: Number(saveResult.saved_verified_count ?? saveResult.saved ?? 0) || 0,
                saved_company_ids_verified: Array.isArray(saveResult.saved_company_ids_verified)
                  ? saveResult.saved_company_ids_verified
                  : Array.isArray(saveResult.saved_ids)
                    ? saveResult.saved_ids
                    : [],
                saved_company_ids_unverified: Array.isArray(saveResult.saved_company_ids_unverified)
                  ? saveResult.saved_company_ids_unverified
                  : [],
                saved: saveResult.saved,
                skipped: saveResult.skipped,
                failed: saveResult.failed,
                save_report: {
                  saved: saveResult.saved,
                  saved_verified_count: Number(saveResult.saved_verified_count ?? saveResult.saved ?? 0) || 0,
                  saved_write_count: Number(saveResult.saved_write_count || 0) || 0,
                  skipped: saveResult.skipped,
                  failed: saveResult.failed,
                  saved_ids: Array.isArray(saveResult.saved_ids) ? saveResult.saved_ids : [],
                  saved_ids_verified: Array.isArray(saveResult.saved_company_ids_verified) ? saveResult.saved_company_ids_verified : [],
                  saved_ids_unverified: Array.isArray(saveResult.saved_company_ids_unverified) ? saveResult.saved_company_ids_unverified : [],
                  saved_ids_write: Array.isArray(saveResult.saved_ids_write) ? saveResult.saved_ids_write : [],
                  skipped_ids: Array.isArray(saveResult.skipped_ids) ? saveResult.skipped_ids : [],
                  skipped_duplicates: Array.isArray(saveResult.skipped_duplicates) ? saveResult.skipped_duplicates : [],
                  failed_items: Array.isArray(saveResult.failed_items) ? saveResult.failed_items : [],
                },
              },
              200
            );
          }

          // Only mark the session as resume-needed if we successfully persisted at least one company.
          // Otherwise we can get stuck in "running" forever because resume-worker has nothing to load.
          const needsResume =
            !dryRunRequested &&
            cosmosEnabled &&
            hasMissingRequired &&
            hasPersistedWrite &&
            allowResumeWorker;

          if (needsResume) {
            let resumeDocPersisted = false;
            mark("enrichment_incomplete");

            if (cosmosEnabled) {
              try {
                const container = getCompaniesCosmosContainer();
                if (container) {
                  const resumeDocId = `_import_resume_${sessionId}`;
                  const nowResumeIso = new Date().toISOString();

                  const resumeDoc = {
                    id: resumeDocId,
                    ...buildImportControlDocBase(sessionId),
                    created_at: nowResumeIso,
                    updated_at: nowResumeIso,
                    request_id: requestId,
                    status: gatewayKeyConfigured ? "queued" : "stalled",
                    resume_auth: buildResumeAuthDiagnostics(),
                    ...(gatewayKeyConfigured
                      ? {}
                      : {
                          stalled_at: nowResumeIso,
                          last_error: buildResumeStallError(),
                        }),
                    saved_count: Number(saveResult.saved_write_count || 0) || 0,
                    saved_company_ids: Array.isArray(saveResult.saved_ids_write)
                      ? saveResult.saved_ids_write
                      : Array.isArray(saveResult.saved_ids)
                        ? saveResult.saved_ids
                        : [],
                    saved_company_urls: (Array.isArray(enriched) ? enriched : [])
                      .map((c) => String(c?.company_url || c?.website_url || c?.canonical_url || c?.url || "").trim())
                      .filter(Boolean)
                      .slice(0, 50),
                    deferred_stages: Array.from(deferredStages),
                    missing_by_company: enrichmentMissingByCompany,
                    keywords_stage_completed: Boolean(keywordStageCompleted),
                    reviews_stage_completed: Boolean(reviewStageCompleted),
                    location_stage_completed: Boolean(geocodeStageCompleted),
                  };

                  const resumeUpsert = await upsertItemWithPkCandidates(container, resumeDoc).catch(() => ({ ok: false }));
                  resumeDocPersisted = Boolean(resumeUpsert && resumeUpsert.ok);
                }

                await upsertCosmosImportSessionDoc({
                  sessionId,
                  requestId,
                  patch: {
                    status: "running",
                    stage_beacon: stage_beacon,
                    saved: Number(saveResult.saved || 0) || 0,
                    skipped: Number(saveResult.skipped || 0) || 0,
                    failed: Number(saveResult.failed || 0) || 0,
                    saved_count: Number(saveResult.saved_write_count || 0) || Number(saveResult.saved || 0) || 0,
                    saved_verified_count: Number(saveResult.saved_verified_count ?? saveResult.saved ?? 0) || 0,
                    saved_company_ids_verified: Array.isArray(saveResult.saved_company_ids_verified)
                      ? saveResult.saved_company_ids_verified
                      : [],
                    saved_company_ids_unverified: Array.isArray(saveResult.saved_company_ids_unverified)
                      ? saveResult.saved_company_ids_unverified
                      : [],
                    saved_company_ids: Array.isArray(saveResult.saved_ids_write)
                      ? saveResult.saved_ids_write
                      : Array.isArray(saveResult.saved_ids)
                        ? saveResult.saved_ids
                        : [],
                    saved_company_urls: (Array.isArray(enriched) ? enriched : [])
                      .map((c) => String(c?.company_url || c?.website_url || c?.canonical_url || c?.url || "").trim())
                      .filter(Boolean)
                      .slice(0, 50),
                    deferred_stages: Array.from(deferredStages),
                    saved_ids: Array.isArray(saveResult.saved_ids_write)
                      ? saveResult.saved_ids_write
                      : Array.isArray(saveResult.saved_ids)
                        ? saveResult.saved_ids
                        : [],
                    skipped_ids: Array.isArray(saveResult.skipped_ids) ? saveResult.skipped_ids : [],
                    failed_items: Array.isArray(saveResult.failed_items) ? saveResult.failed_items : [],
                    resume_needed: true,
                    resume_updated_at: new Date().toISOString(),
                  },
                }).catch(() => null);
              } catch {}
            }

            // Auto-trigger the resume worker so missing enrichment stages get another chance
            // without requiring the client to manually poke the worker.
            try {
              const resumeWorkerRequested = !(bodyObj?.auto_resume === false || bodyObj?.autoResume === false);
              const invocationIsResumeWorker = String(new URL(req.url).searchParams.get("resume_worker") || "") === "1";

              if (resumeWorkerRequested && !invocationIsResumeWorker && resumeDocPersisted) {
                const deadlineMs = Math.max(
                  1000,
                  Math.min(Number(process.env.RESUME_WORKER_DEADLINE_MS || 20000) || 20000, 60000)
                );
                const batchLimit = Math.max(
                  1,
                  Math.min(Number(process.env.RESUME_WORKER_BATCH_LIMIT || 8) || 8, 50)
                );

                setTimeout(() => {
                  (async () => {
                    const workerRequest = buildInternalFetchRequest({
                      job_kind: "import_resume",
                    });

                    let statusCode = 0;
                    let workerOk = false;
                    let workerText = "";
                    let workerError = null;

                    let invokeRequestId = workerRequest.request_id || null;
                    let invokeGatewayKeyAttached = Boolean(workerRequest.gateway_key_attached);

                    try {
                      const invokeRes = await invokeResumeWorkerInProcess({
                        session_id: sessionId,
                        context,
                        workerRequest,
                        no_cosmos: !cosmosEnabled,
                        batch_limit: batchLimit,
                        deadline_ms: deadlineMs,
                      });

                      invokeRequestId = invokeRes.request_id || invokeRequestId;
                      invokeGatewayKeyAttached = Boolean(invokeRes.gateway_key_attached);

                      statusCode = Number(invokeRes.status || 0) || 0;
                      workerOk = Boolean(invokeRes.ok);
                      workerText = typeof invokeRes.bodyText === "string" ? invokeRes.bodyText : "";
                      workerError = invokeRes.error;
                    } catch (e) {
                      workerError = e;
                    }

                    if (workerOk) return;

                    const preview = typeof workerText === "string" && workerText ? workerText.slice(0, 2000) : "";
                    const resume_error = workerError?.message || (statusCode ? `resume_worker_in_process_${statusCode}` : "resume_worker_in_process_error");
                    const resume_error_details = {
                      invocation: "in_process",
                      http_status: statusCode,
                      response_text_preview: preview || null,
                      gateway_key_attached: Boolean(invokeGatewayKeyAttached),
                      request_id: invokeRequestId,
                    };

                    try {
                      upsertImportSession({
                        session_id: sessionId,
                        request_id: requestId,
                        status: "running",
                        stage_beacon,
                        resume_needed: true,
                        resume_error,
                        resume_error_details,
                        resume_worker_last_http_status: statusCode,
                        resume_worker_last_reject_layer: "in_process",
                      });
                    } catch {}

                    if (cosmosEnabled) {
                      const now = new Date().toISOString();
                      try {
                        await upsertCosmosImportSessionDoc({
                          sessionId,
                          requestId,
                          patch: {
                            resume_error,
                            resume_error_details,
                            resume_worker_last_http_status: statusCode,
                            resume_worker_last_reject_layer: "in_process",
                            resume_worker_last_trigger_request_id: workerRequest.request_id || null,
                            resume_worker_last_gateway_key_attached: Boolean(workerRequest.gateway_key_attached),
                            resume_error_at: now,
                            updated_at: now,
                          },
                        }).catch(() => null);
                      } catch {}
                    }
                  })().catch(() => {});
                }, 0);
              }
            } catch {}

            return jsonWithRequestId(
              {
                ok: true,
                session_id: sessionId,
                request_id: requestId,
                stage_beacon,
                status: "running",
                resume_needed: true,
                resume: {
                  status: "queued",
                  internal_auth_configured: Boolean(internalAuthConfigured),
                  triggered_in_process: true,
                  ...buildResumeAuthDiagnostics(),
                },
                deferred_stages: Array.from(deferredStages),
                saved_count: Number(saveResult.saved_write_count || 0) || Number(saveResult.saved || 0) || 0,
                saved_company_ids: Array.isArray(saveResult.saved_ids_write)
                  ? saveResult.saved_ids_write
                  : Array.isArray(saveResult.saved_ids)
                    ? saveResult.saved_ids
                    : [],
                saved_company_urls: (Array.isArray(enriched) ? enriched : [])
                  .map((c) => String(c?.company_url || c?.website_url || c?.canonical_url || c?.url || "").trim())
                  .filter(Boolean)
                  .slice(0, 50),
                missing_by_company: enrichmentMissingByCompany,
                companies: enriched,
                saved: saveResult.saved,
                skipped: saveResult.skipped,
                failed: saveResult.failed,
                save_report: {
                  saved: saveResult.saved,
                  skipped: saveResult.skipped,
                  failed: saveResult.failed,
                  saved_ids: Array.isArray(saveResult.saved_ids) ? saveResult.saved_ids : [],
                  skipped_ids: Array.isArray(saveResult.skipped_ids) ? saveResult.skipped_ids : [],
                  skipped_duplicates: Array.isArray(saveResult.skipped_duplicates) ? saveResult.skipped_duplicates : [],
                  failed_items: Array.isArray(saveResult.failed_items) ? saveResult.failed_items : [],
                },
              },
              200
            );
          }

          // Write a completion marker so import-progress knows this session is done
          if (cosmosEnabled) {
            try {
              const container = getCompaniesCosmosContainer();
              if (container) {
                const warningKeyList = Array.from(warningKeys);

                const completionReason = timedOut
                  ? "max_processing_time_exceeded"
                  : warningKeyList.length
                    ? "completed_with_warnings"
                    : "completed_normally";

                const completionDoc = timedOut
                  ? {
                      id: `_import_timeout_${sessionId}`,
                      ...buildImportControlDocBase(sessionId),
                      completed_at: new Date().toISOString(),
                      elapsed_ms: elapsed,
                      reason: completionReason,
                      ...(warningKeyList.length
                        ? {
                            warnings: warningKeyList,
                            warnings_detail,
                            warnings_v2,
                          }
                        : {}),
                    }
                  : {
                      id: `_import_complete_${sessionId}`,
                      ...buildImportControlDocBase(sessionId),
                      completed_at: new Date().toISOString(),
                      elapsed_ms: elapsed,
                      reason: completionReason,
                      saved: saveResult.saved,
                      skipped: saveResult.skipped,
                      failed: saveResult.failed,
                      saved_ids: Array.isArray(saveResult.saved_ids) ? saveResult.saved_ids : [],
                      skipped_ids: Array.isArray(saveResult.skipped_ids) ? saveResult.skipped_ids : [],
                      skipped_duplicates: Array.isArray(saveResult.skipped_duplicates) ? saveResult.skipped_duplicates : [],
                      failed_items: Array.isArray(saveResult.failed_items) ? saveResult.failed_items : [],
                      ...(warningKeyList.length
                        ? {
                            warnings: warningKeyList,
                            warnings_detail,
                            warnings_v2,
                          }
                        : {}),
                    };

                const result = await upsertItemWithPkCandidates(container, completionDoc);
                if (!result.ok) {
                  console.warn(
                    `[import-start] request_id=${requestId} session=${sessionId} failed to upsert completion marker: ${result.error}`
                  );
                } else if (timedOut) {
                  console.log(`[import-start] request_id=${requestId} session=${sessionId} timeout signal written`);
                } else {
                  console.log(
                    `[import-start] request_id=${requestId} session=${sessionId} completion marker written (saved=${saveResult.saved})`
                  );
                }

                await upsertCosmosImportSessionDoc({
                  sessionId,
                  requestId,
                  patch: {
                    status: timedOut ? "timeout" : "complete",
                    stage_beacon,
                    saved: saveResult.saved,
                    skipped: saveResult.skipped,
                    failed: saveResult.failed,
                    saved_ids: Array.isArray(saveResult.saved_ids) ? saveResult.saved_ids : [],
                    skipped_ids: Array.isArray(saveResult.skipped_ids) ? saveResult.skipped_ids : [],
                    failed_items: Array.isArray(saveResult.failed_items) ? saveResult.failed_items : [],
                    completed_at: completionDoc.completed_at,
                    ...(warningKeyList.length
                      ? {
                          warnings: warningKeyList,
                          warnings_detail,
                          warnings_v2,
                        }
                      : {}),
                  },
                }).catch(() => null);
              }
            } catch (e) {
              console.warn(
                `[import-start] request_id=${requestId} session=${sessionId} error writing completion marker: ${e?.message || String(e)}`
              );
            }

            mark("cosmos_write_done");
          }

          try {
            upsertImportSession({
              session_id: sessionId,
              request_id: requestId,
              status: "complete",
              stage_beacon,
              companies_count: Array.isArray(enriched) ? enriched.length : 0,
            });
          } catch {}

          const cosmosTarget = cosmosEnabled ? await getCompaniesCosmosTargetDiagnostics().catch(() => null) : null;

          return jsonWithRequestId(
            {
              ok: true,
              session_id: sessionId,
              request_id: requestId,
              details:
                requestDetails ||
                buildRequestDetails(req, {
                  body_source,
                  body_source_detail,
                  raw_text_preview,
                  raw_text_starts_with_brace,
                }),
              company_name: contextInfo.company_name,
              website_url: contextInfo.website_url,
              companies: enriched,
              meta: {
                mode: "direct",
                expanded: xaiPayload.expand_if_few && effectiveResultCountForExpansion < minThreshold,
                timedOut: timedOut,
                elapsedMs: elapsed,
              },
              completed_with_warnings: Boolean(warningKeys.size),
              ...(cosmosTarget ? cosmosTarget : {}),
              saved_verified_count: Number(saveResult.saved_verified_count ?? saveResult.saved ?? 0) || 0,
              saved_company_ids_verified: Array.isArray(saveResult.saved_company_ids_verified)
                ? saveResult.saved_company_ids_verified
                : Array.isArray(saveResult.saved_ids)
                  ? saveResult.saved_ids
                  : [],
              saved_company_ids_unverified: Array.isArray(saveResult.saved_company_ids_unverified) ? saveResult.saved_company_ids_unverified : [],
              saved: saveResult.saved,
              skipped: saveResult.skipped,
              failed: saveResult.failed,
              save_report: {
                saved: saveResult.saved,
                saved_verified_count: Number(saveResult.saved_verified_count ?? saveResult.saved ?? 0) || 0,
                saved_write_count: Number(saveResult.saved_write_count || 0) || 0,
                skipped: saveResult.skipped,
                failed: saveResult.failed,
                saved_ids: Array.isArray(saveResult.saved_ids) ? saveResult.saved_ids : [],
                saved_ids_verified: Array.isArray(saveResult.saved_company_ids_verified) ? saveResult.saved_company_ids_verified : [],
                saved_ids_unverified: Array.isArray(saveResult.saved_company_ids_unverified) ? saveResult.saved_company_ids_unverified : [],
                saved_ids_write: Array.isArray(saveResult.saved_ids_write) ? saveResult.saved_ids_write : [],
                skipped_ids: Array.isArray(saveResult.skipped_ids) ? saveResult.skipped_ids : [],
                skipped_duplicates: Array.isArray(saveResult.skipped_duplicates) ? saveResult.skipped_duplicates : [],
                failed_items: Array.isArray(saveResult.failed_items) ? saveResult.failed_items : [],
              },
              ...(warningKeys.size ? { warnings: Array.from(warningKeys), warnings_detail, warnings_v2 } : {}),
              ...(debugOutput ? { debug: debugOutput } : {}),
            },
            200
          );
        } else {
          console.error(`[import-start] XAI error status: ${xaiResponse.status}`);
          const upstreamRequestId = extractXaiRequestId(xaiResponse.headers || {});
          const upstreamTextPreview = toTextPreview(xaiResponse.data);

          const xaiUrlForLog = toHostPathOnlyForLog(xaiUrl);
          console.error(
            `[import-start] session=${sessionId} upstream XAI non-2xx (${xaiResponse.status}) url=${xaiUrlForLog}`
          );

          const upstreamStatus = xaiResponse.status;
          const mappedStatus = upstreamStatus >= 400 && upstreamStatus < 500 ? upstreamStatus : 502;

          if (xaiCallMeta && typeof xaiCallMeta === "object") {
            xaiCallMeta.stage = "xai_error";
            xaiCallMeta.upstream_status = upstreamStatus;
          }

          logImportStartMeta({
            request_id: requestId,
            session_id: sessionId,
            handler_version: handlerVersion,
            stage: "xai_error",
            queryTypes,
            query_len: query.length,
            prompt_len: xaiCallMeta?.prompt_len || 0,
            messages_len: xaiCallMeta?.messages_len || 0,
            has_system_message: Boolean(xaiCallMeta?.has_system_message),
            has_user_message: Boolean(xaiCallMeta?.has_user_message),
            user_message_len: Number.isFinite(Number(xaiCallMeta?.user_message_len)) ? Number(xaiCallMeta.user_message_len) : 0,
            elapsedMs: Date.now() - startTime,
            upstream_status: upstreamStatus,
          });

          const failurePayload = {
            ok: false,
            stage: stage_beacon || "xai_primary_fetch_done",
            session_id: sessionId,
            request_id: requestId,
            resolved_upstream_url_redacted: redactUrlQueryAndHash(xaiUrl) || null,
            upstream_status: upstreamStatus,
            xai_request_id: upstreamRequestId || null,
            build_id: buildInfo?.build_id || null,
            error_message: `Upstream XAI returned ${upstreamStatus}`,
            upstream_text_preview: toTextPreview(xaiResponse.data, 1000),
          };

          return jsonWithRequestId({ ...failurePayload, http_status: mappedStatus }, 200);
        }
      } catch (xaiError) {
        if (xaiError instanceof AcceptedResponseError) throw xaiError;
        const elapsed = Date.now() - startTime;
        const xaiUrlForLog = toHostPathOnlyForLog(xaiUrl);
        console.error(
          `[import-start] session=${sessionId} xai call failed url=${xaiUrlForLog}: ${xaiError.message}`
        );
        console.error(`[import-start] session=${sessionId} error code: ${xaiError.code}`);
        if (xaiError.response) {
          console.error(`[import-start] session=${sessionId} xai error status: ${xaiError.response.status}`);
          console.error(
            `[import-start] session=${sessionId} xai error data preview: ${toTextPreview(xaiError.response.data).slice(0, 200)}`
          );
        }

        // Write timeout signal if this took too long
        if (cosmosEnabled && (isOutOfTime() || (xaiError.code === 'ECONNABORTED' || xaiError.message.includes('timeout')))) {
          try {
            console.log(
              `[import-start] request_id=${requestId} session=${sessionId} timeout detected during XAI call, writing timeout signal`
            );
            const container = getCompaniesCosmosContainer();
            if (container) {
              const timeoutDoc = {
                id: `_import_timeout_${sessionId}`,
                ...buildImportControlDocBase(sessionId),
                failed_at: new Date().toISOString(),
                elapsed_ms: elapsed,
                error: toErrorString(xaiError),
              };
              const result = await upsertItemWithPkCandidates(container, timeoutDoc);
              if (!result.ok) {
                console.warn(
                  `[import-start] request_id=${requestId} session=${sessionId} failed to upsert timeout signal: ${result.error}`
                );
              } else {
                console.log(`[import-start] request_id=${requestId} session=${sessionId} timeout signal written`);
              }
            }
          } catch (e) {
            console.warn(
              `[import-start] request_id=${requestId} session=${sessionId} failed to write timeout signal: ${e?.message || String(e)}`
            );
          }
        }

        const upstreamStatus = xaiError?.response?.status || null;
        if (xaiCallMeta && typeof xaiCallMeta === "object") {
          xaiCallMeta.stage = "xai_error";
          xaiCallMeta.upstream_status = upstreamStatus;
          xaiCallMeta.elapsedMs = elapsed;
        }
        const isTimeout =
          isOutOfTime() ||
          xaiError?.code === "ECONNABORTED" ||
          xaiError?.name === "CanceledError" ||
          String(xaiError?.message || "").toLowerCase().includes("timeout") ||
          String(xaiError?.message || "").toLowerCase().includes("aborted");

        const upstreamErrorCode =
          upstreamStatus === 400
            ? "IMPORT_START_UPSTREAM_BAD_REQUEST"
            : upstreamStatus === 401 || upstreamStatus === 403
              ? "IMPORT_START_UPSTREAM_UNAUTHORIZED"
              : upstreamStatus === 429
                ? "IMPORT_START_UPSTREAM_RATE_LIMITED"
                : upstreamStatus === 404
                  ? "IMPORT_START_UPSTREAM_NOT_FOUND"
                  : "IMPORT_START_UPSTREAM_FAILED";

        const upstreamMessage =
          upstreamStatus === 400
            ? "Upstream rejected the request (400)"
            : upstreamStatus === 401 || upstreamStatus === 403
              ? "XAI endpoint rejected the request (unauthorized). Check XAI_EXTERNAL_KEY / authorization settings."
              : upstreamStatus === 429
                ? "XAI endpoint rate-limited the request (429)."
                : upstreamStatus === 404
                  ? "XAI endpoint returned 404 (not found). Check XAI_EXTERNAL_BASE configuration."
                  : `XAI call failed: ${toErrorString(xaiError)}`;

        const mappedStatus = isTimeout ? 504 : upstreamStatus >= 400 && upstreamStatus < 500 ? upstreamStatus : 502;

        const upstreamRequestId = extractXaiRequestId(xaiError?.response?.headers || {});
        const upstreamTextPreview = toTextPreview(xaiError?.response?.data || xaiError?.response?.body || "");

        logImportStartMeta({
          request_id: requestId,
          session_id: sessionId,
          handler_version: handlerVersion,
          stage: "xai_error",
          queryTypes,
          query_len: query.length,
          prompt_len: xaiCallMeta?.prompt_len || 0,
          messages_len: xaiCallMeta?.messages_len || 0,
          has_system_message: Boolean(xaiCallMeta?.has_system_message),
          has_user_message: Boolean(xaiCallMeta?.has_user_message),
          user_message_len: Number.isFinite(Number(xaiCallMeta?.user_message_len)) ? Number(xaiCallMeta.user_message_len) : 0,
          elapsedMs: Date.now() - startTime,
          upstream_status: upstreamStatus,
        });

        const failurePayload = {
          ok: false,
          stage: stage_beacon || "xai_primary_fetch_start",
          session_id: sessionId,
          request_id: requestId,
          resolved_upstream_url_redacted: redactUrlQueryAndHash(xaiUrl) || null,
          upstream_status: upstreamStatus,
          xai_request_id: upstreamRequestId || null,
          build_id: buildInfo?.build_id || null,
          error_message: upstreamMessage || "XAI call failed",
          error_code: upstreamErrorCode,
          upstream_text_preview: toTextPreview(
            xaiError?.response?.data || xaiError?.response?.body || xaiError?.message || String(xaiError || ""),
            1000
          ),
        };

        return jsonWithRequestId({ ...failurePayload, http_status: mappedStatus }, 200);
      }
      } catch (e) {
        if (e instanceof AcceptedResponseError && e.response) {
          const isCompanyUrlImport =
            Array.isArray(queryTypes) &&
            queryTypes.includes("company_url") &&
            typeof query === "string" &&
            query.trim() &&
            looksLikeCompanyUrlQuery(query);

          if (isCompanyUrlImport) {
            const fallback = await respondWithCompanyUrlSeedFallback(e);
            if (fallback) return fallback;
          }

          return e.response;
        }

        return respondError(e, { status: 500 });
      }
    } catch (e) {
      if (e instanceof AcceptedResponseError && e.response) {
        const isCompanyUrlImport =
          Array.isArray(bodyObj?.queryTypes) &&
          bodyObj.queryTypes.map((t) => String(t || "").trim()).includes("company_url") &&
          typeof bodyObj?.query === "string" &&
          bodyObj.query.trim() &&
          looksLikeCompanyUrlQuery(bodyObj.query);

        if (isCompanyUrlImport) {
          const fallback = await respondWithCompanyUrlSeedFallback(e);
          if (fallback) return fallback;
        }

        return e.response;
      }

      const lastStage = String(stage_beacon || stage || "fatal") || "fatal";
      const error_message = toErrorString(e) || "Unhandled error";

      const stackRaw = e && typeof e === "object" && typeof e.stack === "string" ? e.stack : "";
      const stackRedacted = stackRaw
        ? stackRaw
            .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
            .replace(/(xai[_-]?key|function[_-]?key|cosmos[_-]?key)\s*[:=]\s*[^\s]+/gi, "$1=[REDACTED]")
        : "";
      const error_stack_preview = toTextPreview(stackRedacted || "", 2000);

      try {
        upsertImportSession({
          session_id: sessionId,
          request_id: requestId,
          status: "failed",
          stage_beacon: lastStage,
          companies_count: Array.isArray(enrichedForCounts) ? enrichedForCounts.length : 0,
        });
      } catch {}

      console.error("[import-start] Unhandled error:", error_message);

      // Avoid returning 5xx (SWA can mask it as raw text). Always return JSON.
      return jsonWithRequestId(
        {
          ok: false,
          stage: "import_start",
          stage_beacon: lastStage,
          root_cause: "server_exception",
          retryable: true,
          request_id: requestId,
          session_id: sessionId,
          error_message,
          error_stack_preview,
        },
        200
      );
    }
  };

const importStartHandler = async (req, context) => {
  try {
    return await importStartHandlerInner(req, context);
  } catch (e) {
    if (e instanceof AcceptedResponseError && e.response) return e.response;
    let requestId = "";
    try {
      requestId = generateRequestId(req);
    } catch {
      requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }

    const responseHeaders = { "x-request-id": requestId };

    const buildInfoSafe = (() => {
      try {
        return getBuildInfo();
      } catch {
        return { build_id: "unknown", build_id_source: "error", runtime: {} };
      }
    })();

    const handlerVersion = getImportStartHandlerVersion(buildInfoSafe);

    const env_present = {
      has_xai_key: Boolean(getXAIKey()),
      has_xai_base_url: Boolean(getXAIEndpoint()),
      has_import_start_proxy_base: false,
    };

    const defaultModel = "grok-4-0709";
    let resolved_upstream_url_redacted = null;
    try {
      const xaiEndpointRaw = getXAIEndpoint();
      const xaiUrl = resolveXaiEndpointForModel(xaiEndpointRaw, defaultModel);
      resolved_upstream_url_redacted = redactUrlQueryAndHash(xaiUrl) || null;
    } catch {
      resolved_upstream_url_redacted = null;
    }

    const anyErr = e && typeof e === "object" ? e : null;
    const stage = typeof anyErr?.stage === "string" && anyErr.stage.trim() ? anyErr.stage.trim() : "top_level_handler";

    const upstream_status = Number.isFinite(Number(anyErr?.upstream_status)) ? Number(anyErr.upstream_status) : null;

    const xai_request_id =
      typeof anyErr?.xai_request_id === "string" && anyErr.xai_request_id.trim()
        ? anyErr.xai_request_id.trim()
        : null;

    const error_message = toErrorString(e) || "Import start failed";

    const stackRaw = typeof anyErr?.stack === "string" ? anyErr.stack : "";
    const stackRedacted = stackRaw
      ? stackRaw
          .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
          .replace(/(xai[_-]?key|function[_-]?key|cosmos[_-]?key)\s*[:=]\s*[^\s]+/gi, "$1=[REDACTED]")
      : "";

    const error_stack_preview = toTextPreview(stackRedacted || "", 2000);

    const error_id = makeErrorId();
    const stage_beacon = typeof anyErr?.stage_beacon === "string" && anyErr.stage_beacon.trim() ? anyErr.stage_beacon.trim() : stage;

    logImportStartErrorLine({ error_id, stage_beacon, root_cause: "server_exception", err: e });

    console.error("[import-start] Top-level handler error:", error_message);

    return json(
      {
        ok: false,
        stage,
        stage_beacon,
        root_cause: "server_exception",
        retryable: true,
        http_status: 500,
        error_id,
        request_id: requestId,
        handler_version: handlerVersion,
        build_id: buildInfoSafe?.build_id || null,
        resolved_upstream_url_redacted,
        upstream_status,
        xai_request_id,
        error_message,
        error_stack_preview,
        env_present,
      },
      200,
      responseHeaders
    );
  }
};

const xaiSmokeHandler = async (req, context) => {
  try {
    const requestId = generateRequestId(req);
    const responseHeaders = { "x-request-id": requestId };

    const method = String(req.method || "").toUpperCase();
    if (method === "OPTIONS") {
      return {
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Access-Control-Allow-Headers":
            "content-type,authorization,x-functions-key,x-request-id,x-correlation-id,x-session-id,x-client-request-id",
          "Access-Control-Expose-Headers": "x-request-id,x-correlation-id,x-session-id",
          ...responseHeaders,
        },
      };
    }

    if (method !== "GET") {
      return json(
        {
          ok: false,
          error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" },
        },
        405,
        responseHeaders
      );
    }

    const buildInfo = getBuildInfo();
    const handlerVersion = getImportStartHandlerVersion(buildInfo);

    const model = String(readQueryParam(req, "model") || "grok-4-0709").trim() || "grok-4-0709";

    const xaiEndpointRaw = getXAIEndpoint();
    const xaiKey = getXAIKey();
    const xaiUrl = resolveXaiEndpointForModel(xaiEndpointRaw, model);

    const resolved_upstream_url_redacted = redactUrlQueryAndHash(xaiUrl) || null;
    const auth_header_present = Boolean(xaiKey);

    if (!xaiUrl || !xaiKey) {
      return json(
        {
          ok: false,
          handler_version: handlerVersion,
          build_id: buildInfo?.build_id || null,
          resolved_upstream_url_redacted,
          auth_header_present,
          status: null,
          model_returned: null,
        },
        500,
        responseHeaders
      );
    }

    const timeoutMsUsed = Math.min(20000, Number(process.env.XAI_TIMEOUT_MS) || 20000);

    const upstreamBody = {
      model,
      messages: [
        { role: "system", content: XAI_SYSTEM_PROMPT },
        {
          role: "user",
          content:
            'Return ONLY valid JSON with the schema {"ok":true,"source":"xai_smoke"} and no other text.',
        },
      ],
      temperature: 0,
      stream: false,
    };

    const res = await postJsonWithTimeout(xaiUrl, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${xaiKey}`,
      },
      body: JSON.stringify(upstreamBody),
      timeoutMs: timeoutMsUsed,
    });

    const model_returned =
      typeof res?.data?.model === "string" && res.data.model.trim() ? res.data.model.trim() : model;

    const upstream_status = res?.status ?? null;
    const okUpstream = upstream_status === 200;

    const headersObj = res && typeof res === "object" ? res.headers : null;
    const xai_request_id =
      (headersObj && typeof headersObj === "object" && (headersObj["xai-request-id"] || headersObj["x-request-id"] || headersObj["request-id"])) ||
      null;

    return json(
      {
        ok: okUpstream,
        handler_version: handlerVersion,
        build_id: buildInfo?.build_id || null,
        resolved_upstream_url_redacted,
        auth_header_present,
        status: upstream_status,
        model_returned,
        xai_request_id,
      },
      okUpstream ? 200 : 502,
      responseHeaders
    );
  } catch (e) {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const responseHeaders = { "x-request-id": requestId };

    return json(
      {
        ok: false,
        resolved_upstream_url_redacted: null,
        auth_header_present: false,
        status: null,
        model_returned: null,
        upstream_text_preview: toTextPreview(e?.message || String(e || ""), 2000),
      },
      502,
      responseHeaders
    );
  }
};

app.http("xai-smoke", {
  route: "xai/smoke",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: xaiSmokeHandler,
});

const importStartSwaWrapper = require("../_importStartWrapper");

app.http("import-start", {
  route: "import/start",
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => importStartSwaWrapper(req, context),
});

// Legacy alias: some clients still call /api/import-start.
app.http("import-start-legacy", {
  route: "import-start",
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => importStartSwaWrapper(req, context),
});

function createSafeHandler(handler, { stage = "import_start" } = {}) {
  return async (req, context) => {
    try {
      const result = await handler(req, context);

      if (!result || typeof result !== "object") {
        return json(
          {
            ok: false,
            root_cause: "handler_contract",
            stage,
            message: "Handler returned no response",
          },
          200
        );
      }

      const status = Number(result.status || 200) || 200;

      // Never let a raw 5xx response escape: SWA can mask it as plain-text "Backend call failure".
      if (status >= 500) {
        return json(
          {
            ok: false,
            root_cause: "handler_5xx",
            stage,
            http_status: status,
            message: `Handler returned HTTP ${status}`,
          },
          200
        );
      }

      if (result.body && typeof result.body === "object") {
        return {
          ...result,
          status: 200,
          headers: {
            ...(result.headers && typeof result.headers === "object" ? result.headers : {}),
            "Content-Type": "application/json",
          },
          body: JSON.stringify(result.body),
        };
      }

      return result;
    } catch (e) {
      const message = sanitizeTextPreview(e?.message || String(e || "Unhandled exception"));
      try {
        console.error("[import-start] safeHandler caught exception:", message);
      } catch {}
      return json(
        {
          ok: false,
          root_cause: "unhandled_exception",
          message,
          stage,
        },
        200
      );
    }
  };
}

const safeHandler = createSafeHandler(importStartHandler, { stage: "import_start" });

module.exports = {
  handler: safeHandler,
  safeHandler,
  _test: {
    readJsonBody,
    readQueryParam,
    importStartHandler,
    buildReviewsUpstreamPayloadForImportStart,
    createSafeHandler,
  },
};
