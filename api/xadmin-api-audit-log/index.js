// GET /api/xadmin-api-audit-log — the sortable admin activity table.
//
// Distinct from xadmin-api-recent-activity, which is a FEED: that one collapses
// batches, drops batch-member rows entirely, takes only ?limit, and has no
// filtering, paging or sorting. This is the full record, filterable by person
// and time, sortable, and paged.
//
// Admin-only. It reports on everyone's activity, so a contributor must not see
// it — withAdminGuard, not withContributorGuard.
//
// DEFAULT WINDOW: the previous 72 hours. Query cost against this container
// scales with how much of it a query has to walk, not with how much comes back,
// so the common case stays cheap and a wider look is something you ask for.
// There is no server-side ceiling on the range — the operator decides.

const { app, hasRoute } = require("../_app");
const { getBuildInfo } = require("../_buildInfo");
const { getCompanyEditHistoryContainer } = require("../_companyEditHistory");
const { withAdminGuard } = require("../_adminAuth");

const BUILD_INFO = getBuildInfo();
const HANDLER_ID = "xadmin-api-audit-log";

const DEFAULT_WINDOW_HOURS = 72;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

// Cap on ids from a name search. A broad name can match many companies; past
// this the IN clause stops being worth its cost and the filter stops being a
// filter.
const MAX_COMPANY_IDS = 60;

// Columns the table may sort by. Anything else is rejected rather than
// interpolated — these names reach the SQL string.
const SORTABLE = new Map([
  ["created_at", "c.created_at"],
  ["actor_email", "c.actor_email"],
  ["action", "c.action"],
  ["company_id", "c.company_id"],
]);

function json(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, x-functions-key, x-ms-client-principal",
      "Cache-Control": "no-store",
      "X-Api-Handler": HANDLER_ID,
      "X-Api-Build-Id": String(BUILD_INFO.build_id || ""),
    },
    body: JSON.stringify(obj),
  };
}

function getQueryParam(req, name) {
  if (!req) return "";
  const q = req.query;
  if (q) {
    if (typeof q.get === "function") {
      const v = q.get(name);
      if (v != null) return String(v);
    } else if (typeof q === "object") {
      const v = q[name];
      if (v != null) return String(v);
    }
  }
  try {
    const url = typeof req.url === "string" ? req.url : "";
    if (url) {
      const u = url.includes("://") ? new URL(url) : new URL(url, "http://localhost");
      const v = u.searchParams.get(name);
      if (v != null) return String(v);
    }
  } catch {
    /* fall through */
  }
  return "";
}

function parseIso(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Resolve the time window. Defaults to the previous 72 hours; either bound may
 * be overridden independently, and an unparseable bound falls back to the
 * default rather than silently returning everything.
 */
function resolveWindow(req, now = new Date()) {
  const to = parseIso(getQueryParam(req, "to")) || now;

  // `all=1` lifts the lower bound entirely. This is the one query that walks
  // the whole container, so it is opt-in and reported back as such — the page
  // must be able to say which it ran.
  const allTime = ["1", "true", "yes"].includes(
    String(getQueryParam(req, "all") || "").trim().toLowerCase()
  );

  if (allTime) {
    return {
      from: new Date(0).toISOString(),
      to: to.toISOString(),
      is_default: false,
      is_all_time: true,
      hours: null,
    };
  }

  const explicitFrom = parseIso(getQueryParam(req, "from"));
  const from =
    explicitFrom || new Date(to.getTime() - DEFAULT_WINDOW_HOURS * 60 * 60 * 1000);

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    is_default: !explicitFrom && !parseIso(getQueryParam(req, "to")),
    is_all_time: false,
    hours: Math.round((new Date(to).getTime() - new Date(from).getTime()) / 36e5),
  };
}

function clampLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(n)));
}

function resolveSort(req) {
  const requested = String(getQueryParam(req, "sort") || "created_at").trim();
  const field = SORTABLE.has(requested) ? requested : "created_at";
  const dir =
    String(getQueryParam(req, "dir") || "desc").trim().toLowerCase() === "asc" ? "asc" : "desc";
  return { field, dir, rejected: requested && !SORTABLE.has(requested) ? requested : null };
}

/**
 * The row shape the table consumes. The `diff` payload — the before/after of
 * every changed field — is deliberately dropped: it is the bulk of the stored
 * document and the table only needs the headline. The per-company history panel
 * is where field-level detail lives.
 */
