// api/xadmin-api-cleanup-import-control/index.js
//
// Manual admin endpoint that purges stale import-control docs from the
// companies container via the shared _importControlCleanup engine. Used to
// clear the historical backlog and for ad-hoc runs; the weekly
// cleanup-import-control-timer calls the same engine for steady-state.
//
// Route: POST /xadmin-api-cleanup-import-control   (withAdminGuard)
// Body:  { older_than_hours?, dry_run?, page_size?, max_pages?,
//          time_budget_ms?, continuation? }
//   → { ok, processed, deleted, matched_so_far, continuation, done, ... }
//
// dry_run defaults to TRUE — you must pass dry_run:false to actually delete.
// older_than_hours is floored at 0.25h (15 min) so a mistyped 0 can never purge
// docs an in-flight/just-finished import still needs.

const { app } = require("../_app");
const { withAdminGuard } = require("../_adminAuth");
const { runImportControlCleanup, getCompaniesContainer } = require("../_importControlCleanup");

const MIN_HOURS = 0.25; // 15-minute grace floor
const DEFAULT_HOURS = 24;

const cors = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, x-functions-key, x-internal-job-secret, x-ms-client-principal, x-session-id",
  "Content-Type": "application/json",
});
const json = (obj, status = 200) => ({ status, headers: cors(), body: JSON.stringify(obj) });

function parseBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (!v) return fallback;
    if (["1", "true", "yes", "y", "on"].includes(v)) return true;
    if (["0", "false", "no", "n", "off"].includes(v)) return false;
  }
  return fallback;
}

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function cleanupHandler(req, context) {
  if (String(req?.method || "").toUpperCase() === "OPTIONS") return { status: 200, headers: cors() };

  let body = {};
  try {
    body = (await req.json()) || {};
  } catch {
    body = {};
  }

  const container = getCompaniesContainer();
  if (!container) return json({ ok: false, error: "Cosmos not configured" }, 503);

  const requestedHours = toNumber(body?.older_than_hours ?? body?.olderThanHours, DEFAULT_HOURS);
  const olderThanHours = Math.max(MIN_HOURS, requestedHours);
  const dryRun = parseBoolean(body?.dry_run ?? body?.dryRun, true);
  const pageSize = toNumber(body?.page_size ?? body?.pageSize, 200);
  const maxPages = body?.max_pages ?? body?.maxPages;
  const timeBudgetMs = body?.time_budget_ms ?? body?.timeBudgetMs;
  const continuation = body?.continuation ? String(body.continuation) : undefined;

  let result;
  try {
    result = await runImportControlCleanup({
      container,
      olderThanHours,
      dryRun,
      pageSize,
      ...(Number.isFinite(Number(maxPages)) ? { maxPages: Number(maxPages) } : {}),
      ...(Number.isFinite(Number(timeBudgetMs)) ? { timeBudgetMs: Number(timeBudgetMs) } : {}),
      continuation,
      context,
    });
  } catch (e) {
    context?.log?.("[xadmin-api-cleanup-import-control] unhandled", { message: e?.message || String(e) });
    return json({ ok: false, error: `cleanup crashed: ${e?.message || e}` }, 200);
  }

  // Always 200 so partial failures (e.g. throttling) surface in the body rather
  // than being swallowed as a thrown 500; callers inspect ok/failures/done.
  return json(result, 200);
}

app.http("xadminApiCleanupImportControl", {
  route: "xadmin-api-cleanup-import-control",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: withAdminGuard(cleanupHandler),
});

module.exports = { handler: cleanupHandler, _test: { cleanupHandler, MIN_HOURS } };
