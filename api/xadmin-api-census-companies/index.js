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
// Each query is isolated (its own try/catch) so one bad query yields a partial
// census + a per-key error map rather than failing the whole run.
//
// Route: GET|POST /xadmin-api-census-companies   (withAdminGuard)
//   → { ok, total, exclusive_buckets, reconciliation, breakdowns, diagnostics, errors }

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
const NOT_JOB_OR_IMPORT = `${NOT_REFRESH} AND ${NOT_IMPORT_ID} AND ${NOT_IMPORT_CTRL}`;
const SOFT_DELETED_WHERE = `${NOT_JOB_OR_IMPORT} AND IS_DEFINED(c.is_deleted) AND c.is_deleted = true`;

async function scalarCount(container, where) {
  const query = where ? `SELECT VALUE COUNT(1) FROM c WHERE ${where}` : "SELECT VALUE COUNT(1) FROM c";
  const res = await container.items.query({ query }, { enableCrossPartitionQuery: true }).fetchAll();
  return Number((res.resources || [])[0] || 0);
}

// GROUP BY <field> → [{ key, count }], capped and sorted desc.
// NB: alias must avoid Cosmos reserved words (VALUE/COUNT) — use `k`/`n`.
async function groupCount(container, field, where, { cap = 40 } = {}) {
  const whereClause = where ? `WHERE ${where} ` : "";
  const query = `SELECT ${field} AS k, COUNT(1) AS n FROM c ${whereClause}GROUP BY ${field}`;
  const res = await container.items.query({ query }, { enableCrossPartitionQuery: true }).fetchAll();
  const rows = (res.resources || []).map((r) => ({
    key: r?.k === undefined ? "(undefined)" : r.k === null ? "(null)" : r.k,
    count: Number(r?.n || 0),
  }));
  rows.sort((a, b) => b.count - a.count);
  return rows.slice(0, cap);
}

// Sample up to `n` full docs matching `where`, measure serialized byte size.
// One page (fetchNext) so RU stays bounded. Returns { sampled, avg_bytes,
// min_bytes, max_bytes, example_keys }.
async function sizeSample(container, where, { n = 50 } = {}) {
  const query = `SELECT * FROM c WHERE ${where}`;
  const page = await container.items
    .query({ query }, { maxItemCount: n, enableCrossPartitionQuery: true })
    .fetchNext();
  const docs = Array.isArray(page?.resources) ? page.resources : [];
  if (docs.length === 0) return { sampled: 0, avg_bytes: null, min_bytes: null, max_bytes: null, example_keys: [] };
  let sum = 0;
  let min = Infinity;
  let max = 0;
  for (const d of docs) {
    const b = Buffer.byteLength(JSON.stringify(d), "utf8");
    sum += b;
    if (b < min) min = b;
    if (b > max) max = b;
  }
  return {
    sampled: docs.length,
    avg_bytes: Math.round(sum / docs.length),
    min_bytes: min,
    max_bytes: max,
    example_keys: Object.keys(docs[0] || {}).sort(),
  };
}

// Read a param from either the query string (GET) or JSON body (POST).
async function readParam(req, name) {
  try {
    const v = req?.query?.get ? req.query.get(name) : undefined;
    if (v != null && v !== "") return v;
  } catch {}
  try {
    req.__body ||= (await req.json()) || {};
    const v = req.__body?.[name];
    if (v != null && v !== "") return v;
  } catch {}
  return undefined;
}

const CONTROL_PREDICATE =
  "(STARTSWITH(c.id, '_import_') OR (IS_DEFINED(c.type) AND c.type IN ('import_control','import_stop','import_primary_job','import_session')))";

