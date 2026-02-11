/**
 * XAI request pipeline for import-start.
 *
 * Extracted from import-start/index.js. Each function receives a `reqCtx`
 * object containing handler-scoped dependencies:
 *   { budget, requestId, sessionId, xaiUrl, xaiKey, throwAccepted }
 *
 * Additionally uses imported utilities for endpoint detection and payload conversion.
 */

const {
  isResponsesEndpoint,
  convertToResponsesPayload,
  isAzureWebsitesUrl,
  postJsonWithTimeout,
  AcceptedResponseError,
} = require("./_importStartRequestUtils");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_UPSTREAM_TIMEOUT_MS = 60_000;

const STAGE_MAX_MS = {
  primary: 60_000,
  keywords: 60_000,
  reviews: 90_000,
  location: 60_000,
  expand: 8_000,
};

const MIN_STAGE_REMAINING_MS = 4_000;
const DEADLINE_SAFETY_BUFFER_MS = 1_500;
const UPSTREAM_TIMEOUT_MARGIN_MS = 1_200;
const STAGE_RETRY_BACKOFF_MS = [0, 2000, 5000, 10000];

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function shouldRetryUpstreamStatus(status) {
  const s = Number(status);
  if (!Number.isFinite(s)) return true;
  if (s === 408 || s === 421 || s === 429) return true;
  return s >= 500 && s <= 599;
}

// ---------------------------------------------------------------------------
// Budget guards
// ---------------------------------------------------------------------------

function ensureStageBudgetOrThrow(stageKey, nextStageBeacon, reqCtx) {
  const { budget, throwAccepted } = reqCtx;
  const remainingMs = budget.getRemainingMs();

  if (remainingMs < MIN_STAGE_REMAINING_MS) {
    if (stageKey === "primary") {
      throwAccepted(nextStageBeacon, "remaining_budget_low", { stage: stageKey, remainingMs });
    }
  }

  return remainingMs;
}

// ---------------------------------------------------------------------------
// Core XAI fetch with budget
// ---------------------------------------------------------------------------

