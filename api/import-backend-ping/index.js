let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}

const axios = require("axios");
const { getBuildInfo } = require("../_buildInfo");
const { getXAIEndpoint, getXAIKey } = require("../_shared");

function json(obj, status = 200, extraHeaders) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers":
        "content-type,authorization,x-functions-key,x-request-id,x-correlation-id,x-session-id,x-client-request-id",
      "Access-Control-Expose-Headers": "x-request-id,x-correlation-id,x-session-id",
      ...(extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {}),
    },
    body: JSON.stringify(obj),
  };
}

function getHeader(req, name) {
  const target = String(name || "").toLowerCase();
  const hdrs = req?.headers;
  if (!target || !hdrs) return null;

  if (typeof hdrs.get === "function") {
    try {
      const v = hdrs.get(target);
      if (v != null && String(v).trim()) return String(v).trim();
    } catch {}
  }

  try {
    const direct = hdrs[target] ?? hdrs[name] ?? hdrs[target.toUpperCase()];
    if (direct != null && String(direct).trim()) return String(direct).trim();
  } catch {}

  return null;
}

function tryParseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function toHostPathOnlyForLog(rawUrl) {
  const u = tryParseUrl(rawUrl);
  if (u) return `${u.host}${u.pathname}`;

  const raw = String(rawUrl || "").trim();
  if (!raw) return "";

  const noQuery = raw.split("?")[0];
  const noScheme = noQuery.replace(/^https?:\/\//i, "");
  return noScheme;
}

function redactHostForDiagnostics(host) {
  const value = String(host || "").trim();
  if (!value) return "";
  if (value.length <= 18) return value;
  return `${value.slice(0, 8)}…${value.slice(-8)}`;
}

function buildProxyResolutionDetails(req, proxyBase, proxySource) {
  const reqUrl = tryParseUrl(req?.url);
  const reqHost = String(reqUrl?.host || "").trim();

  const proxyUrl = tryParseUrl(proxyBase);
  const proxyHost = String(proxyUrl?.host || "").trim();

  const same_origin = reqHost && proxyHost ? reqHost.toLowerCase() === proxyHost.toLowerCase() : null;

  const resolved_base_host = proxyHost ? redactHostForDiagnostics(proxyHost) : "";

  return {
    proxy_source: String(proxySource || "").trim() || null,
    resolved_base_host: resolved_base_host || null,
    same_origin,
    is_external: typeof same_origin === "boolean" ? !same_origin : null,
  };
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

function getImportStartProxyInfo() {
  const candidates = [
    { key: "IMPORT_START_PROXY_BASE", value: process.env.IMPORT_START_PROXY_BASE },
    { key: "XAI_IMPORT_PROXY_BASE", value: process.env.XAI_IMPORT_PROXY_BASE },
  ];

  for (const c of candidates) {
    const v = String(c.value || "").trim();
    if (!v) continue;
    return { base: v, source: c.key };
  }

  return { base: "", source: "" };
}

function getImportStartProxyKeyInfo() {
  const candidates = [
    { key: "IMPORT_START_PROXY_KEY", value: process.env.IMPORT_START_PROXY_KEY },
    { key: "XAI_IMPORT_PROXY_KEY", value: process.env.XAI_IMPORT_PROXY_KEY },
  ];

  for (const c of candidates) {
    const v = String(c.value || "").trim();
    if (!v) continue;
    return { key: v, source: c.key };
  }

  return { key: "", source: "" };
}

function classifyAxiosUpstreamError(err) {
  const status = err?.response?.status;
  if (Number.isFinite(Number(status))) return "http_error";

  const code = String(err?.code || "").trim();
  const message = String(err?.message || "").toLowerCase();

  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
  if (code === "ETIMEDOUT") return "connect_timeout";
  if (code === "ECONNABORTED" || message.includes("timeout") || message.includes("aborted")) return "read_timeout";
  if (code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENETUNREACH") return "fetch_failed";
  return "fetch_failed";
}

function buildEnvPresent() {
  return {
    has_xai_key: Boolean(getXAIKey()),
    has_xai_base_url: Boolean(getXAIEndpoint()),
    has_import_start_proxy_base: Boolean(getImportStartProxyInfo().base),
    has_import_start_proxy_key: Boolean(getImportStartProxyKeyInfo().key),
  };
}

function generateRequestId(req) {
  const fromHeader = String(getHeader(req, "x-request-id") || getHeader(req, "x-correlation-id") || "").trim();
  if (fromHeader) return fromHeader;

  try {
    const { randomUUID } = require("node:crypto");
    if (typeof randomUUID === "function") return randomUUID();
  } catch {}

  return `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

app.http("import-backend-ping", {
  route: "import/backend-ping",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    const request_id = generateRequestId(req);
    const responseHeaders = { "x-request-id": request_id };

    if ((req.method || "").toUpperCase() === "OPTIONS") {
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

    const session_id = `sess_ping_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const env_present = buildEnvPresent();

    const proxyInfo = getImportStartProxyInfo();
    const proxyBase = proxyInfo.base;
    const proxySource = proxyInfo.source;
    const proxyKeyInfo = getImportStartProxyKeyInfo();
    const proxyKey = proxyKeyInfo.key;
    const proxy_resolution = buildProxyResolutionDetails(req, proxyBase, proxySource);

    const details = {
      body_source: "none",
      content_type: getHeader(req, "content-type") || null,
      content_length_header: getHeader(req, "content-length") || null,
      proxy_resolution,
      proxy_key_source: proxyKeyInfo.source || null,
    };

    if (!proxyBase) {
      console.error(`[import-backend-ping] request_id=${request_id} missing proxy base`);
      return json(
        {
          ok: false,
          stage: "config",
          request_id,
          session_id,
          env_present,
          upstream: {},
          details,
          error: {
            code: "IMPORT_BACKEND_PING_NOT_CONFIGURED",
            message: "IMPORT_START_PROXY_BASE (or XAI_IMPORT_PROXY_BASE) is not configured",
            request_id,
            step: "config",
          },
          legacy_error: "Not configured",
          ...getBuildInfo(),
        },
        500,
        responseHeaders
      );
    }

    const base = proxyBase.replace(/\/$/, "");
    const candidatePaths = ["/ping", "/health", "/api/ping", "/api/health"]; // support both /api root and host-only bases

    const upstream_timeout_ms = 8000;

    let lastErr = null;
    let lastHttp = null;

    for (const path of candidatePaths) {
      const url = `${base}${path}`;
      const resolved_host_path = toHostPathOnlyForLog(url);

      try {
        console.log(`[import-backend-ping] request_id=${request_id} calling ${resolved_host_path}`);
        const resp = await axios.get(url, {
          headers: {
            "x-request-id": request_id,
            "x-correlation-id": request_id,
            "x-session-id": session_id,
            ...(proxyKey ? { "x-functions-key": proxyKey } : {}),
          },
          timeout: upstream_timeout_ms,
          validateStatus: () => true,
        });

        const upstream_body_preview = toTextPreview(resp.data);
        const upstream_status = resp.status;

        if (upstream_status >= 200 && upstream_status < 300) {
          return json(
            {
              ok: true,
              stage: "backend_ping",
              request_id,
              session_id,
              upstream_status,
              upstream_body_preview,
              resolved_host_path,
              proxy_resolution,
              proxy_key_source: proxyKeyInfo.source || null,
              ...getBuildInfo(),
            },
            200,
            responseHeaders
          );
        }

        lastHttp = { upstream_status, resolved_host_path, upstream_body_preview };

        if (upstream_status === 404) {
          continue;
        }

        // Keep searching for a viable ping endpoint, but record the last non-404 failure.
        continue;
      } catch (err) {
        lastErr = err;

        const error_class = classifyAxiosUpstreamError(err);
        console.error(
          `[import-backend-ping] request_id=${request_id} upstream_failure class=${error_class} target=${resolved_host_path} status=${err?.response?.status ?? ""} error=${String(err?.message || err)}`
        );

        continue;
      }
    }

    const failureHostPath = lastHttp?.resolved_host_path || "";
    const upstream_status = lastHttp?.upstream_status ?? lastErr?.response?.status ?? null;
    const error_class = lastHttp ? "http_error" : classifyAxiosUpstreamError(lastErr);
    const upstream_text_preview = lastHttp?.upstream_body_preview || toTextPreview(lastErr?.response?.data || lastErr?.response?.body || "");

    console.error(`[import-backend-ping] request_id=${request_id} ping exhausted routes`);

    return json(
      {
        ok: false,
        stage: "backend_ping",
        request_id,
        session_id,
        env_present,
        upstream: {
          ...(failureHostPath ? { host_path: failureHostPath } : {}),
          ...(Number.isFinite(Number(upstream_status)) ? { status: Number(upstream_status) } : {}),
          timeout_ms: upstream_timeout_ms,
          ...(upstream_text_preview ? { body_preview: upstream_text_preview } : {}),
          ...(error_class ? { error_class } : {}),
        },
        details: {
          ...details,
          upstream_timeout_ms,
          upstream_status,
          upstream_url: failureHostPath || null,
          upstream_error_class: error_class,
          upstream_text_preview,
          upstream_content_type: String(lastErr?.response?.headers?.["content-type"] || "").trim() || null,
        },
        error: {
          code: "IMPORT_BACKEND_PING_FAILED",
          message: upstream_status ? `Backend ping returned ${upstream_status}` : "Backend ping call failed",
          request_id,
          step: "backend_ping",
          upstream_status,
          ...(failureHostPath ? { upstream_url: failureHostPath } : {}),
        },
        legacy_error: "Backend ping failed",
        ...(lastErr ? { last_error: String(lastErr?.message || lastErr) } : {}),
        ...getBuildInfo(),
      },
      500,
      responseHeaders
    );
  },
});
