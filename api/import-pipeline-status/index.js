/**
 * Pipeline-status signal for the admin Import page.
 * Route: GET /api/import-pipeline-status   (withContributorGuard)
 * Global operational aggregate — is anything importing right now. Not
 * scopable to a row, and it exposes no company data, so contributors see the
 * same traffic light everyone else does.
 *
 * Answers one operator question: "is it safe to start a new import series,
 * or is earlier work still enriching?" Three signals, cheapest first:
 *   - resume-queue depth (import-resume-worker carries canonical resumes AND
 *     second looks via reason routing)
 *   - companies with second_look_pending = true
 *   - import session control docs touched recently (single "import" partition)
 *
 * Verdict: "importing" (session touched in the last ~3 min) →
 *          "enriching" (queue depth > 0 or second looks pending) →
 *          "idle".
 * Starting a new import never cancels QUEUED work — but the poll-driven
 * canonical-retry tail of a previous session stops when its page stops
 * polling, which is why the banner asks operators to wait for idle.
 */

const { app } = require("../_app");
const { withContributorGuard } = require("../_adminAuth");
const { getCosmosClient } = require("../_cosmosConfig");
const { resolveQueueConfig } = require("../_enrichmentQueue");

let QueueClient;
try {
  ({ QueueClient } = require("@azure/storage-queue"));
} catch {
  QueueClient = null;
}

const DB_ID = process.env.COSMOS_DB_DATABASE || "tabarnam-db";

// A "second_look_pending" flag is only treated as ACTIVE work (i.e. shown in
// the enriching banner) when its enqueue timestamp is within this window.
// Any real second-look finishes in seconds to a couple of minutes; the
// worker's longest self-requeue (circuit breaker) is 120s. 5 min is a
// comfortable margin over that. A flag older than this either succeeded and
// forgot to clear itself, or the worker crashed between the enrichment write
// and the bookkeeping upsert — in either case no worker is running now, so
// the banner shouldn't wait on it. Docs older than this stay flagged until
// the 30-min watchdog sweeps them (see api/second-look-watchdog-timer); the
// banner is decoupled from that horizon.
const SECOND_LOOK_ACTIVE_WINDOW_SEC = 5 * 60;

const cors = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, x-functions-key, x-internal-job-secret, x-ms-client-principal, x-session-id",
  "Content-Type": "application/json",
});
const json = (obj, status = 200) => ({ status, headers: cors(), body: JSON.stringify(obj) });

function parseQueueMessage(text) {
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  let body = tryParse(text);
  if (!body) {
    try {
      body = tryParse(Buffer.from(text, "base64").toString("utf8"));
    } catch {
      body = null;
    }
  }
  return body && typeof body === "object" ? body : null;
}

async function getQueueSnapshot() {
  try {
    if (!QueueClient) return { depth: null, items: [] };
    const cfg = resolveQueueConfig();
    if (!cfg.connectionString) return { depth: null, items: [] };
    const client = new QueueClient(cfg.connectionString, cfg.queueName);
    const props = await client.getProperties();

    // approximateMessagesCount includes SCHEDULED (not-yet-visible) messages.
    // Every import enqueues two delayed safety-net resume messages per
    // company (180s + 480s), so a finished 10-company batch leaves ~20
    // invisible messages sitting in the queue — which held the light amber
    // for ~6 minutes after the last company was actually written
    // (2026-08-09). Depth is kept for diagnostics only; the light must key
    // off work that is actually runnable NOW.
    const depth = Number(props.approximateMessagesCount ?? 0);

    let items = [];
    if (depth > 0) {
      // peekMessages returns only VISIBLE messages — i.e. real, runnable
      // work — and is non-destructive (no dequeue, no visibility change).
      const peeked = await client.peekMessages({ numberOfMessages: 32 }).catch(() => null);
      items = (peeked?.peekedMessageItems || [])
        .map((m) => parseQueueMessage(m.messageText))
        .filter(Boolean)
        .map((b) => ({
          domain: String(b.normalized_domain || "").trim(),
          company_id: String(b.company_id || "").trim(),
          reason: String(b.reason || "resume").trim(),
          fields: Array.isArray(b.fields) ? b.fields.filter(Boolean).slice(0, 8) : [],
        }));
    }
    return { depth, items };
  } catch {
    return { depth: null, items: [] };
  }
}

async function resolveQueueItemNames(companies, items) {
  const ids = [...new Set(items.map((i) => i.company_id).filter(Boolean))].slice(0, 32);
  if (!ids.length) return;
  try {
    const { resources } = await companies.items
      .query({
        query: `SELECT c.id, c.company_name FROM c WHERE ARRAY_CONTAINS(@ids, c.id)`,
        parameters: [{ name: "@ids", value: ids }],
      })
      .fetchAll();
    const nameById = new Map(resources.map((r) => [r.id, r.company_name]));
    for (const item of items) {
      item.name = nameById.get(item.company_id) || item.domain || item.company_id;
      delete item.company_id;
    }
  } catch {
    for (const item of items) {
      item.name = item.domain || item.company_id;
      delete item.company_id;
    }
  }
}