// Read-only inspector: window control docs by _ts age and return real samples +
// type/source/created-day breakdowns, so we can identify a burst of docs.
async function inspectControlWindow(container, { ageMinHours, ageMaxHours }) {
  const nowSec = Math.floor(Date.now() / 1000);
  const hi = ageMinHours != null ? nowSec - Math.floor(ageMinHours * 3600) : null; // _ts <= hi (older than ageMin)
  const lo = ageMaxHours != null ? nowSec - Math.floor(ageMaxHours * 3600) : null; // _ts > lo (younger than ageMax)

  const clauses = [CONTROL_PREDICATE, "(NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true)"];
  const params = [];
  if (hi != null) { clauses.push("c._ts <= @hi"); params.push({ name: "@hi", value: hi }); }
  if (lo != null) { clauses.push("c._ts > @lo"); params.push({ name: "@lo", value: lo }); }
  const where = clauses.join(" AND ");

  const q = async (sql, extraParams = []) =>
    (await container.items.query({ query: sql, parameters: [...params, ...extraParams] }, { enableCrossPartitionQuery: true }).fetchAll()).resources || [];

  const [countRow, byType, bySource, byDay, sample] = await Promise.all([
    q(`SELECT VALUE COUNT(1) FROM c WHERE ${where}`),
    q(`SELECT c.type AS k, COUNT(1) AS n FROM c WHERE ${where} GROUP BY c.type`),
    q(`SELECT c.source AS k, COUNT(1) AS n FROM c WHERE ${where} GROUP BY c.source`),
    q(`SELECT SUBSTRING(c.created_at,0,13) AS k, COUNT(1) AS n FROM c WHERE ${where} GROUP BY SUBSTRING(c.created_at,0,13)`),
    q(`SELECT TOP 25 c.id, c.type, c._ts, c.source, c.session_id, c.created_at, c.updated_at, c.status, c.company_name FROM c WHERE ${where}`),
  ]);

  const tidy = (rows) =>
    rows.map((r) => ({ key: r?.k === undefined ? "(undefined)" : r.k === null ? "(null)" : r.k, count: Number(r?.n || 0) }))
      .sort((a, b) => b.count - a.count).slice(0, 60);

  return {
    window: { age_min_hours: ageMinHours ?? null, age_max_hours: ageMaxHours ?? null, ts_lo: lo, ts_hi: hi },
    count: Number(countRow[0] || 0),
    by_type: tidy(byType),
    by_source: tidy(bySource),
    by_created_hour: tidy(byDay),
    sample,
  };
}

