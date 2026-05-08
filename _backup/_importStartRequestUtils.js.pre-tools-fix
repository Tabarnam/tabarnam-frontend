let randomUUID;
let createHash;
try {
  ({ randomUUID, createHash } = require("crypto"));
} catch {
  randomUUID = null;
  createHash = null;
}

const XAI_SYSTEM_PROMPT =
  "You are a precise assistant. Follow the user's instructions exactly. When asked for JSON, output ONLY valid JSON with no markdown, no prose, and no extra keys.";

// Helper: Check if the URL is an xAI /responses endpoint (vs /chat/completions)
function isResponsesEndpoint(rawUrl) {
  const raw = String(rawUrl || "").trim().toLowerCase();
  return raw.includes("/v1/responses") || raw.includes("/responses");
}

// Helper: Convert chat/completions payload to /responses format
function convertToResponsesPayload(chatPayload) {
  if (!chatPayload || typeof chatPayload !== "object") return chatPayload;

  // If it already has 'input', it's already in responses format
  if (Array.isArray(chatPayload.input)) return chatPayload;

  // Convert messages array to input array
  const messages = chatPayload.messages;
  if (!Array.isArray(messages)) return chatPayload;

  const responsesPayload = {
    model: chatPayload.model || "grok-4-latest",
    input: messages.map(m => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : String(m.content || ""),
    })),
  };

  // Add search if search_parameters was present
  if (chatPayload.search_parameters) {
    responsesPayload.search = { mode: chatPayload.search_parameters.mode || "on" };
  }

  return responsesPayload;
}

// Helper: Extract text content from xAI response (works for both formats)
function extractXaiResponseText(data) {
  if (!data || typeof data !== "object") return "";

  // Try /responses format first: data.output[0].content[...].text
  if (Array.isArray(data.output)) {
    const firstOutput = data.output[0];
    if (firstOutput?.content) {
      // Find output_text type or use first text
      const textItem = Array.isArray(firstOutput.content)
        ? firstOutput.content.find(c => c?.type === "output_text") || firstOutput.content[0]
        : firstOutput.content;
      if (textItem?.text) return String(textItem.text);
    }
  }

  // Fall back to /chat/completions format: data.choices[0].message.content
  if (Array.isArray(data.choices)) {
    const content = data.choices[0]?.message?.content;
    if (content) return String(content);
  }

  return "";
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

module.exports = {
  XAI_SYSTEM_PROMPT,
  isResponsesEndpoint,
  convertToResponsesPayload,
  extractXaiResponseText,
  AcceptedResponseError,
  logImportStartMeta,
  safeJsonParse,
  InvalidJsonBodyError,
  isBinaryBody,
  binaryBodyToString,
  parseJsonBodyStrict,
  sanitizeTextPreview,
  toTextPreview,
  buildFirstBytesPreview,
  buildHexPreview,
  readQueryParam,
  getBodyType,
  getBodyLen,
  getBodyKeysPreview,
  isProbablyStreamBody,
  parseJsonFromStringOrBinary,
  toBufferChunk,
  readStreamLikeToBuffer,
  parseJsonFromStreamLike,
  isJsonContentType,
  readJsonBody,
  toErrorString,
  getHeader,
  isDebugDiagnosticsEnabled,
  buildBodyDiagnostics,
  buildRequestDetails,
  generateRequestId,
  makeErrorId,
  toStackFirstLine,
  logImportStartErrorLine,
  extractXaiRequestId,
  tryParseUrl,
  looksLikeCompanyUrlQuery,
  isAzureWebsitesUrl,
  joinUrlPath,
  toHostPathOnlyForLog,
  redactUrlQueryAndHash,
  getHostPathFromUrl,
  buildUpstreamResolutionSnapshot,
  buildXaiExecutionPlan,
  resolveXaiEndpointForModel,
  safeParseJsonObject,
  buildXaiPayloadMetaSnapshotFromOutboundBody,
  ensureValidOutboundXaiBodyOrThrow,
  postJsonWithTimeout,
  isProxyExplicitlyDisabled,
  isProxyExplicitlyEnabled,
  buildSaveReport,
};

// ── buildSaveReport ─────────────────────────────────────────────────────────

/**
 * Builds a normalized `save_report` object from a raw saveResult.
 * Called from 7+ response sites to avoid duplicating the 12-field
 * array-safety + numeric-coercion block.
 *
 * @param {object} saveResult  - Raw result from saveCompaniesToCosmos
 * @param {object} [overrides] - Optional field overrides (e.g. { saved: 0, save_outcome })
 * @returns {object}
 */
function buildSaveReport(saveResult, overrides) {
  const r = saveResult && typeof saveResult === "object" ? saveResult : {};
  return {
    saved: Number(r.saved || 0) || 0,
    saved_verified_count: Number(r.saved_verified_count ?? r.saved ?? 0) || 0,
    saved_write_count: Number(r.saved_write_count || 0) || 0,
    skipped: Number(r.skipped || 0) || 0,
    failed: Number(r.failed || 0) || 0,
    saved_ids: Array.isArray(r.saved_ids) ? r.saved_ids : [],
    saved_ids_verified: Array.isArray(r.saved_company_ids_verified) ? r.saved_company_ids_verified : [],
    saved_ids_unverified: Array.isArray(r.saved_company_ids_unverified) ? r.saved_company_ids_unverified : [],
    saved_ids_write: Array.isArray(r.saved_ids_write) ? r.saved_ids_write : [],
    skipped_ids: Array.isArray(r.skipped_ids) ? r.skipped_ids : [],
    skipped_duplicates: Array.isArray(r.skipped_duplicates) ? r.skipped_duplicates : [],
    failed_items: Array.isArray(r.failed_items) ? r.failed_items : [],
    ...overrides,
  };
}