async function postXaiJsonWithBudget({ stageKey, stageBeacon, body, stageCapMsOverride }, reqCtx) {
  const { budget, requestId, sessionId, xaiUrl, xaiKey, throwAccepted } = reqCtx;
  const remainingMs = ensureStageBudgetOrThrow(stageKey, stageBeacon, reqCtx);
  const stageCapMsBase = Number(STAGE_MAX_MS?.[stageKey]) || DEFAULT_UPSTREAM_TIMEOUT_MS;
  const stageCapMsOverrideNumber =
    Number.isFinite(Number(stageCapMsOverride)) && Number(stageCapMsOverride) > 0 ? Number(stageCapMsOverride) : null;
  const stageCapMs = stageCapMsOverrideNumber ? Math.min(stageCapMsOverrideNumber, stageCapMsBase) : stageCapMsBase;

  const timeoutForThisStage = budget.clampStageTimeoutMs({
    remainingMs,
    minMs: 2500,
    maxMs: stageCapMs,
    safetyMarginMs: DEADLINE_SAFETY_BUFFER_MS + UPSTREAM_TIMEOUT_MARGIN_MS,
  });

  const minRequired = DEADLINE_SAFETY_BUFFER_MS + UPSTREAM_TIMEOUT_MARGIN_MS + 2500;
  if (remainingMs < minRequired) {
    if (stageKey === "primary") {
      throwAccepted(stageBeacon, "insufficient_time_for_fetch", {
        stage: stageKey,
        remainingMs,
        timeoutForThisStage,
        stageCapMs,
      });
    }

    const err = new Error("Insufficient time for upstream fetch");
    err.code = "INSUFFICIENT_TIME_FOR_FETCH";
    err.stage = stageKey;
    err.stage_beacon = stageBeacon;
    err.remainingMs = remainingMs;
    err.timeoutForThisStage = timeoutForThisStage;
    err.stageCapMs = stageCapMs;
    throw err;
  }

  const fetchStart = Date.now();

  try {
    console.log("[import-start] fetch_begin", {
      stage: stageKey,
      remainingMs,
      timeoutForThisStage,
      request_id: requestId,
      session_id: sessionId,
    });
  } catch {}

  try {
    let finalBody = typeof body === "string" ? body : "";
    if (isResponsesEndpoint(xaiUrl) && finalBody) {
      try {
        const parsed = JSON.parse(finalBody);
        const converted = convertToResponsesPayload(parsed);
        finalBody = JSON.stringify(converted);
      } catch (parseErr) {
        console.error("[import-start] payload conversion failed:", parseErr?.message);
      }
    }

    const res = await postJsonWithTimeout(xaiUrl, {
      headers: (() => {
        const headers = {
          "Content-Type": "application/json",
        };

        if (isAzureWebsitesUrl(xaiUrl)) {
          headers["x-functions-key"] = xaiKey;
        } else {
          headers["Authorization"] = `Bearer ${xaiKey}`;
        }

        return headers;
      })(),
      body: finalBody,
      timeoutMs: timeoutForThisStage,
    });

    const elapsedMs = Date.now() - fetchStart;
    try {
      console.log("[import-start] fetch_end", {
        stage: stageKey,
        elapsedMs,
        request_id: requestId,
        session_id: sessionId,
        status: res?.status,
      });
    } catch {}

    return res;
  } catch (e) {
    const name = String(e?.name || "").toLowerCase();
    const code = String(e?.code || "").toUpperCase();
    const isAbort = code === "ECONNABORTED" || name.includes("abort");

    if (isAbort) {
      if (stageKey === "primary") {
        throwAccepted(stageBeacon, "upstream_timeout_returning_202", {
          stage: stageKey,
          timeoutForThisStage,
          stageCapMs,
        });
      }

      const err = new Error("Upstream timeout");
      err.code = "UPSTREAM_TIMEOUT";
      err.stage = stageKey;
      err.stage_beacon = stageBeacon;
      err.timeoutForThisStage = timeoutForThisStage;
      err.stageCapMs = stageCapMs;
      throw err;
    }

    throw e;
  }
}

// ---------------------------------------------------------------------------
// Retry wrapper
// ---------------------------------------------------------------------------

async function postXaiJsonWithBudgetRetry({ stageKey, stageBeacon, body, stageCapMsOverride }, reqCtx) {
  const { budget } = reqCtx;
  const attempts = STAGE_RETRY_BACKOFF_MS.length;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const delayMs = STAGE_RETRY_BACKOFF_MS[attempt] || 0;
    if (delayMs > 0) {
      const remaining = budget.getRemainingMs();
      if (remaining < delayMs + DEADLINE_SAFETY_BUFFER_MS) {
        break;
      }
      await sleep(delayMs);
    }

    try {
      const res = await postXaiJsonWithBudget({ stageKey, stageBeacon, body, stageCapMsOverride }, reqCtx);

      if (res && typeof res.status === "number" && shouldRetryUpstreamStatus(res.status) && attempt < attempts - 1) {
        continue;
      }

      return res;
    } catch (e) {
      if (e instanceof AcceptedResponseError) throw e;

      const code = String(e?.code || "").toUpperCase();
      const retryable = code === "UPSTREAM_TIMEOUT" || code === "INSUFFICIENT_TIME_FOR_FETCH";

      if (retryable && attempt < attempts - 1) {
        continue;
      }

      throw e;
    }
  }

  return await postXaiJsonWithBudget({ stageKey, stageBeacon, body, stageCapMsOverride }, reqCtx);
}

module.exports = {
  // Constants
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  STAGE_MAX_MS,
  MIN_STAGE_REMAINING_MS,
  DEADLINE_SAFETY_BUFFER_MS,
  UPSTREAM_TIMEOUT_MARGIN_MS,
  STAGE_RETRY_BACKOFF_MS,

  // Utilities
  sleep,
  shouldRetryUpstreamStatus,

  // Budget guards
  ensureStageBudgetOrThrow,

  // Core request functions
  postXaiJsonWithBudget,
  postXaiJsonWithBudgetRetry,
};
