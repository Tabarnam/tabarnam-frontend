const { resumeWorkerHandler } = require("./api/import/resume-worker/handler");

function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function safeParseJson(text) {
  const s = asString(text).trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function buildFakeRequest({ session_id, body }) {
  const sid = asString(session_id).trim();
  const url = new URL("https://internal/import/resume-worker");
  url.searchParams.set("session_id", sid);

  const headers = new Map();
  headers.set("x-tabarnam-internal", "1");

  return {
    method: "POST",
    url: url.toString(),
    __in_process: true,
    headers: {
      get: (k) => {
        const key = asString(k).toLowerCase();
        return headers.get(key) || headers.get(asString(k)) || null;
      },
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

async function importResumeWorkerQueueHandler(queueItem, context) {
  // Log function entry for observability in Azure Log Stream
  try {
    context?.log?.info?.("import-resume-worker-queue invoked");
  } catch {}

  const raw = typeof queueItem === "string" ? queueItem : Buffer.isBuffer(queueItem) ? queueItem.toString("utf8") : null;

  const msg = safeParseJson(raw) || (queueItem && typeof queueItem === "object" ? queueItem : null);

  const session_id = asString(msg?.session_id).trim();
  if (!session_id) {
    try {
      context?.log?.warn?.("[import-resume-worker-queue] missing session_id in queue message");
    } catch {}
    return;
  }

  const body = {
    session_id,
    reason: asString(msg?.reason).trim() || "queue",
    requested_by: asString(msg?.requested_by).trim() || "queue",
    enqueue_at: asString(msg?.enqueue_at).trim() || null,
    ...(Number.isFinite(Number(msg?.cycle_count)) ? { cycle_count: Math.max(0, Math.trunc(Number(msg.cycle_count))) } : {}),
    ...(Array.isArray(msg?.company_ids) ? { company_ids: msg.company_ids } : {}),
    ...(asString(msg?.run_id).trim() ? { run_id: asString(msg.run_id).trim() } : {}),
  };

  const req = buildFakeRequest({ session_id, body });

  const res = await resumeWorkerHandler(req, context);
  try {
    context?.log?.info?.("[import-resume-worker-queue] processed", {
      session_id,
      status: res?.status,
    });
  } catch {}

  return res;
}

module.exports = {
  importResumeWorkerQueueHandler,
};
