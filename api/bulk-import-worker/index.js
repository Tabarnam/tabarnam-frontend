/**
 * Bulk Import Worker
 *
 * Processes queued bulk import jobs by calling import-start for each URL.
 *
 * This worker can be triggered by:
 * 1. HTTP POST /api/bulk-import/worker (for testing/manual invocation)
 * 2. Azure Storage Queue (bulk-import-jobs) - queue trigger registered below
 */

const { app } = require("../_app");
const { getJob, updateJobStatus } = require("../_bulkImportJobStore");
const { handler: importStartHandler } = require("../import-start/index");

function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Process a queue message (called by queue trigger or HTTP endpoint)
 */
async function processQueueMessage(message, context) {
  const jobId = asString(message?.job_id).trim();
  const url = asString(message?.url).trim();
  const batchId = asString(message?.batch_id).trim();
  const invocationId = context?.invocationId || "unknown";

  if (!jobId) {
    console.warn("[bulk-import-worker] Missing job_id in queue message");
    return { ok: false, error: "missing_job_id" };
  }

  if (!url) {
    console.warn(`[bulk-import-worker] Missing url for job ${jobId}`);
    await updateJobStatus({
      jobId,
      status: "failed",
      error: "missing_url",
    });
    return { ok: false, error: "missing_url", job_id: jobId };
  }

  console.log(`[bulk-import-worker] Processing job ${jobId}: ${url} (invocation: ${invocationId})`);

  // Update job status to running
  await updateJobStatus({
    jobId,
    status: "running",
  });

  try {
    // Build a mock request object for import-start
    const mockReq = {
      method: "POST",
      url: new URL("https://localhost/api/import/start"),
      headers: {
        get: (name) => {
          if (name.toLowerCase() === "content-type") return "application/json";
          if (name.toLowerCase() === "x-request-id") return `bulk_import_${jobId}`;
          return null;
        },
        "content-type": "application/json",
      },
      body: {
        query: url,
        queryType: "company_url",
        queryTypes: ["company_url"],
        source: "bulk_import",
        bulk_import_job_id: jobId,
        bulk_import_batch_id: batchId,
      },
      json: async () => ({
        query: url,
        queryType: "company_url",
        queryTypes: ["company_url"],
        source: "bulk_import",
        bulk_import_job_id: jobId,
        bulk_import_batch_id: batchId,
      }),
      query: {},
      __in_process: true, // Trust as internal call
    };

    // Build a mock context object
    const mockContext = {
      log: console.log,
      warn: console.warn,
      error: console.error,
      invocationId: `bulk_import_${jobId}`,
    };

    // Call import-start handler directly
    const result = await importStartHandler(mockReq, mockContext);

    // Parse the response
    let responseBody = result?.body;
    if (typeof responseBody === "string") {
      try {
        responseBody = JSON.parse(responseBody);
      } catch {
        // Keep as string
      }
    }

    const httpStatus = result?.status || 500;
    const isSuccess = httpStatus >= 200 && httpStatus < 300;
    const sessionId = responseBody?.session_id || responseBody?.sessionId || null;

    // Extract result summary
    const resultSummary = {
      saved_count: responseBody?.saved || responseBody?.saved_verified_count || 0,
      company_ids: responseBody?.saved_company_ids_verified || responseBody?.saved_company_ids || [],
      http_status: httpStatus,
      session_id: sessionId,
    };

    if (isSuccess || httpStatus === 202) {
      // 202 means accepted/async - still consider it a success
      console.log(`[bulk-import-worker] Job ${jobId} completed successfully. Session: ${sessionId}`);

      await updateJobStatus({
        jobId,
        status: "completed",
        session_id: sessionId,
        result_summary: resultSummary,
      });

      return {
        ok: true,
        job_id: jobId,
        session_id: sessionId,
        result_summary: resultSummary,
      };
    } else {
      // Import failed
      const errorMessage = responseBody?.error || responseBody?.message || `HTTP ${httpStatus}`;
      console.error(`[bulk-import-worker] Job ${jobId} failed: ${errorMessage}`);

      await updateJobStatus({
        jobId,
        status: "failed",
        session_id: sessionId,
        error: errorMessage,
        result_summary: resultSummary,
      });

      return {
        ok: false,
        job_id: jobId,
        error: errorMessage,
        session_id: sessionId,
        result_summary: resultSummary,
      };
    }
  } catch (err) {
    const errorMessage = err?.message || String(err || "unknown_error");
    console.error(`[bulk-import-worker] Job ${jobId} threw error: ${errorMessage}`);

    await updateJobStatus({
      jobId,
      status: "failed",
      error: errorMessage,
    });

    return {
      ok: false,
      job_id: jobId,
      error: errorMessage,
    };
  }
}

/**
 * HTTP endpoint handler for manual testing
 */
