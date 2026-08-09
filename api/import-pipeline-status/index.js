/**
 * Pipeline-status signal for the admin Import page.
 * Route: GET /api/import-pipeline-status   (withAdminGuard)
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
const { withAdminGuard } = require("../_adminAuth");
const { getCosmosClient } = require("../_cosmosConfig");
const { resolveQueueConfig } = require("../_enrichmentQueue");

let QueueClient;
try {
  ({ QueueClient } = require("@azure/storage-queue"));
} catch {
  QueueClient = null;
}

const DB_ID = process.env.COSMOS_DB_DATABASE || "tabarnam-db";

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
    const depth = Number(props.approximateMessagesCount ?? 0);

    let items = [];
    if (depth > 0) {
      // Peek is non-destructive (does not dequeue or bump visibility) — this
      // is what lets the banner show WHAT is queued, not just how many.
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

  const [queueSnapshot, pendingRes, sessionsRes] = await Promise.all([
    getQueueSnapshot(),
    companies.items
      .query("SELECT c.company_name FROM c WHERE c.second_look_pending = true AND NOT STARTSWITH(c.id, '_import_')")
      .fetchAll()
      .catch(() => ({ resources: [] })),
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
  const enriching = (queueDepth || 0) > 0 || pendingNames.length > 0;
  const verdict = importing ? "importing" : enriching ? "enriching" : "idle";

  return json({
    ok: true,
    verdict,
    queue_depth: queueDepth,
    // The actual queued work (peeked, non-destructive, up to 32 messages):
    // [{name, domain, reason, fields}] — the banner renders this as a
    // shrinking list so the operator can see what's left.
    queued_items: queueSnapshot.items,
    queued_items_truncated: (queueDepth || 0) > queueSnapshot.items.length,
    second_look_pending_count: pendingNames.length,
    second_look_pending_names: pendingNames.slice(0, 10),
    recent_sessions_15m: sessions.length,
    freshest_session_age_sec: freshestSessionAgeSec,
    checked_at: new Date().toISOString(),
  });
}

app.http("importPipelineStatus", {
  route: "import-pipeline-status",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: withAdminGuard(handler),
});

module.exports = {};