async function handler(req, context) {
  if (String(req?.method || "").toUpperCase() === "OPTIONS") return { status: 200, headers: cors() };

  const companies = getCosmosClient().database(DB_ID).container(process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies");
  const nowSec = Math.floor(Date.now() / 1000);

  const secondLookActiveCutIso = new Date((nowSec - SECOND_LOOK_ACTIVE_WINDOW_SEC) * 1000).toISOString();

  const [queueSnapshot, pendingRes, pendingStrandedRes, sessionsRes] = await Promise.all([
    getQueueSnapshot(),
    // Runnable-now second-looks: pending AND enqueued within the active
    // window. Docs missing second_look_enqueued_at are treated as stranded
    // (matches the watchdog's treatment in api/second-look-watchdog-timer).
    companies.items
      .query({
        query:
          "SELECT c.company_name FROM c WHERE c.second_look_pending = true AND IS_DEFINED(c.second_look_enqueued_at) AND c.second_look_enqueued_at >= @slCut AND NOT STARTSWITH(c.id, '_import_')",
        parameters: [{ name: "@slCut", value: secondLookActiveCutIso }],
      })
      .fetchAll()
      .catch(() => ({ resources: [] })),
    // Stranded diagnostic — pending but outside the active window OR missing
    // the enqueue stamp entirely. Not counted toward the banner; surfaced in
    // the response so operators can see stuck flags accumulating and so we
    // can spot regressions where the worker starts leaving stragglers.
    companies.items
      .query({
        query:
          "SELECT VALUE COUNT(1) FROM c WHERE c.second_look_pending = true AND (NOT IS_DEFINED(c.second_look_enqueued_at) OR c.second_look_enqueued_at < @slCut) AND NOT STARTSWITH(c.id, '_import_')",
        parameters: [{ name: "@slCut", value: secondLookActiveCutIso }],
      })
      .fetchAll()
      .catch(() => ({ resources: [0] })),
    companies.items
      .query({
        // Single-partition query against the control partition — cheap.
        // Sessions whose status already reads terminal don't count as
        // "importing" even when freshly touched: the +10-min safety-net
        // closer writes the doc at conclusion, and that bookkeeping write
        // must not re-redden the light.
        query:
          "SELECT c.id, c._ts, c.stage_beacon, c.status FROM c WHERE c.normalized_domain = 'import' AND STARTSWITH(c.id, '_import_session_') AND c._ts >= @cut AND (NOT IS_DEFINED(c.status) OR (c.status != 'complete' AND c.status != 'terminal' AND c.status != 'stopped' AND c.status != 'timeout'))",
        parameters: [{ name: "@cut", value: nowSec - 15 * 60 }],
      })
      .fetchAll()
      .catch(() => ({ resources: [] })),
  ]);

  const queueDepth = queueSnapshot.depth;
  await resolveQueueItemNames(companies, queueSnapshot.items);

  const pendingNames = (pendingRes.resources || []).map((r) => r.company_name).filter(Boolean);
  const sessions = sessionsRes.resources || [];
  const freshestSessionAgeSec = sessions.length ? nowSec - Math.max(...sessions.map((s) => s._ts || 0)) : null;

  // During an active run the UI + workers write session beacons every few
  // seconds, so a short cool-down is enough; 180s made "importing" linger
  // ~3 min after the batch visibly finished in the Companies view.
  const importing = freshestSessionAgeSec != null && freshestSessionAgeSec < 75;

  // Runnable-now work only. A message that a worker is actively processing is
  // also invisible to peek, but that case sets second_look_pending on the
  // company doc, so the two signals together cover real in-flight work
  // without counting our own scheduled safety nets.
  const runnableQueued = queueSnapshot.items.length;
  const enriching = runnableQueued > 0 || pendingNames.length > 0;
  const verdict = importing ? "importing" : enriching ? "enriching" : "idle";

  const strandedCount = Number((pendingStrandedRes.resources || [])[0] || 0);

  return json({
    ok: true,
    verdict,
    // Runnable now (visible) — what the light keys off.
    queue_runnable: runnableQueued,
    // Total including our scheduled safety-net messages — diagnostics only.
    queue_depth_including_scheduled: queueDepth,
    queue_depth: runnableQueued,
    // The actual queued work (peeked, non-destructive, up to 32 messages):
    // [{name, domain, reason, fields}] — the banner renders this as a
    // shrinking list so the operator can see what's left.
    queued_items: queueSnapshot.items,
    queued_items_truncated: queueSnapshot.items.length >= 32,
    second_look_pending_count: pendingNames.length,
    second_look_pending_names: pendingNames.slice(0, 10),
    // Stranded pending flags — outside the active window (or missing enqueue
    // stamp). Not counted toward "enriching"; exposed so operators can see
    // stuck flags accumulating and so the watchdog's job is visible.
    second_look_stranded_count: strandedCount,
    second_look_active_window_sec: SECOND_LOOK_ACTIVE_WINDOW_SEC,
    recent_sessions_15m: sessions.length,
    freshest_session_age_sec: freshestSessionAgeSec,
    checked_at: new Date().toISOString(),
  });
}

app.http("importPipelineStatus", {
  route: "import-pipeline-status",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: withContributorGuard(handler),
});

module.exports = {};
