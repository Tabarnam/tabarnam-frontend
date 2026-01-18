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
} = require("../../_internalJobAuth");

const { getBuildInfo } = require("../../_buildInfo");
const { computeMissingFields } = require("../../_requiredFields");

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

function normalizeKey(value) {
  return String(value ?? "").trim().toLowerCase();
}

const GROK_ONLY_FIELDS = new Set([
  "headquarters_location",
  "manufacturing_locations",
  "reviews",
]);

function assertNoWebsiteFallback(field) {
  if (GROK_ONLY_FIELDS.has(field)) return true;
  return false;
}

function isTrueish(value) {
  if (value === true) return true;
  if (value === false) return false;
  const s = String(value ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "y";
}

function isTerminalMissingReason(reason) {
  return new Set([
    "low_quality_terminal",
    "not_found_terminal",
    "conflicting_sources_terminal",
    "not_disclosed",
    "exhausted",
    "not_found_on_site" // only if still used for other fields like logo, not HQ/MFG/Reviews
  ]).has(reason);
}

function deriveMissingReason(doc, field) {
  const d = doc && typeof doc === "object" ? doc : {};
  const f = String(field || "").trim();

  const reasons =
    d.import_missing_reason && typeof d.import_missing_reason === "object" && !Array.isArray(d.import_missing_reason)
      ? d.import_missing_reason
      : {};

  const direct = normalizeKey(reasons[f] || "");
  if (direct) return direct;

  if (f === "headquarters_location") {
    const val = normalizeKey(d.headquarters_location);
    if (val === "not disclosed" || val === "not_disclosed") return "not_disclosed";
  }

  if (f === "manufacturing_locations") {
    const rawList = Array.isArray(d.manufacturing_locations)
      ? d.manufacturing_locations
      : d.manufacturing_locations == null
        ? []
        : [d.manufacturing_locations];

    const normalized = rawList
      .map((loc) => {
        if (typeof loc === "string") return normalizeKey(loc);
        if (loc && typeof loc === "object") {
          return normalizeKey(loc.formatted || loc.full_address || loc.address || loc.location);
        }
        return "";
      })
      .filter(Boolean);

    if (normalized.length > 0 && normalized.every((v) => v === "not disclosed" || v === "not_disclosed")) {
      return "not_disclosed";
    }
  }

  if (f === "reviews") {
    const stage = normalizeKey(d.reviews_stage_status || d.review_cursor?.reviews_stage_status);
    if (stage === "exhausted") return "exhausted";
    if (Boolean(d.review_cursor && typeof d.review_cursor === "object" && d.review_cursor.exhausted === true)) return "exhausted";
  }

  if (f === "logo") {
    const stage = normalizeKey(d.logo_stage_status || d.logo_status);
    if (stage === "not_found_on_site") return "not_found_on_site";
  }

  return "";
}

function isTerminalMissingField(doc, field) {
  const reason = deriveMissingReason(doc, field);
  return isTerminalMissingReason(reason);
}

function computeRetryableMissingFields(doc) {
  const baseMissing = computeMissingFields(doc);
  return (Array.isArray(baseMissing) ? baseMissing : []).filter((f) => !isTerminalMissingField(doc, f));
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
        c.primary_candidate, c.seed,
        c.import_missing_fields, c.import_missing_reason, c.import_warnings
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

async function resumeWorkerHandler(req, context) {
  const method = String(req?.method || "").toUpperCase();
  if (method === "OPTIONS") return { status: 200, headers: cors(req) };
  if (method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405, req);

  const url = new URL(req.url);
  const noCosmosMode = String(url.searchParams.get("no_cosmos") || "").trim() === "1";
  const cosmosEnabled = !noCosmosMode;

  const parseBoundedInt = (value, fallback, { min = 1, max = 50 } = {}) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(Math.trunc(n), max));
  };

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

  const batchLimit = parseBoundedInt(
    body?.batch_limit ?? body?.batchLimit ?? url.searchParams.get("batch_limit") ?? url.searchParams.get("batchLimit"),
    25,
    { min: 1, max: 50 }
  );

  const deadlineMs = parseBoundedInt(
    body?.deadline_ms ?? body?.deadlineMs ?? url.searchParams.get("deadline_ms") ?? url.searchParams.get("deadlineMs"),
    25000,
    { min: 1000, max: 60000 }
  );

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
  if (cosmosEnabled) {
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

  const inProcessTrusted = Boolean(req && req.__in_process === true);
  const authDecision = inProcessTrusted
    ? {
        auth_ok: true,
        auth_method_used: "in-process",
        secret_source: "in-process",
        internal_flag_present: true,
      }
    : getInternalAuthDecision(req);

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

  if (!CosmosClient || !endpoint || !key) {
    return json(
      {
        ok: false,
        session_id: sessionId,
        root_cause: "cosmos_not_configured",
        retryable: false,
        details: {
          has_cosmos_module: Boolean(CosmosClient),
          has_endpoint: Boolean(endpoint),
          has_key: Boolean(key),
        },
      },
      200,
      req
    );
  }

  const client = new CosmosClient({ endpoint, key });
  const container = client.database(databaseId).container(containerId);

  const resumeDocId = `_import_resume_${sessionId}`;
  const sessionDocId = `_import_session_${sessionId}`;

  let [resumeDoc, sessionDoc] = await Promise.all([
    readControlDoc(container, resumeDocId, sessionId).catch(() => null),
    readControlDoc(container, sessionDocId, sessionId).catch(() => null),
  ]);

  // Required: resume worker must always upsert a resume control doc every run.
  if (!resumeDoc) {
    const now = nowIso();
    const savedIds = Array.isArray(sessionDoc?.saved_company_ids)
      ? sessionDoc.saved_company_ids
      : Array.isArray(sessionDoc?.saved_ids)
        ? sessionDoc.saved_ids
        : Array.isArray(sessionDoc?.saved_company_ids_verified)
          ? sessionDoc.saved_company_ids_verified
          : [];

    const created = {
      id: resumeDocId,
      session_id: sessionId,
      normalized_domain: "import",
      partition_key: "import",
      type: "import_control",
      created_at: now,
      updated_at: now,
      status: "queued",
      doc_created: false,
      saved_company_ids: savedIds.map((v) => String(v || "").trim()).filter(Boolean).slice(0, 50),
      missing_by_company: [],
    };

    const upsertResult = await upsertDoc(container, created).catch(() => ({ ok: false }));
    const doc_created = Boolean(upsertResult && upsertResult.ok);

    resumeDoc = { ...created, doc_created };

    if (doc_created) {
      // Refresh from Cosmos so we always operate on the authoritative doc.
      resumeDoc = (await readControlDoc(container, resumeDocId, sessionId).catch(() => null)) || resumeDoc;
    }
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

  const resumeControlUpsert = await upsertDoc(container, {
    ...(resumeDoc && typeof resumeDoc === "object" ? resumeDoc : {}),
    id: resumeDocId,
    session_id: sessionId,
    normalized_domain: "import",
    partition_key: "import",
    type: "import_control",
    doc_created: true,
    status: "running",
    attempt: attempt + 1,
    last_invoked_at: nowIso(),
    lock_expires_at: thisLockExpiresAt,
    updated_at: nowIso(),
  }).catch(() => ({ ok: false }));

  const resume_control_doc_upsert_ok = Boolean(resumeControlUpsert && resumeControlUpsert.ok);
  if (resume_control_doc_upsert_ok && resumeDoc && typeof resumeDoc === "object") {
    resumeDoc.doc_created = true;
  }

  let seedDocs = await fetchSeedCompanies(container, sessionId, batchLimit).catch(() => []);

  // If the session/company docs are missing the session_id markers (e.g. platform kill mid-flight),
  // fall back to canonical saved IDs persisted in the resume/session docs.
  if (seedDocs.length === 0) {
    const fallbackIds = Array.isArray(resumeDoc?.saved_company_ids) ? resumeDoc.saved_company_ids : [];
    if (fallbackIds.length > 0) {
      seedDocs = await fetchCompaniesByIds(container, fallbackIds).catch(() => []);
    }
  }

  // Idempotency: only attempt resume on company docs that still violate the required-fields contract.
  // Placeholders like "Unknown" do NOT count as present.
  if (seedDocs.length > 0) {
    const withMissing = seedDocs.filter((d) => computeRetryableMissingFields(d).length > 0);

    if (withMissing.length > 0) {
      seedDocs = withMissing;
    } else {
      const updatedAt = nowIso();

      await upsertDoc(container, {
        ...resumeDoc,
        status: "complete",
        missing_by_company: [],
        last_trigger_result: {
          ok: true,
          status: 200,
          stage_beacon: "already_complete",
          resume_needed: false,
        },
        lock_expires_at: null,
        updated_at: updatedAt,
      }).catch(() => null);

      await bestEffortPatchSessionDoc({
        container,
        sessionId,
        patch: {
          resume_needed: false,
          resume_updated_at: updatedAt,
          updated_at: updatedAt,
        },
      }).catch(() => null);

      return json(
        {
          ok: true,
          session_id: sessionId,
          skipped: true,
          reason: "no_missing_required_fields",
          batch_limit: batchLimit,
        },
        200,
        req
      );
    }
  }

  const buildSeedCompanyPayload = (d) => {
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
      headquarters_location: typeof d?.headquarters_location === "string" ? d.headquarters_location : d?.headquarters_location || "",
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
  };

  const request = sessionDoc?.request && typeof sessionDoc.request === "object" ? sessionDoc.request : {};

  const initialMissing = seedDocs.length === 1 && seedDocs[0] ? computeRetryableMissingFields(seedDocs[0]) : [];
  const forceStages =
    seedDocs.length === 1 &&
    initialMissing.some(
      (f) => f === "industries" || f === "headquarters_location" || f === "manufacturing_locations" || f === "reviews"
    );

  // Fast path: for single-company company_url imports, avoid repeatedly calling import-start/XAI
  // once we've already tried enough times to conclude industries are not recoverable.
  // IMPORTANT: do NOT terminalize HQ/MFG/Reviews here — those are still handled via Grok-only live search.
  if (forceStages && seedDocs.length === 1 && seedDocs[0]) {
    const doc = seedDocs[0];
    const retryableMissing = computeRetryableMissingFields(doc);

    if (retryableMissing.includes("industries")) {
      const attemptsObj =
        doc.import_low_quality_attempts && typeof doc.import_low_quality_attempts === "object" && !Array.isArray(doc.import_low_quality_attempts)
          ? { ...doc.import_low_quality_attempts }
          : {};

      const reasonsObj =
        doc.import_missing_reason && typeof doc.import_missing_reason === "object" && !Array.isArray(doc.import_missing_reason)
          ? { ...doc.import_missing_reason }
          : {};

      const prevReason = normalizeKey(reasonsObj.industries || "");
      const baseReason = prevReason || "not_found";
      const currentAttempts = Number(attemptsObj.industries) || 0;

      // If the next attempt would hit the cap, terminalize industries in-place and continue.
      if (currentAttempts >= 2) {
        const updatedAt = nowIso();
        attemptsObj.industries = currentAttempts + 1;
        reasonsObj.industries = baseReason === "low_quality" ? "low_quality_terminal" : "not_found_terminal";

        const terminalParts = [];
        terminalParts.push("industries (" + (baseReason === "low_quality" ? "low quality" : "missing") + ")");

        const computedTerminalReason = terminalParts.length
          ? "Enrichment complete (terminal): " + terminalParts.join(", ")
          : "Enrichment complete (terminal)";

        const existingReason = String(doc.red_flag_reason || "").trim();
        const replaceReason = !existingReason || /enrichment pending/i.test(existingReason);

        const nextDoc = {
          ...doc,
          import_missing_reason: reasonsObj,
          import_low_quality_attempts: attemptsObj,
          import_missing_fields: Array.isArray(doc.import_missing_fields) ? doc.import_missing_fields : computeMissingFields(doc),
          red_flag: true,
          red_flag_reason: replaceReason ? computedTerminalReason : existingReason,
          updated_at: updatedAt,
        };

        await upsertDoc(container, nextDoc).catch(() => null);

        const refreshedFinal = await fetchCompaniesByIds(container, [String(doc.id).trim()]).catch(() => []);
        if (Array.isArray(refreshedFinal) && refreshedFinal.length > 0) seedDocs = refreshedFinal;
      }
    }
  }

  // Resume behavior: call /api/import/start once, skipping only what is already satisfied.
  const missingUnion = new Set();
  for (const doc of seedDocs) {
    for (const field of computeRetryableMissingFields(doc)) missingUnion.add(field);
  }

  const needsKeywords = missingUnion.has("industries") || missingUnion.has("product_keywords");
  const needsReviews = missingUnion.has("reviews");
  const needsLocation = missingUnion.has("headquarters_location") || missingUnion.has("manufacturing_locations");

  const skipStages = new Set(["primary", "expand"]);
  if (!needsKeywords) skipStages.add("keywords");
  if (!needsReviews) skipStages.add("reviews");
  if (!needsLocation) skipStages.add("location");

  const base = new URL(req.url);
  const startUrlBase = new URL("/api/import/start", base.origin);
  startUrlBase.searchParams.set("resume_worker", "1");
  startUrlBase.searchParams.set("deadline_ms", String(deadlineMs));
  if (skipStages.size > 0) {
    startUrlBase.searchParams.set("skip_stages", Array.from(skipStages).join(","));
  }

  // IMPORTANT: We invoke import-start directly in-process to avoid an internal HTTP round-trip.
  const startRequest = buildInternalFetchRequest({ job_kind: "import_resume" });

  const invokeImportStartDirect = async (startBody, urlOverride) => {
    const { handler: importStartHandler } = require("../../import-start/index.js");

    const hdrs = new Headers();
    for (const [k, v] of Object.entries(startRequest.headers || {})) {
      if (v === undefined || v === null) continue;
      hdrs.set(k, String(v));
    }

    const internalReq = {
      method: "POST",
      url: String(urlOverride || startUrlBase).toString(),
      headers: hdrs,
      json: async () => startBody,
      text: async () => JSON.stringify(startBody),
    };

    return await importStartHandler(internalReq, context);
  };

  const startTime = Date.now();
  const maxIterations = 1;

  let iteration = 0;
  let lastStartRes = null;
  let lastStartText = "";
  let lastStartJson = null;
  let lastStartHttpStatus = 0;
  let lastStartOk = false;

  let lastImportStartRequestPayload = null;
  let lastImportStartRequestUrl = null;
  let lastImportStartResponse = null;
  let last_error_details = null;

  let missing_by_company = [];

  while (iteration < maxIterations) {
    const companies = seedDocs.map(buildSeedCompanyPayload).filter(Boolean);

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

    const startBody = {
      session_id: sessionId,
      query: String(request?.query || "resume").trim() || "resume",
      queryTypes: Array.isArray(request?.queryTypes) ? request.queryTypes : [String(request?.queryType || "product_keyword")],
      location: typeof request?.location === "string" && request.location.trim() ? request.location.trim() : undefined,
      limit: Number.isFinite(Number(request?.limit)) ? Number(request.limit) : Math.min(batchLimit, companies.length),
      expand_if_few: true,
      dry_run: false,
      companies,
    };

    const urlForThisPass = startUrlBase;

    lastImportStartRequestPayload = startBody;
    lastImportStartRequestUrl = String(urlForThisPass);

    try {
      lastStartRes = await invokeImportStartDirect(startBody, urlForThisPass);
      if (lastStartRes?.body && typeof lastStartRes.body === "string") lastStartText = lastStartRes.body;
      else if (lastStartRes?.body && typeof lastStartRes.body === "object") lastStartText = JSON.stringify(lastStartRes.body);
      else lastStartText = "";

      try {
        lastStartJson = lastStartText ? JSON.parse(lastStartText) : null;
      } catch {
        lastStartJson = null;
      }
    } catch (e) {
      lastStartRes = { ok: false, status: 0, _error: e };
      lastStartText = "";
      lastStartJson = null;
    }

    lastStartHttpStatus = Number(lastStartJson?.http_status || lastStartRes?.status || 0) || 0;
    lastStartOk = Boolean(lastStartJson) ? lastStartJson.ok !== false : false;

    lastImportStartResponse = lastStartJson || (lastStartText ? { text: lastStartText.slice(0, 8000) } : null);

    if (!lastStartOk || lastStartHttpStatus >= 400) {
      const msg =
        typeof lastStartJson?.error_message === "string" && lastStartJson.error_message.trim()
          ? lastStartJson.error_message.trim()
          : typeof lastStartJson?.root_cause === "string" && lastStartJson.root_cause.trim()
            ? lastStartJson.root_cause.trim()
            : lastStartHttpStatus
              ? `import_start_http_${lastStartHttpStatus}`
              : "import_start_failed";
      last_error_details = String(msg).slice(0, 240);
    }

    // Re-load docs and re-check contract.
    const ids = companies.map((c) => String(c?.id || "").trim()).filter(Boolean).slice(0, 25);
    const refreshed = ids.length > 0 ? await fetchCompaniesByIds(container, ids).catch(() => []) : [];

    const refreshedById = new Map(
      (Array.isArray(refreshed) ? refreshed : []).map((d) => [String(d?.id || "").trim(), d])
    );

    seedDocs = ids.map((id) => refreshedById.get(id)).filter(Boolean);

    missing_by_company = seedDocs
      .map((d) => {
        const missing = computeRetryableMissingFields(d);
        if (missing.length === 0) return null;
        return {
          company_id: String(d?.id || "").trim(),
          company_name: String(d?.company_name || d?.name || "").trim(),
          website_url: String(d?.website_url || d?.url || "").trim(),
          missing_fields: missing,
        };
      })
      .filter(Boolean);

    if (missing_by_company.length === 0) break;

    iteration += 1;
    const elapsed = Date.now() - startTime;
    if (elapsed > Math.max(0, deadlineMs - 1500)) break;
  }

  const updatedAt = nowIso();

  const importStartRequestSummary = lastImportStartRequestPayload && typeof lastImportStartRequestPayload === "object"
    ? {
        session_id: lastImportStartRequestPayload.session_id,
        query: lastImportStartRequestPayload.query,
        queryTypes: Array.isArray(lastImportStartRequestPayload.queryTypes)
          ? lastImportStartRequestPayload.queryTypes
          : null,
        limit: lastImportStartRequestPayload.limit,
        expand_if_few: Boolean(lastImportStartRequestPayload.expand_if_few),
        dry_run: Boolean(lastImportStartRequestPayload.dry_run),
        companies_count: Array.isArray(lastImportStartRequestPayload.companies)
          ? lastImportStartRequestPayload.companies.length
          : 0,
        company_ids: Array.isArray(lastImportStartRequestPayload.companies)
          ? lastImportStartRequestPayload.companies
              .map((c) => String(c?.id || c?.company_id || "").trim())
              .filter(Boolean)
              .slice(0, 25)
          : [],
      }
    : null;

  const importStartDebug = {
    url: lastImportStartRequestUrl,
    request: importStartRequestSummary,
    response: lastImportStartResponse,
    last_error_details,
  };

  let exhausted = false;

  // Terminal behavior: after a full forced pass for a single-company import,
  // if we're still missing core fields, write explicit terminal markers so the session completes cleanly.
  if (forceStages && seedDocs.length === 1 && missing_by_company.length > 0) {
    const shouldExhaust = iteration >= maxIterations || Date.now() - startTime > Math.max(0, deadlineMs - 1500);

    if (shouldExhaust) {
      exhausted = true;
      const doc = seedDocs[0];

      if (doc && typeof doc === "object" && String(doc.id || "").trim()) {
        const missing = computeMissingFields(doc);

        const import_missing_reason =
          doc.import_missing_reason && typeof doc.import_missing_reason === "object"
            ? { ...doc.import_missing_reason }
            : {};

        const patch = {};

        if (missing.includes("headquarters_location")) {
          patch.headquarters_location = "Not disclosed";
          patch.hq_unknown = true;
          patch.hq_unknown_reason = "not_disclosed";
          import_missing_reason.headquarters_location = "not_disclosed";
        }

        if (missing.includes("manufacturing_locations")) {
          patch.manufacturing_locations = ["Not disclosed"];
          patch.manufacturing_locations_reason = "not_disclosed";
          patch.mfg_unknown = true;
          patch.mfg_unknown_reason = "not_disclosed";
          import_missing_reason.manufacturing_locations = "not_disclosed";
        }

        if (missing.includes("reviews")) {
          patch.reviews_stage_status = "exhausted";
          const cursor = doc.review_cursor && typeof doc.review_cursor === "object" ? { ...doc.review_cursor } : {};
          patch.review_cursor = {
            ...cursor,
            exhausted: true,
            reviews_stage_status: cursor.reviews_stage_status || "exhausted",
            exhausted_at: nowIso(),
          };
          import_missing_reason.reviews = "exhausted";
        }

        const LOW_QUALITY_MAX_ATTEMPTS = 3;

        if (missing.includes("industries")) {
          const attemptsObj =
            doc.import_low_quality_attempts && typeof doc.import_low_quality_attempts === "object" && !Array.isArray(doc.import_low_quality_attempts)
              ? { ...doc.import_low_quality_attempts }
              : {};

          const prevReason = normalizeKey(import_missing_reason.industries || "");
          const baseReason = prevReason || "not_found";

          const nextAttempts = (Number(attemptsObj.industries) || 0) + 1;
          attemptsObj.industries = nextAttempts;

          doc.import_low_quality_attempts = attemptsObj;

          if (nextAttempts >= LOW_QUALITY_MAX_ATTEMPTS) {
            import_missing_reason.industries = baseReason === "low_quality" ? "low_quality_terminal" : "not_found_terminal";
          } else {
            import_missing_reason.industries = baseReason;
          }
        }

        if (missing.includes("product_keywords")) {
          const attemptsObj =
            doc.import_low_quality_attempts && typeof doc.import_low_quality_attempts === "object" && !Array.isArray(doc.import_low_quality_attempts)
              ? { ...doc.import_low_quality_attempts }
              : {};

          const prevReason = normalizeKey(import_missing_reason.product_keywords || "");
          const baseReason = prevReason || "not_found";

          const nextAttempts = (Number(attemptsObj.product_keywords) || 0) + 1;
          attemptsObj.product_keywords = nextAttempts;

          doc.import_low_quality_attempts = attemptsObj;

          if (nextAttempts >= LOW_QUALITY_MAX_ATTEMPTS) {
            import_missing_reason.product_keywords = baseReason === "low_quality" ? "low_quality_terminal" : "not_found_terminal";
          } else {
            import_missing_reason.product_keywords = baseReason;
          }
        }

        const existingReason = String(doc.red_flag_reason || "").trim();
        const replaceReason = !existingReason || /enrichment pending/i.test(existingReason);

        const terminalParts = [];
        if (missing.includes("industries")) {
          const reason = normalizeKey(import_missing_reason.industries || "");
          terminalParts.push(reason === "low_quality" || reason === "low_quality_terminal" ? "industries (low quality)" : "industries missing");
        }
        if (missing.includes("product_keywords")) {
          const reason = normalizeKey(import_missing_reason.product_keywords || "");
          terminalParts.push(reason === "low_quality" || reason === "low_quality_terminal" ? "keywords (low quality)" : "keywords missing");
        }
        if (missing.includes("headquarters_location")) terminalParts.push("HQ not disclosed");
        if (missing.includes("manufacturing_locations")) terminalParts.push("manufacturing not disclosed");
        if (missing.includes("reviews")) terminalParts.push("reviews exhausted");
        if (missing.includes("logo")) terminalParts.push("logo not found");

        const computedTerminalReason = terminalParts.length
          ? `Enrichment complete (terminal): ${terminalParts.join(", ")}`
          : "Enrichment complete (terminal)";

        const next = {
          ...doc,
          ...patch,
          import_missing_reason,
          import_missing_fields: missing,
          red_flag: Boolean(doc.red_flag) || missing.some((f) => f === "headquarters_location" || f === "manufacturing_locations"),
          red_flag_reason: replaceReason ? computedTerminalReason : existingReason,
          resume_exhausted: true,
          updated_at: updatedAt,
        };

        await upsertDoc(container, next).catch(() => null);

        const refreshedFinal = await fetchCompaniesByIds(container, [String(doc.id).trim()]).catch(() => []);
        if (Array.isArray(refreshedFinal) && refreshedFinal.length > 0) {
          seedDocs = refreshedFinal;
          missing_by_company = seedDocs
            .map((d) => {
              const missing = computeRetryableMissingFields(d);
              if (missing.length === 0) return null;
              return {
                company_id: String(d?.id || "").trim(),
                company_name: String(d?.company_name || d?.name || "").trim(),
                website_url: String(d?.website_url || d?.url || "").trim(),
                missing_fields: missing,
              };
            })
            .filter(Boolean);
        }
      }
    }
  }

  const docsById = new Map(
    (Array.isArray(seedDocs) ? seedDocs : [])
      .map((d) => [String(d?.id || "").trim(), d])
      .filter((pair) => Boolean(pair[0]))
  );

  let totalMissing = 0;
  let totalRetryableMissing = 0;
  let totalTerminalMissing = 0;

  for (const entry of missing_by_company) {
    const doc = docsById.get(String(entry?.company_id || "").trim());
    if (!doc) continue;

    const missing = Array.isArray(doc?.import_missing_fields)
      ? doc.import_missing_fields
      : Array.isArray(entry?.missing_fields)
        ? entry.missing_fields
        : [];

    const reasons = doc?.import_missing_reason && typeof doc.import_missing_reason === "object" && !Array.isArray(doc.import_missing_reason)
      ? doc.import_missing_reason
      : {};

    const retryableMissing = missing.filter((f) => {
      const reason = deriveMissingReason(doc, f) || normalizeKey(reasons[f] || "");
      return !isTerminalMissingReason(reason);
    });

    const retryableMissingCount = retryableMissing.length;
    const terminalMissingCount = missing.length - retryableMissingCount;

    totalMissing += missing.length;
    totalRetryableMissing += retryableMissingCount;
    totalTerminalMissing += terminalMissingCount;
  }

  const retryableMissingCount = totalRetryableMissing;
  const terminalMissingCount = totalTerminalMissing;

  const terminalOnly = retryableMissingCount === 0;

  const completion_beacon = terminalOnly ? "complete" : exhausted ? "enrichment_exhausted" : "enrichment_complete";

  // Resume-needed is ONLY retryable based.
  const resumeNeeded = retryableMissingCount > 0;

  await upsertDoc(container, {
    ...resumeDoc,
    status: resumeNeeded ? (lastStartOk ? "queued" : "error") : "complete",
    missing_by_company,
    last_trigger_result: {
      ok: Boolean(lastStartOk),
      status: lastStartHttpStatus || (Number(lastStartRes?.status || 0) || 0),
      stage_beacon: resumeNeeded ? lastStartJson?.stage_beacon || null : completion_beacon,
      resume_needed: resumeNeeded,
      iterations: iteration + 1,
      resume_control_doc_upsert_ok: resume_control_doc_upsert_ok,
      ...(lastStartHttpStatus === 400 || !lastStartOk ? { import_start_debug: importStartDebug } : {}),
    },
    lock_expires_at: null,
    updated_at: updatedAt,
  }).catch(() => null);

  await bestEffortPatchSessionDoc({
    container,
    sessionId,
    patch: {
      resume_needed: resumeNeeded,
      resume: {
        status: resumeNeeded ? (lastStartOk ? "queued" : "error") : "complete",
        updated_at: updatedAt,
      },
      resume_updated_at: updatedAt,
      ...(resumeNeeded
        ? {}
        : {
            status: "complete",
            stage_beacon: completion_beacon,
            ...(exhausted ? { resume_exhausted: true } : {}),
            completed_at: updatedAt,
          }),
      updated_at: updatedAt,
    },
  }).catch(() => null);

  // Lightweight telemetry on the session control doc.
  if (sessionDoc && typeof sessionDoc === "object") {
    const invokedAt = String(resumeDoc?.last_invoked_at || "").trim() || updatedAt;

    const companyIdFromResponse = Array.isArray(lastStartJson?.saved_company_ids_verified) && lastStartJson.saved_company_ids_verified[0]
      ? String(lastStartJson.saved_company_ids_verified[0]).trim()
      : Array.isArray(lastStartJson?.saved_company_ids) && lastStartJson.saved_company_ids[0]
        ? String(lastStartJson.saved_company_ids[0]).trim()
        : seedDocs && seedDocs[0] && seedDocs[0].id
          ? String(seedDocs[0].id).trim()
          : null;

    const derivedResult = (() => {
      if (lastStartOk) return resumeNeeded ? "ok_incomplete" : "ok_complete";
      const root = typeof lastStartJson?.root_cause === "string" && lastStartJson.root_cause.trim()
        ? lastStartJson.root_cause.trim()
        : "import_start_failed";
      const status = lastStartHttpStatus || (Number(lastStartRes?.status || 0) || 0);
      return status ? `${root}_http_${status}` : root;
    })();

    await upsertDoc(container, {
      ...sessionDoc,
      resume_worker_last_invoked_at: invokedAt,
      resume_worker_last_finished_at: updatedAt,
      resume_worker_last_result: derivedResult,
      resume_worker_last_ok: Boolean(lastStartOk),
      resume_worker_last_http_status: lastStartHttpStatus || (Number(lastStartRes?.status || 0) || 0),
      resume_worker_last_error: lastStartOk
        ? null
        : lastStartRes?._error?.message || `import_start_http_${lastStartHttpStatus || (Number(lastStartRes?.status || 0) || 0)}`,
      resume_worker_last_error_details: last_error_details || null,
      resume_worker_last_stage_beacon: lastStartJson?.stage_beacon || null,
      resume_worker_last_resume_needed: resumeNeeded,
      resume_worker_last_company_id: companyIdFromResponse,
      resume_worker_last_resume_doc_upsert_ok: resume_control_doc_upsert_ok,
      ...(lastStartHttpStatus === 400
        ? {
            resume_worker_last_import_start_url: lastImportStartRequestUrl,
            resume_worker_last_import_start_request: importStartRequestSummary,
            resume_worker_last_import_start_response: lastImportStartResponse,
          }
        : {}),
      updated_at: updatedAt,
    }).catch(() => null);
  }

  return json(
    {
      ok: true,
      session_id: sessionId,
      triggered: true,
      import_start_status: lastStartHttpStatus || (Number(lastStartRes?.status || 0) || 0),
      import_start_ok: Boolean(lastStartOk),
      resume_needed: resumeNeeded,
      iterations: iteration + 1,
      missing_by_company,
      import_start_body: lastStartJson || (lastStartText ? { text: lastStartText.slice(0, 2000) } : null),
    },
    200,
    req
  );
}

async function invokeResumeWorkerInProcess({
  session_id,
  sessionId,
  context,
  workerRequest,
  no_cosmos,
  batch_limit,
  deadline_ms,
} = {}) {
  const sid = String(session_id || sessionId || "").trim();
  if (!sid) {
    return {
      ok: false,
      status: 0,
      bodyText: "",
      error: new Error("missing_session_id"),
      gateway_key_attached: false,
      request_id: null,
    };
  }

  const reqMeta = workerRequest && typeof workerRequest === "object"
    ? workerRequest
    : buildInternalFetchRequest({ job_kind: "import_resume" });

  const hdrs = new Headers();
  for (const [k, v] of Object.entries(reqMeta.headers || {})) {
    if (v === undefined || v === null) continue;
    hdrs.set(k, String(v));
  }

  const inProcessUrl = new URL("https://in-process.local/api/import/resume-worker");
  inProcessUrl.searchParams.set("session_id", sid);
  if (no_cosmos) inProcessUrl.searchParams.set("no_cosmos", "1");
  if (batch_limit != null) inProcessUrl.searchParams.set("batch_limit", String(batch_limit));
  if (deadline_ms != null) inProcessUrl.searchParams.set("deadline_ms", String(deadline_ms));

  const body = {
    session_id: sid,
    ...(batch_limit != null ? { batch_limit } : {}),
    ...(deadline_ms != null ? { deadline_ms } : {}),
  };

  const internalReq = {
    method: "POST",
    url: inProcessUrl.toString(),
    headers: hdrs,
    __in_process: true,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };

  let res;
  try {
    res = await resumeWorkerHandler(internalReq, context);
  } catch (e) {
    return {
      ok: false,
      status: 0,
      bodyText: "",
      error: e,
      gateway_key_attached: Boolean(reqMeta.gateway_key_attached),
      request_id: reqMeta.request_id || null,
    };
  }

  const status = Number(res?.status || 0) || 0;
  const ok = status >= 200 && status < 300;
  const bodyText =
    typeof res?.body === "string" ? res.body : res?.body != null ? JSON.stringify(res.body) : "";

  return {
    ok,
    status,
    bodyText,
    error: res?._error || null,
    gateway_key_attached: Boolean(reqMeta.gateway_key_attached),
    request_id: reqMeta.request_id || null,
  };
}

module.exports = {
  resumeWorkerHandler,
  invokeResumeWorkerInProcess,
  _test: {
    resumeWorkerHandler,
    invokeResumeWorkerInProcess,
  },
};
