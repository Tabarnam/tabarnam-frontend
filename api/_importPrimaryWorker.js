const { getXAIEndpoint, getXAIKey, resolveXaiEndpointForModel } = require("./_shared");
const { getJob, tryClaimJob, patchJob } = require("./_importPrimaryJobStore");

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJsonParse(text) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function redactUrlQueryAndHash(rawUrl) {
  const s = String(rawUrl || "").trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return s.split("?")[0].split("#")[0];
  }
}

function redactErrorForJob(err) {
  if (!err) return { message: "Unknown error" };
  const out = {
    name: typeof err?.name === "string" ? err.name : "Error",
    message: typeof err?.message === "string" ? err.message : String(err),
  };
  if (typeof err?.code === "string") out.code = err.code;
  if (typeof err?.status === "number") out.status = err.status;
  if (typeof err?.upstream_status === "number") out.upstream_status = err.upstream_status;
  if (typeof err?.xai_request_id === "string" && err.xai_request_id.trim()) out.xai_request_id = err.xai_request_id.trim();
  if (typeof err?.text_preview === "string" && err.text_preview.trim()) out.upstream_text_preview = err.text_preview.trim();
  return out;
}

function buildMeta({ invocationSource, workerId, workerClaimed, claimError, stallDetected }) {
  return {
    invocation_source: invocationSource || null,
    worker_id: workerId || null,
    worker_claimed: Boolean(workerClaimed),
    ...(claimError ? { claim_error: String(claimError) } : {}),
    ...(stallDetected ? { stall_detected: true } : {}),
  };
}

function buildFallbackOutboundBodyFromJob(job) {
  const req = job?.request_payload && typeof job.request_payload === "object" ? job.request_payload : {};

  const query = typeof req.query === "string" ? req.query.trim() : "";
  if (!query) return "";

  const queryTypes = Array.isArray(req.queryTypes)
    ? req.queryTypes
        .map((t) => String(t || "").trim())
        .filter(Boolean)
        .slice(0, 10)
    : [];

  const limitRaw = Number(req.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.trunc(limitRaw), 25) : 10;

  const userPrompt = [
    `Find ${limit} companies that match the following search: ${query}`,
    queryTypes.length ? `QueryTypes: ${queryTypes.join(", ")}` : "",
    "Return ONLY valid JSON.",
    "Response must be a JSON array.",
    "Each object must include: company_name (string) and website_url (string).",
  ]
    .filter(Boolean)
    .join("\n")
    .trim();

  const systemPrompt =
    "You are a precise assistant. Follow the user's instructions exactly. When asked for JSON, output ONLY valid JSON with no markdown, no prose, and no extra keys.";

  const model =
    typeof job?.xai_model === "string" && job.xai_model.trim() ? job.xai_model.trim() : "grok-4-latest";

  try {
    return JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1,
      stream: false,
    });
  } catch {
    return "";
  }
}

