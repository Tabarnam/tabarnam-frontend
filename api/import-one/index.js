// C:\dev\tabarnam-frontend\api\import-one\index.js
let app;
try {
  ({ app } = require("@azure/functions"));
} catch {
  app = { http() {} };
}

const { randomUUID } = require("crypto");
const { upsertSession: upsertImportSession } = require("../_importSessionStore");
const {
  buildPrimaryJobId: buildImportPrimaryJobId,
  upsertJob: upsertImportPrimaryJob,
} = require("../_importPrimaryJobStore");
const { runPrimaryJob } = require("../_importPrimaryWorker");
const { getSession: getImportSession } = require("../_importSessionStore");
const { enqueueResumeRun } = require("../_enrichmentQueue");

// Build stamp for deployment verification
const BUILD_STAMP = process.env.GIT_SHA || "import_one_build_pr671";

const DEADLINE_MS = 25000; // 25 second max for request

function json(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers":
        "content-type,authorization,x-functions-key,x-request-id,x-correlation-id,x-session-id,x-client-request-id",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(obj),
  };
}

function normalizeUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;

  try {
    const u = s.includes("://") ? new URL(s) : new URL(`https://${s}`);
    u.search = "";
    u.hash = "";
    u.pathname = u.pathname && u.pathname !== "/" ? u.pathname : "/";
    return u.toString();
  } catch {
    return null;
  }
}

function looksLikeUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return false;
  if (/\s/.test(s)) return false;

  try {
    const u = s.includes("://") ? new URL(s) : new URL(`https://${s}`);
    const host = String(u.hostname || "").toLowerCase();
    if (!host || !host.includes(".")) return false;
    const parts = host.split(".").filter(Boolean);
    if (parts.length < 2) return false;
    const tld = parts[parts.length - 1];
    if (!tld || tld.length < 2) return false;
    return true;
  } catch {
    return false;
  }
}

async function readJsonBody(req) {
  if (!req) return null;
  try {
    if (typeof req.text === "function") {
      const text = await req.text();
      return text ? JSON.parse(text) : null;
    }
    if (typeof req.json === "function") {
      return await req.json();
    }
    if (req.body) {
      if (typeof req.body === "string") return JSON.parse(req.body);
      if (typeof req.body === "object") return req.body;
    }
  } catch {}
  return null;
}

