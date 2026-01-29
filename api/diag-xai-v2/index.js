let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}

const { getBuildInfo } = require("../_buildInfo");

function json(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "content-type,authorization,x-debug-key,x-functions-key",
    },
    body: JSON.stringify(obj),
  };
}

function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function nowIso() {
  return new Date().toISOString();
}

function redactUrl(rawUrl) {
  const raw = asString(rawUrl).trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return raw;
  }
}

function isAzureWebsitesUrl(rawUrl) {
  const raw = asString(rawUrl).trim();
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return /\.azurewebsites\.net$/i.test(String(u.hostname || ""));
  } catch {
    return false;
  }
}

function redactHeaders(headersObj) {
  const headers = headersObj && typeof headersObj === "object" ? headersObj : {};
  const out = {};
  for (const [kRaw, vRaw] of Object.entries(headers)) {
    const k = asString(kRaw).toLowerCase();
    if (!k) continue;
    if (k === "authorization" || k === "x-functions-key" || k === "cookie" || k === "set-cookie") {
      out[k] = "[REDACTED]";
      continue;
    }
    out[k] = Array.isArray(vRaw) ? vRaw.join(", ") : asString(vRaw);
  }
  return out;
}

function classifyKeyShape(keyStr) {
  const safe = asString(keyStr).trim();
  if (!safe) return null;
  if (safe.toLowerCase().startsWith("xai-")) return "starts_with_xai";
  if (safe.length > 50 && /^[a-zA-Z0-9_-]+$/.test(safe)) return "looks_like_host_key";
  if (safe.startsWith("http://") || safe.startsWith("https://")) return "looks_like_url";
  return "unknown_format";
}

function debugGateAllows(req) {
  const debugKeyFromEnv = asString(process.env.DEBUG_KEY || "").trim();
  if (!debugKeyFromEnv) return false;
  const headerValue = asString((req?.headers?.["x-debug-key"] ?? req?.headers?.["X-Debug-Key"]) || "").trim();
  return headerValue === debugKeyFromEnv;
}

