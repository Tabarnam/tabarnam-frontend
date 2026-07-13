// api/xadmin-api-backfill-visible-counts/index.js
//
// One-time (re-runnable) backfill that pins company.visible_review_count for
// every company, using the same authoritative get-reviews computation as the
// live pin-on-write paths. Paged via a Cosmos continuation token so it never
// times out on a large catalog: call repeatedly, passing back the returned
// `continuation`, until it comes back null.
//
// Route: POST /xadmin-api-backfill-visible-counts   (withAdminGuard)
// Body:  { continuation?: string, pageSize?: number }
//   → { ok, processed, pinned, continuation, done }

const { app } = require("../_app");
const { getCompaniesContainer } = require("../_reviewCounts");
const { withAdminGuard } = require("../_adminAuth");
const { recomputeAndPinVisibleCount } = require("../_pinVisibleReviewCount");

const DEFAULT_PAGE = 100;
const MAX_PAGE = 300;
const CONCURRENCY = 4;

const cors = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-ms-client-principal, x-session-id",
  "Content-Type": "application/json",
});
const json = (obj, status = 200) => ({ status, headers: cors(), body: JSON.stringify(obj) });

async function backfillHandler(req, context) {
  if (String(req.method || "").toUpperCase() === "OPTIONS") return { status: 200, headers: cors() };

  const companiesContainer = getCompaniesContainer();
  if (!companiesContainer) return json({ ok: false, error: "Cosmos not configured" }, 503);

  let body = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const continuation = body?.continuation ? String(body.continuation) : undefined;
  const pageSize = Math.min(MAX_PAGE, Math.max(1, Number(body?.pageSize) || DEFAULT_PAGE));

  // Only the fields recompute+pin needs — keeps the page light. Exclude the
  // non-company docs that also live in this container (soft-deleted records and
  // import/refresh control docs) so we don't waste work pinning junk — the same
  // filter search-companies applies.
  const query =
    "SELECT c.id, c.company_id, c.company_name, c.normalized_domain FROM c " +
    "WHERE (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true) " +
    "AND NOT STARTSWITH(c.id, 'refresh_job_') " +
    "AND NOT STARTSWITH(c.id, '_import_') " +
    "AND (NOT IS_DEFINED(c.type) OR c.type != 'import_control')";
  let page;
  try {
    page = await companiesContainer.items
      .query({ query }, { maxItemCount: pageSize, continuationToken: continuation, enableCrossPartitionQuery: true })
      .fetchNext();
  } catch (e) {
    return json({ ok: false, error: `query failed: ${e?.message || e}` }, 500);
  }

  const docs = Array.isArray(page?.resources) ? page.resources : [];

  // Pin each with bounded concurrency.
  let pinned = 0;
  let i = 0;
  async function worker() {
    while (i < docs.length) {
      const d = docs[i++];
      const c = await recomputeAndPinVisibleCount(companiesContainer, d, {}, context);
      if (typeof c === "number") pinned++;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, docs.length) }, worker));

  const nextContinuation = page?.continuationToken || null;
  return json({
    ok: true,
    processed: docs.length,
    pinned,
    continuation: nextContinuation,
    done: !nextContinuation,
  });
}

app.http("xadminApiBackfillVisibleCounts", {
  route: "xadmin-api-backfill-visible-counts",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: withAdminGuard(backfillHandler),
});

module.exports = { handler: backfillHandler };
