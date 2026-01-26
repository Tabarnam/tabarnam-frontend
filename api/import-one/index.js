let app;
try {
  ({ app } = require("@azure/functions"));
} catch {
  app = { http() {} };
}

const { randomUUID } = require("crypto");
const { upsertSession: upsertImportSession } = require("../_importSessionStore");
const { buildPrimaryJobId: buildImportPrimaryJobId, getJob: getImportPrimaryJob, upsertJob: upsertImportPrimaryJob } = require("../_importPrimaryJobStore");
const { runPrimaryJob } = require("../_importPrimaryWorker");
const { getSession: getImportSession } = require("../_importSessionStore");
const { enqueueResumeRun } = require("../_enrichmentQueue");

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
      return json({ ok: false, error: { message: "Invalid request body", code: "invalid_body" } }, 400);
    }

    const url = String(body.url || "").trim();
    if (!url || !looksLikeUrl(url)) {
      return json({
        ok: false,
        error: { message: "Missing or invalid 'url' in request body", code: "invalid_url" },
      }, 400);
    }

    const normalizedUrl = normalizeUrl(url);
    if (!normalizedUrl) {
      return json({
        ok: false,
        error: { message: "Could not normalize URL", code: "normalize_error" },
      }, 400);
    }

    // Log start
    try {
      console.log("[import-one] started", { session_id: sessionId, url: normalizedUrl });
    } catch {}

    // Create session
    upsertImportSession({
      session_id: sessionId,
      status: "running",
      request_url: normalizedUrl,
      created_at: new Date().toISOString(),
    }).catch(() => null);

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

    await upsertImportPrimaryJob({ jobDoc, cosmosEnabled }).catch(() => null);

    // Run work loop until completion or deadline
    let lastSession = null;
    let completed = false;
    let loopCount = 0;
    const maxLoops = 20; // Safety limit on loop iterations

    while (!completed && loopCount < maxLoops) {
      loopCount++;
      const elapsed = Date.now() - startTime;
      if (elapsed > DEADLINE_MS) {
        // Deadline reached
        try {
          console.log("[import-one] deadline_reached", { session_id: sessionId, elapsed_ms: elapsed, loops: loopCount });
        } catch {}
        break;
      }

      // Run primary job
      try {
        const workerResult = await runPrimaryJob({
          context,
          sessionId,
          cosmosEnabled,
          invocationSource: "import-one",
        });

        // Get updated session to check completion status
        try {
          lastSession = await getImportSession({ session_id: sessionId, cosmosEnabled });
        } catch {}

        // Check completion indicators
        const savedVerifiedCount = Number(lastSession?.saved_verified_count || 0);
        const sessionStatus = String(lastSession?.status || "").toLowerCase();

        if (savedVerifiedCount > 0 || sessionStatus === "complete" || sessionStatus === "stopped") {
          completed = true;
          try {
            console.log("[import-one] completed", { session_id: sessionId, saved_count: savedVerifiedCount, status: sessionStatus });
          } catch {}
          break;
        }
      } catch (err) {
        try {
          console.log("[import-one] worker_error", { session_id: sessionId, error: String(err?.message || err) });
        } catch {}
        break;
      }

      // Small delay between loops to avoid tight spinning
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // Fetch final session state and company data
    try {
      lastSession = await getImportSession({ session_id: sessionId, cosmosEnabled });
    } catch {}

    const finalStatus = String(lastSession?.status || "").toLowerCase();
    const savedCount = Number(lastSession?.saved_verified_count || 0);

    if (savedCount > 0) {
      // Import completed - return success with company data
      return json({
        ok: true,
        completed: true,
        session_id: sessionId,
        saved_count: savedCount,
        status: finalStatus,
      }, 200);
    } else {
      // Work still in progress or deadline reached
      return json({
        ok: true,
        completed: false,
        session_id: sessionId,
        status: finalStatus,
        note: "Import started but not completed; use /api/import-status to poll",
      }, 200);
    }
  } catch (err) {
    const errorMessage = typeof err?.message === "string" ? err.message : String(err);
    try {
      console.log("[import-one] handler_error", { session_id: sessionId, error: errorMessage });
    } catch {}

    return json({
      ok: false,
      error: { message: errorMessage, code: "handler_error" },
    }, 500);
  }
}

app.http("import-one", {
  route: "import-one",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    if (String(req.method || "").toUpperCase() === "OPTIONS") {
      return json({}, 200);
    }
    return handleImportOne(req, context);
  },
});

module.exports = {
  handleImportOne,
};
