let app;
try {
  ({ app } = require("@azure/functions"));
} catch {
  app = { http() {} };
}
const axios = require("axios");
const { CosmosClient } = require("@azure/cosmos");
let randomUUID;
try {
  ({ randomUUID } = require("crypto"));
} catch {
  randomUUID = null;
}
const {
  getContainerPartitionKeyPath,
  buildPartitionKeyCandidates,
  getValueAtPath,
} = require("../_cosmosPartitionKey");
const { getXAIEndpoint, getXAIKey } = require("../_shared");
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
const { getBuildInfo } = require("../_buildInfo");
const { getImportStartHandlerVersion } = require("../_handlerVersions");
const { upsertSession: upsertImportSession } = require("../_importSessionStore");

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
const DEFAULT_UPSTREAM_TIMEOUT_MS = 20_000;

const XAI_SYSTEM_PROMPT =
  "You are a precise assistant. Follow the user's instructions exactly. When asked for JSON, output ONLY valid JSON with no markdown, no prose, and no extra keys.";

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

function json(obj, status = 200, extraHeaders) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers":
        "content-type,authorization,x-functions-key,x-request-id,x-correlation-id,x-session-id,x-client-request-id",
      "Access-Control-Expose-Headers": "x-request-id,x-correlation-id,x-session-id",
      ...(extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {}),
    },
    body: JSON.stringify(obj),
  };
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
  if (pathLower.includes("/proxy-xai")) return u.toString();

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

  return {
    ...c,
    headquarters,
    headquarters_locations: headquarters,
    manufacturing_locations: manufacturing_geocodes,
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

// Check if company already exists by normalized domain
async function findExistingCompany(container, normalizedDomain, companyName) {
  if (!container) return null;

  const nameValue = (companyName || "").toLowerCase();

  try {
    let query;
    let parameters;

    if (normalizedDomain && normalizedDomain !== "unknown") {
      query = `
        SELECT c.id
        FROM c
        WHERE c.normalized_domain = @domain
           OR LOWER(c.company_name) = @name
      `;
      parameters = [
        { name: "@domain", value: normalizedDomain },
        { name: "@name", value: nameValue },
      ];
    } else {
      // If domain is unknown, only dedupe by name, not by 'unknown'
      query = `
        SELECT c.id
        FROM c
        WHERE LOWER(c.company_name) = @name
      `;
      parameters = [
        { name: "@name", value: nameValue },
      ];
    }

    const { resources } = await container.items
      .query({ query, parameters }, { enableCrossPartitionQuery: true })
      .fetchAll();

    return resources && resources.length > 0 ? resources[0] : null;
  } catch (e) {
    console.warn(`[import-start] Error checking for existing company: ${e.message}`);
    return null;
  }
}

// Helper: import logo (discover -> fetch w/ retries -> rasterize SVG -> upload to blob)
async function fetchLogo({ companyId, domain, websiteUrl, existingLogoUrl }) {
  if (existingLogoUrl) {
    return {
      ok: true,
      logo_import_status: "imported",
      logo_source_url: existingLogoUrl,
      logo_url: existingLogoUrl,
      logo_error: "",
      logo_discovery_strategy: "provided",
      logo_discovery_page_url: "",
    };
  }

  if (!domain || domain === "unknown") {
    return {
      ok: true,
      logo_import_status: "missing",
      logo_source_url: "",
      logo_url: null,
      logo_error: "missing domain",
      logo_discovery_strategy: "",
      logo_discovery_page_url: "",
    };
  }

  const importCompanyLogo = requireImportCompanyLogo();
  return importCompanyLogo({ companyId, domain, websiteUrl }, console);
}

// Fetch editorial reviews for a company using XAI
async function fetchEditorialReviews(company, xaiUrl, xaiKey, timeout, debugCollector, stageCtx) {
  const companyName = String(company?.company_name || company?.name || "").trim();
  const websiteUrl = String(company?.website_url || company?.url || "").trim();

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
    return [];
  }

  const debug = {
    company_name: companyName,
    website_url: websiteUrl,
    candidates: [],
    kept: 0,
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
      content: `You are a research assistant finding editorial and professional reviews.
For this company, find and summarize up to 3 editorial/professional reviews ONLY.

Company: ${companyName}
Website: ${websiteUrl}
Industries: ${Array.isArray(company.industries) ? company.industries.join(", ") : ""}

CRITICAL REVIEW SOURCE REQUIREMENTS:
You MUST ONLY include editorial and professional sources. Do NOT include:
- Amazon customer reviews
- Google/Yelp reviews
- Customer testimonials or user-generated content
- Social media comments

ONLY accept reviews from:
- Magazines and industry publications
- News outlets and journalists
- Professional review websites
- Independent testing labs (ConsumerLab, Labdoor, etc.)
- Health/product analysis sites
- Major retailer editorial content (blogs, articles written in editorial voice)
- Company blog articles written in editorial/educational voice

Search for editorial commentary about this company and its products. If you find some, return up to 3 reviews. Include variety when possible (positive and critical/mixed). If you find fewer than 3, return only what you find (0-3).

For each review found, return a JSON object with:
{
  "source": "magazine|editorial_site|lab_test|news|professional_review",
  "source_url": "https://example.com/article",
  "title": "Article/review headline",
  "excerpt": "1-2 sentence summary of the editorial analysis or findings",
  "rating": null or number if the source uses a rating,
  "author": "Publication name or author name",
  "date": "YYYY-MM-DD or null if unknown"
}

Return ONLY a valid JSON array of review objects (0-3 items), no other text.
If you find NO editorial reviews after exhaustive search, return an empty array: []`,
    };

    const reviewPayload = {
      model: "grok-4-latest",
      messages: [
        { role: "system", content: XAI_SYSTEM_PROMPT },
        reviewMessage,
      ],
      temperature: 0.2,
      stream: false,
    };

    console.log(
      `[import-start] Fetching editorial reviews for ${companyName} (upstream=${toHostPathOnlyForLog(xaiUrl)})`
    );
    const response = await postJsonWithTimeout(xaiUrl, {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${xaiKey}`,
      },
      body: JSON.stringify(reviewPayload),
      timeoutMs: timeout,
    });

    if (!(response.status >= 200 && response.status < 300)) {
      console.warn(`[import-start] Failed to fetch reviews for ${companyName}: status ${response.status}`);
      if (debugCollector) debugCollector.push({ ...debug, reason: `xai_status_${response.status}` });
      return [];
    }

    const responseText = response.data?.choices?.[0]?.message?.content || "";
    console.log(`[import-start] Review response preview for ${companyName}: ${responseText.substring(0, 80)}...`);

    let reviews = [];
    let parseError = null;
    try {
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        reviews = JSON.parse(jsonMatch[0]);
        if (!Array.isArray(reviews)) reviews = [];
      }
    } catch (err) {
      parseError = err?.message || String(err);
      reviews = [];
    }

    if (parseError) {
      console.warn(`[import-start] Failed to parse reviews for ${companyName}: ${parseError}`);
    }

    const candidates = (Array.isArray(reviews) ? reviews : [])
      .filter((r) => r && typeof r === "object")
      .slice(0, 3);

    const nowIso = new Date().toISOString();
    const curated = [];

    for (const r of candidates) {
      const url = String(r.source_url || r.url || "").trim();
      const title = String(r.title || "").trim();

      if (stageCtx?.setStage) {
        stageCtx.setStage("validateReviews", {
          company_name: companyName,
          website_url: websiteUrl,
          normalized_domain: String(company?.normalized_domain || ""),
          review_url: url,
        });
      }

      const v = await validateCuratedReviewCandidate(
        {
          companyName,
          websiteUrl,
          normalizedDomain: company.normalized_domain || "",
          url,
          title,
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
      debug.candidates.push({
        url,
        title,
        link_status: v?.link_status,
        final_url: v?.final_url,
        is_valid: Boolean(v?.is_valid),
        matched_brand_terms: v?.matched_brand_terms || [],
        match_confidence: v?.match_confidence,
        evidence_snippets_count: evidenceCount,
        reason_if_rejected: v?.reason_if_rejected,
      });

      if (v?.is_valid === true) {
        const show_to_users =
          v.link_status === "ok" &&
          (typeof v.match_confidence !== "number" || v.match_confidence >= 0.7);

        const evidence = Array.isArray(v.evidence_snippets) ? v.evidence_snippets : [];
        const evidenceSentence = evidence.length ? `Evidence: \"${evidence[0]}\".` : "";

        const abstract = title
          ? `The article \"${title}\" explicitly mentions ${companyName}. ${evidenceSentence}`.trim()
          : `This article explicitly mentions ${companyName}. ${evidenceSentence}`.trim();

        curated.push({
          id: `xai_auto_${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.trunc(Math.random() * 1e6)}`,
          source: String(r.source || "editorial_site").trim() || "editorial_site",
          source_url: v.final_url || url,
          title,
          excerpt: "",
          abstract,
          rating: r.rating || null,
          author: String(r.author || "").trim(),
          date: r.date || null,
          created_at: nowIso,
          last_updated_at: nowIso,
          imported_via: "xai_import",

          show_to_users,
          is_public: show_to_users,
          link_status: v.link_status,
          last_checked_at: v.last_checked_at,
          matched_brand_terms: v.matched_brand_terms,
          evidence_snippets: v.evidence_snippets,
          match_confidence: v.match_confidence,
        });
        continue;
      }

      const finalUrl = String(v?.final_url || url || "").trim();
      const host = (() => {
        try {
          return new URL(finalUrl).hostname;
        } catch {
          return "";
        }
      })();

      const companyHost = (() => {
        try {
          return new URL(websiteUrl).hostname;
        } catch {
          return "";
        }
      })();

      const shouldKeepForManual =
        v?.link_status === "blocked" &&
        looksLikeReviewUrl(finalUrl) &&
        host &&
        companyHost &&
        !isSameDomain(host, companyHost);

      if (shouldKeepForManual) {
        curated.push({
          id: `xai_manual_${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.trunc(Math.random() * 1e6)}`,
          source: String(r.source || "editorial_site").trim() || "editorial_site",
          source_url: finalUrl || url,
          title,
          excerpt: String(r.excerpt || "").trim(),
          abstract: "",
          rating: r.rating || null,
          author: String(r.author || "").trim(),
          date: r.date || null,
          created_at: nowIso,
          last_updated_at: nowIso,
          imported_via: "xai_import",

          show_to_users: false,
          is_public: false,
          needs_manual_review: true,
          link_status: v?.link_status,
          last_checked_at: v?.last_checked_at || nowIso,
          matched_brand_terms: v?.matched_brand_terms || [],
          evidence_snippets: v?.evidence_snippets || [],
          match_confidence: typeof v?.match_confidence === "number" ? v.match_confidence : 0,
          validation_reason: v?.reason_if_rejected || "blocked",
        });
      }
    }

    debug.kept = curated.length;

    console.log(`[import-start] Found ${curated.length} curated reviews for ${companyName}`);

    if (debugCollector) {
      debugCollector.push(debug);
    }

    return curated;
  } catch (e) {
    console.warn(`[import-start] Error fetching reviews for ${companyName}: ${e.message}`);
    if (debugCollector) debugCollector.push({ ...debug, reason: e?.message || String(e) });
    return [];
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
async function saveCompaniesToCosmos(companies, sessionId, axiosTimeout) {
  try {
    const endpoint = (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim();
    const key = (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim();
    const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
    const containerId = (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();

    if (!endpoint || !key) {
      console.warn("[import-start] Cosmos DB not configured, skipping save");
      return { saved: 0, failed: 0, skipped: 0 };
    }

    const client = new CosmosClient({ endpoint, key });
    const database = client.database(databaseId);
    const container = database.container(containerId);

    let saved = 0;
    let failed = 0;
    let skipped = 0;

    // Process companies in batches for better concurrency
    const BATCH_SIZE = 4;
    for (let batchStart = 0; batchStart < companies.length; batchStart += BATCH_SIZE) {
      // Check if import was stopped
      if (batchStart > 0) {
        const stopped = await checkIfSessionStopped(sessionId);
        if (stopped) {
          console.log(`[import-start] Import stopped by user after ${saved} companies`);
          break;
        }
      }

      const batch = companies.slice(batchStart, Math.min(batchStart + BATCH_SIZE, companies.length));

      // Process batch in parallel
      const batchResults = await Promise.allSettled(
        batch.map(async (company) => {
          const companyName = company.company_name || company.name || "";

          const normalizedDomain = toNormalizedDomain(
            company.website_url ||
              company.canonical_url ||
              company.url ||
              company.amazon_url ||
              company.normalized_domain ||
              ""
          );

          // Check if company already exists
          const existing = await findExistingCompany(container, normalizedDomain, companyName);
          if (existing) {
            console.log(`[import-start] Skipping duplicate company: ${companyName} (${normalizedDomain})`);
            return { type: "skipped" };
          }

          const finalNormalizedDomain = normalizedDomain && normalizedDomain !== "unknown" ? normalizedDomain : "unknown";

          // Fetch + upload logo for the company
          const companyId = `company_${Date.now()}_${Math.random().toString(36).slice(2)}`;

          const logoImport = await fetchLogo({
            companyId,
            domain: finalNormalizedDomain,
            websiteUrl: company.website_url || company.canonical_url || company.url || "",
            existingLogoUrl: company.logo_url || null,
          });

          // Calculate default rating based on company data
          const hasManufacturingLocations = Array.isArray(company.manufacturing_locations) && company.manufacturing_locations.length > 0;
          const hasHeadquarters = !!(company.headquarters_location && company.headquarters_location.trim());

          // Check for reviews from curated_reviews or legacy fields
          const hasCuratedReviews = Array.isArray(company.curated_reviews) && company.curated_reviews.length > 0;
          const hasEditorialReviews = (company.editorial_review_count || 0) > 0 ||
                                      (Array.isArray(company.reviews) && company.reviews.length > 0) ||
                                      hasCuratedReviews;

          const defaultRatingWithReviews = {
            star1: { value: hasManufacturingLocations ? 1.0 : 0.0, notes: [] },
            star2: { value: hasHeadquarters ? 1.0 : 0.0, notes: [] },
            star3: { value: hasEditorialReviews ? 1.0 : 0.0, notes: [] },
            star4: { value: 0.0, notes: [] },
            star5: { value: 0.0, notes: [] },
          };

          const doc = {
            id: companyId,
            company_name: companyName,
            name: company.name || companyName,
            url: company.url || company.website_url || company.canonical_url || "",
            website_url: company.website_url || company.canonical_url || company.url || "",
            industries: company.industries || [],
            product_keywords: company.product_keywords || "",
            keywords: Array.isArray(company.keywords) ? company.keywords : [],
            normalized_domain: finalNormalizedDomain,
            logo_url: logoImport.logo_url || null,
            logo_source_url: logoImport.logo_source_url || null,
            logo_import_status: logoImport.logo_import_status || "missing",
            logo_error: logoImport.logo_error || "",
            tagline: company.tagline || "",
            location_sources: Array.isArray(company.location_sources) ? company.location_sources : [],
            show_location_sources_to_users: Boolean(company.show_location_sources_to_users),
            hq_lat: company.hq_lat,
            hq_lng: company.hq_lng,
            headquarters_location: company.headquarters_location || "",
            headquarters_locations: company.headquarters_locations || [],
            headquarters: Array.isArray(company.headquarters) ? company.headquarters : Array.isArray(company.headquarters_locations) ? company.headquarters_locations : [],
            manufacturing_locations: company.manufacturing_locations || [],
            manufacturing_geocodes: Array.isArray(company.manufacturing_geocodes) ? company.manufacturing_geocodes : [],
            curated_reviews: Array.isArray(company.curated_reviews) ? company.curated_reviews : [],
            red_flag: Boolean(company.red_flag),
            red_flag_reason: company.red_flag_reason || "",
            location_confidence: company.location_confidence || "medium",
            social: company.social || {},
            amazon_url: company.amazon_url || "",
            rating_icon_type: "star",
            rating: defaultRatingWithReviews,
            source: "xai_import",
            session_id: sessionId,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };

          if (!doc.company_name && !doc.url) {
            throw new Error("Missing company_name and url");
          }

          await container.items.create(doc);
          return { type: "saved" };
        })
      );

      // Process batch results
      for (const result of batchResults) {
        if (result.status === "fulfilled") {
          if (result.value.type === "skipped") {
            skipped++;
          } else if (result.value.type === "saved") {
            saved++;
          }
        } else {
          failed++;
          console.warn(`[import-start] Failed to save company: ${result.reason?.message}`);
        }
      }
    }

    return { saved, failed, skipped };
  } catch (e) {
    console.error("[import-start] Error in saveCompaniesToCosmos:", e.message);
    return { saved: 0, failed: companies?.length || 0, skipped: 0 };
  }
}

// Max time to spend processing (4 minutes, safe from Azure's 5 minute timeout)
const MAX_PROCESSING_TIME_MS = 4 * 60 * 1000;

const importStartHandlerInner = async (req, context) => {
    const requestId = generateRequestId(req);
    const responseHeaders = { "x-request-id": requestId };

    const buildInfo = getBuildInfo();
    const handlerVersion = getImportStartHandlerVersion(buildInfo);

    const jsonWithRequestId = (obj, status = 200) => {
      const payload =
        obj && typeof obj === "object" && !Array.isArray(obj)
          ? { handler_version: handlerVersion, ...obj }
          : { handler_version: handlerVersion, value: obj };
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
    let stage = "init";
    let debugEnabled = false;
    let debugOutput = null;
    let enrichedForCounts = [];

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
          const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;
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

          return jsonWithRequestId(
            {
              ok: false,
              stage: "validate_request",
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
            400
          );
        }
        throw err;
      }

      const proxyQuery = readQueryParam(req, "proxy");
      if (!Object.prototype.hasOwnProperty.call(payload || {}, "proxy") && proxyQuery !== undefined) {
        payload.proxy = proxyQuery;
      }

      const bodyObj = payload && typeof payload === "object" ? payload : {};
      sessionId = bodyObj.session_id || `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;

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

      const deadlineMs = Date.now() + 45_000;

      const allowedStages = ["primary", "keywords", "reviews", "location", "expand"];
      const stageOrder = new Map(allowedStages.map((s, i) => [s, i]));

      const parseStageParam = (raw) => {
        const v = String(raw || "").trim().toLowerCase();
        if (!v) return null;
        return allowedStages.includes(v) ? v : "__invalid__";
      };

      const maxStageRaw = readQueryParam(req, "max_stage");
      const skipStagesRaw = readQueryParam(req, "skip_stages");

      const maxStageParsed = parseStageParam(maxStageRaw);
      const skipStagesList = String(skipStagesRaw || "")
        .split(",")
        .map((s) => String(s || "").trim().toLowerCase())
        .filter(Boolean);

      if (maxStageParsed === "__invalid__") {
        return jsonWithRequestId(
          {
            ok: false,
            session_id: sessionId,
            request_id: requestId,
            stage_beacon,
            error_message: "Invalid max_stage. Expected one of: primary,keywords,reviews,location,expand",
          },
          400
        );
      }

      const skipStages = new Set();
      for (const s of skipStagesList) {
        const parsed = parseStageParam(s);
        if (parsed === "__invalid__") {
          return jsonWithRequestId(
            {
              ok: false,
              session_id: sessionId,
              request_id: requestId,
              stage_beacon,
              error_message: "Invalid skip_stages. Expected comma-separated list from: primary,keywords,reviews,location,expand",
            },
            400
          );
        }
        if (parsed) skipStages.add(parsed);
      }

      const maxStage = maxStageParsed;

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

        const errorPayload = {
          ok: false,
          stage: errorStage,
          session_id: sessionId,
          request_id: requestId,
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

        return jsonWithRequestId(errorPayload, status);
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
      if (!noUpstreamMode && cosmosEnabled) {
        try {
          const container = getCompaniesCosmosContainer();
          if (container) {
            const sessionDoc = {
              id: `_import_session_${sessionId}`,
              ...buildImportControlDocBase(sessionId),
              created_at: new Date().toISOString(),
              request_id: requestId,
              request: {
                query: String(bodyObj.query || ""),
                queryType: String(bodyObj.queryType || ""),
                queryTypes: Array.isArray(bodyObj.queryTypes) ? bodyObj.queryTypes : [],
                location: String(bodyObj.location || ""),
                limit: Number(bodyObj.limit) || 0,
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

      // Helper to check if we're running out of time
      const isOutOfTime = () => {
        const elapsed = Date.now() - startTime;
        return elapsed > MAX_PROCESSING_TIME_MS;
      };

      // Helper to check if we need to abort
      const shouldAbort = () => {
        if (isOutOfTime()) {
          console.warn(`[import-start] TIMEOUT: Processing exceeded ${MAX_PROCESSING_TIME_MS}ms limit`);
          return true;
        }
        return false;
      };

      const respondAcceptedBeforeGatewayTimeout = (nextStageBeacon) => {
        const beacon = String(nextStageBeacon || stage_beacon || stage || "unknown") || "unknown";
        mark(beacon);

        try {
          upsertImportSession({
            session_id: sessionId,
            request_id: requestId,
            status: "running",
            stage_beacon: beacon,
            companies_count: Array.isArray(enrichedForCounts) ? enrichedForCounts.length : 0,
          });
        } catch {}

        return jsonWithRequestId(
          {
            ok: true,
            accepted: true,
            session_id: sessionId,
            request_id: requestId,
            stage_beacon: beacon,
            reason: "deadline_exceeded_returning_202",
          },
          202
        );
      };

      const checkDeadlineOrReturn = (nextStageBeacon) => {
        if (Date.now() > deadlineMs) {
          return respondAcceptedBeforeGatewayTimeout(nextStageBeacon);
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

        // Use a more aggressive timeout to ensure we finish before Azure kills the function
        // Limit to 2 minutes per API call to stay well within Azure's 5 minute limit
        const requestedTimeout = Number(bodyObj.timeout_ms) || 600000;
        const timeout = Math.min(requestedTimeout, 2 * 60 * 1000);
        console.log(`[import-start] Request timeout: ${timeout}ms (requested: ${requestedTimeout}ms)`);

        // Get XAI configuration (consolidated to use XAI_EXTERNAL_BASE primarily)
        const xaiEndpointRaw = getXAIEndpoint();
        const xaiKey = getXAIKey();
        const xaiModel = "grok-4-latest";
        const xaiUrl = resolveXaiEndpointForModel(xaiEndpointRaw, xaiModel);
        const xaiUrlForLog = toHostPathOnlyForLog(xaiUrl);

        console.log(`[import-start] XAI Endpoint: ${xaiEndpointRaw ? "configured" : "NOT SET"}`);
        console.log(`[import-start] XAI Key: ${xaiKey ? "configured" : "NOT SET"}`);
        console.log(`[import-start] Config source: ${process.env.XAI_EXTERNAL_BASE ? "XAI_EXTERNAL_BASE" : process.env.FUNCTION_URL ? "FUNCTION_URL (legacy)" : "none"}`);
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

          const deadlineBeforePrimary = checkDeadlineOrReturn("xai_primary_fetch_start");
          if (deadlineBeforePrimary) return deadlineBeforePrimary;

          if (!shouldRunStage("primary")) {
            mark("xai_primary_fetch_skipped");
            try {
              upsertImportSession({
                session_id: sessionId,
                request_id: requestId,
                status: "complete",
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

          mark("xai_primary_fetch_start");

          const xaiResponse = await postJsonWithTimeout(xaiUrl, {
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${xaiKey}`,
            },
            body: outboundBody,
            timeoutMs: timeout,
          });

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
          enrichedForCounts = enriched;

          // Early exit if no companies found
          if (enriched.length === 0) {
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
                  };

                  const result = await upsertItemWithPkCandidates(container, completionDoc);
                  if (!result.ok) {
                    console.warn(
                      `[import-start] request_id=${requestId} session=${sessionId} failed to upsert completion marker: ${result.error}`
                    );
                  } else {
                    console.log(`[import-start] request_id=${requestId} session=${sessionId} completion marker written`);
                  }
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
            const res = await postJsonWithTimeout(xaiUrl, {
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${xaiKey}`,
              },
              body: JSON.stringify(payload),
              timeoutMs,
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

            return {
              prompt,
              raw_response: text.length > 20000 ? text.slice(0, 20000) : text,
              keywords,
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

                const merged = [...finalList, ...gen.keywords];
                finalList = normalizeProductKeywords(merged, { companyName, websiteUrl }).slice(0, 25);
              } catch (e) {
                debugEntry.generated = true;
                debugEntry.raw_response = e?.message || String(e);
              }
            }

            company.keywords = finalList;
            company.product_keywords = keywordListToString(finalList);

            debugEntry.final_keywords = finalList;
            debugEntry.final_count = finalList.length;

            if (debugOutput) debugOutput.keywords_debug.push(debugEntry);

            return company;
          }

          if (shouldStopAfterStage("primary")) {
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

          const deadlineBeforeKeywords = checkDeadlineOrReturn("xai_keywords_fetch_start");
          if (deadlineBeforeKeywords) return deadlineBeforeKeywords;

          if (shouldRunStage("keywords")) {
            mark("xai_keywords_fetch_start");
            setStage("generateKeywords");

            const keywordsConcurrency = 4;
            for (let i = 0; i < enriched.length; i += keywordsConcurrency) {
              if (Date.now() > deadlineMs) {
                return respondAcceptedBeforeGatewayTimeout("xai_keywords_fetch_start");
              }

              const slice = enriched.slice(i, i + keywordsConcurrency);
              const batch = await Promise.all(
                slice.map(async (company) => {
                  try {
                    return await ensureCompanyKeywords(company);
                  } catch (e) {
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
            mark("xai_keywords_fetch_done");
          } else {
            mark("xai_keywords_fetch_skipped");
          }

          if (shouldStopAfterStage("keywords")) {
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
          if (shouldRunStage("location")) {
            const deadlineBeforeGeocode = checkDeadlineOrReturn("xai_location_geocode_start");
            if (deadlineBeforeGeocode) return deadlineBeforeGeocode;

            mark("xai_location_geocode_start");
            setStage("geocodeLocations");
            console.log(`[import-start] session=${sessionId} geocoding start count=${enriched.length}`);

            for (let i = 0; i < enriched.length; i++) {
              if (Date.now() > deadlineMs) {
                return respondAcceptedBeforeGatewayTimeout("xai_location_geocode_start");
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
            mark("xai_location_geocode_done");
          } else {
            mark("xai_location_geocode_skipped");
          }

          // Fetch editorial reviews for companies
          if (shouldRunStage("reviews") && !shouldAbort()) {
            const deadlineBeforeReviews = checkDeadlineOrReturn("xai_reviews_fetch_start");
            if (deadlineBeforeReviews) return deadlineBeforeReviews;

            mark("xai_reviews_fetch_start");
            setStage("fetchEditorialReviews");
            console.log(`[import-start] session=${sessionId} editorial review enrichment start count=${enriched.length}`);
            for (let i = 0; i < enriched.length; i++) {
              if (Date.now() > deadlineMs) {
                return respondAcceptedBeforeGatewayTimeout("xai_reviews_fetch_start");
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

              if (company.company_name && company.website_url) {
                const editorialReviews = await fetchEditorialReviews(
                  company,
                  xaiUrl,
                  xaiKey,
                  timeout,
                  debugOutput ? debugOutput.reviews_debug : null,
                  { setStage }
                );
                if (editorialReviews.length > 0) {
                  enriched[i] = { ...company, curated_reviews: editorialReviews };
                  console.log(
                    `[import-start] session=${sessionId} fetched ${editorialReviews.length} editorial reviews for ${company.company_name}`
                  );
                } else {
                  enriched[i] = { ...company, curated_reviews: [] };
                }
              } else {
                enriched[i] = { ...company, curated_reviews: [] };
              }
            }
            console.log(`[import-start] session=${sessionId} editorial review enrichment done`);
            mark("xai_reviews_fetch_done");
          } else if (!shouldRunStage("reviews")) {
            mark("xai_reviews_fetch_skipped");
          }

          if (shouldStopAfterStage("reviews")) {
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
                temperature: 0.1,
                stream: false,
              };

              console.log(
                `[import-start] Running location refinement pass for ${companiesNeedingLocationRefinement.length} companies (upstream=${toHostPathOnlyForLog(
                  xaiUrl
                )})`
              );

              const deadlineBeforeLocationRefinement = checkDeadlineOrReturn("xai_location_refinement_fetch_start");
              if (deadlineBeforeLocationRefinement) return deadlineBeforeLocationRefinement;

              mark("xai_location_refinement_fetch_start");
              const refinementResponse = await postJsonWithTimeout(xaiUrl, {
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${xaiKey}`,
                },
                body: JSON.stringify(refinementPayload),
                timeoutMs: timeout,
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

          let saveResult = { saved: 0, failed: 0, skipped: 0 };

          if (enriched.length > 0 && cosmosEnabled) {
            const deadlineBeforeCosmosWrite = checkDeadlineOrReturn("cosmos_write_start");
            if (deadlineBeforeCosmosWrite) return deadlineBeforeCosmosWrite;

            mark("cosmos_write_start");
            setStage("saveCompaniesToCosmos");
            console.log(`[import-start] session=${sessionId} saveCompaniesToCosmos start count=${enriched.length}`);
            saveResult = await saveCompaniesToCosmos(enriched, sessionId, timeout);
            console.log(
              `[import-start] session=${sessionId} saveCompaniesToCosmos done saved=${saveResult.saved} skipped=${saveResult.skipped} duplicates=${saveResult.skipped}`
            );
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
                temperature: 0.3,
                stream: false,
              };

              console.log(
                `[import-start] Making expansion search for "${xaiPayload.query}" (upstream=${toHostPathOnlyForLog(xaiUrl)})`
              );

              const deadlineBeforeExpand = checkDeadlineOrReturn("xai_expand_fetch_start");
              if (deadlineBeforeExpand) return deadlineBeforeExpand;

              mark("xai_expand_fetch_start");
              const expansionResponse = await postJsonWithTimeout(xaiUrl, {
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${xaiKey}`,
                },
                body: JSON.stringify(expansionPayload),
                timeoutMs: timeout,
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

                  // Fetch editorial reviews for expansion companies
                  console.log(`[import-start] Fetching editorial reviews for ${enrichedExpansion.length} expansion companies`);
                  for (let i = 0; i < enrichedExpansion.length; i++) {
                    const company = enrichedExpansion[i];
                    if (company.company_name && company.website_url) {
                      setStage("fetchEditorialReviews", {
                        company_name: String(company?.company_name || company?.name || ""),
                        website_url: String(company?.website_url || company?.url || ""),
                        normalized_domain: String(company?.normalized_domain || ""),
                      });

                      const editorialReviews = await fetchEditorialReviews(
                        company,
                        xaiUrl,
                        xaiKey,
                        timeout,
                        debugOutput ? debugOutput.reviews_debug : null,
                        { setStage }
                      );
                      if (editorialReviews.length > 0) {
                        enrichedExpansion[i] = { ...company, curated_reviews: editorialReviews };
                        console.log(`[import-start] Fetched ${editorialReviews.length} editorial reviews for expansion company ${company.company_name}`);
                      } else {
                        enrichedExpansion[i] = { ...company, curated_reviews: [] };
                      }
                    } else {
                      enrichedExpansion[i] = { ...company, curated_reviews: [] };
                    }
                  }

                  enriched = enriched.concat(enrichedExpansion);

                  // Re-save with expansion results
                  if (cosmosEnabled) {
                    const expansionResult = await saveCompaniesToCosmos(enrichedExpansion, sessionId, timeout);
                    saveResult.saved += expansionResult.saved;
                    saveResult.skipped += expansionResult.skipped;
                    saveResult.failed += expansionResult.failed;
                    console.log(
                      `[import-start] Expansion: saved ${expansionResult.saved}, skipped ${expansionResult.skipped}, failed ${expansionResult.failed}`
                    );
                  }
                }
              }
            } catch (expansionErr) {
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

          // Write a completion marker so import-progress knows this session is done
          if (cosmosEnabled) {
            try {
              const container = getCompaniesCosmosContainer();
              if (container) {
                const completionDoc = timedOut
                  ? {
                      id: `_import_timeout_${sessionId}`,
                      ...buildImportControlDocBase(sessionId),
                      completed_at: new Date().toISOString(),
                      elapsed_ms: elapsed,
                      reason: "max_processing_time_exceeded",
                    }
                  : {
                      id: `_import_complete_${sessionId}`,
                      ...buildImportControlDocBase(sessionId),
                      completed_at: new Date().toISOString(),
                      elapsed_ms: elapsed,
                      reason: "completed_normally",
                      saved: saveResult.saved,
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
              saved: saveResult.saved,
              skipped: saveResult.skipped,
              failed: saveResult.failed,
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

          return jsonWithRequestId(failurePayload, mappedStatus);
        }
      } catch (xaiError) {
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

        return jsonWithRequestId(failurePayload, mappedStatus);
      }
      } catch (e) {
        return respondError(e, { status: 500 });
      }
    } catch (e) {
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

      return {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers":
            "content-type,authorization,x-functions-key,x-request-id,x-correlation-id,x-session-id,x-client-request-id",
          "Access-Control-Expose-Headers": "x-request-id,x-correlation-id,x-session-id",
          ...responseHeaders,
        },
        body: JSON.stringify(
          {
            ok: false,
            stage_beacon: lastStage,
            request_id: requestId,
            session_id: sessionId,
            error_message,
            error_stack_preview,
          },
          null,
          2
        ),
      };
    }
  };

const importStartHandler = async (req, context) => {
  try {
    return await importStartHandlerInner(req, context);
  } catch (e) {
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

    console.error("[import-start] Top-level handler error:", error_message);

    return json(
      {
        ok: false,
        stage,
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
      500,
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

app.http("import-start", {
  route: "import/start",
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: importStartHandler,
});

// Legacy alias: some clients still call /api/import-start.
app.http("import-start-legacy", {
  route: "import-start",
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: importStartHandler,
});

module.exports = {
  _test: {
    readJsonBody,
    readQueryParam,
    importStartHandler,
  },
};
