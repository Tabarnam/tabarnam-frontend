try {
  ({ app } = require("@azure/functions"));
} catch {
  app = { http() {} };
}

const { getXAIEndpoint, getXAIKey } = require("../_shared");
const {
  getJob,
  tryClaimJob,
  patchJob,
} = require("../_importPrimaryJobStore");

function cors(req) {
  const origin = req?.headers?.get?.("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers":
      "content-type,authorization,x-functions-key,x-request-id,x-correlation-id,x-session-id,x-client-request-id",
  };
}

function json(obj, status = 200, req) {
  return {
    status,
    headers: { ...cors(req), "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

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

function redactErrorForJob(err) {
  if (!err) return { message: "Unknown error" };
  const out = {
    name: typeof err?.name === "string" ? err.name : "Error",
    message: typeof err?.message === "string" ? err.message : String(err),
  };
  if (typeof err?.code === "string") out.code = err.code;
  if (typeof err?.status === "number") out.status = err.status;
  if (typeof err?.upstream_status === "number") out.upstream_status = err.upstream_status;
  return out;
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
  if (s === 408 || s === 429) return true;
  return s >= 500 && s <= 599;
}

async function runPrimaryJob({ req, context, sessionId, cosmosEnabled }) {
  const workerId =
    (context && typeof context === "object" && context.invocationId ? `inv_${context.invocationId}` : "") ||
    `inv_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const existing = await getJob({ sessionId, cosmosEnabled });
  if (!existing) {
    return json(
      {
        ok: false,
        error: "Unknown session_id",
        session_id: sessionId,
      },
      404,
      req
    );
  }

  const claim = await tryClaimJob({
    sessionId,
    cosmosEnabled,
    workerId,
    lockTtlMs: 120_000,
  });

  if (!claim.ok) {
    return json({ ok: false, error: claim.error || "claim_failed", session_id: sessionId }, 500, req);
  }

  const job = claim.job || existing;
  if (!claim.claimed) {
    return json(
      {
        ok: true,
        session_id: sessionId,
        status: String(job?.job_state || "queued"),
        stage_beacon: String(job?.stage_beacon || "xai_primary_fetch_queued"),
        note: "Job already running or complete",
      },
      200,
      req
    );
  }

  const xaiUrl = getXAIEndpoint();
  const xaiKey = getXAIKey();
  const hasKey = Boolean(xaiKey);
  const keyLen = hasKey ? String(xaiKey).length : 0;

  try {
    console.log("[import-primary-worker] env_check", {
      session_id: sessionId,
      has_xai_key: hasKey,
      xai_key_length: keyLen,
    });
  } catch {}

  await patchJob({
    sessionId,
    cosmosEnabled,
    patch: {
      job_state: "running",
      stage: "primary",
      stage_beacon: "xai_primary_fetch_running",
      updated_at: nowIso(),
      started_at: job?.started_at || nowIso(),
      last_error: null,
    },
  });

  const requested = Number(job?.requested_stage_ms_primary);
  const requestedStageMsPrimary = Number.isFinite(requested) && requested > 0 ? requested : 20_000;

  const effectiveTimeoutMs = Math.max(1_000, Math.min(requestedStageMsPrimary, 180_000));
  const outboundBody = typeof job?.xai_outbound_body === "string" ? job.xai_outbound_body : "";

  if (!xaiUrl) {
    await patchJob({
      sessionId,
      cosmosEnabled,
      patch: {
        job_state: "error",
        stage_beacon: "xai_primary_fetch_error",
        last_error: { code: "MISSING_XAI_ENDPOINT", message: "Missing XAI endpoint" },
        updated_at: nowIso(),
      },
    });
    return json({ ok: false, error: "Missing XAI endpoint", session_id: sessionId }, 500, req);
  }

  if (!hasKey) {
    await patchJob({
      sessionId,
      cosmosEnabled,
      patch: {
        job_state: "error",
        stage_beacon: "xai_primary_fetch_error",
        last_error: { code: "MISSING_XAI_KEY", message: "Missing XAI key" },
        updated_at: nowIso(),
      },
    });
    return json({ ok: false, error: "Missing XAI key", session_id: sessionId }, 500, req);
  }

  if (!outboundBody) {
    await patchJob({
      sessionId,
      cosmosEnabled,
      patch: {
        job_state: "error",
        stage_beacon: "xai_primary_fetch_error",
        last_error: { code: "MISSING_OUTBOUND_BODY", message: "Missing xai_outbound_body" },
        updated_at: nowIso(),
      },
    });

    return json({ ok: false, error: "Missing xai_outbound_body", session_id: sessionId }, 500, req);
  }

  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await patchJob({
      sessionId,
      cosmosEnabled,
      patch: {
        attempt,
        stage_beacon: "xai_primary_fetch_running",
        updated_at: nowIso(),
      },
    });

    let xaiResponse;
    try {
      xaiResponse = await postJsonWithTimeout(xaiUrl, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${xaiKey}`,
        },
        body: outboundBody,
        timeoutMs: effectiveTimeoutMs,
      });

      if (!xaiResponse.ok) {
        const err = new Error(`Upstream error (${xaiResponse.status})`);
        err.upstream_status = xaiResponse.status;
        err.code = "UPSTREAM_ERROR";
        err.text_preview =
          typeof xaiResponse.text === "string" && xaiResponse.text
            ? xaiResponse.text.slice(0, 500)
            : "";
        throw err;
      }

      const parsed = parseCompaniesFromXaiResponse(xaiResponse);

      if (parsed.parse_error) {
        const err = new Error(`Parse error: ${parsed.parse_error}`);
        err.code = "PARSE_ERROR";
        throw err;
      }

      const companies = parsed.companies.slice(0, 200);

      await patchJob({
        sessionId,
        cosmosEnabled,
        patch: {
          job_state: "complete",
          stage_beacon: "xai_primary_fetch_complete",
          completed_at: nowIso(),
          updated_at: nowIso(),
          companies_count: companies.length,
          companies,
          last_error: null,
        },
      });

      try {
        console.log("[import-primary-worker] job_complete", {
          session_id: sessionId,
          companies_count: companies.length,
          requested_stage_ms_primary: requestedStageMsPrimary,
          effective_timeout_ms: effectiveTimeoutMs,
        });
      } catch {}

      return json(
        {
          ok: true,
          session_id: sessionId,
          status: "complete",
          stage_beacon: "xai_primary_fetch_complete",
          companies_count: companies.length,
        },
        200,
        req
      );
    } catch (e) {
      const redacted = redactErrorForJob(e);

      try {
        console.warn("[import-primary-worker] upstream_error", {
          session_id: sessionId,
          attempt,
          code: redacted.code || redacted.name,
          message: redacted.message,
        });
      } catch {}

      const isTransient =
        redacted.code === "UPSTREAM_TIMEOUT" ||
        redacted.code === "UPSTREAM_ERROR"
          ? isTransientUpstream(e?.upstream_status)
          : true;

      const willRetry = attempt < maxAttempts && isTransient;

      await patchJob({
        sessionId,
        cosmosEnabled,
        patch: {
          updated_at: nowIso(),
          last_error: redacted,
          job_state: willRetry ? "running" : "error",
          stage_beacon: willRetry ? "xai_primary_fetch_running" : "xai_primary_fetch_error",
        },
      });

      if (!willRetry) {
        return json(
          {
            ok: false,
            session_id: sessionId,
            status: "error",
            stage_beacon: "xai_primary_fetch_error",
            error: redacted,
          },
          500,
          req
        );
      }

      const backoffMs = attempt === 1 ? 1000 : attempt === 2 ? 2000 : 4000;
      await sleep(backoffMs);
      continue;
    }
  }

  return json(
    {
      ok: false,
      session_id: sessionId,
      status: "error",
      stage_beacon: "xai_primary_fetch_error",
      error: { code: "UNKNOWN", message: "Worker reached unexpected end" },
    },
    500,
    req
  );
}

async function handler(req, context) {
  const method = String(req?.method || "").toUpperCase();
  if (method === "OPTIONS") return { status: 200, headers: cors(req) };

  const url = new URL(req.url);
  const noCosmosMode = String(url.searchParams.get("no_cosmos") || "").trim() === "1";
  const cosmosEnabled = !noCosmosMode;

  let body = {};
  if (method === "POST") {
    try {
      const txt = await req.text();
      if (txt) body = JSON.parse(txt);
    } catch {}
  }

  const sessionId =
    String(body?.session_id || body?.sessionId || url.searchParams.get("session_id") || "").trim() || "";

  if (!sessionId) {
    return json({ ok: false, error: "Missing session_id" }, 400, req);
  }

  try {
    console.log("[import-primary-worker] received", {
      session_id: sessionId,
      no_cosmos: noCosmosMode,
    });
  } catch {}

  return await runPrimaryJob({ req, context, sessionId, cosmosEnabled });
}

app.http("import-primary-worker", {
  route: "import/primary-worker",
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  handler,
});

app.http("import-primary-worker-alt", {
  route: "import-primary-worker",
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  handler,
});

module.exports = { _test: { handler } };