function projectRow(doc) {
  if (!doc || typeof doc !== "object") return null;

  const companyId =
    doc.company_id && doc.company_id !== "_batch_summary" ? String(doc.company_id) : null;

  return {
    id: String(doc.id || ""),
    created_at: String(doc.created_at || ""),
    actor_email: doc.actor_email || null,
    actor_user_id: doc.actor_user_id || null,
    action: String(doc.action || ""),
    company_id: companyId,
    company_name: null, // hydrated below, best effort
    changed_fields: Array.isArray(doc.changed_fields) ? doc.changed_fields : [],
    changed_field_count: Array.isArray(doc.changed_fields) ? doc.changed_fields.length : 0,
    source: doc.source || null,
    request_id: doc.request_id || null,
    batch_id: doc.batch_id || null,
    is_batch_summary: doc.company_id === "_batch_summary",
    summary: doc.summary && typeof doc.summary === "object" ? doc.summary : null,
  };
}

/**
 * Build the SQL and parameters.
 *
 * `multiField` orders by the chosen column AND time. That needs a composite
 * index (migration 0003); when it is absent Cosmos rejects the request outright
 * with 400, so the caller retries single-field.
 */
function buildQuery({ window: win, sort, limit, filters, multiField }) {
  const where = ["c.created_at >= @from", "c.created_at <= @to"];
  const parameters = [
    { name: "@from", value: win.from },
    { name: "@to", value: win.to },
  ];

  if (filters.actor_email) {
    where.push("IS_DEFINED(c.actor_email) AND LOWER(c.actor_email) = @actor");
    parameters.push({ name: "@actor", value: filters.actor_email });
  }

  if (filters.action) {
    where.push("c.action = @action");
    parameters.push({ name: "@action", value: filters.action });
  }

  if (filters.company_id) {
    where.push("c.company_id = @company_id");
    parameters.push({ name: "@company_id", value: filters.company_id });
  }

  // Resolved from a company-NAME search on the client, which runs against the
  // same companies endpoint the admin list uses — so "name" here means exactly
  // what it means in the /admin search box, rather than a second, subtly
  // different matcher living in this file.
  if (Array.isArray(filters.company_ids) && filters.company_ids.length > 0) {
    const names = filters.company_ids.map((_, i) => `@cid${i}`);
    filters.company_ids.forEach((id, i) => parameters.push({ name: `@cid${i}`, value: id }));
    where.push(`c.company_id IN (${names.join(", ")})`);
  }

  const column = SORTABLE.get(sort.field);
  const direction = sort.dir === "asc" ? "ASC" : "DESC";

  // Sorting by a non-time column without a time tiebreak groups rows by that
  // column in arbitrary internal order, which reads as noise. Pair it with time
  // when we can.
  const orderBy =
    multiField && sort.field !== "created_at"
      ? `${column} ${direction}, c.created_at DESC`
      : `${column} ${direction}`;

  return {
    query: `SELECT * FROM c WHERE ${where.join(" AND ")} ORDER BY ${orderBy}`,
    parameters,
    limit,
  };
}

function isMissingCompositeIndexError(e) {
  const status = Number(e?.code || e?.statusCode || 0);
  const message = String(e?.message || e?.body?.message || "");
  return status === 400 && /composite index/i.test(message);
}

