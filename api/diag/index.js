let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}

const { getBuildInfo } = require("../_buildInfo");
const { getHandlerVersions } = require("../_handlerVersions");

function json(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "content-type,authorization,x-functions-key",
    },
    body: JSON.stringify(obj),
  };
}

function pickEnv(env) {
  const e = env && typeof env === "object" ? env : {};
  return {
    website_site_name: String(e.WEBSITE_SITE_NAME || ""),
    website_hostname: String(e.WEBSITE_HOSTNAME || ""),
    scm_commit_id: String(e.SCM_COMMIT_ID || ""),
    website_commit_hash: String(e.WEBSITE_COMMIT_HASH || ""),
    build_sourceversion: String(e.BUILD_SOURCEVERSION || ""),
    github_sha: String(e.GITHUB_SHA || ""),
    node_version: String(e.WEBSITE_NODE_DEFAULT_VERSION || process.version || ""),
  };
}

app.http("diag", {
  route: "diag",
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
          "Access-Control-Allow-Headers": "content-type,authorization,x-functions-key",
        },
      };
    }

    const buildInfo = getBuildInfo();
    const handler_versions = getHandlerVersions(buildInfo);

    let routes = [];
    try {
      const appMod = require("../_app");
      routes = typeof appMod?.listRoutes === "function" ? appMod.listRoutes() : [];
    } catch {
      routes = [];
    }

    return json({
      ok: true,
      now: new Date().toISOString(),
      env: pickEnv(process.env),
      routes,
      handler_version: handler_versions.import_start,
      handler_versions,
      ...buildInfo,
    });
  },
});

// xAI connectivity diagnostic (same config + auth rules used by the import enrichment pipeline).
let axios;
try {
  axios = require("axios");
} catch {
  axios = null;
}

const dns = require("dns");
const { getXAIEndpoint, getXAIKey, resolveXaiEndpointForModel } = require("../_shared");

function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
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

app.http("diag-xai", {
  route: "diag/xai",
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
          "Access-Control-Allow-Headers": "content-type,authorization,x-functions-key",
        },
      };
    }

    const started = Date.now();
    const buildInfo = getBuildInfo();

    const base = asString(getXAIEndpoint()).trim();
    const key = asString(getXAIKey()).trim();
    const model = "grok-2-latest";
    const url = resolveXaiEndpointForModel(base, model);

    const hostname = (() => {
      try {
        return url ? new URL(url).hostname : "";
      } catch {
        return "";
      }
    })();

    const dnsResult = await (async () => {
      if (!hostname || !dns?.promises?.lookup) {
        return { ok: false, host: hostname || null, error: "dns_lookup_unavailable" };
      }
      try {
        const r = await dns.promises.lookup(hostname);
        return { ok: true, host: hostname, address: r?.address || null, family: r?.family || null };
      } catch (e) {
        return { ok: false, host: hostname, error: asString(e?.message || e) || "dns_lookup_failed" };
      }
    })();

    if (!url || !key) {
      return json({
        ok: false,
        error: "missing_xai_config",
        dns: dnsResult,
        resolved_upstream_url_redacted: redactUrl(url) || null,
        has_url: Boolean(url),
        has_key: Boolean(key),
        elapsed_ms: Date.now() - started,
        website_hostname: asString(process.env.WEBSITE_HOSTNAME || "") || null,
        ...buildInfo,
      });
    }

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
    let responseHeaders = {};
    let bodyPreview = "";

    try {
      if (axios) {
        const resp = await axios.post(url, payload, {
          headers,
          timeout: 12_000,
          validateStatus: () => true,
        });

        status = Number(resp?.status || 0) || 0;
        responseHeaders = redactHeaders(resp?.headers);

        const dataText = (() => {
          try {
            if (typeof resp?.data === "string") return resp.data;
            return JSON.stringify(resp?.data ?? {});
          } catch {
            return "";
          }
        })();

        bodyPreview = dataText.slice(0, 500);
      } else {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });

        status = res.status;
        const headersObj = {};
        try {
          res.headers.forEach((v, k) => {
            headersObj[k] = v;
          });
        } catch {}

        responseHeaders = redactHeaders(headersObj);
        const text = await res.text().catch(() => "");
        bodyPreview = (text || "").slice(0, 500);
      }
    } catch (e) {
      return json({
        ok: false,
        error: "xai_request_failed",
        message: asString(e?.message || e) || "xai_request_failed",
        dns: dnsResult,
        resolved_upstream_url_redacted: redactUrl(url) || null,
        elapsed_ms: Date.now() - started,
        website_hostname: asString(process.env.WEBSITE_HOSTNAME || "") || null,
        ...buildInfo,
      });
    }

    return json({
      ok: status != null && status >= 200 && status < 300,
      dns: dnsResult,
      http_status: status,
      elapsed_ms: Date.now() - started,
      resolved_upstream_url_redacted: redactUrl(url) || null,
      response_headers: responseHeaders,
      response_body_preview: bodyPreview,
      website_hostname: asString(process.env.WEBSITE_HOSTNAME || "") || null,
      ...buildInfo,
    });
  },
});
