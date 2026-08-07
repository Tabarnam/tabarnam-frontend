// api/second-look-worker/index.js
//
// Queue trigger for the second-look lane (see _secondLookWorker.js /
// _secondLookEnrichment.js). Separate queue from import-resume-worker so
// the two lanes drain independently: with host.json batchSize=1 per
// trigger, at most one canonical call AND one second-look call are in
// flight at once — company N's second look overlaps company N+1's
// canonical call.
//
// Registered ONLY in the dedicated worker function app (same gate as the
// resume-worker queue trigger); the SWA-managed API never registers queue
// triggers.

const { app } = require("../_app");
const { processSecondLook } = require("../_secondLookWorker");
const { resolveSecondLookQueueName } = require("../_enrichmentQueue");

const EXPLICIT_WORKER_FLAG = String(process.env.TABARNAM_QUEUE_WORKER || "").trim();
const IS_DEDICATED_WORKER =
  EXPLICIT_WORKER_FLAG === "1" ||
  EXPLICIT_WORKER_FLAG.toLowerCase() === "true" ||
  String(process.env.WEBSITE_SITE_NAME || "").toLowerCase().includes("dedicated");

const triggerConnectionSetting =
  String(process.env.ENRICHMENT_QUEUE_CONNECTION_SETTING || "").trim() || "AzureWebJobsStorage";

if (IS_DEDICATED_WORKER) {
  app.storageQueue("second-look-worker-queue-trigger", {
    queueName: resolveSecondLookQueueName(),
    connection: triggerConnectionSetting,
    handler: async (message, context) => {
      const handlerEnteredAt = Date.now();
      const invocationId = context?.invocationId || "unknown";

      let queueBody = {};
      let parseError = null;
      try {
        queueBody = typeof message === "string" ? JSON.parse(message) : message;
      } catch (e) {
        parseError = String(e?.message || e);
      }

      console.log("[second-look-worker-queue] dequeued_message", {
        invocation_id: invocationId,
        company_id: queueBody?.company_id || null,
        session_id: queueBody?.session_id || null,
        fields: queueBody?.fields || null,
        parse_error: parseError,
      });

      if (parseError) {
        // Malformed message — drop (returning normally deletes it; retrying
        // a message that can't parse would just poison-loop).
        return { status: 400, body: JSON.stringify({ ok: false, error: "parse_error", parse_error: parseError }) };
      }

      let result = null;
      let handlerError = null;
      try {
        result = await processSecondLook(queueBody, context);
      } catch (e) {
        handlerError = String(e?.message || e);
      }

      console.log("[second-look-worker-queue] handler_finished", {
        invocation_id: invocationId,
        company_id: queueBody?.company_id || null,
        elapsed_ms: Date.now() - handlerEnteredAt,
        result: handlerError ? "error" : result?.ok ? "ok" : "failed",
        requeued: result?.requeued || null,
        skipped: result?.skipped || null,
        fields_recovered: result?.fields_recovered || null,
        error: handlerError || result?.error || null,
      });

      if (handlerError) {
        return { status: 500, body: JSON.stringify({ ok: false, error: handlerError }) };
      }
      return { status: result?.ok ? 200 : 500, body: JSON.stringify(result || { ok: false }) };
    },
  });
}

module.exports = {
  processSecondLook,
};
