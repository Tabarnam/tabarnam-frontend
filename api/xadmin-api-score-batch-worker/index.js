const { app } = require("../_app");

// HTTP worker that drives backfill scoring inline until done OR time budget
// exhausted. Mirrors the api/import/primary-worker pattern used by admin/import:
// the frontend fires a keepalive POST here after POSTing /xadmin-api-score-all-missing,
// and polls /xadmin-api-score-status for progress. No queue trigger involved.
//
// Route: POST /api/xadmin-api-score-batch-worker
// Body:  { job_id, cycle_count? }
// Anonymous (same auth posture as /api/import/primary-worker).

const TIME_CAP_MS = 9 * 60 * 1000; // Stop ~1 min before the 10-min Functions timeout.

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };
}

const json = (obj, status = 200) => ({
  status,
  headers: getCorsHeaders(),
  body: JSON.stringify(obj),
});

async function adminScoreBatchWorkerHandler(req, context) {
  const method = String(req?.method || "").toUpperCase();
  if (method === "OPTIONS") return { status: 200, headers: getCorsHeaders() };

  let body = {};
  try { body = (await req.json()) || {}; } catch { body = {}; }

  const jobId = String(body?.job_id || body?.session_id || "").trim();
  const startingCycleCount = Number(body?.cycle_count) || 0;
  if (!jobId) return json({ ok: false, error: "Missing job_id" }, 400);

  // Lazy require to avoid circular load at startup — score-all-missing registers
  // its own HTTP route; we only need the exported batch processor here.
  let processBackfillScoreBatch;
  try {
    ({ processBackfillScoreBatch } = require("../xadmin-api-score-all-missing/index.js"));
  } catch (e) {
    context.log(`[score-batch-worker] Failed to load batch processor: ${e?.message || e}`);
    return json({ ok: false, error: "batch_processor_unavailable", detail: e?.message || String(e) }, 500);
  }

  const startedAt = Date.now();
  let cyclesRun = 0;
  let totalScored = 0;
  let totalFailed = 0;
  let lastResult = null;
  let stopReason = "unknown";

  context.log(`[score-batch-worker] start job=${jobId} cycle_count=${startingCycleCount}`);

  while (true) {
    if (Date.now() - startedAt > TIME_CAP_MS) {
      stopReason = "time_cap_reached";
      break;
    }

    const queueBody = {
      session_id: jobId,
      reason: "backfill_score",
      cycle_count: startingCycleCount + cyclesRun,
      requested_by: "score_batch_worker",
    };

    let result;
    try {
      result = await processBackfillScoreBatch(queueBody, context);
    } catch (e) {
      context.log(`[score-batch-worker] processBackfillScoreBatch threw: ${e?.message || e}`);
      stopReason = `error: ${e?.message || e}`;
      break;
    }

    lastResult = result;
    cyclesRun++;

    if (!result?.ok) {
      stopReason = `batch_failed: ${result?.error || "unknown"}`;
      break;
    }
    if (result.skipped) {
      // Job was cancelled/paused/completed — processBackfillScoreBatch short-circuits.
      stopReason = `skipped: ${result.reason || "unknown"}`;
      break;
    }

    totalScored += result.scored || 0;
    totalFailed += result.failed || 0;

    if ((result.remaining || 0) === 0) {
      stopReason = "all_done";
      break;
    }
  }

  const elapsedMs = Date.now() - startedAt;
  context.log(
    `[score-batch-worker] exit job=${jobId} cycles=${cyclesRun} scored=${totalScored} ` +
    `failed=${totalFailed} stop=${stopReason} elapsed=${(elapsedMs / 1000).toFixed(1)}s`
  );

  return json({
    ok: true,
    job_id: jobId,
    cycles_run: cyclesRun,
    total_scored: totalScored,
    total_failed: totalFailed,
    stop_reason: stopReason,
    elapsed_ms: elapsedMs,
    last_result: lastResult,
  });
}

app.http("adminScoreBatchWorker", {
  route: "xadmin-api-score-batch-worker",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: adminScoreBatchWorkerHandler,
});

module.exports = { handler: adminScoreBatchWorkerHandler };
