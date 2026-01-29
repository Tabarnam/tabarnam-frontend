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

function normalizeBaseUrl(rawBase) {
  const raw = asString(rawBase).trim();
  if (!raw) return "";
  // If someone mistakenly sets XAI_BASE_URL to the full endpoint, normalize it.
  if (/\/v1\/(chat\/completions|responses)(\/)?$/i.test(raw)) {
    return raw.replace(/\/v1\/(chat\/completions|responses)(\/)?$/i, "");
  }
  return raw.replace(/\/+$/, "");
}

function computeResponsesUrl(baseUrl) {
  const base = normalizeBaseUrl(baseUrl) || "https://api.x.ai";
  return `${base}/v1/responses`;
}

app.http("diag-xai-v2", {
  route: "diag/xai-v2",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req) => {
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

    try {
      const ts = nowIso();
      const debugAllowed = debugGateAllows(req);

      let axios;
      try {
        axios = require("axios");
      } catch {
        axios = null;
      }

      // Build info early
      const buildInfo = getBuildInfo();

      // Shared helpers
      let getXAIEndpoint, getXAIKey;
      try {
        const shared = require("../_shared");
        getXAIEndpoint = shared.getXAIEndpoint;
        getXAIKey = shared.getXAIKey;
      } catch (e) {
        return json({
          ok: false,
          route: "diag/xai-v2",
          ts,
          diag_xai_build: buildInfo?.build_timestamp || ts,
          error: { name: e?.name || "Error", message: "Failed to load shared module" },
          ...(debugAllowed ? { stack: asString(e?.stack || "") } : {}),
        });
      }

      // Read config
      let base, key, configuredModel;
      try {
        base = asString(getXAIEndpoint()).trim(); // may be XAI_BASE_URL or legacy; we normalize below
        key = asString(getXAIKey()).trim(); // should be Bearer token for api.x.ai
        configuredModel = asString(process.env.XAI_CHAT_MODEL || process.env.XAI_MODEL || "").trim();
      } catch (e) {
        return json({
          ok: false,
          route: "diag/xai-v2",
          ts,
          diag_xai_build: buildInfo?.build_timestamp || ts,
          error: { name: e?.name || "Error", message: "Failed to read xAI configuration" },
          ...(debugAllowed ? { stack: asString(e?.stack || "") } : {}),
        });
      }

      // Env diagnostics (lengths only)
      const envDiag = {
        has_xai_endpoint: Boolean(base),
        xai_endpoint_len: base.length,
        has_xai_key: Boolean(key),
        xai_key_len: key.length,
        has_xai_base_url: Boolean(process.env.XAI_BASE_URL),
        xai_base_url_len: asString(process.env.XAI_BASE_URL || "").length,
        has_function_key: Boolean(process.env.FUNCTION_KEY),
        function_key_len: asString(process.env.FUNCTION_KEY || "").length,
      };

      const model = configuredModel || "grok-4";
      const url = computeResponsesUrl(base || process.env.XAI_BASE_URL || "https://api.x.ai");

      const resolved = {
        base_url: redactUrl(url),
        key_shape: key ? classifyKeyShape(key) : null,
        model,
      };

      if (!key) {
        return json({
          ok: false,
          route: "diag/xai-v2",
          ts,
          diag_xai_build: buildInfo?.build_timestamp || ts,
          error: { name: "ConfigError", message: "Missing xAI key" },
          env: envDiag,
          resolved,
          ...buildInfo,
        });
      }

      // Smoke test: call Responses API (not chat/completions)
      const smoke = await (async () => {
        try {
          const headers = { "Content-Type": "application/json" };

          // Support both: direct xAI Bearer and "internal azure function" x-functions-key.
          if (isAzureWebsitesUrl(url)) {
            headers["x-functions-key"] = key;
          } else {
            headers.Authorization = `Bearer ${key}`;
          }

          const payload = {
            model,
            input: [
              { role: "system", content: "You are a helpful assistant." },
              { role: "user", content: "Say 'ok' in one word." },
            ],
            store: false,
          };

          let status = 0;
          let data = null;

          try {
            if (axios) {
              const resp = await axios.post(url, payload, {
                headers,
                timeout: 12_000,
                validateStatus: () => true,
              });
              status = Number(resp?.status || 0) || 0;
              data = resp?.data ?? null;
            } else {
              const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
              status = res.status;
              try {
                data = await res.json();
              } catch {
                data = null;
              }
            }
          } catch (requestErr) {
            return {
              ok: false,
              message: asString(requestErr?.message || requestErr) || "request_failed",
              detail: "upstream_call_failed",
            };
          }

          const ok = status >= 200 && status < 300;
          if (!ok) {
            return {
              ok: false,
              status,
              message: `HTTP ${status} from upstream`,
              detail: "non_2xx_response",
              ...(debugAllowed
                ? {
                    upstream: {
                      url: redactUrl(url),
                      request_headers: redactHeaders(headers),
                      response_excerpt: data && typeof data === "object" ? data : asString(data || ""),
                    },
                  }
                : {}),
            };
          }

          // Try to extract a short confirmation without leaking anything
          const text =
            data?.output?.[0]?.content?.find?.((c) => c?.type === "output_text")?.text ??
            data?.output?.[0]?.content?.[0]?.text ??
            "";

          return {
            ok: true,
            status,
            response_id: asString(data?.id || ""),
            model: asString(data?.model || ""),
            status_text: asString(data?.status || ""),
            output_text: asString(text).slice(0, 64),
          };
        } catch (e) {
          return {
            ok: false,
            message: asString(e?.message || e) || "smoke_test_error",
            detail: "smoke_test_exception",
          };
        }
      })();

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
