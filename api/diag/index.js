let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}

let CosmosClient;
try {
  ({ CosmosClient } = require("@azure/cosmos"));
} catch {
  CosmosClient = null;
}

const { getBuildInfo } = require("../_buildInfo");
const { getHandlerVersions } = require("../_handlerVersions");
const { getContainerPartitionKeyPath, buildPartitionKeyCandidates } = require("../_cosmosPartitionKey");

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

function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function nowIso() {
  return new Date().toISOString();
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

let _cosmosContainerPromise;
function getCosmosContainer() {
  if (_cosmosContainerPromise) return _cosmosContainerPromise;

  _cosmosContainerPromise = (async () => {
    const endpoint = asString(process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim();
    const key = asString(process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim();
    const databaseId = asString(process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
    const containerId = asString(process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();

    if (!endpoint || !key || !CosmosClient) return null;

    const client = new CosmosClient({ endpoint, key });
    return client.database(databaseId).container(containerId);
  })();

  return _cosmosContainerPromise;
}

let _companiesPkPathPromise;
async function getCompaniesPkPath(container) {
  if (!container) return "/normalized_domain";
  _companiesPkPathPromise ||= getContainerPartitionKeyPath(container, "/normalized_domain");
  try {
    return await _companiesPkPathPromise;
  } catch {
    return "/normalized_domain";
  }
}

async function readControlDoc(container, id, sessionId) {
  if (!container) return null;
  const containerPkPath = await getCompaniesPkPath(container);

  const docForCandidates = {
    id,
    session_id: sessionId,
    normalized_domain: "import",
    partition_key: "import",
    type: "import_control",
  };

  const candidates = buildPartitionKeyCandidates({
    doc: docForCandidates,
    containerPkPath,
    requestedId: id,
  });

  for (const partitionKeyValue of candidates) {
    try {
      const item =
        partitionKeyValue !== undefined ? container.item(id, partitionKeyValue) : container.item(id);
      const { resource } = await item.read();
      return resource || null;
    } catch (e) {
      if (e?.code === 404) return null;
    }
  }

  return null;
}

async function upsertDoc(container, doc) {
  if (!container || !doc) return { ok: false, error: "no_container" };
  const id = asString(doc.id).trim();
  if (!id) return { ok: false, error: "missing_id" };

  const containerPkPath = await getCompaniesPkPath(container);
  const candidates = buildPartitionKeyCandidates({ doc, containerPkPath, requestedId: id });

  let lastErr = null;
  for (const partitionKeyValue of candidates) {
    try {
      if (partitionKeyValue !== undefined) {
        await container.items.upsert(doc, { partitionKey: partitionKeyValue });
      } else {
        await container.items.upsert(doc);
      }
      return { ok: true };
    } catch (e) {
      lastErr = e;
    }
  }

  return { ok: false, error: lastErr?.message || String(lastErr || "upsert_failed") };
}

async function persistXaiDiagBundle({ sessionId, bundle }) {
  const sid = asString(sessionId).trim();
  if (!sid) return { ok: false, error: "missing_session_id" };

  const container = await getCosmosContainer();
  if (!container) return { ok: false, error: "cosmos_not_configured" };

  const stamp = nowIso();

  const sessionDocId = `_import_session_${sid}`;
  const resumeDocId = `_import_resume_${sid}`;

  const out = {
    ok: true,
    writes: {
      session: { attempted: true, ok: false, id: sessionDocId },
      resume: { attempted: true, ok: false, id: resumeDocId },
    },
  };

  // 1) Session control doc
  try {
    const existingSession = await readControlDoc(container, sessionDocId, sid).catch(() => null);
    const base = existingSession && typeof existingSession === "object"
      ? { ...existingSession }
      : {
          id: sessionDocId,
          session_id: sid,
          normalized_domain: "import",
          partition_key: "import",
          type: "import_control",
          status: "running",
          stage_beacon: "diag_xai",
          created_at: stamp,
        };

    const sessionWrite = {
      ...base,
      last_xai_diag_bundle: bundle && typeof bundle === "object" ? bundle : null,
      last_xai_diag_bundle_at: stamp,
      updated_at: stamp,
    };

    const res = await upsertDoc(container, sessionWrite);
    out.writes.session.ok = Boolean(res.ok);
    if (!res.ok) out.writes.session.error = res.error;
  } catch (e) {
    out.writes.session.error = asString(e?.message || e) || "write_failed";
  }

  // 2) Resume/control doc (best-effort; only patch if it already exists)
  try {
    const existingResume = await readControlDoc(container, resumeDocId, sid).catch(() => null);
    if (!existingResume) {
      out.writes.resume.ok = true;
      out.writes.resume.skipped = true;
      return out;
    }

    const resumeWrite = {
      ...existingResume,
      last_xai_diag_bundle: bundle && typeof bundle === "object" ? bundle : null,
      last_xai_diag_bundle_at: stamp,
      updated_at: stamp,
    };

    const res = await upsertDoc(container, resumeWrite);
    out.writes.resume.ok = Boolean(res.ok);
    if (!res.ok) out.writes.resume.error = res.error;
  } catch (e) {
    out.writes.resume.error = asString(e?.message || e) || "write_failed";
  }

  return out;
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
// NOTE: axios, dns, and shared module imports are now inside the handler to avoid top-level crash risks (requirement B.1).

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

app.http("diag-xai", {
  route: "diag/xai",
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

    // Wrap entire handler body in try/catch (requirement A.1)
    try {
      const started = Date.now();
      const ts = nowIso();
      const debugAllowed = debugGateAllows(req);

      // Move optional imports inside handler (requirement B.1)
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

      // Move shared imports into try/catch to detect errors (requirement B.2)
      let getXAIEndpoint, getXAIKey, resolveXaiEndpointForModel;
      try {
        const shared = require("../_shared");
        getXAIEndpoint = shared.getXAIEndpoint;
        getXAIKey = shared.getXAIKey;
        resolveXaiEndpointForModel = shared.resolveXaiEndpointForModel;
      } catch (e) {
        return json({
          ok: false,
          route: "/api/diag/xai",
          ts,
          error: {
            name: e?.name || "Error",
            message: "Failed to load shared module",
          },
          ...(debugAllowed ? { stack: asString(e?.stack || "") } : {}),
        });
      }

      const buildInfo = getBuildInfo();

      // Wrap environment reads (requirement B.2)
      let base, key, configuredModel;
      try {
        base = asString(getXAIEndpoint()).trim();
        key = asString(getXAIKey()).trim();
        configuredModel = asString(process.env.XAI_CHAT_MODEL || process.env.XAI_MODEL || "").trim();
      } catch (e) {
        return json({
          ok: false,
          route: "/api/diag/xai",
          ts,
          error: {
            name: e?.name || "Error",
            message: "Failed to read xAI configuration",
          },
          ...(debugAllowed ? { stack: asString(e?.stack || "") } : {}),
        });
      }

      // Build environment diagnostic (requirement D: env booleans and lengths only)
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

      // Wrap model resolution (requirement B.2)
      let model, url;
      try {
        model = configuredModel || asString(process.env.XAI_CHAT_MODEL || process.env.XAI_MODEL || "grok-4-latest").trim();
        url = base && model ? resolveXaiEndpointForModel(base, model) : null;
      } catch (e) {
        return json({
          ok: false,
          route: "/api/diag/xai",
          ts,
          error: {
            name: e?.name || "Error",
            message: "Failed to resolve xAI endpoint for model",
          },
          env: envDiag,
          resolved,
          ...(debugAllowed ? { stack: asString(e?.stack || "") } : {}),
        });
      }

      // If missing config, return gracefully (requirement D: return 200 always)
      if (!url || !key) {
        return json({
          ok: false,
          route: "/api/diag/xai",
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

      // Smoke test: minimal upstream call only if both base and key exist (requirement D)
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

      // Always return 200 with complete diagnostic (requirement E)
      return json({
        ok: smoke.ok,
        route: "/api/diag/xai",
        ts,
        env: envDiag,
        resolved,
        smoke,
        ...buildInfo,
      });
    } catch (e) {
      // Top-level catch for any unhandled errors (requirement A.1-3)
      const ts = nowIso();
      const debugAllowed = debugGateAllows(req);

      return json({
        ok: false,
        route: "/api/diag/xai",
        ts,
        error: {
          name: e?.name || "Error",
          message: asString(e?.message || e) || "Unhandled exception",
        },
        ...(debugAllowed ? { stack: asString(e?.stack || "") } : {}),
      });
    }
  },
});