async function bulkImportWorkerHandler(req, context) {
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
    // Parse body
    let body = req.body;
    if (!body && typeof req.json === "function") {
      try {
        body = await req.json();
      } catch {
        body = {};
      }
    }
    body = body || {};

    // Option 1: Process a specific job_id
    if (body.job_id) {
      const job = await getJob({ jobId: body.job_id, cosmosEnabled: true });
      if (!job) {
        return {
          status: 404,
          headers: corsHeaders,
          body: JSON.stringify({
            ok: false,
            error: "not_found",
            message: `Job ${body.job_id} not found`,
          }),
        };
      }

      const result = await processQueueMessage({
        job_id: job.job_id,
        url: job.url,
        batch_id: job.batch_id,
      }, context);

      return {
        status: result.ok ? 200 : 500,
        headers: corsHeaders,
        body: JSON.stringify(result),
      };
    }

    // Option 2: Process a raw message (for testing)
    if (body.url) {
      const result = await processQueueMessage({
        job_id: body.job_id || `test_${Date.now()}`,
        url: body.url,
        batch_id: body.batch_id || "test_batch",
      }, context);

      return {
        status: result.ok ? 200 : 500,
        headers: corsHeaders,
        body: JSON.stringify(result),
      };
    }

    return {
      status: 400,
      headers: corsHeaders,
      body: JSON.stringify({
        ok: false,
        error: "invalid_request",
        message: "Provide either job_id or url in request body",
      }),
    };
  } catch (err) {
    console.error("[bulk-import-worker] HTTP handler error:", err);
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

// Register HTTP endpoint
app.http("bulk-import-worker", {
  route: "bulk-import/worker",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: bulkImportWorkerHandler,
});

// Storage Queue trigger for automatic processing
// Only register in dedicated worker environment (same pattern as resume-worker)
const IS_DEDICATED_WORKER = String(process.env.WEBSITE_SITE_NAME || "").toLowerCase().includes("dedicated");

const triggerConnectionSetting =
  String(process.env.BULK_IMPORT_QUEUE_CONNECTION_SETTING || "").trim() || "AzureWebJobsStorage";

if (IS_DEDICATED_WORKER) {
  app.storageQueue("bulk-import-worker-queue-trigger", {
    queueName: "bulk-import-jobs",
    connection: triggerConnectionSetting,
    handler: async (message, context) => {
      const handlerEnteredAt = new Date().toISOString();
      const invocationId = context?.invocationId || "unknown";

      // Parse the queue message
      let queueBody = {};
      let parseError = null;
      try {
        queueBody = typeof message === "string" ? JSON.parse(message) : message;
      } catch (e) {
        parseError = String(e?.message || e);
      }

      const jobId = String(queueBody?.job_id || "").trim();

      // Log at handler entry
      console.log("[bulk-import-worker-queue] handler_entered", {
        handler_entered_at: handlerEnteredAt,
        invocation_id: invocationId,
        job_id: jobId || null,
        trigger_connection_setting: triggerConnectionSetting,
      });

      // Log after dequeue/parse
      console.log("[bulk-import-worker-queue] dequeued_message", {
        job_id: jobId || null,
        invocation_id: invocationId,
        batch_id: queueBody?.batch_id || null,
        url: queueBody?.url || null,
        parse_error: parseError,
      });

      if (parseError) {
        console.log("[bulk-import-worker-queue] handler_finished", {
          handler_finished_at: new Date().toISOString(),
          invocation_id: invocationId,
          job_id: null,
          elapsed_ms: Date.now() - Date.parse(handlerEnteredAt),
          result: "parse_error",
          error: parseError,
        });
        return {
          status: 400,
          body: JSON.stringify({ ok: false, error: "Failed to parse queue message", parse_error: parseError }),
        };
      }

      // Process the job
      let result = null;
      let handlerError = null;
      try {
        result = await processQueueMessage(queueBody, context);
      } catch (e) {
        handlerError = String(e?.message || e);
      }

      const handlerFinishedAt = new Date().toISOString();
      const elapsedMs = Date.now() - Date.parse(handlerEnteredAt);

      // Log at handler exit
      console.log("[bulk-import-worker-queue] handler_finished", {
        handler_finished_at: handlerFinishedAt,
        invocation_id: invocationId,
        job_id: jobId || null,
        elapsed_ms: elapsedMs,
        result: handlerError ? "error" : (result?.ok ? "ok" : "failed"),
        error: handlerError,
      });

      if (handlerError) {
        return {
          status: 500,
          body: JSON.stringify({ ok: false, error: handlerError }),
        };
      }

      return {
        status: result?.ok ? 200 : 500,
        body: JSON.stringify(result),
      };
    },
  });
}

// Export for legacy Azure Functions runtime
module.exports = async function (context, req) {
  const result = await bulkImportWorkerHandler(req, context);
  context.res = result;
};

// Also export named exports for testing
module.exports.handler = bulkImportWorkerHandler;
module.exports.bulkImportWorkerHandler = bulkImportWorkerHandler;
module.exports.processQueueMessage = processQueueMessage;
