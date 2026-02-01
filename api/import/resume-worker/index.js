const { app } = require("../../_app");
const { resumeWorkerHandler } = require("./handler");

// HTTP endpoint for manual triggers or testing
app.http("import-resume-worker", {
  route: "import/resume-worker",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: resumeWorkerHandler,
});

// Storage Queue trigger for automatic processing of enqueued resume jobs
// ONLY register in the dedicated worker function app, NOT in SWA-managed API.
// The test "queue trigger moved to dedicated worker" expects this to NOT be registered in SWA.
const IS_DEDICATED_WORKER = String(process.env.WEBSITE_SITE_NAME || "").toLowerCase().includes("dedicated");

const triggerConnectionSetting =
  String(process.env.ENRICHMENT_QUEUE_CONNECTION_SETTING || "").trim() || "AzureWebJobsStorage";

// Conditionally register queue trigger - only in dedicated worker
if (IS_DEDICATED_WORKER) {
  app.storageQueue("import-resume-worker-queue-trigger", {
    queueName: "import-resume-worker",
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

      const sessionId = String(queueBody?.session_id || "").trim();
      const messageReason = String(queueBody?.reason || "").trim();
      const cycleCount = queueBody?.cycle_count ?? null;

      // Log at handler entry
      console.log("[import-resume-worker-queue] handler_entered", {
        handler_entered_at: handlerEnteredAt,
        invocation_id: invocationId,
        session_id: sessionId || null,
        trigger_connection_setting: triggerConnectionSetting,
      });

      // Log after dequeue/parse
      console.log("[import-resume-worker-queue] dequeued_message", {
        session_id: sessionId || null,
        invocation_id: invocationId,
        reason: messageReason || null,
        cycle_count: cycleCount,
        parse_error: parseError,
        message_keys: queueBody && typeof queueBody === "object" ? Object.keys(queueBody) : [],
      });

      if (parseError) {
        console.log("[import-resume-worker-queue] handler_finished", {
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
      console.log("[import-resume-worker-queue] handler_finished", {
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
} // End of IS_DEDICATED_WORKER conditional

// Export for test visibility
module.exports = {
  handler: resumeWorkerHandler,
  resumeWorkerHandler,
};