/** Best-effort company_name lookup so the table shows names, not opaque ids. */
async function hydrateCompanyNames(rows, context) {
  const ids = [...new Set(rows.map((r) => r.company_id).filter(Boolean))];
  if (ids.length === 0) return rows;

  try {
    const { CosmosClient } = require("@azure/cosmos");
    if (!CosmosClient) return rows;

    const client = require("../_cosmosConfig").getCosmosClient();
    if (!client) return rows;

    const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
    const containerId = (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();
    const companies = client.database(databaseId).container(containerId);

    const placeholders = ids.map((_, i) => `@id${i}`).join(",");
    const parameters = ids.map((id, i) => ({ name: `@id${i}`, value: id }));

    const { resources } = await companies.items
      .query(
        {
          query: `SELECT c.id, c.company_id, c.company_name, c.display_name FROM c WHERE c.id IN (${placeholders}) OR c.company_id IN (${placeholders})`,
          parameters,
        },
        { enableCrossPartitionQuery: true }
      )
      .fetchAll();

    const byId = new Map();
    for (const c of resources || []) {
      const name = c.display_name || c.company_name || null;
      if (!name) continue;
      if (c.id) byId.set(String(c.id), name);
      if (c.company_id) byId.set(String(c.company_id), name);
    }

    for (const row of rows) {
      if (row.company_id && byId.has(row.company_id)) {
        row.company_name = byId.get(row.company_id);
      }
    }
  } catch (e) {
    // Non-fatal — the table falls back to showing company_id.
    try {
      context?.log?.("[audit-log] company name hydration failed", { error: e?.message });
    } catch {}
  }

  return rows;
}

async function handleGet(req, context, deps = {}) {
  const container = deps.container || (await getCompanyEditHistoryContainer());
  if (!container) {
    return json(
      { ok: false, items: [], error: "Cosmos DB not configured", build_id: String(BUILD_INFO.build_id || "") },
      503
    );
  }

  const win = resolveWindow(req, deps.now);
  const sort = resolveSort(req);
  const limit = clampLimit(getQueryParam(req, "limit") || DEFAULT_LIMIT);
  const cursor = String(getQueryParam(req, "cursor") || "").trim();

  const filters = {
    actor_email: String(getQueryParam(req, "actor_email") || "").trim().toLowerCase(),
    action: String(getQueryParam(req, "action") || "").trim(),
    company_id: String(getQueryParam(req, "company_id") || "").trim(),
    company_ids: String(getQueryParam(req, "company_ids") || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .slice(0, MAX_COMPANY_IDS),
  };

  // A name search that matched nothing must return nothing. Without this the
  // empty id list would be dropped and the page would show ALL activity —
  // reading as "this company was never touched by anyone" when the truth is
  // "no company matched that name".
  const nameSearchMissed =
    String(getQueryParam(req, "company_ids") || "").trim() === "__none__";

  if (nameSearchMissed) {
    return json({
      ok: true,
      items: [],
      count: 0,
      window: resolveWindow(req, deps.now),
      sort: { field: "created_at", dir: "desc" },
      ordering: "indexed",
      limit,
      next_cursor: null,
      no_company_match: true,
    });
  }

  let ordering = "indexed";
  let spec = buildQuery({ window: win, sort, limit, filters, multiField: true });

  async function run(querySpec) {
    const iterator = container.items.query(
      { query: querySpec.query, parameters: querySpec.parameters },
      {
        enableCrossPartitionQuery: true,
        maxItemCount: limit,
        ...(cursor ? { continuationToken: cursor } : {}),
      }
    );
    return iterator.fetchNext();
  }

  let page;
  try {
    page = await run(spec);
  } catch (e) {
    if (!isMissingCompositeIndexError(e)) {
      try {
        context?.log?.("[audit-log] query failed", { error: e?.message });
      } catch {}
      return json({ ok: false, items: [], error: "query_failed", detail: e?.message }, 500);
    }

    // Migration 0003 has not finished re-indexing. Fall back to a single-field
    // ORDER BY so the table still works, and SAY SO — a silently degraded sort
    // looks identical to a correct one, which is how a wrong answer gets
    // trusted.
    ordering = "degraded_no_composite_index";
    spec = buildQuery({ window: win, sort, limit, filters, multiField: false });
    page = await run(spec);
  }

  const rows = (Array.isArray(page?.resources) ? page.resources : [])
    .map(projectRow)
    .filter(Boolean);

  await hydrateCompanyNames(rows, context);

  return json({
    ok: true,
    items: rows,
    count: rows.length,
    window: win,
    sort: { field: sort.field, dir: sort.dir, ...(sort.rejected ? { rejected: sort.rejected } : {}) },
    ordering,
    limit,
    next_cursor: page?.continuationToken || null,
    build_id: String(BUILD_INFO.build_id || ""),
  });
}

async function handler(req, context, deps = {}) {
  const method = String(req?.method || "GET").toUpperCase();
  if (method === "OPTIONS") return json({ ok: true, items: [] }, 200);
  if (method !== "GET") return json({ ok: false, error: "Method not allowed" }, 405);
  return handleGet(req, context, deps);
}

const ROUTE = "xadmin-api-audit-log";

if (!hasRoute(ROUTE)) {
  app.http("xadminApiAuditLog", {
    route: ROUTE,
    methods: ["GET", "OPTIONS"],
    authLevel: "anonymous",
    handler: withAdminGuard(handler),
  });
}

module.exports = {
  handler,
  _test: {
    handleGet,
    resolveWindow,
    resolveSort,
    buildQuery,
    projectRow,
    clampLimit,
    isMissingCompositeIndexError,
    MAX_COMPANY_IDS,
    SORTABLE,
    DEFAULT_WINDOW_HOURS,
    MAX_LIMIT,
  },
};
