function asString(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function normalizeHttpStatus(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const code = Math.trunc(n);
  if (code >= 100 && code <= 599) return code;
  return null;
}

function extractUpstreamRequestId(headers) {
  const h = headers && typeof headers === "object" ? headers : {};
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
    get("x-amzn-requestid") ||
    null
  );
}

function truncateText(s, maxLen) {
  const raw = asString(s);
  const n = Math.max(0, Math.trunc(Number(maxLen) || 0));
  if (!n) return raw;
  if (raw.length <= n) return raw;
  return raw.slice(0, n) + `…(+${raw.length - n} chars)`;
}

function safeBodyPreview(data, { maxLen = 4000 } = {}) {
  if (data == null) return null;

  const jsonPreviewOrTruncated = (obj) => {
    try {
      const json = JSON.stringify(obj);
      if (json.length <= maxLen) return { kind: "json", preview: obj };
      return { kind: "json_text", preview: truncateText(json, maxLen) };
    } catch {
      return { kind: "json", preview: obj };
    }
  };

  if (typeof data === "string") {
    const trimmed = data.trim();
    if (!trimmed) return null;

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        return jsonPreviewOrTruncated(parsed);
      }
    } catch {
      // ignore
    }

    return { kind: "text", preview: truncateText(trimmed, maxLen) };
  }

  if (data && typeof data === "object") {
    return jsonPreviewOrTruncated(data);
  }

  return { kind: "text", preview: truncateText(String(data), maxLen) };
}

function redactReviewsUpstreamPayloadForLog(payload, meta) {
  const p = payload && typeof payload === "object" ? payload : {};
  const m = meta && typeof meta === "object" ? meta : {};

  const messages = Array.isArray(p.messages) ? p.messages : [];
  const messages_redacted = messages
    .filter((m) => m && typeof m === "object")
    .map((m) => {
      const role = asString(m.role).trim() || "unknown";
      const content = asString(m.content);
      return {
        role,
        content_len: content.length,
        content_preview: truncateText(content.replace(/\s+/g, " ").trim(), 180),
      };
    });

  const sp = p.search_parameters && typeof p.search_parameters === "object" ? p.search_parameters : {};
  const sources = Array.isArray(sp.sources) ? sp.sources : [];

  const sources_redacted = sources
    .filter((s) => s && typeof s === "object")
    .map((s) => {
      const type = asString(s.type).trim() || "unknown";
      const excludedRaw = Array.isArray(s.excluded_websites) ? s.excluded_websites : null;

      const excluded = excludedRaw
        ? excludedRaw
            .filter((x) => typeof x === "string" && x.trim())
            .map((x) => String(x).trim())
        : [];

      return {
        type,
        excluded_websites_count: excluded.length,
        excluded_websites_hosts_preview: excluded.slice(0, 5),
      };
    });

  return {
    model: asString(p.model).trim() || null,
    temperature: typeof p.temperature === "number" ? p.temperature : null,
    stream: typeof p.stream === "boolean" ? p.stream : null,
    search_parameters: {
      mode: asString(sp.mode).trim() || null,
      sources: sources_redacted,
    },
    messages: messages_redacted,

    // Optional extra diagnostics (kept small + stable for log-only payload shape).
    excluded_websites_original_count:
      typeof m.excluded_websites_original_count === "number" ? m.excluded_websites_original_count : null,
    excluded_websites_used_count: typeof m.excluded_websites_used_count === "number" ? m.excluded_websites_used_count : null,
    excluded_websites_truncated:
      typeof m.excluded_websites_truncated === "boolean" ? m.excluded_websites_truncated : null,
    excluded_hosts_spilled_to_prompt_count:
      typeof m.excluded_hosts_spilled_to_prompt_count === "number" ? m.excluded_hosts_spilled_to_prompt_count : null,
  };
}

function classifyUpstreamFailure({ upstream_status, err_code } = {}) {
  const status = normalizeHttpStatus(upstream_status);

  if (status === 429) {
    return {
      stage_status: "upstream_rate_limited",
      retryable: true,
    };
  }

  if (status != null && status >= 500) {
    return {
      stage_status: "upstream_5xx",
      retryable: true,
    };
  }

  if (status != null && status >= 400) {
    return {
      stage_status: "upstream_4xx",
      retryable: false,
    };
  }

  const code = asString(err_code).toUpperCase();
  if (code.includes("TIMEOUT") || code.includes("ECONNABORTED")) {
    return {
      stage_status: "upstream_unreachable",
      retryable: true,
    };
  }

  return {
    stage_status: "upstream_unreachable",
    retryable: true,
  };
}

function extractContentType(headers) {
  const h = headers && typeof headers === "object" ? headers : {};
  const v = h["content-type"] ?? h["Content-Type"] ?? h["CONTENT-TYPE"];

  if (typeof v === "string") return v.trim() || null;
  if (Array.isArray(v)) {
    const first = v.find((x) => typeof x === "string" && x.trim());
    return first ? first.trim() : null;
  }

  return null;
}

function safeRawBodyPreview(data, { maxLen = 4096 } = {}) {
  if (data == null) return null;

  let text = "";

  if (typeof data === "string") {
    text = data;
  } else if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
    try {
      text = Buffer.from(data).toString("utf8");
    } catch {
      text = String(data);
    }
  } else if (data && typeof data === "object") {
    try {
      text = JSON.stringify(data);
    } catch {
      text = String(data);
    }
  } else {
    text = String(data);
  }

  const trimmed = text.trim();
  if (!trimmed) return null;
  return truncateText(trimmed, maxLen);
}

function classifyRawBodyKind({ content_type, raw_body_preview } = {}) {
  const ct = asString(content_type).toLowerCase();
  const body = asString(raw_body_preview).trim();

  if (!body) return "empty";

  const looksHtml =
    ct.includes("text/html") ||
    body.toLowerCase().startsWith("<!doctype") ||
    body.toLowerCase().startsWith("<html") ||
    body.toLowerCase().includes("<head") ||
    body.toLowerCase().includes("<body");

  if (looksHtml) return "html";

  const looksJson = ct.includes("application/json") || body.startsWith("{") || body.startsWith("[");

  if (looksJson) {
    try {
      JSON.parse(body);
      return "text";
    } catch {
      return "json_invalid";
    }
  }

  return "text";
}

function buildUpstreamBodyDiagnostics(data, headers, { maxLen = 4096 } = {}) {
  const content_type = extractContentType(headers);
  const raw_body_preview = safeRawBodyPreview(data, { maxLen });
  const raw_body_kind = classifyRawBodyKind({ content_type, raw_body_preview });

  return {
    content_type,
    raw_body_kind,
    raw_body_preview,
  };
}

function bumpUpstreamFailureBucket(telemetry, stage_status) {
  if (!telemetry || typeof telemetry !== "object") return;

  telemetry.upstream_failure_buckets ||= {
    upstream_4xx: 0,
    upstream_5xx: 0,
    upstream_rate_limited: 0,
    upstream_unreachable: 0,
  };

  const k = asString(stage_status).trim();
  if (!k) return;

  if (telemetry.upstream_failure_buckets[k] == null) telemetry.upstream_failure_buckets[k] = 0;
  telemetry.upstream_failure_buckets[k] += 1;
}

module.exports = {
  asString,
  normalizeHttpStatus,
  extractUpstreamRequestId,
  extractContentType,
  safeBodyPreview,
  safeRawBodyPreview,
  classifyRawBodyKind,
  buildUpstreamBodyDiagnostics,
  redactReviewsUpstreamPayloadForLog,
  classifyUpstreamFailure,
  bumpUpstreamFailureBucket,
};
