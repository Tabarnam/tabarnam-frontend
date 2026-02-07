/**
 * Bulk Import Status Endpoint
 *
 * GET /api/bulk-import/status?batch_id={id}
 * Returns: { batch_id, jobs: [...], summary: { queued, running, completed, failed } }
 */

const { getJobsByBatch, getJob } = require("../_bulkImportJobStore");

function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

async function handler(context, req) {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    };
  }

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  try {
    const batchId = asString(req.query?.batch_id || req.params?.batch_id).trim();
    const jobId = asString(req.query?.job_id || req.params?.job_id).trim();

    // If job_id is provided, return single job status
    if (jobId) {
      const job = await getJob({ jobId, cosmosEnabled: true });

      if (!job) {
        return {
          status: 404,
          headers: corsHeaders,
          body: JSON.stringify({
            ok: false,
            error: "not_found",
            message: `Job ${jobId} not found`,
          }),
        };
      }

      return {
        status: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          ok: true,
          job: {
            job_id: job.job_id,
            batch_id: job.batch_id,
            url: job.url,
            position: job.position,
            status: job.status,
            session_id: job.session_id,
            error: job.error,
            result_summary: job.result_summary,
            queued_at: job.queued_at,
            started_at: job.started_at,
            completed_at: job.completed_at,
          },
        }),
      };
    }

    // Otherwise, require batch_id
    if (!batchId) {
      return {
        status: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          ok: false,
          error: "missing_batch_id",
          message: "Either batch_id or job_id query parameter is required",
        }),
      };
    }

    const jobs = await getJobsByBatch({ batchId, cosmosEnabled: true });

    if (jobs.length === 0) {
      return {
        status: 404,
        headers: corsHeaders,
        body: JSON.stringify({
          ok: false,
          error: "not_found",
          message: `No jobs found for batch ${batchId}`,
        }),
      };
    }

    // Calculate summary
    const summary = {
      total: jobs.length,
      queued: jobs.filter((j) => j.status === "queued").length,
      running: jobs.filter((j) => j.status === "running").length,
      completed: jobs.filter((j) => j.status === "completed").length,
      failed: jobs.filter((j) => j.status === "failed").length,
    };

    // Compute overall batch status
    let batchStatus = "queued";
    if (summary.running > 0) {
      batchStatus = "running";
    } else if (summary.queued === 0 && summary.running === 0) {
      batchStatus = summary.failed > 0 && summary.completed === 0 ? "failed" : "completed";
    }

    return {
      status: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        ok: true,
        batch_id: batchId,
        batch_status: batchStatus,
        jobs: jobs.map((j) => ({
          job_id: j.job_id,
          url: j.url,
          position: j.position,
          status: j.status,
          session_id: j.session_id,
          error: j.error,
          result_summary: j.result_summary,
          queued_at: j.queued_at,
          started_at: j.started_at,
          completed_at: j.completed_at,
        })),
        summary,
      }),
    };
  } catch (err) {
    console.error("[bulk-import-status] Error:", err);
    return {
      status: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        ok: false,
        error: "internal_error",
        message: err?.message || "Unknown error",
      }),
    };
  }
}

module.exports = async function (context, req) {
  const result = await handler(context, req);
  context.res = result;
};
