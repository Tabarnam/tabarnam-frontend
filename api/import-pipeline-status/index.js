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

async function getQueueDepth() {
  try {
    if (!QueueClient) return null;
    const cfg = resolveQueueConfig();
    if (!cfg.connectionString) return null;
    const client = new QueueClient(cfg.connectionString, cfg.queueName);
    const props = await client.getProperties();
    return Number(props.approximateMessagesCount ?? 0);
  } catch {
    return null;
  }
}

async function handler(req, context) {
  if (String(req?.method || "").toUpperCase() === "OPTIONS") return { status: 200, headers: cors() };

  const companies = getCosmosClient().database(DB_ID).container(process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies");
  const nowSec = Math.floor(Date.now() / 1000);

  const [queueDepth, pendingRes, sessionsRes] = await Promise.all([
    getQueueDepth(),
    companies.items
      .query("SELECT c.company_name FROM c WHERE c.second_look_pending = true AND NOT STARTSWITH(c.id, '_import_')")
      .fetchAll()
      .catch(() => ({ resources: [] })),
    companies.items
      .query({
        // Single-partition query against the control partition — cheap.
        query:
          "SELECT c.id, c._ts, c.stage_beacon FROM c WHERE c.normalized_domain = 'import' AND STARTSWITH(c.id, '_import_session_') AND c._ts >= @cut",
        parameters: [{ name: "@cut", value: nowSec - 15 * 60 }],
      })
      .fetchAll()
      .catch(() => ({ resources: [] })),
  ]);

  const pendingNames = (pendingRes.resources || []).map((r) => r.company_name).filter(Boolean);
  const sessions = sessionsRes.resources || [];
  const freshestSessionAgeSec = sessions.length ? nowSec - Math.max(...sessions.map((s) => s._ts || 0)) : null;

  const importing = freshestSessionAgeSec != null && freshestSessionAgeSec < 180;
  const enriching = (queueDepth || 0) > 0 || pendingNames.length > 0;
  const verdict = importing ? "importing" : enriching ? "enriching" : "idle";

  return json({
    ok: true,
    verdict,
    queue_depth: queueDepth,
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