async function censusHandler(req, context) {
  if (String(req.method || "").toUpperCase() === "OPTIONS") return { status: 200, headers: cors() };

  const container = getCompaniesContainer();
  if (!container) return json({ ok: false, error: "Cosmos not configured" }, 503);

  // Optional read-only inspector (does not run the full census).
  const inspect = await readParam(req, "inspect");
  if (inspect === "control") {
    const ageMin = await readParam(req, "age_min_hours");
    const ageMax = await readParam(req, "age_max_hours");
    try {
      const result = await inspectControlWindow(container, {
        ageMinHours: ageMin != null ? Number(ageMin) : undefined,
        ageMaxHours: ageMax != null ? Number(ageMax) : undefined,
      });
      return json({ ok: true, inspect: "control", ...result });
    } catch (e) {
      return json({ ok: false, error: `inspect failed: ${e?.message || e}` }, 500);
    }
  }

  const errors = {};

  // Isolated scalar count: never throws — records the error under `key`.
  const counts = {};
  async function count(key, where) {
    try {
      counts[key] = await scalarCount(container, where);
    } catch (e) {
      counts[key] = null;
      errors[key] = e?.message || String(e);
    }
  }

  // Isolated group query.
  const groups = {};
  async function group(key, field, where) {
    try {
      groups[key] = await groupCount(container, field, where);
    } catch (e) {
      groups[key] = null;
      errors[`group:${key}`] = e?.message || String(e);
    }
  }

  // ── Mutually-exclusive buckets (priority order; sum must == total) ──
  const bRefreshJob = `STARTSWITH(c.id, 'refresh_job_')`;
  const bImportId = `(NOT STARTSWITH(c.id, 'refresh_job_')) AND STARTSWITH(c.id, '_import_')`;
  const bImportCtrl = `${NOT_REFRESH} AND ${NOT_IMPORT_ID} AND IS_DEFINED(c.type) AND c.type = 'import_control'`;

  await Promise.all([
    count("total", ""),
    count("refresh_job", bRefreshJob),
    count("import_id", bImportId),
    count("import_control", bImportCtrl),
    count("soft_deleted", SOFT_DELETED_WHERE),
    count("live", LIVE_WHERE),
    // Overlapping diagnostics (do NOT sum to total)
    count("domain_bearing", "IS_DEFINED(c.normalized_domain)"),
    count("domain_unknown", "c.normalized_domain = 'unknown'"),
    count("seed_fallback_dup_all", "STARTSWITH(LOWER(c.normalized_domain), 'seed-fallback-dup')"),
    count("live_domain_bearing", `${LIVE_WHERE} AND IS_DEFINED(c.normalized_domain) AND c.normalized_domain != 'unknown'`),
    count("live_no_domain", `${LIVE_WHERE} AND NOT IS_DEFINED(c.normalized_domain)`),
    count("live_domain_unknown", `${LIVE_WHERE} AND c.normalized_domain = 'unknown'`),
    count("live_seed_fallback_dup", `${LIVE_WHERE} AND STARTSWITH(LOWER(c.normalized_domain), 'seed-fallback-dup')`),
    count(
      "live_missing_name",
      `${LIVE_WHERE} AND (NOT IS_DEFINED(c.company_name) OR c.company_name = '') AND (NOT IS_DEFINED(c.name) OR c.name = '')`,
    ),
  ]);

  // ── GROUP BY breakdowns (isolated; run after counts to keep RU pressure low) ──
  await Promise.all([
    group("by_type", "c.type", ""),
    group("soft_deleted_by_reason", "c.deleted_reason", SOFT_DELETED_WHERE),
    group("live_by_source", "c.source", LIVE_WHERE),
    group("soft_deleted_by_source", "c.source", SOFT_DELETED_WHERE),
  ]);

  // ── Byte-size sampling (isolated) to estimate storage per category ──
  const sizing = {};
  async function size(key, where) {
    try {
      sizing[key] = await sizeSample(container, where);
    } catch (e) {
      sizing[key] = null;
      errors[`size:${key}`] = e?.message || String(e);
    }
  }
  await Promise.all([
    size("import_id", "STARTSWITH(c.id, '_import_')"),
    size("live", LIVE_WHERE),
    size("soft_deleted", SOFT_DELETED_WHERE),
  ]);

  const exclusive_buckets = {
    refresh_job: counts.refresh_job,
    import_id: counts.import_id,
    import_control: counts.import_control,
    soft_deleted: counts.soft_deleted,
    live: counts.live,
  };
  const bucketVals = Object.values(exclusive_buckets);
  const allBucketsOk = bucketVals.every((v) => typeof v === "number");
  const bucketSum = allBucketsOk ? bucketVals.reduce((a, b) => a + b, 0) : null;

  return json({
    ok: Object.keys(errors).length === 0,
    container: "companies",
    total: counts.total,
    exclusive_buckets,
    reconciliation: {
      bucket_sum: bucketSum,
      total: counts.total,
      matches: bucketSum != null && typeof counts.total === "number" ? bucketSum === counts.total : null,
      unaccounted: bucketSum != null && typeof counts.total === "number" ? counts.total - bucketSum : null,
    },
    diagnostics: {
      domain_bearing: counts.domain_bearing,
      domain_unknown: counts.domain_unknown,
      seed_fallback_dup_all: counts.seed_fallback_dup_all,
      live_domain_bearing: counts.live_domain_bearing,
      live_no_domain: counts.live_no_domain,
      live_domain_unknown: counts.live_domain_unknown,
      live_seed_fallback_dup: counts.live_seed_fallback_dup,
      live_missing_name: counts.live_missing_name,
    },
    breakdowns: {
      by_type: groups.by_type,
      soft_deleted_by_reason: groups.soft_deleted_by_reason,
      live_by_source: groups.live_by_source,
      soft_deleted_by_source: groups.soft_deleted_by_source,
    },
    sizing: {
      import_id: sizing.import_id,
      live: sizing.live,
      soft_deleted: sizing.soft_deleted,
      // Extrapolated total bytes = avg sample bytes × bucket count (docs only,
      // excludes Cosmos index overhead which is typically comparable again).
      est_import_id_doc_bytes:
        sizing.import_id?.avg_bytes != null && typeof counts.import_id === "number"
          ? sizing.import_id.avg_bytes * counts.import_id
          : null,
      est_live_doc_bytes:
        sizing.live?.avg_bytes != null && typeof counts.live === "number"
          ? sizing.live.avg_bytes * counts.live
          : null,
    },
    errors: Object.keys(errors).length ? errors : undefined,
  });
}

app.http("xadminApiCensusCompanies", {
  route: "xadmin-api-census-companies",
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: withAdminGuard(censusHandler),
});

module.exports = { _test: { censusHandler, LIVE_WHERE } };
