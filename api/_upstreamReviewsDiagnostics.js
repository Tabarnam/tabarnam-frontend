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
  safeBodyPreview,
  redactReviewsUpstreamPayloadForLog,
  classifyUpstreamFailure,
  bumpUpstreamFailureBucket,
};
