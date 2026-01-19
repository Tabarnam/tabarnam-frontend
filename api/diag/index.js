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
let axios;
try {
  axios = require("axios");
} catch {
  axios = null;
}

const dns = require("dns");
const { getXAIEndpoint, getXAIKey, resolveXaiEndpointForModel } = require("../_shared");

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

    // NOTE: accepted query param name is session_id (snake_case) to match the import pipeline.
    const session_id = asString(readQueryParam(req, "session_id")).trim() || null;

    const base = asString(getXAIEndpoint()).trim();
    const key = asString(getXAIKey()).trim();

    const configuredModel = asString(process.env.XAI_CHAT_MODEL || process.env.XAI_MODEL || "").trim();
    if (!configuredModel) {
      const responsePayload = {
        ok: false,
        error: "XAI_CHAT_MODEL_MISSING",
        attempted_model: null,
        elapsed_ms: Date.now() - started,
        website_hostname: asString(process.env.WEBSITE_HOSTNAME || "") || null,
        ...buildInfo,
      };

      const persisted = await persistIfRequested({
        kind: "xai_diag_bundle",
        session_id,
        ok: false,
        error: responsePayload.error,
        attempted_model: responsePayload.attempted_model,
        elapsed_ms: responsePayload.elapsed_ms,
        website_hostname: responsePayload.website_hostname,
        build_id: buildInfo?.build_id || null,
        at: nowIso(),
      });

      return json({ ...responsePayload, ...(persisted ? { persisted } : {}) });
    }

    const model = asString(process.env.XAI_CHAT_MODEL || process.env.XAI_MODEL || "grok-4-latest").trim();
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

    const persistIfRequested = async (bundle) => {
      if (!session_id) return null;
      return await persistXaiDiagBundle({ sessionId: session_id, bundle }).catch((e) => ({
        ok: false,
        error: asString(e?.message || e) || "persist_failed",
      }));
    };

    if (!url || !key) {
      const payload = {
        ok: false,
        error: "missing_xai_config",
        attempted_model: model,
        dns: dnsResult,
        resolved_upstream_url_redacted: redactUrl(url) || null,
        has_url: Boolean(url),
        has_key: Boolean(key),
        elapsed_ms: Date.now() - started,
        website_hostname: asString(process.env.WEBSITE_HOSTNAME || "") || null,
        ...buildInfo,
      };

      const persisted = await persistIfRequested({
        kind: "xai_diag_bundle",
        session_id,
        ok: false,
        error: payload.error,
        attempted_model: payload.attempted_model,
        dns: payload.dns,
        resolved_upstream_url_redacted: payload.resolved_upstream_url_redacted,
        elapsed_ms: payload.elapsed_ms,
        website_hostname: payload.website_hostname,
        build_id: buildInfo?.build_id || null,
        at: nowIso(),
      });

      return json({ ...payload, ...(persisted ? { persisted } : {}) });
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
      const responsePayload = {
        ok: false,
        error: "xai_request_failed",
        attempted_model: model,
        message: asString(e?.message || e) || "xai_request_failed",
        dns: dnsResult,
        resolved_upstream_url_redacted: redactUrl(url) || null,
        elapsed_ms: Date.now() - started,
        website_hostname: asString(process.env.WEBSITE_HOSTNAME || "") || null,
        ...buildInfo,
      };

      const persisted = await persistIfRequested({
        kind: "xai_diag_bundle",
        session_id,
        ok: false,
        error: responsePayload.error,
        attempted_model: responsePayload.attempted_model,
        message: responsePayload.message,
        dns: responsePayload.dns,
        resolved_upstream_url_redacted: responsePayload.resolved_upstream_url_redacted,
        elapsed_ms: responsePayload.elapsed_ms,
        website_hostname: responsePayload.website_hostname,
        build_id: buildInfo?.build_id || null,
        at: nowIso(),
      });

      return json({ ...responsePayload, ...(persisted ? { persisted } : {}) });
    }

    const responsePayload = {
      ok: status != null && status >= 200 && status < 300,
      attempted_model: model,
      dns: dnsResult,
      http_status: status,
      elapsed_ms: Date.now() - started,
      resolved_upstream_url_redacted: redactUrl(url) || null,
      response_headers: responseHeaders,
      response_body_preview: bodyPreview,
      website_hostname: asString(process.env.WEBSITE_HOSTNAME || "") || null,
      ...buildInfo,
    };

    const persisted = await persistIfRequested({
      kind: "xai_diag_bundle",
      session_id,
      ok: responsePayload.ok,
      attempted_model: responsePayload.attempted_model,
      dns: responsePayload.dns,
      http_status: responsePayload.http_status,
      resolved_upstream_url_redacted: responsePayload.resolved_upstream_url_redacted,
      response_headers: responsePayload.response_headers,
      response_body_preview: responsePayload.response_body_preview,
      elapsed_ms: responsePayload.elapsed_ms,
      website_hostname: responsePayload.website_hostname,
      build_id: buildInfo?.build_id || null,
      at: nowIso(),
    });

    return json({ ...responsePayload, ...(persisted ? { persisted } : {}) });
  },
});