app.http("diag-xai-v2", {
  route: "diag/xai-v2",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req) => {
    // Handle OPTIONS first (no need to wrap)
    const method = String(req?.method || "").toUpperCase();
    if (method === "OPTIONS") {
      return {
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Access-Control-Allow-Headers": "content-type,authorization,x-debug-key,x-functions-key",
        },
      };
    }

    // Wrap entire handler body in try/catch
    try {
      const started = Date.now();
      const ts = nowIso();
      const debugAllowed = debugGateAllows(req);

      // Move optional imports inside handler to avoid top-level crash risks
      let axios;
      try {
        axios = require("axios");
      } catch {
        axios = null;
      }

      let dns;
      try {
        dns = require("dns");
      } catch {
        dns = null;
      }

      // Get build info early so we can include it in all responses
      const buildInfo = getBuildInfo();

      // Move shared imports into try/catch to detect errors
      let getXAIEndpoint, getXAIKey, resolveXaiEndpointForModel;
      try {
        const shared = require("../_shared");
        getXAIEndpoint = shared.getXAIEndpoint;
        getXAIKey = shared.getXAIKey;
        resolveXaiEndpointForModel = shared.resolveXaiEndpointForModel;
      } catch (e) {
        return json({
          ok: false,
          route: "diag/xai-v2",
          ts,
          diag_xai_build: buildInfo?.build_timestamp || ts,
          error: {
            name: e?.name || "Error",
            message: "Failed to load shared module",
          },
          ...(debugAllowed ? { stack: asString(e?.stack || "") } : {}),
        });
      }

      // Wrap environment reads
      let base, key, configuredModel;
      try {
        base = asString(getXAIEndpoint()).trim();
        key = asString(getXAIKey()).trim();
        configuredModel = asString(process.env.XAI_CHAT_MODEL || process.env.XAI_MODEL || "").trim();
      } catch (e) {
        return json({
          ok: false,
          route: "diag/xai-v2",
          ts,
          diag_xai_build: buildInfo?.build_timestamp || ts,
          error: {
            name: e?.name || "Error",
            message: "Failed to read xAI configuration",
          },
          ...(debugAllowed ? { stack: asString(e?.stack || "") } : {}),
        });
      }

      // Build environment diagnostic (env booleans and lengths only)
      const envDiag = {
        has_xai_api_key: Boolean(base),
        xai_api_key_len: base.length,
        has_xai_external_key: Boolean(key),
        xai_external_key_len: key.length,
        has_xai_base_url: Boolean(process.env.XAI_BASE_URL),
        xai_base_url_len: asString(process.env.XAI_BASE_URL || "").length,
        has_function_key: Boolean(process.env.FUNCTION_KEY),
        function_key_len: asString(process.env.FUNCTION_KEY || "").length,
      };

      const resolved = {
        base_url: base || null,
        key_shape: key ? classifyKeyShape(key) : null,
      };

      // Wrap model resolution
      let model, url;
      try {
        model = configuredModel || asString(process.env.XAI_CHAT_MODEL || process.env.XAI_MODEL || "grok-4-latest").trim();
        url = base && model ? resolveXaiEndpointForModel(base, model) : null;
      } catch (e) {
        return json({
          ok: false,
          route: "diag/xai-v2",
          ts,
          diag_xai_build: buildInfo?.build_timestamp || ts,
          error: {
            name: e?.name || "Error",
            message: "Failed to resolve xAI endpoint for model",
          },
          env: envDiag,
          resolved,
          ...(debugAllowed ? { stack: asString(e?.stack || "") } : {}),
        });
      }

      // If missing config, return gracefully (always return 200)
      if (!url || !key) {
        return json({
          ok: false,
          route: "diag/xai-v2",
          ts,
          diag_xai_build: buildInfo?.build_timestamp || ts,
          error: {
            name: "ConfigError",
            message: "Missing xAI configuration (base_url or key)",
          },
          env: envDiag,
          resolved,
        });
      }

      // Smoke test: minimal upstream call only if both base and key exist
      const smoke = await (async () => {
        try {
          const headers = {
            "Content-Type": "application/json",
          };

          if (isAzureWebsitesUrl(url)) {
            headers["x-functions-key"] = key;
          } else {
            headers.Authorization = `Bearer ${key}`;
          }

          const payload = {
            model,
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
            temperature: 0,
            stream: false,
            search_parameters: { mode: "off" },
          };

          let status = null;

          try {
            if (axios) {
              const resp = await axios.post(url, payload, {
                headers,
                timeout: 12_000,
                validateStatus: () => true,
              });
              status = Number(resp?.status || 0) || 0;
            } else {
              const res = await fetch(url, {
                method: "POST",
                headers,
                body: JSON.stringify(payload),
              });
              status = res.status;
            }

            if (status >= 200 && status < 300) {
              return { ok: true, status };
            } else {
              return {
                ok: false,
                status,
                message: `HTTP ${status} from upstream`,
                detail: "non_2xx_response",
              };
            }
          } catch (axiosOrFetchError) {
            return {
              ok: false,
              message: asString(axiosOrFetchError?.message || axiosOrFetchError) || "request_failed",
              detail: "upstream_call_failed",
            };
          }
        } catch (e) {
          return {
            ok: false,
            message: asString(e?.message || e) || "smoke_test_error",
            detail: "smoke_test_exception",
          };
        }
      })();

      // Always return 200 with complete diagnostic
      return json({
        ok: smoke.ok,
        route: "diag/xai-v2",
        ts,
        diag_xai_build: buildInfo?.build_timestamp || ts,
        env: envDiag,
        resolved,
        smoke,
        ...buildInfo,
      });
    } catch (e) {
      // Top-level catch for any unhandled errors
      const ts = nowIso();
      const debugAllowed = debugGateAllows(req);
      let buildTimestamp = ts;
      try {
        const bi = getBuildInfo();
        if (bi?.build_timestamp) buildTimestamp = bi.build_timestamp;
      } catch {}

      return json({
        ok: false,
        route: "diag/xai-v2",
        ts,
        diag_xai_build: buildTimestamp,
        error: {
          name: e?.name || "Error",
          message: asString(e?.message || e) || "Unhandled exception",
        },
        ...(debugAllowed ? { stack: asString(e?.stack || "") } : {}),
      });
    }
  },
});