async function handleImportOne(req, context) {
  const startTime = Date.now();
  const sessionId = randomUUID();
  const cosmosEnabled = !process.env.TABARNAM_DISABLE_COSMOS;

  try {
    // Read and validate request body
    const body = await readJsonBody(req);
    if (!body || typeof body !== "object") {
      return json(
        { ok: false, build_id: BUILD_STAMP, error: { message: "Invalid request body", code: "invalid_body" } },
        400
      );
    }

    const url = String(body.url || "").trim();
    if (!url || !looksLikeUrl(url)) {
      return json(
        {
          ok: false,
          build_id: BUILD_STAMP,
          error: { message: "Missing or invalid 'url' in request body", code: "invalid_url" },
        },
        400
      );
    }

    const normalizedUrl = normalizeUrl(url);
    if (!normalizedUrl) {
      return json(
        {
          ok: false,
          build_id: BUILD_STAMP,
          error: { message: "Could not normalize URL", code: "normalize_error" },
        },
        400
      );
    }

    // Log start
    try {
      console.log("[import-one] build", BUILD_STAMP);
      console.log("[import-one] started", { session_id: sessionId, url: normalizedUrl });
      console.log("[import-one] about_to_upsert_session", { session_id: sessionId });
    } catch {}

    // Create session (upsertImportSession is synchronous; do not chain .catch)
    try {
      upsertImportSession({
        session_id: sessionId,
        status: "running",
        request_url: normalizedUrl,
        created_at: new Date().toISOString(),
      });
      try {
        console.log("[import-one] session_upsert_ok", { session_id: sessionId });
      } catch {}
    } catch (err) {
      try {
        console.log("[import-one] session_upsert_threw", {
          session_id: sessionId,
          error: String(err?.message || err),
          stack: String(err?.stack || ""),
        });
      } catch {}
      // Non-fatal: continue
    }

    // Create primary job with single URL seed
    const jobDoc = {
      id: buildImportPrimaryJobId(sessionId),
      session_id: sessionId,
      job_state: "queued",
      stage: "primary",
      stage_beacon: "single_import_started",
      request_payload: {
        query: normalizedUrl,
        queryTypes: ["direct_url"],
        limit: 1,
        expand_if_few: false,
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // Upsert primary job (non-fatal if it fails)
    try {
      await upsertImportPrimaryJob({ jobDoc, cosmosEnabled });
    } catch (err) {
      try {
        console.log("[import-one] primary_job_upsert_failed", {
          session_id: sessionId,
          error: String(err?.message || err),
          stack: String(err?.stack || ""),
        });
      } catch {}
      // Continue; worker may still run depending on backing store behavior
    }

    // Run work loop until completion or deadline
    let lastSession = null;
    let completed = false;
    let loopCount = 0;
    const maxLoops = 20; // Safety limit on loop iterations

    while (!completed && loopCount < maxLoops) {
      loopCount++;
      const elapsed = Date.now() - startTime;
      if (elapsed > DEADLINE_MS) {
        try {
          console.log("[import-one] deadline_reached", {
            session_id: sessionId,
            elapsed_ms: elapsed,
            loops: loopCount,
          });
        } catch {}
        break;
      }

      try {
        await runPrimaryJob({
          context,
          sessionId,
          cosmosEnabled,
          invocationSource: "import-one",
        });

        // Get updated session to check completion status
        try {
          lastSession = await getImportSession({ session_id: sessionId, cosmosEnabled });
        } catch {}

        const savedVerifiedCount = Number(lastSession?.saved_verified_count || 0);
        const sessionStatus = String(lastSession?.status || "").toLowerCase();

        if (savedVerifiedCount > 0 || sessionStatus === "complete" || sessionStatus === "stopped") {
          completed = true;
          try {
            console.log("[import-one] completed", {
              session_id: sessionId,
              saved_count: savedVerifiedCount,
              status: sessionStatus,
            });
          } catch {}
          break;
        }
      } catch (err) {
        try {
          console.log("[import-one] worker_error", {
            session_id: sessionId,
            error: String(err?.message || err),
            stack: String(err?.stack || ""),
          });
        } catch {}
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // Fetch final session state
    try {
      lastSession = await getImportSession({ session_id: sessionId, cosmosEnabled });
    } catch {}

    const finalStatus = String(lastSession?.status || "").toLowerCase();
    const savedCount = Number(lastSession?.saved_verified_count || 0);

    if (savedCount > 0) {
      return json(
        {
          ok: true,
          build_id: BUILD_STAMP,
          completed: true,
          session_id: sessionId,
          saved_count: savedCount,
          status: finalStatus,
        },
        200
      );
    }

    // Not completed: enqueue resume message for background processing
    try {
      const enqueueResult = await enqueueResumeRun({
        session_id: sessionId,
        reason: "import-one-deadline",
        requested_by: "import-one-endpoint",
        enqueue_at: new Date().toISOString(),
        run_after_ms: 0,
      });

      if (enqueueResult?.ok) {
        try {
          console.log("[import-one] enqueued_resume", {
            session_id: sessionId,
            message_id: enqueueResult.message_id,
            queue_name: enqueueResult.queue?.name,
          });
        } catch {}
      } else {
        try {
          console.log("[import-one] enqueue_failed", {
            session_id: sessionId,
            error: enqueueResult?.error,
          });
        } catch {}
      }
    } catch (err) {
      try {
        console.log("[import-one] enqueue_exception", {
          session_id: sessionId,
          error: String(err?.message || err),
          stack: String(err?.stack || ""),
        });
      } catch {}
    }

    return json(
      {
        ok: true,
        build_id: BUILD_STAMP,
        completed: false,
        session_id: sessionId,
        status: finalStatus,
        note: "Import started but not completed; use /api/import/status to poll",
      },
      200
    );
  } catch (err) {
    const errorMessage = typeof err?.message === "string" ? err.message : String(err);
    try {
      console.log("[import-one] handler_error", { session_id: sessionId, error: errorMessage, build: BUILD_STAMP });
    } catch {}

    return json(
      {
        ok: false,
        build_id: BUILD_STAMP,
        error: { message: errorMessage, code: "handler_error" },
      },
      500
    );
  }
}

app.http("import-one", {
  route: "import-one",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    if (String(req.method || "").toUpperCase() === "OPTIONS") {
      return json({ ok: true, build_id: BUILD_STAMP }, 200);
    }
    return handleImportOne(req, context);
  },
});

module.exports = {
  handleImportOne,
};
