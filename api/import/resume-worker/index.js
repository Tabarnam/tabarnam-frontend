let app;
try {
  ({ app } = require("@azure/functions"));
} catch {
  app = { http() {} };
}

let CosmosClient;
try {
  ({ CosmosClient } = require("@azure/cosmos"));
} catch {
  CosmosClient = null;
}

const {
  getContainerPartitionKeyPath,
  buildPartitionKeyCandidates,
} = require("../../_cosmosPartitionKey");

const {
  buildInternalFetchRequest,
  getInternalAuthDecision,
  isInternalJobRequest,
} = require("../../_internalJobAuth");

const { getBuildInfo } = require("../../_buildInfo");

const HANDLER_ID = "import-resume-worker";

const BUILD_INFO = (() => {
  try {
    return getBuildInfo();
  } catch {
    return { build_id: "" };
  }
})();

function cors(req) {
  const origin = req?.headers?.get?.("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers":
      "content-type,authorization,x-functions-key,x-request-id,x-correlation-id,x-session-id,x-client-request-id,x-tabarnam-internal,x-internal-secret,x-internal-job-secret,x-job-kind",
  };
}

function json(obj, status = 200, req) {
  const payload = obj && typeof obj === "object" && !Array.isArray(obj)
    ? { ...obj, build_id: obj.build_id || String(BUILD_INFO.build_id || "") }
    : obj;

  return {
    status,
    headers: {
      ...cors(req),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Api-Handler": HANDLER_ID,
      "X-Api-Build-Id": String(BUILD_INFO.build_id || ""),
    },
    body: JSON.stringify(payload),
  };
}

function nowIso() {
  return new Date().toISOString();
}

