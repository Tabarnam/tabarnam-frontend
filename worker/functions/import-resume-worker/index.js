// Rebuild tick: 2026-01-31T04:00:00Z - added diagnostics logging per issue #26
const { app } = require("@azure/functions");
const { resumeWorkerHandler } = require("./handler");
const { resolveQueueConfig } = require("../../../api/_enrichmentQueue");

/**
 * Dedicated worker for import resume queue processing.
 * This function runs in tabarnam-xai-dedicated Function App only.
 */

// Log queue configuration once at cold start
let didLogQueueConfig = false;
function logQueueConfigOnce() {
  if (didLogQueueConfig) return;
  didLogQueueConfig = true;

  try {
    const cfg = resolveQueueConfig();
    console.log("[import-resume-worker] queue_config", {
      queue_name: cfg?.queueName || "import-resume-worker",
      connection_source: cfg?.connection_source || "unknown",
      binding_connection_setting: cfg?.binding_connection_setting_name || "AzureWebJobsStorage",
      connection_string_length: cfg?.connectionString?.length || 0,
      connection_string_present: Boolean(cfg?.connectionString),
    });
  } catch (e) {
    console.log("[import-resume-worker] queue_config_error", {
      error: String(e?.message || e),
    });
  }
}

/**
 * Storage Queue trigger for import resume worker.
 * Runs in the dedicated tabarnam-xai-dedicated Function App.
 *
 * Converts queue message to HTTP-like request and delegates to the same handler
 * that powers the HTTP endpoint in the SWA-managed API.
 *
 * NOTE: Connection setting name MUST match what enqueue() resolves in api/_enrichmentQueue.js.
 * enqueue uses: ENRICHMENT_QUEUE_CONNECTION_STRING > AzureWebJobsStorage > AZURE_STORAGE_CONNECTION_STRING
 * So trigger uses ENRICHMENT_QUEUE_CONNECTION_SETTING (default: AzureWebJobsStorage)
 */
const triggerConnectionSetting =
  String(process.env.ENRICHMENT_QUEUE_CONNECTION_SETTING || "").trim() || "AzureWebJobsStorage";

app.storageQueue("import-resume-worker-queue-trigger", {
  queueName: "import-resume-worker",
  connection: triggerConnectionSetting,
  handler: async (message, context) => {
    const handlerEnteredAt = new Date().toISOString();
    const invocationId = context?.invocationId || "unknown";

    // Log queue config once at cold start
    logQueueConfigOnce();

    // Parse the queue message
    let queueBody = {};
    let parseError = null;
    try {
      queueBody = typeof message === "string" ? JSON.parse(message) : message;
    } catch (e) {
      parseError = String(e?.message || e);
    }

    const sessionId = String(queueBody?.session_id || "").trim();
    const messageReason = String(queueBody?.reason || "").trim();
    const cycleCount = queueBody?.cycle_count ?? null;

    // Log at handler entry (first line of handler)
    console.log("[import-resume-worker] handler_entered", {
      handler_entered_at: handlerEnteredAt,
      invocation_id: invocationId,
      session_id: sessionId || null,
      trigger_connection_setting: triggerConnectionSetting,
    });

    // Log after dequeue/parse
    console.log("[import-resume-worker] dequeued_message", {
      session_id: sessionId || null,
      invocation_id: invocationId,
      reason: messageReason || null,
      cycle_count: cycleCount,
      parse_error: parseError,
      message_keys: queueBody && typeof queueBody === "object" ? Object.keys(queueBody) : [],
    });

    if (parseError) {
      console.log("[import-resume-worker] handler_finished", {
        handler_finished_at: new Date().toISOString(),
        invocation_id: invocationId,
        session_id: null,
        elapsed_ms: Date.now() - Date.parse(handlerEnteredAt),
        wrote_to_cosmos: false,
        result: "parse_error",
        error: parseError,
      });
      return {
        status: 400,
        body: JSON.stringify({ ok: false, error: "Failed to parse queue message", parse_error: parseError }),
      };
    }

    // Mock HTTP request object that the handler expects
    const fakeReq = {
      method: "POST",
      url: new URL("https://localhost/api/import/resume-worker"),
      headers: {
        get: (name) => {
          if (name.toLowerCase() === "x-request-id") {
            return String(queueBody?.run_id || context?.invocationId || "");
          }
          return null;
        },
      },
      json: async () => queueBody,
      text: async () => JSON.stringify(queueBody),
      __in_process: true, // Trust queue trigger as internal
    };

    // Call the handler
    let result = null;
    let handlerError = null;
    let wroteToComos = false;
    try {
      result = await resumeWorkerHandler(fakeReq, context);
      // Try to determine if handler wrote to cosmos from result
      if (result && typeof result === "object") {
        const body = typeof result.body === "string" ? JSON.parse(result.body) : result.body;
        wroteToComos = Boolean(body?.did_work) || Boolean(body?.resume_control_doc_upsert_ok);
      }
    } catch (e) {
      handlerError = String(e?.message || e);
    }

    const handlerFinishedAt = new Date().toISOString();
    const elapsedMs = Date.now() - Date.parse(handlerEnteredAt);

    // Log at handler exit
    console.log("[import-resume-worker] handler_finished", {
      handler_finished_at: handlerFinishedAt,
      invocation_id: invocationId,
      session_id: sessionId || null,
      elapsed_ms: elapsedMs,
      wrote_to_cosmos: wroteToComos,
      result: handlerError ? "error" : (result?.status === 200 ? "ok" : "non_200"),
      http_status: result?.status ?? null,
      error: handlerError,
    });

    if (handlerError) {
      return {
        status: 500,
        body: JSON.stringify({ ok: false, error: handlerError }),
      };
    }

    return result;
  },
});

module.exports = {
  resumeWorkerHandler,
};