async function postJsonWithTimeout(url, { headers, body, timeoutMs }) {
  const u = String(url || "").trim();
  if (!u) throw new Error("Missing upstream URL");

  const ms = Number.isFinite(Number(timeoutMs)) ? Math.max(1, Number(timeoutMs)) : 30_000;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);

  try {
    const res = await fetch(u, {
      method: "POST",
      headers: headers && typeof headers === "object" ? headers : {},
      body: typeof body === "string" ? body : "",
      signal: controller.signal,
    });

    const text = await res.text().catch(() => "");
    const data = safeJsonParse(text) || (text ? { text } : {});

    return {
      status: res.status,
      ok: res.ok,
      headers: Object.fromEntries(res.headers.entries()),
      data,
      text,
    };
  } catch (e) {
    const isAbort = e && typeof e === "object" && (e.name === "AbortError" || e.code === "ECONNABORTED");
    if (isAbort) {
      const err = new Error("Upstream timeout");
      err.code = "UPSTREAM_TIMEOUT";
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseCompaniesFromXaiResponse(xaiResponse) {
  const responseText =
    xaiResponse?.data?.choices?.[0]?.message?.content ||
    (typeof xaiResponse?.text === "string" && xaiResponse.text ? xaiResponse.text : "") ||
    JSON.stringify(xaiResponse?.data || {});

  let companies = [];
  let parseError = null;

  try {
    const jsonMatch = typeof responseText === "string" ? responseText.match(/\[[\s\S]*\]/) : null;
    if (jsonMatch) {
      companies = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(companies)) companies = [];
    }
  } catch (e) {
    parseError = e?.message || String(e);
    companies = [];
  }

  return {
    companies: Array.isArray(companies) ? companies.filter((it) => it && typeof it === "object") : [],
    parse_error: parseError,
    response_len: typeof responseText === "string" ? responseText.length : 0,
  };
}

function isTransientUpstream(status) {
  if (!Number.isFinite(Number(status))) return true;
  const s = Number(status);
  if (s === 408 || s === 421 || s === 429) return true;
  return s >= 500 && s <= 599;
}

function getHeartbeatTimestamp(job) {
  const hb = Date.parse(job?.last_heartbeat_at || "") || 0;
  if (hb) return hb;
  const updated = Date.parse(job?.updated_at || "") || 0;
  if (updated) return updated;
  const started = Date.parse(job?.started_at || "") || 0;
  return started || 0;
}

function getJobCreatedTimestamp(job) {
  const created = Date.parse(job?.created_at || "") || 0;
  if (created) return created;
  const updated = Date.parse(job?.updated_at || "") || 0;
  if (updated) return updated;
  const started = Date.parse(job?.started_at || "") || 0;
  return started || 0;
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.trunc(n);
}

function buildRuntimeInfo(job, nowTs, hardMaxRuntimeMs) {
  const startedAtTs = Date.parse(job?.started_at || "") || 0;
  const startTs = startedAtTs || nowTs;

  const elapsedMs = Math.max(0, nowTs - startTs);
  const remainingBudgetMs = Math.max(0, hardMaxRuntimeMs - elapsedMs);

  const upstreamCallsMade = toPositiveInt(job?.upstream_calls_made, 0);
  const candidatesFoundFromJob = Number.isFinite(Number(job?.companies_candidates_found))
    ? Math.max(0, Number(job.companies_candidates_found))
    : Number.isFinite(Number(job?.companies_count))
      ? Math.max(0, Number(job.companies_count))
      : 0;

  return {
    start_ts: startTs,
    elapsed_ms: elapsedMs,
    remaining_budget_ms: remainingBudgetMs,
    upstream_calls_made: upstreamCallsMade,
    companies_candidates_found: candidatesFoundFromJob,
    early_exit_triggered: Boolean(job?.early_exit_triggered),
  };
}

async function markPrimaryError({
  sessionId,
  cosmosEnabled,
  code,
  message,
  stageBeacon,
  details,
  lockTtlMs,
}) {
  const now = Date.now();
  const patch = {
    job_state: "error",
    stage_beacon: stageBeacon,
    last_error: {
      code,
      message,
      ...(details && typeof details === "object" ? details : {}),
    },
    last_heartbeat_at: new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(),
    lock_expires_at: null,
    locked_by: null,
  };

  if (Number.isFinite(Number(lockTtlMs)) && Number(lockTtlMs) > 0) {
    patch.lock_expires_at = new Date(now + Math.max(1000, Number(lockTtlMs))).toISOString();
  }

  await patchJob({ sessionId, cosmosEnabled, patch }).catch(() => null);
}

async function markStalledJob({ sessionId, cosmosEnabled, nowTs, note }) {
  const now = Number.isFinite(Number(nowTs)) ? Number(nowTs) : Date.now();

  await patchJob({
    sessionId,
    cosmosEnabled,
    patch: {
      job_state: "error",
      stage_beacon: "primary_search_started",
      last_error: {
        code: "stalled_worker",
        message: "Worker heartbeat stale",
        ...(note ? { note: String(note) } : {}),
      },
      last_heartbeat_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
      lock_expires_at: null,
      locked_by: null,
    },
  }).catch(() => null);
}

async function patchProgress({ sessionId, cosmosEnabled, patch }) {
  await patchJob({
    sessionId,
    cosmosEnabled,
    patch: {
      ...(patch && typeof patch === "object" ? patch : {}),
      updated_at: nowIso(),
      last_heartbeat_at: nowIso(),
    },
  }).catch(() => null);
}

async function heartbeat({ sessionId, cosmosEnabled, lockTtlMs, extraPatch }) {
  const ttlMs = Number.isFinite(Number(lockTtlMs)) ? Math.max(1000, Number(lockTtlMs)) : 240_000;
  const now = Date.now();

  await patchJob({
    sessionId,
    cosmosEnabled,
    patch: {
      last_heartbeat_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
      lock_expires_at: new Date(now + ttlMs).toISOString(),
      ...(extraPatch && typeof extraPatch === "object" ? extraPatch : {}),
    },
  }).catch(() => null);
}

async function runPrimaryJob({ context, sessionId, cosmosEnabled, invocationSource }) {
  const workerId =
    (context && typeof context === "object" && context.invocationId ? `inv_${context.invocationId}` : "") ||
    `inv_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const existing = await getJob({ sessionId, cosmosEnabled });
  if (!existing) {
    return {
      httpStatus: 404,
      body: { ok: false, error: "Unknown session_id", session_id: sessionId },
    };
  }

  const HARD_MAX_RUNTIME_MS = Math.max(
    10_000,
    toPositiveInt(process.env.IMPORT_PRIMARY_HARD_TIMEOUT_MS, 300_000)
  );
  const NO_CANDIDATES_AFTER_MS = Math.max(
    5_000,
    toPositiveInt(process.env.IMPORT_PRIMARY_NO_CANDIDATES_MS, 300_000)
  );
  const UPSTREAM_TIMEOUT_CAP_MS = Math.max(
    5_000,
    toPositiveInt(process.env.IMPORT_PRIMARY_UPSTREAM_TIMEOUT_CAP_MS, 300_000)
  );
  const UPSTREAM_TIMEOUT_CAP_SINGLE_MS = Math.max(
    5_000,
    toPositiveInt(process.env.IMPORT_PRIMARY_UPSTREAM_TIMEOUT_CAP_SINGLE_MS, 300_000)
  );

  const state = String(existing?.job_state || "queued");
  const now = Date.now();

  const HEARTBEAT_STALE_MS = Number.isFinite(Number(process.env.IMPORT_HEARTBEAT_STALE_MS))
    ? Math.max(5_000, Number(process.env.IMPORT_HEARTBEAT_STALE_MS))
    : 330_000;

  if (state === "queued") {
    const createdTs = getJobCreatedTimestamp(existing);
    if (createdTs && now - createdTs > HARD_MAX_RUNTIME_MS) {
      const queueAgeMs = now - createdTs;

      await markPrimaryError({
        sessionId,
        cosmosEnabled,
        code: "primary_timeout",
        message: "Primary search exceeded hard runtime limit",
        stageBeacon: "primary_timeout",
        details: {
          elapsed_ms: queueAgeMs,
          hard_timeout_ms: HARD_MAX_RUNTIME_MS,
          note: "Job remained queued beyond hard timeout",
        },
      });

      const after = await getJob({ sessionId, cosmosEnabled }).catch(() => null);
      return {
        httpStatus: 200,
        body: {
          ok: false,
          session_id: sessionId,
          status: "error",
          stage_beacon: "primary_timeout",
          error:
            after?.last_error ||
            ({ code: "primary_timeout", message: "Primary search exceeded hard runtime limit" }),
          note: "Job marked as error due to queued timeout",
          meta: buildMeta({ invocationSource, workerId, workerClaimed: false }),
        },
      };
    }
  }

  if (state === "running") {
    const hbTs = getHeartbeatTimestamp(existing);
    if (hbTs && now - hbTs > HEARTBEAT_STALE_MS) {
      await markStalledJob({
        sessionId,
        cosmosEnabled,
        nowTs: now,
        note: `heartbeat_stale_ms=${now - hbTs}`,
      });

      const after = await getJob({ sessionId, cosmosEnabled }).catch(() => null);
      return {
        httpStatus: 200,
        body: {
          ok: false,
          session_id: sessionId,
          status: "error",
          stage_beacon: "primary_search_started",
          error: after?.last_error || { code: "stalled_worker", message: "Worker heartbeat stale" },
          note: "Job marked as error due to stalled worker heartbeat",
          meta: buildMeta({ invocationSource, workerId, workerClaimed: false, stallDetected: true }),
        },
      };
    }

    const runtime = buildRuntimeInfo(existing, now, HARD_MAX_RUNTIME_MS);
    if (runtime.elapsed_ms > HARD_MAX_RUNTIME_MS) {
      await markPrimaryError({
        sessionId,
        cosmosEnabled,
        code: "primary_timeout",
        message: "Primary search exceeded hard runtime limit",
        stageBeacon: "primary_timeout",
        details: {
          elapsed_ms: runtime.elapsed_ms,
          hard_timeout_ms: HARD_MAX_RUNTIME_MS,
        },
      });

      const after = await getJob({ sessionId, cosmosEnabled }).catch(() => null);
      return {
        httpStatus: 200,
        body: {
          ok: false,
          session_id: sessionId,
          status: "error",
          stage_beacon: "primary_timeout",
          error:
            after?.last_error ||
            ({ code: "primary_timeout", message: "Primary search exceeded hard runtime limit" }),
          meta: buildMeta({ invocationSource, workerId, workerClaimed: false }),
        },
      };
    }

    if (runtime.elapsed_ms > NO_CANDIDATES_AFTER_MS && runtime.companies_candidates_found === 0) {
      await markPrimaryError({
        sessionId,
        cosmosEnabled,
        code: "no_candidates_found",
        message: "Primary search produced no candidates within progress threshold",
        stageBeacon: "primary_expanding_candidates",
        details: {
          elapsed_ms: runtime.elapsed_ms,
          no_candidates_threshold_ms: NO_CANDIDATES_AFTER_MS,
          upstream_calls_made: runtime.upstream_calls_made,
        },
      });

      const after = await getJob({ sessionId, cosmosEnabled }).catch(() => null);
      return {
        httpStatus: 200,
        body: {
          ok: false,
          session_id: sessionId,
          status: "error",
          stage_beacon: "primary_expanding_candidates",
          error:
            after?.last_error ||
            ({
              code: "no_candidates_found",
              message: "Primary search produced no candidates within progress threshold",
            }),
          meta: buildMeta({ invocationSource, workerId, workerClaimed: false }),
        },
      };
    }
  }

  const LOCK_TTL_MS = Number.isFinite(Number(process.env.IMPORT_LOCK_TTL_MS))
    ? Math.max(5_000, Number(process.env.IMPORT_LOCK_TTL_MS))
    : 360_000;

  const claim = await tryClaimJob({
    sessionId,
    cosmosEnabled,
    workerId,
    lockTtlMs: LOCK_TTL_MS,
  });

  if (!claim.ok) {
    return {
      httpStatus: 200,
      body: {
        ok: false,
        error: claim.error || "claim_failed",
        session_id: sessionId,
        status: "error",
        stage_beacon: "primary_search_started",
        meta: buildMeta({
          invocationSource,
          workerId,
          workerClaimed: false,
          claimError: claim.error || "claim_failed",
        }),
      },
    };
  }

  const job = claim.job || existing;

  if (!claim.claimed) {
    const finalJobState = String(job?.job_state || "queued");
    const status =
      finalJobState === "complete"
        ? "complete"
        : finalJobState === "error"
          ? "error"
          : finalJobState === "running"
            ? "running"
            : "queued";

    const runtime = buildRuntimeInfo(job, Date.now(), HARD_MAX_RUNTIME_MS);

    return {
      httpStatus: status === "complete" || status === "error" ? 200 : 202,
      body: {
        ok: status !== "error",
        session_id: sessionId,
        status,
        stage_beacon: String(job?.stage_beacon || "primary_search_started"),
        ...(status === "error" ? { error: job?.last_error || { code: "UNKNOWN", message: "Job failed" } } : {}),
        note: "Job already running or complete",
        meta: buildMeta({ invocationSource, workerId, workerClaimed: false }),
        progress: runtime,
      },
    };
  }

  const requestedLimit = Number(job?.request_payload?.limit) || 0;
  const isSingleCompany = requestedLimit === 1;

  const startedAtIso = job?.started_at || nowIso();
  const startedAtTs = Date.parse(startedAtIso) || Date.now();

  let upstreamCallsMade = toPositiveInt(job?.upstream_calls_made, 0);
  let companiesCandidatesFound = Number.isFinite(Number(job?.companies_candidates_found))
    ? Math.max(0, Number(job.companies_candidates_found))
    : Number.isFinite(Number(job?.companies_count))
      ? Math.max(0, Number(job.companies_count))
      : 0;
  let earlyExitTriggered = Boolean(job?.early_exit_triggered);

  const getRuntime = (nowTs) => {
    const elapsedMs = Math.max(0, nowTs - startedAtTs);
    return {
      start_ts: startedAtTs,
      elapsed_ms: elapsedMs,
      remaining_budget_ms: Math.max(0, HARD_MAX_RUNTIME_MS - elapsedMs),
      upstream_calls_made: upstreamCallsMade,
      companies_candidates_found: companiesCandidatesFound,
      early_exit_triggered: earlyExitTriggered,
    };
  };

  const xaiModel =
    typeof job?.xai_model === "string" && job.xai_model.trim() ? job.xai_model.trim() : "grok-4-latest";

  const xaiEndpointRaw = getXAIEndpoint();
  const xaiUrl = resolveXaiEndpointForModel(xaiEndpointRaw, xaiModel);

  const xaiKey = getXAIKey();
  const hasKey = Boolean(xaiKey);

  await patchJob({
    sessionId,
    cosmosEnabled,
    patch: {
      job_state: "running",
      stage: "primary",
      stage_beacon: "primary_search_started",
      xai_model: xaiModel,
      resolved_upstream_url_redacted: redactUrlQueryAndHash(xaiUrl),
      updated_at: nowIso(),
      started_at: startedAtIso,
      last_error: null,
      last_heartbeat_at: nowIso(),
      lock_expires_at: new Date(Date.now() + LOCK_TTL_MS).toISOString(),
      elapsed_ms: 0,
      remaining_budget_ms: HARD_MAX_RUNTIME_MS,
      upstream_calls_made: upstreamCallsMade,
      companies_candidates_found: companiesCandidatesFound,
      early_exit_triggered: earlyExitTriggered,
    },
  }).catch(() => null);

  const requestedStageMsPrimary = Math.max(1000, Number(job?.requested_stage_ms_primary) || 20_000);
  let outboundBody = typeof job?.xai_outbound_body === "string" ? job.xai_outbound_body : "";

  if (!outboundBody) {
    outboundBody = buildFallbackOutboundBodyFromJob(job);

    if (outboundBody) {
      await patchJob({
        sessionId,
        cosmosEnabled,
        patch: {
          xai_outbound_body: outboundBody,
          updated_at: nowIso(),
        },
      }).catch(() => null);
    }
  }

  if (!xaiUrl || !hasKey || !outboundBody) {
    const code = !xaiUrl
      ? "MISSING_XAI_ENDPOINT"
      : !hasKey
        ? "MISSING_XAI_KEY"
        : "MISSING_OUTBOUND_BODY";

    const msg =
      code === "MISSING_XAI_ENDPOINT"
        ? "Missing XAI endpoint"
        : code === "MISSING_XAI_KEY"
          ? "Missing XAI key"
          : "Missing xai_outbound_body";

    await markPrimaryError({
      sessionId,
      cosmosEnabled,
      code,
      message: msg,
      stageBeacon: "primary_search_started",
    });

    return {
      httpStatus: 200,
      body: {
        ok: false,
        error: msg,
        session_id: sessionId,
        status: "error",
        stage_beacon: "primary_search_started",
        meta: buildMeta({ invocationSource, workerId, workerClaimed: true }),
      },
    };
  }

  const maxAttempts = Math.max(1, toPositiveInt(process.env.IMPORT_PRIMARY_MAX_ATTEMPTS, 5));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const nowAttemptTs = Date.now();
    const runtime = getRuntime(nowAttemptTs);

    if (runtime.elapsed_ms > HARD_MAX_RUNTIME_MS) {
      await markPrimaryError({
        sessionId,
        cosmosEnabled,
        code: "primary_timeout",
        message: "Primary search exceeded hard runtime limit",
        stageBeacon: "primary_timeout",
        details: {
          elapsed_ms: runtime.elapsed_ms,
          hard_timeout_ms: HARD_MAX_RUNTIME_MS,
          upstream_calls_made: runtime.upstream_calls_made,
          companies_candidates_found: runtime.companies_candidates_found,
        },
      });

      return {
        httpStatus: 200,
        body: {
          ok: false,
          session_id: sessionId,
          status: "error",
          stage_beacon: "primary_timeout",
          error: { code: "primary_timeout", message: "Primary search exceeded hard runtime limit" },
          meta: buildMeta({ invocationSource, workerId, workerClaimed: true }),
        },
      };
    }

    if (runtime.elapsed_ms > NO_CANDIDATES_AFTER_MS && runtime.companies_candidates_found === 0) {
      await markPrimaryError({
        sessionId,
        cosmosEnabled,
        code: "no_candidates_found",
        message: "Primary search produced no candidates within progress threshold",
        stageBeacon: "primary_expanding_candidates",
        details: {
          elapsed_ms: runtime.elapsed_ms,
          no_candidates_threshold_ms: NO_CANDIDATES_AFTER_MS,
          upstream_calls_made: runtime.upstream_calls_made,
        },
      });

      return {
        httpStatus: 200,
        body: {
          ok: false,
          session_id: sessionId,
          status: "error",
          stage_beacon: "primary_expanding_candidates",
          error: { code: "no_candidates_found", message: "Primary search produced no candidates within progress threshold" },
          meta: buildMeta({ invocationSource, workerId, workerClaimed: true }),
        },
      };
    }

    const stageBeacon = attempt === 1 ? "primary_search_started" : "primary_expanding_candidates";

    const capForLimit = isSingleCompany ? UPSTREAM_TIMEOUT_CAP_SINGLE_MS : UPSTREAM_TIMEOUT_CAP_MS;
    const timeoutBudgetMs = Math.max(1_000, runtime.remaining_budget_ms);
    const perCallTimeoutMs = Math.max(
      1_000,
      Math.min(requestedStageMsPrimary, timeoutBudgetMs, capForLimit)
    );

    upstreamCallsMade += 1;
    const nextUpstreamCallsMade = upstreamCallsMade;

    await heartbeat({
      sessionId,
      cosmosEnabled,
      lockTtlMs: LOCK_TTL_MS,
      extraPatch: {
        attempt,
        stage_beacon: stageBeacon,
        elapsed_ms: runtime.elapsed_ms,
        remaining_budget_ms: runtime.remaining_budget_ms,
        upstream_calls_made: nextUpstreamCallsMade,
        companies_candidates_found: companiesCandidatesFound,
        early_exit_triggered: earlyExitTriggered,
      },
    });

    try {
      const xaiResponse = await postJsonWithTimeout(xaiUrl, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${xaiKey}`,
        },
        body: outboundBody,
        timeoutMs: perCallTimeoutMs,
      });

      await heartbeat({
        sessionId,
        cosmosEnabled,
        lockTtlMs: LOCK_TTL_MS,
        extraPatch: {
          stage_beacon: stageBeacon,
          elapsed_ms: getRuntime(Date.now()).elapsed_ms,
        },
      });

      if (!xaiResponse.ok) {
        const err = new Error(`Upstream error (${xaiResponse.status})`);
        err.upstream_status = xaiResponse.status;
        err.code = "UPSTREAM_ERROR";

        const headersObj = xaiResponse && typeof xaiResponse === "object" ? xaiResponse.headers : null;
        const xaiRequestId =
          headersObj && typeof headersObj === "object"
            ? headersObj["xai-request-id"] || headersObj["x-request-id"] || headersObj["request-id"] || null
            : null;
        if (typeof xaiRequestId === "string" && xaiRequestId.trim()) err.xai_request_id = xaiRequestId.trim();

        err.text_preview =
          typeof xaiResponse.text === "string" && xaiResponse.text ? xaiResponse.text.slice(0, 500) : "";

        throw err;
      }

      await patchProgress({
        sessionId,
        cosmosEnabled,
        patch: {
          stage_beacon: "primary_candidate_found",
        },
      });

      const parsed = parseCompaniesFromXaiResponse(xaiResponse);
      if (parsed.parse_error) {
        const err = new Error(`Parse error: ${parsed.parse_error}`);
        err.code = "PARSE_ERROR";
        throw err;
      }

      const parsedCompanies = parsed.companies.slice(0, 200);
      const candidatesFound = parsedCompanies.length;
      companiesCandidatesFound = candidatesFound;

      const runtimeAfterParse = getRuntime(Date.now());

      await patchProgress({
        sessionId,
        cosmosEnabled,
        patch: {
          companies_candidates_found: candidatesFound,
          elapsed_ms: runtimeAfterParse.elapsed_ms,
          remaining_budget_ms: runtimeAfterParse.remaining_budget_ms,
          upstream_calls_made: upstreamCallsMade,
          early_exit_triggered: earlyExitTriggered,
        },
      });

      if (isSingleCompany && candidatesFound > 0) {
        const first = parsedCompanies[0];

        earlyExitTriggered = true;

        await patchJob({
          sessionId,
          cosmosEnabled,
          patch: {
            job_state: "complete",
            stage_beacon: "primary_early_exit",
            completed_at: nowIso(),
            updated_at: nowIso(),
            last_heartbeat_at: nowIso(),
            companies_count: 1,
            companies: [first],
            companies_candidates_found: candidatesFound,
            early_exit_triggered: true,
            last_error: null,
            lock_expires_at: null,
            locked_by: null,
          },
        }).catch(() => null);

        return {
          httpStatus: 200,
          body: {
            ok: true,
            session_id: sessionId,
            status: "complete",
            stage_beacon: "primary_early_exit",
            companies_count: 1,
            meta: buildMeta({ invocationSource, workerId, workerClaimed: true }),
          },
        };
      }

      await patchJob({
        sessionId,
        cosmosEnabled,
        patch: {
          job_state: "complete",
          stage_beacon: "primary_complete",
          completed_at: nowIso(),
          updated_at: nowIso(),
          last_heartbeat_at: nowIso(),
          companies_count: parsedCompanies.length,
          companies: parsedCompanies,
          companies_candidates_found: candidatesFound,
          early_exit_triggered: earlyExitTriggered,
          last_error: null,
          lock_expires_at: null,
          locked_by: null,
        },
      }).catch(() => null);

      return {
        httpStatus: 200,
        body: {
          ok: true,
          session_id: sessionId,
          status: "complete",
          stage_beacon: "primary_complete",
          companies_count: parsedCompanies.length,
          meta: buildMeta({ invocationSource, workerId, workerClaimed: true }),
        },
      };
    } catch (e) {
      const redacted = redactErrorForJob(e);

      const isTransient =
        redacted.code === "UPSTREAM_TIMEOUT" || redacted.code === "UPSTREAM_ERROR"
          ? isTransientUpstream(e?.upstream_status)
          : true;

      const nowErrTs = Date.now();
      const runtimeAfterErr = getRuntime(nowErrTs);
      const shouldStopForBudget = runtimeAfterErr.remaining_budget_ms <= 0;

      const willRetry = attempt < maxAttempts && isTransient && !shouldStopForBudget;

      await patchJob({
        sessionId,
        cosmosEnabled,
        patch: {
          updated_at: nowIso(),
          last_heartbeat_at: nowIso(),
          last_error: redacted,
          job_state: willRetry ? "running" : "error",
          stage_beacon: willRetry ? "primary_expanding_candidates" : "primary_expanding_candidates",
          elapsed_ms: runtimeAfterErr.elapsed_ms,
          remaining_budget_ms: runtimeAfterErr.remaining_budget_ms,
          upstream_calls_made: upstreamCallsMade,
          companies_candidates_found: companiesCandidatesFound,
          early_exit_triggered: earlyExitTriggered,
          ...(willRetry ? {} : { lock_expires_at: null, locked_by: null }),
        },
      }).catch(() => null);

      if (!willRetry) {
        return {
          httpStatus: 200,
          body: {
            ok: false,
            session_id: sessionId,
            status: "error",
            stage_beacon: "primary_expanding_candidates",
            error: redacted,
            meta: buildMeta({ invocationSource, workerId, workerClaimed: true }),
          },
        };
      }

      const baseBackoffMs = Math.min(30_000, 1000 * 2 ** (attempt - 1));
      const jitterMs = Math.floor(Math.random() * 500);
      const backoffMs = baseBackoffMs + jitterMs;
      await sleep(Math.min(backoffMs, Math.max(0, HARD_MAX_RUNTIME_MS - getRuntime(Date.now()).elapsed_ms)));
    }
  }

  return {
    httpStatus: 200,
    body: {
      ok: false,
      session_id: sessionId,
      status: "error",
      stage_beacon: "primary_expanding_candidates",
      error: { code: "UNKNOWN", message: "Worker reached unexpected end" },
      meta: buildMeta({ invocationSource, workerId, workerClaimed: true }),
    },
  };
}

module.exports = {
  runPrimaryJob,
  _test: {
    getHeartbeatTimestamp,
    buildRuntimeInfo,
  },
};
