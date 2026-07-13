// api/xadmin-api-census-companies/index.js
//
// READ-ONLY census of the `companies` container. Runs a battery of cheap
// COUNT(1) aggregates and GROUP BY breakdowns so we can characterize the ~16k
// non-published docs (soft-deletes, seed-fallback dups, import placeholders,
// job/control docs) BEFORE any pruning. Performs no writes.
//
// The five "exclusive" buckets are defined in priority order so every doc lands
// in exactly one; their sum must equal `total` (surfaced as reconciliation).
// The `live` bucket uses the same canonical junk filter search-companies and
// admin-companies-v2 apply, so live ≈ the admin dashboard's PUBLISHED count.
//
// Route: GET|POST /xadmin-api-census-companies   (withAdminGuard)
//   → { ok, total, exclusive_buckets, reconciliation, breakdowns, diagnostics }

const { app } = require("../_app");
const { getCompaniesContainer } = require("../_reviewCounts");
const { withAdminGuard } = require("../_adminAuth");

const cors = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, x-functions-key, x-internal-job-secret, x-ms-client-principal, x-session-id",
  "Content-Type": "application/json",
});
const json = (obj, status = 200) => ({ status, headers: cors(), body: JSON.stringify(obj) });

// Canonical junk filter (matches search-companies softDeleteFilter and
// admin-companies-v2 baseWhere). A doc passing this is a "live" / published company.
const NOT_DELETED = "(NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true)";
const NOT_REFRESH = "NOT STARTSWITH(c.id, 'refresh_job_')";
const NOT_IMPORT_ID = "NOT STARTSWITH(c.id, '_import_')";
const NOT_IMPORT_CTRL = "(NOT IS_DEFINED(c.type) OR c.type != 'import_control')";
const LIVE_WHERE = [NOT_DELETED, NOT_REFRESH, NOT_IMPORT_ID, NOT_IMPORT_CTRL].join(" AND ");

async function scalarCount(container, where) {
  const query = where ? `SELECT VALUE COUNT(1) FROM c WHERE ${where}` : "SELECT VALUE COUNT(1) FROM c";
  const res = await container.items.query({ query }, { enableCrossPartitionQuery: true }).fetchAll();
  return Number((res.resources || [])[0] || 0);
}

// GROUP BY <field> → [{ value, count }], capped and sorted desc.
async function groupCount(container, field, where, { cap = 40 } = {}) {
  const whereClause = where ? `WHERE ${where} ` : "";
  const query = `SELECT ${field} AS value, COUNT(1) AS count FROM c ${whereClause}GROUP BY ${field}`;
  const res = await container.items.query({ query }, { enableCrossPartitionQuery: true }).fetchAll();
  const rows = (res.resources || []).map((r) => ({
    value: r?.value === undefined ? "(undefined)" : r.value === null ? "(null)" : r.value,
    count: Number(r?.count || 0),
  }));
  rows.sort((a, b) => b.count - a.count);
  return rows.slice(0, cap);
}

async function censusHandler(req, context) {
  if (String(req.method || "").toUpperCase() === "OPTIONS") return { status: 200, headers: cors() };

  const container = getCompaniesContainer();
  if (!container) return json({ ok: false, error: "Cosmos not configured" }, 503);

  try {
    // ── Mutually-exclusive buckets (priority order; sum must == total) ──
    const bRefreshJob = `STARTSWITH(c.id, 'refresh_job_')`;
    const bImportId = `(NOT STARTSWITH(c.id, 'refresh_job_')) AND STARTSWITH(c.id, '_import_')`;
    const bImportCtrl = `${NOT_REFRESH} AND ${NOT_IMPORT_ID} AND IS_DEFINED(c.type) AND c.type = 'import_control'`;
    const bSoftDeleted = `${NOT_REFRESH} AND ${NOT_IMPORT_ID} AND ${NOT_IMPORT_CTRL} AND IS_DEFINED(c.is_deleted) AND c.is_deleted = true`;
    const bLive = LIVE_WHERE;

    const [
      total,
      refresh_job,
      import_id,
      import_control,
      soft_deleted,
      live,
    ] = await Promise.all([
      scalarCount(container, ""),
      scalarCount(container, bRefreshJob),
      scalarCount(container, bImportId),
      scalarCount(container, bImportCtrl),
      scalarCount(container, bSoftDeleted),
      scalarCount(container, bLive),
    ]);

    const exclusive_buckets = { refresh_job, import_id, import_control, soft_deleted, live };
    const bucketSum = refresh_job + import_id + import_control + soft_deleted + live;

    // ── Overlapping diagnostics (do NOT sum to total) ──
    const [
      domain_bearing,
      domain_unknown,
      seed_fallback_dup_all,
      live_domain_bearing,
      live_no_domain,
      live_domain_unknown,
      live_seed_fallback_dup,
      live_missing_name,
    ] = await Promise.all([
      scalarCount(container, "IS_DEFINED(c.normalized_domain)"),
      scalarCount(container, "c.normalized_domain = 'unknown'"),
      scalarCount(container, "STARTSWITH(LOWER(c.normalized_domain), 'seed-fallback-dup')"),
      scalarCount(container, `${bLive} AND IS_DEFINED(c.normalized_domain) AND c.normalized_domain != 'unknown'`),
      scalarCount(container, `${bLive} AND NOT IS_DEFINED(c.normalized_domain)`),
      scalarCount(container, `${bLive} AND c.normalized_domain = 'unknown'`),
      scalarCount(container, `${bLive} AND STARTSWITH(LOWER(c.normalized_domain), 'seed-fallback-dup')`),
      scalarCount(
        container,
        `${bLive} AND (NOT IS_DEFINED(c.company_name) OR c.company_name = '') AND (NOT IS_DEFINED(c.name) OR c.name = '')`,
      ),
    ]);

    // ── GROUP BY breakdowns to surface anything unexpected ──
    const [byType, byDeletedReason, liveBySource, softDeletedBySource] = await Promise.all([
      groupCount(container, "c.type", ""),
      groupCount(container, "c.deleted_reason", `${NOT_REFRESH} AND ${NOT_IMPORT_ID} AND ${NOT_IMPORT_CTRL} AND IS_DEFINED(c.is_deleted) AND c.is_deleted = true`),
      groupCount(container, "c.source", bLive),
      groupCount(container, "c.source", `${NOT_REFRESH} AND ${NOT_IMPORT_ID} AND ${NOT_IMPORT_CTRL} AND IS_DEFINED(c.is_deleted) AND c.is_deleted = true`),
    ]);

    return json({
      ok: true,
      container: "companies",
      total,
      exclusive_buckets,
      reconciliation: {
        bucket_sum: bucketSum,
        total,
        matches: bucketSum === total,
        unaccounted: total - bucketSum,
      },
      diagnostics: {
        domain_bearing,
        domain_unknown,
        seed_fallback_dup_all,
        live_domain_bearing,
        live_no_domain,
        live_domain_unknown,
        live_seed_fallback_dup,
        live_missing_name,
      },
      breakdowns: {
        by_type: byType,
        soft_deleted_by_reason: byDeletedReason,
        live_by_source: liveBySource,
        soft_deleted_by_source: softDeletedBySource,
      },
    });
  } catch (e) {
    context?.log?.("[xadmin-api-census-companies] failed", { message: e?.message || String(e) });
    return json({ ok: false, error: `census failed: ${e?.message || e}` }, 500);
  }
}

app.http("xadminApiCensusCompanies", {
  route: "xadmin-api-census-companies",
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: withAdminGuard(censusHandler),
});

module.exports = { _test: { censusHandler, LIVE_WHERE } };
