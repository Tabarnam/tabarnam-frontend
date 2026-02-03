/**
 * Bulk Import Enqueue Endpoint
 *
 * POST /api/bulk-import/enqueue
 * Body: { urls: ["https://company1.com", "https://company2.com", ...] }
 * Returns: { batch_id, jobs: [{ job_id, url, position }], summary }
 */

const { v4: uuidv4 } = require("uuid");
const { enqueueBulkImportJob } = require("../_bulkImportQueue");
const { createBatchJobs, getJobsByBatch } = require("../_bulkImportJobStore");

function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function nowIso() {
  return new Date().toISOString();
}

function isValidUrl(str) {
  if (!str || typeof str !== "string") return false;
  try {
    const url = new URL(str.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeUrl(str) {
  if (!str || typeof str !== "string") return null;
  let urlStr = str.trim();

  // Add https:// if no protocol
  if (!urlStr.match(/^https?:\/\//i)) {
    urlStr = `https://${urlStr}`;
  }

  try {
    const url = new URL(urlStr);
    // Normalize to lowercase hostname
    return `${url.protocol}//${url.hostname.toLowerCase()}${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

const MAX_URLS_PER_BATCH = 50;

async function handler(context, req) {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    };
  }

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  try {
    const body = req.body || {};
    const urlsRaw = body.urls;

    if (!Array.isArray(urlsRaw)) {
      return {
        status: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          ok: false,
          error: "invalid_request",
          message: "Request body must contain 'urls' array",
        }),
      };
    }

    if (urlsRaw.length === 0) {
      return {
        status: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          ok: false,
          error: "empty_urls",
          message: "URLs array cannot be empty",
        }),
      };
    }

    if (urlsRaw.length > MAX_URLS_PER_BATCH) {
      return {
        status: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          ok: false,
          error: "too_many_urls",
          message: `Maximum ${MAX_URLS_PER_BATCH} URLs per batch`,
          max_allowed: MAX_URLS_PER_BATCH,
          received: urlsRaw.length,
        }),
      };
    }

    // Normalize and validate URLs
    const validUrls = [];
    const invalidUrls = [];

    for (let i = 0; i < urlsRaw.length; i++) {
      const raw = asString(urlsRaw[i]).trim();
      if (!raw) continue;

      const normalized = normalizeUrl(raw);
      if (normalized && isValidUrl(normalized)) {
        // Dedupe
        if (!validUrls.find((v) => v.normalized === normalized)) {
          validUrls.push({ raw, normalized, position: validUrls.length });
        }
      } else {
        invalidUrls.push({ raw, position: i, error: "invalid_url" });
      }
    }

    if (validUrls.length === 0) {
      return {
        status: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          ok: false,
          error: "no_valid_urls",
          message: "No valid URLs provided",
          invalid_urls: invalidUrls,
        }),
      };
    }

    // Generate batch ID
    const batchId = uuidv4();
    const requestedBy = asString(body.requested_by).trim() || "admin_ui";
    const enqueuedAt = nowIso();

    // Create job records
    const jobs = validUrls.map((v, idx) => ({
      job_id: uuidv4(),
      url: v.normalized,
      position: idx,
    }));

    // Store jobs in Cosmos
    const createResult = await createBatchJobs({
      batchId,
      jobs,
      cosmosEnabled: true,
    });

    if (!createResult.ok) {
      return {
        status: 500,
        headers: corsHeaders,
        body: JSON.stringify({
          ok: false,
          error: "job_creation_failed",
          message: "Failed to create job records",
          details: createResult,
        }),
      };
    }

    // Enqueue jobs to Azure Storage Queue
    const queueResults = [];
    for (const job of jobs) {
      const queueResult = await enqueueBulkImportJob({
        job_id: job.job_id,
        url: job.url,
        position: job.position,
        batch_id: batchId,
        requested_by: requestedBy,
        enqueued_at: enqueuedAt,
        run_after_ms: 0, // Immediate visibility
      });
      queueResults.push({
        job_id: job.job_id,
        queued: queueResult.ok,
        error: queueResult.ok ? null : queueResult.error,
      });
    }

    const queuedCount = queueResults.filter((r) => r.queued).length;
    const failedQueueCount = queueResults.filter((r) => !r.queued).length;

    // Retrieve jobs to return current state
    const storedJobs = await getJobsByBatch({ batchId, cosmosEnabled: true });

    return {
      status: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        ok: true,
        batch_id: batchId,
        jobs: storedJobs.map((j) => ({
          job_id: j.job_id,
          url: j.url,
          position: j.position,
          status: j.status,
        })),
        summary: {
          total: jobs.length,
          queued: queuedCount,
          queue_failed: failedQueueCount,
          invalid_urls: invalidUrls.length,
        },
        invalid_urls: invalidUrls.length > 0 ? invalidUrls : undefined,
        enqueued_at: enqueuedAt,
      }),
    };
  } catch (err) {
    console.error("[bulk-import-enqueue] Error:", err);
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