function looksLikeUuid(value) {
  const s = String(value || "").trim();
  if (!s) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

async function bestEffortPatchSessionDoc({ container, sessionId, patch }) {
  if (!container || !sessionId || !patch) return { ok: false, error: "missing_inputs" };

  const sessionDocId = `_import_session_${sessionId}`;
  const existing = await readControlDoc(container, sessionDocId, sessionId).catch(() => null);

  const base = existing && typeof existing === "object"
    ? existing
    : {
        id: sessionDocId,
        session_id: sessionId,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_session",
        created_at: nowIso(),
      };

  const next = {
    ...base,
    ...(patch && typeof patch === "object" ? patch : {}),
    updated_at: nowIso(),
  };

  await upsertDoc(container, next).catch(() => null);
  return { ok: true };
}

let companiesPkPathPromise;
async function getCompaniesPkPath(container) {
  if (!container) return "/normalized_domain";
  companiesPkPathPromise ||= getContainerPartitionKeyPath(container, "/normalized_domain");
  try {
    return await companiesPkPathPromise;
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
        partitionKeyValue !== undefined
          ? container.item(id, partitionKeyValue)
          : container.item(id);
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
  const id = String(doc?.id || "").trim();
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

async function fetchSeedCompanies(container, sessionId, limit = 25) {
  if (!container) return [];
  const n = Math.max(1, Math.min(Number(limit) || 10, 50));

  const q = {
    query: `
      SELECT TOP ${n}
        c.id, c.company_name, c.name, c.url, c.website_url, c.normalized_domain,
        c.industries, c.product_keywords, c.keywords,
        c.headquarters_location, c.manufacturing_locations,
        c.curated_reviews, c.review_count, c.review_cursor,
        c.red_flag, c.red_flag_reason,
        c.hq_unknown, c.hq_unknown_reason,
        c.mfg_unknown, c.mfg_unknown_reason,
        c.source, c.source_stage, c.seed_ready,
        c.primary_candidate, c.seed
      FROM c
      WHERE (c.session_id = @sid OR c.import_session_id = @sid)
        AND NOT STARTSWITH(c.id, '_import_')
        AND (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true)
      ORDER BY c.created_at DESC
    `,
    parameters: [{ name: "@sid", value: sessionId }],
  };

  const { resources } = await container.items
    .query(q, { enableCrossPartitionQuery: true })
    .fetchAll();

  return Array.isArray(resources) ? resources : [];
}

async function fetchCompaniesByIds(container, ids) {
  if (!container) return [];
  const list = Array.isArray(ids) ? ids.map((v) => String(v || "").trim()).filter(Boolean) : [];
  if (list.length === 0) return [];

  const unique = Array.from(new Set(list)).slice(0, 25);
  const params = unique.map((id, idx) => ({ name: `@id${idx}`, value: id }));
  const inClause = unique.map((_, idx) => `@id${idx}`).join(", ");

  const q = {
    query: `SELECT * FROM c WHERE c.id IN (${inClause})`,
    parameters: params,
  };

  const { resources } = await container.items.query(q, { enableCrossPartitionQuery: true }).fetchAll();
  return Array.isArray(resources) ? resources : [];
}

async function handler(req, context) {
  const method = String(req?.method || "").toUpperCase();
  if (method === "OPTIONS") return { status: 200, headers: cors(req) };
  if (method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405, req);

  const url = new URL(req.url);
  const noCosmosMode = String(url.searchParams.get("no_cosmos") || "").trim() === "1";
  const cosmosEnabled = !noCosmosMode;

  let body = {};
  try {
    if (typeof req?.json === "function") {
      body = (await req.json().catch(() => ({}))) || {};
    } else {
      const txt = await req.text();
      if (txt) body = JSON.parse(txt);
    }
  } catch {}

  const sessionId = String(body?.session_id || body?.sessionId || url.searchParams.get("session_id") || "").trim();
  if (!sessionId) return json({ ok: false, error: "Missing session_id" }, 200, req);

  // Deterministic diagnosis marker: if this never updates, the request never reached the handler
  // (e.g. rejected at gateway/host key layer).
  const enteredAt = nowIso();
  try {
    console.log(`[${HANDLER_ID}] handler_entered`, {
      session_id: sessionId,
      entered_at: enteredAt,
      build_id: String(BUILD_INFO.build_id || ""),
    });
  } catch {}

  let cosmosContainer = null;
  if (cosmosEnabled && looksLikeUuid(sessionId)) {
    try {
      const endpoint = (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim();
      const key = (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim();
      const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
      const containerId = (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();

      if (endpoint && key && CosmosClient) {
        const client = new CosmosClient({ endpoint, key });
        cosmosContainer = client.database(databaseId).container(containerId);

        await bestEffortPatchSessionDoc({
          container: cosmosContainer,
          sessionId,
          patch: {
            resume_worker_handler_entered_at: enteredAt,
            resume_worker_handler_entered_build_id: String(BUILD_INFO.build_id || ""),
          },
        });
      }
    } catch {}
  }

  const authDecision = getInternalAuthDecision(req);

  if (!authDecision.auth_ok) {
    if (cosmosContainer) {
      await bestEffortPatchSessionDoc({
        container: cosmosContainer,
        sessionId,
        patch: {
          resume_worker_last_http_status: 401,
          resume_worker_last_reject_layer: "handler",
          resume_worker_last_auth: authDecision,
          resume_worker_last_finished_at: enteredAt,
          resume_worker_last_error: "unauthorized",
        },
      }).catch(() => null);
    }

    return json(
      {
        ok: false,
        session_id: sessionId,
        error: "Unauthorized",
        auth: authDecision,
      },
      401,
      req
    );
  }

  if (!cosmosEnabled) {
    return json({ ok: false, session_id: sessionId, root_cause: "no_cosmos", retryable: false }, 200, req);
  }

  const endpoint = (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim();
  const key = (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim();
  const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
  const containerId = (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();

  if (!endpoint || !key || !CosmosClient) {
    return json(
      {
        ok: false,
        session_id: sessionId,
        root_cause: "cosmos_not_configured",
        retryable: false,
        message: "Cosmos client not available or credentials missing",
      },
      200,
      req
    );
  }

  const client = new CosmosClient({ endpoint, key });
  const container = client.database(databaseId).container(containerId);

  const resumeDocId = `_import_resume_${sessionId}`;
  const sessionDocId = `_import_session_${sessionId}`;

  const [resumeDoc, sessionDoc] = await Promise.all([
    readControlDoc(container, resumeDocId, sessionId),
    readControlDoc(container, sessionDocId, sessionId),
  ]);

  if (!resumeDoc) {
    return json({ ok: false, session_id: sessionId, root_cause: "missing_resume_doc", retryable: false }, 200, req);
  }

  const lockUntil = Date.parse(String(resumeDoc?.lock_expires_at || "")) || 0;
  if (lockUntil && Date.now() < lockUntil) {
    return json(
      {
        ok: true,
        session_id: sessionId,
        skipped: true,
        reason: "resume_locked",
        lock_expires_at: resumeDoc.lock_expires_at,
      },
      200,
      req
    );
  }

  const attempt = Number.isFinite(Number(resumeDoc?.attempt)) ? Number(resumeDoc.attempt) : 0;
  const thisLockExpiresAt = new Date(Date.now() + 60_000).toISOString();

  await upsertDoc(container, {
    ...resumeDoc,
    status: "running",
    attempt: attempt + 1,
    last_invoked_at: nowIso(),
    lock_expires_at: thisLockExpiresAt,
    updated_at: nowIso(),
  }).catch(() => null);

  let seedDocs = await fetchSeedCompanies(container, sessionId, 25).catch(() => []);

  // If the session/company docs are missing the session_id markers (e.g. platform kill mid-flight),
  // fall back to canonical saved IDs persisted in the resume/session docs.
  if (seedDocs.length === 0) {
    const fallbackIds = Array.isArray(resumeDoc?.saved_company_ids) ? resumeDoc.saved_company_ids : [];
    if (fallbackIds.length > 0) {
      seedDocs = await fetchCompaniesByIds(container, fallbackIds).catch(() => []);
    }
  }

  const companies = seedDocs
    .map((d) => {
      const company_name = String(d?.company_name || d?.name || "").trim();
      const website_url = String(d?.website_url || d?.url || "").trim();
      const normalized_domain = String(d?.normalized_domain || "").trim();
      if (!company_name && !website_url) return null;

      return {
        id: d.id,
        company_name,
        website_url,
        url: String(d?.url || website_url).trim(),
        normalized_domain,
        industries: Array.isArray(d?.industries) ? d.industries : [],
        product_keywords: typeof d?.product_keywords === "string" ? d.product_keywords : "",
        keywords: Array.isArray(d?.keywords) ? d.keywords : [],
        headquarters_location: typeof d?.headquarters_location === "string" ? d.headquarters_location : "",
        manufacturing_locations: Array.isArray(d?.manufacturing_locations) ? d.manufacturing_locations : [],
        curated_reviews: Array.isArray(d?.curated_reviews) ? d.curated_reviews : [],
        review_count: typeof d?.review_count === "number" ? d.review_count : 0,
        review_cursor: d?.review_cursor && typeof d.review_cursor === "object" ? d.review_cursor : undefined,
        red_flag: Boolean(d?.red_flag),
        red_flag_reason: String(d?.red_flag_reason || "").trim(),
        hq_unknown: Boolean(d?.hq_unknown),
        hq_unknown_reason: String(d?.hq_unknown_reason || "").trim(),
        mfg_unknown: Boolean(d?.mfg_unknown),
        mfg_unknown_reason: String(d?.mfg_unknown_reason || "").trim(),
        source: String(d?.source || "").trim(),
        source_stage: String(d?.source_stage || "").trim(),
        seed_ready: Boolean(d?.seed_ready),
        primary_candidate: Boolean(d?.primary_candidate),
        seed: Boolean(d?.seed),
      };
    })
    .filter(Boolean);

  if (companies.length === 0) {
    await upsertDoc(container, {
      ...resumeDoc,
      status: "error",
      last_error: { code: "missing_seed_companies", message: "No saved company docs found for session" },
      lock_expires_at: null,
      updated_at: nowIso(),
    }).catch(() => null);

    return json(
      {
        ok: false,
        session_id: sessionId,
        root_cause: "missing_seed_companies",
        retryable: true,
      },
      200,
      req
    );
  }

  const request = sessionDoc?.request && typeof sessionDoc.request === "object" ? sessionDoc.request : {};

  const startBody = {
    session_id: sessionId,
    query: String(request?.query || "resume").trim() || "resume",
    queryTypes: Array.isArray(request?.queryTypes) ? request.queryTypes : [String(request?.queryType || "product_keyword")],
    location: typeof request?.location === "string" && request.location.trim() ? request.location.trim() : undefined,
    limit: Number.isFinite(Number(request?.limit)) ? Number(request.limit) : Math.min(25, companies.length),
    expand_if_few: true,
    dry_run: false,
    companies,
  };

  const base = new URL(req.url);
  const startUrl = new URL("/api/import-start", base.origin);
  startUrl.searchParams.set("skip_stages", "primary");
  startUrl.searchParams.set("max_stage", "expand");
  startUrl.searchParams.set("resume_worker", "1");
  startUrl.searchParams.set("deadline_ms", "25000");

  const startRes = await fetch(startUrl.toString(), {
    method: "POST",
    headers: buildInternalFetchHeaders(),
    body: JSON.stringify(startBody),
  }).catch((e) => ({ ok: false, status: 0, _error: e }));

  const startText = await (async () => {
    try {
      if (startRes && typeof startRes.text === "function") return await startRes.text();
    } catch {}
    return "";
  })();

  const startJson = (() => {
    try {
      return startText ? JSON.parse(startText) : null;
    } catch {
      return null;
    }
  })();

  const ok = Boolean(startRes?.ok) && Boolean(startJson?.ok !== false);

  const updatedAt = nowIso();

  await upsertDoc(container, {
    ...resumeDoc,
    status: ok ? "triggered" : "error",
    last_trigger_result: {
      ok: Boolean(ok),
      status: Number(startRes?.status || 0) || 0,
      stage_beacon: startJson?.stage_beacon || null,
      resume_needed: Boolean(startJson?.resume_needed),
    },
    lock_expires_at: null,
    updated_at: updatedAt,
  }).catch(() => null);

  // Lightweight telemetry on the session control doc so /admin/import Copy Debug has parity with refresh endpoints.
  if (sessionDoc && typeof sessionDoc === "object") {
    const invokedAt = String(resumeDoc?.last_invoked_at || "").trim() || updatedAt;
    const companyIdFromResponse = Array.isArray(startJson?.saved_company_ids_verified) && startJson.saved_company_ids_verified[0]
      ? String(startJson.saved_company_ids_verified[0]).trim()
      : Array.isArray(startJson?.saved_company_ids) && startJson.saved_company_ids[0]
        ? String(startJson.saved_company_ids[0]).trim()
        : companies && companies[0] && companies[0].id
          ? String(companies[0].id).trim()
          : null;

    const derivedResult = (() => {
      if (ok) return "ok";
      const root = typeof startJson?.root_cause === "string" && startJson.root_cause.trim() ? startJson.root_cause.trim() : "import_start_failed";
      const status = Number(startRes?.status || 0) || 0;
      return status ? `${root}_http_${status}` : root;
    })();

    await upsertDoc(container, {
      ...sessionDoc,
      resume_worker_last_invoked_at: invokedAt,
      resume_worker_last_finished_at: updatedAt,
      resume_worker_last_result: derivedResult,
      resume_worker_last_ok: Boolean(ok),
      resume_worker_last_http_status: Number(startRes?.status || 0) || 0,
      resume_worker_last_error: ok
        ? null
        : startRes?._error?.message || `import_start_http_${Number(startRes?.status || 0) || 0}`,
      resume_worker_last_stage_beacon: startJson?.stage_beacon || null,
      resume_worker_last_resume_needed: Boolean(startJson?.resume_needed),
      resume_worker_last_company_id: companyIdFromResponse,
      // Best-effort: import-start does not currently return a structured "fields written" list.
      resume_worker_last_written_fields:
        Array.isArray(startJson?.fields_written)
          ? startJson.fields_written
          : null,
      updated_at: updatedAt,
    }).catch(() => null);
  }

  return json(
    {
      ok: true,
      session_id: sessionId,
      triggered: true,
      companies_seeded: companies.length,
      import_start_status: Number(startRes?.status || 0) || 0,
      import_start_ok: Boolean(startRes?.ok),
      import_start_body: startJson || (startText ? { text: startText.slice(0, 2000) } : null),
    },
    200,
    req
  );
}

app.http("import-resume-worker", {
  route: "import/resume-worker",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler,
});

module.exports = { _test: { handler } };
