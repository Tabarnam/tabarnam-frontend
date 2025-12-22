// api/_debugSnapshots.js
// In-memory debug snapshots (no disk). Designed for Azure Functions v4 (Node) handlers.

const SENSITIVE_KEY_RE = /authorization|key|token|secret/i;

let latestIngressSnapshot = null;
let latestEgressSnapshot = null;

function nowIso() {
  return new Date().toISOString();
}

function getHandlerVersion() {
  return (
    (process.env.WEBSITE_COMMIT_HASH || "").trim() ||
    (process.env.GITHUB_SHA || "").trim() ||
    (process.env.SOURCE_VERSION || "").trim() ||
    (process.env.BUILD_BUILDID || "").trim() ||
    (process.env.BUILD_ID || "").trim() ||
    "dev"
  );
}

function isSensitiveKey(key) {
  return SENSITIVE_KEY_RE.test(String(key || ""));
}

function truncate(str, maxLen) {
  const s = typeof str === "string" ? str : String(str || "");
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen);
}

function toHexPreview(str, maxHexChars) {
  const s = typeof str === "string" ? str : String(str || "");
  try {
    const hex = Buffer.from(s, "utf8").toString("hex");
    return hex.length <= maxHexChars ? hex : hex.slice(0, maxHexChars);
  } catch {
    return "";
  }
}

function redactUrlForReturn(rawUrl) {
  const u = String(rawUrl || "").trim();
  if (!u) return "";

  try {
    const parsed = new URL(u);
    // Always redact common Azure function key params and anything sensitive.
    const keysToDelete = [];
    for (const key of parsed.searchParams.keys()) {
      if (String(key).toLowerCase() === "code") keysToDelete.push(key);
      else if (String(key).toLowerCase() === "x-functions-key") keysToDelete.push(key);
      else if (isSensitiveKey(key)) keysToDelete.push(key);
    }
    for (const k of keysToDelete) parsed.searchParams.delete(k);
    return parsed.toString();
  } catch {
    // Best effort: strip query string entirely.
    return u.split("?")[0];
  }
}

function headersToObject(headers) {
  const out = {};
  if (!headers) return out;

  // Web Headers
  if (typeof headers.entries === "function") {
    try {
      for (const [k, v] of headers.entries()) out[String(k || "")] = String(v || "");
      return out;
    } catch {
      return out;
    }
  }

  // Plain object
  if (typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) out[String(k || "")] = String(v || "");
  }

  return out;
}

function redactHeaders(headers, { maxEntries = 50, maxValueLen = 200 } = {}) {
  const obj = headersToObject(headers);
  const entries = Object.entries(obj);
  const limited = entries.slice(0, Math.max(0, maxEntries));

  const out = {};
  for (const [rawKey, rawValue] of limited) {
    const key = String(rawKey || "");
    const value = String(rawValue || "");
    out[key] = isSensitiveKey(key) ? "[REDACTED]" : truncate(value, maxValueLen);
  }
  return out;
}

function computeChatBodyMeta(parsedBody) {
  const isObject = !!parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody);
  const keys = isObject ? Object.keys(parsedBody) : [];

  const model = isObject && typeof parsedBody.model === "string" ? parsedBody.model : null;
  const messages = isObject && Array.isArray(parsedBody.messages) ? parsedBody.messages : [];

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
    parse_ok: true,
    is_object: isObject,
    keys,
    model,
    messages_len: messages.length,
    system_count,
    user_count,
    has_empty_trimmed_content,
    content_lens,
  };
}

function buildIngressSnapshot({ req, rawBodyText, parsedBody, parseOk }) {
  const handler_version = getHandlerVersion();
  const url = (() => {
    try {
      return new URL(req.url);
    } catch {
      return null;
    }
  })();

  const contentType = req.headers?.get ? req.headers.get("content-type") : undefined;
  const contentLengthHeader = req.headers?.get ? req.headers.get("content-length") : undefined;
  const computedLen = typeof rawBodyText === "string" ? Buffer.byteLength(rawBodyText, "utf8") : 0;

  const base = {
    ts: nowIso(),
    handler_version,
    ingress: {
      method: String(req.method || ""),
      path: url ? url.pathname : "",
      content_type: contentType || null,
      content_length: contentLengthHeader ? Number(contentLengthHeader) : computedLen,
      headers_redacted: redactHeaders(req.headers),
      body: null,
    },
  };

  if (!parseOk) {
    const preview = truncate(rawBodyText || "", 200);
    base.ingress.body = {
      parse_ok: false,
      raw_text_preview: preview,
      raw_text_hex_preview: toHexPreview(preview, 200),
    };
    return base;
  }

  base.ingress.body = computeChatBodyMeta(parsedBody);
  return base;
}

function buildEgressSnapshot({ xaiUrl, method, outboundHeaders, outboundBodyJsonText, fetchResult }) {
  const handler_version = getHandlerVersion();
  const parsedBody = (() => {
    try {
      return JSON.parse(outboundBodyJsonText);
    } catch {
      return null;
    }
  })();

  const bodyMeta = parsedBody ? computeChatBodyMeta(parsedBody) : {
    parse_ok: false,
    raw_text_preview: truncate(outboundBodyJsonText || "", 200),
    raw_text_hex_preview: toHexPreview(truncate(outboundBodyJsonText || "", 200), 200),
  };

  return {
    ts: nowIso(),
    handler_version,
    egress: {
      xai_url: redactUrlForReturn(xaiUrl),
      method: String(method || "POST"),
      headers_redacted: redactHeaders(outboundHeaders),
      body: {
        model: bodyMeta.model ?? null,
        messages_len: Number.isFinite(Number(bodyMeta.messages_len)) ? Number(bodyMeta.messages_len) : 0,
        system_count: Number.isFinite(Number(bodyMeta.system_count)) ? Number(bodyMeta.system_count) : 0,
        user_count: Number.isFinite(Number(bodyMeta.user_count)) ? Number(bodyMeta.user_count) : 0,
        has_empty_trimmed_content: !!bodyMeta.has_empty_trimmed_content,
        content_lens: Array.isArray(bodyMeta.content_lens) ? bodyMeta.content_lens : [],
      },
      result: fetchResult && typeof fetchResult === "object" ? fetchResult : null,
    },
  };
}

function setLatestIngressSnapshot(snapshot) {
  latestIngressSnapshot = snapshot || null;
}

function getLatestIngressSnapshot() {
  return latestIngressSnapshot;
}

function setLatestEgressSnapshot(snapshot) {
  latestEgressSnapshot = snapshot || null;
}

function getLatestEgressSnapshot() {
  return latestEgressSnapshot;
}

function isDebugAuthorized(req) {
  const expected = (process.env.DEBUG_KEY || "").trim();
  if (!expected) return false;

  const provided = req?.headers?.get ? String(req.headers.get("x-tabarnam-debug-key") || "").trim() : "";
  if (!provided) return false;
  return provided === expected;
}

module.exports = {
  getHandlerVersion,
  redactUrlForReturn,
  redactHeaders,
  buildIngressSnapshot,
  buildEgressSnapshot,
  setLatestIngressSnapshot,
  getLatestIngressSnapshot,
  setLatestEgressSnapshot,
  getLatestEgressSnapshot,
  isDebugAuthorized,
};
