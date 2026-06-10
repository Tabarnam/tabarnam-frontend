// Phase 4.35 — Recent Activity feed for the AdminImport page.
//
// GET /api/xadmin-api-recent-activity?limit=25
//   Returns the most recent admin actions across the catalog, aggregated
//   at the batch level. Reads `company_edit_history` cross-partition and
//   filters per-company entries that are part of a batch operation (they
//   carry batch_id) — those are represented by a single batch-summary
//   row instead.
//
// POST /api/xadmin-api-recent-activity
//   Body: { action, summary, request_id?, batch_id? }
//   action must be one of: "bulk_import_summary", "apply_batch_fields_summary"
//   Writes a single row to the BATCH_SUMMARY_PARTITION in the same
//   container. The actor is identified from the SWA x-ms-client-principal
//   header (matches the existing actor_email plumbing used elsewhere).
//
// Feed entries returned:
//   - Batch summaries (action ends in "_summary")
//   - Per-company create/update entries WHERE batch_id is undefined
//
// Single-company edits via the editor drawer naturally surface (no
// batch_id). Bulk-import and Apply-Industries/Products operations write
// per-company entries WITH batch_id (so they're filtered out of the
// feed) plus one batch summary (which surfaces).

const { app, hasRoute } = require("../_app");
const { getBuildInfo } = require("../_buildInfo");
const {
  getCompanyEditHistoryContainer,
  writeBatchSummaryEntry,
} = require("../_companyEditHistory");
const { decodeClientPrincipal } = require("../_adminAuth");

const BUILD_INFO = getBuildInfo();
const HANDLER_ID = "xadmin-api-recent-activity";

const ALLOWED_SUMMARY_ACTIONS = new Set([
  "bulk_import_summary",
  "apply_batch_fields_summary",
]);

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function json(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, x-functions-key, x-ms-client-principal",
      "Cache-Control": "no-store",
      "X-Api-Handler": HANDLER_ID,
      "X-Api-Build-Id": String(BUILD_INFO.build_id || ""),
      "X-Api-Build-Source": String(BUILD_INFO.build_id_source || ""),
    },
    body: JSON.stringify(obj),
  };
}

function clampLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(n)));
}

function getQueryParam(req, name) {
  if (!req) return "";
  // Azure Functions v4 exposes `req.query` as a URLSearchParams instance,
  // NOT a plain object — bracket access (`req.query[name]`) silently
  // returns undefined. Use `.get()` when available, then fall back to a
  // plain-object access (for tests / older shapes) and finally parse the
  // URL ourselves.
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
  // Last-resort: parse the URL. Useful when `req.url` is absolute and
  // `req.query` is missing entirely (e.g. some local-dev harnesses).
  const url = typeof req.url === "string" ? req.url : "";
  if (url) {
    try {
      const u = url.includes("://") ? new URL(url) : new URL(url, "http://localhost");
      const v = u.searchParams.get(name);
      if (v != null) return String(v);
    } catch {
      /* fall through */
    }
  }
  return "";
}

function extractActor(req) {
  const principal = decodeClientPrincipal(req);
  if (!principal) return { actor_email: "", actor_user_id: "" };
  const userDetails =
    typeof principal.userDetails === "string" ? principal.userDetails.trim() : "";
  const userId =
    typeof principal.userId === "string" ? principal.userId.trim() : "";
  return {
    actor_email: userDetails || "",
    actor_user_id: userId || userDetails || "",
  };
}

/**
 * Project a Cosmos history doc to the row shape the UI consumes. Strip
 * the large `diff` payload — the global feed only needs the headline,
 * not the field-by-field before/after (the per-company history page
 * surfaces those).
 */
function projectRow(doc) {
  if (!doc || typeof doc !== "object") return null;
  return {
    id: String(doc.id || ""),
    action: String(doc.action || ""),
    created_at: String(doc.created_at || ""),
    actor_email: doc.actor_email || null,
    actor_user_id: doc.actor_user_id || null,
    source: doc.source || null,
    request_id: doc.request_id || null,
    batch_id: doc.batch_id || null,
    company_id: doc.company_id && doc.company_id !== "_batch_summary" ? doc.company_id : null,
    // Per-company entries: list of changed field names (UI uses to render
    // "Company X edited" — count or first field if useful).
    changed_fields: Array.isArray(doc.changed_fields) ? doc.changed_fields : [],
    // Batch summary entries: structured payload describing the batch.
    summary: doc.summary && typeof doc.summary === "object" ? doc.summary : null,
  };
}

async function handleGet(req, context) {
  const container = await getCompanyEditHistoryContainer();
  if (!container) {
    return json(
      {
        ok: false,
        items: [],
        build_id: String(BUILD_INFO.build_id || ""),
        error: "Cosmos DB not configured",
      },
      503
    );
  }

  const limit = clampLimit(getQueryParam(req, "limit") || DEFAULT_LIMIT);

  // Query enough headroom that filtering out single-company batch-member
  // entries still leaves us with `limit` items. Worst case: a recent
  // bulk import of 20 companies adds 20 batch-member rows + 1 summary
  // — we filter out the 20 and keep the 1. Pull 4x as a safety margin.
  const overFetch = Math.min(MAX_LIMIT * 4, limit * 4);

  // The filter we want:
  //   - Batch summary rows (company_id = "_batch_summary") always
  //   - Per-company rows where batch_id is undefined
  // Pre-filter in SQL to keep RU spend small.
  const sql = `
    SELECT TOP @over c.id, c.company_id, c.action, c.created_at,
           c.actor_email, c.actor_user_id, c.source, c.request_id,
           c.batch_id, c.changed_fields, c.summary
    FROM c
    WHERE
      c.company_id = "_batch_summary"
      OR (NOT IS_DEFINED(c.batch_id) AND c.company_id != "_batch_summary")
    ORDER BY c.created_at DESC
  `;

  try {
    const { resources } = await container.items
      .query(
        { query: sql, parameters: [{ name: "@over", value: overFetch }] },
        { enableCrossPartitionQuery: true }
      )
      .fetchAll();

    const rows = Array.isArray(resources) ? resources : [];

    // Hydrate company_name for per-company rows (best-effort). Skip for
    // batch summaries — those carry their company list inside `summary`.
    const projected = rows.map(projectRow).filter(Boolean);

    // Already filtered in SQL, but defensively prune again client-side
    // (cheap; protects against stale rows that pre-date the filter).
    const filtered = projected.filter((r) => {
      if (r.company_id == null) return true; // batch summary
      return !r.batch_id; // per-company w/o batch_id
    });

    // Take top `limit`.
    const items = filtered.slice(0, limit);

    // Best-effort company-name lookup for per-company rows. One small
    // cross-partition query (id IN [...]) — the alternative of joining
    // in SQL has worse RU profile.
    const companyIds = [
      ...new Set(
        items
          .map((r) => r.company_id)
          .filter((v) => typeof v === "string" && v && v !== "_batch_summary")
      ),
    ];

    if (companyIds.length > 0) {
      try {
        const companiesClient = require("@azure/cosmos").CosmosClient
          ? require("../_cosmosConfig").getCosmosClient()
          : null;
        if (companiesClient) {
          const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
          const companiesId = (
            process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies"
          ).trim();
          const companies = companiesClient.database(databaseId).container(companiesId);

          // Cosmos doesn't support parameterized IN well via array; build
          // placeholders. Cap the lookup at MAX_LIMIT (100) so the progressive
          // disclosure expansion to 100 items still gets friendly names on
          // every row.
          const idsForQuery = companyIds.slice(0, MAX_LIMIT);
          const placeholders = idsForQuery
            .map((_, i) => `@id${i}`)
            .join(", ");
          const nameSql = `SELECT c.id, c.company_id, c.company_name, c.display_name FROM c WHERE c.id IN (${placeholders}) OR c.company_id IN (${placeholders})`;
          const nameParams = idsForQuery.flatMap((v, i) => [
            { name: `@id${i}`, value: v },
          ]);
          const { resources: nameRes } = await companies.items
            .query({ query: nameSql, parameters: nameParams }, { enableCrossPartitionQuery: true })
            .fetchAll();
          const byId = new Map();
          for (const c of nameRes || []) {
            const name =
              (typeof c.company_name === "string" && c.company_name.trim()) ||
              (typeof c.display_name === "string" && c.display_name.trim()) ||
              "";
            if (c.id) byId.set(String(c.id), name);
            if (c.company_id) byId.set(String(c.company_id), name);
          }
          for (const r of items) {
            if (r.company_id && byId.has(r.company_id)) {
              r.company_name = byId.get(r.company_id);
            }
          }
        }
      } catch (e) {
        // Non-fatal — the UI shows company_id when company_name is missing.
        context?.log?.(
          `[recent-activity] company-name lookup failed: ${e?.message || e}`
        );
      }
    }

    return json(
      {
        ok: true,
        items,
        build_id: String(BUILD_INFO.build_id || ""),
      },
      200
    );
  } catch (e) {
    context?.log?.("[recent-activity] query error", e?.message || e);
    return json(
      {
        ok: false,
        items: [],
        build_id: String(BUILD_INFO.build_id || ""),
        error: "Failed to load recent activity",
        detail: e?.message || String(e),
      },
      500
    );
  }
}

async function handlePost(req, context) {
  let body;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  if (!body || typeof body !== "object") body = {};

  const action = String(body.action || "").trim();
  if (!ALLOWED_SUMMARY_ACTIONS.has(action)) {
    return json(
      {
        ok: false,
        error: `action must be one of: ${[...ALLOWED_SUMMARY_ACTIONS].join(", ")}`,
      },
      400
    );
  }

  const { actor_email, actor_user_id } = extractActor(req);
  // Body-supplied actor_email overrides (the bulk-import frontend has
  // the user's email via getAdminUser and passes it explicitly so the
  // entry has provenance even when SWA principal isn't present).
  const bodyActorEmail = String(body.actor_email || body.actorEmail || "").trim();
  const bodyActorUserId = String(body.actor_user_id || body.actorUserId || "").trim();

  const result = await writeBatchSummaryEntry({
    action,
    actor_email: bodyActorEmail || actor_email || undefined,
    actor_user_id: bodyActorUserId || actor_user_id || undefined,
    request_id: String(body.request_id || body.requestId || "").trim() || undefined,
    batch_id: String(body.batch_id || body.batchId || "").trim() || undefined,
    source: String(body.source || "admin-ui").trim() || "admin-ui",
    summary: body.summary,
  });

  if (!result.ok) {
    context?.log?.("[recent-activity] write failed", result.error);
    return json({ ok: false, error: result.error || "write failed" }, 500);
  }

  return json({ ok: true, id: result.id }, 201);
}

async function handler(req, context) {
  const method = String(req?.method || "GET").toUpperCase();
  if (method === "OPTIONS") return json({ ok: true, items: [] }, 200);
  if (method === "GET") return handleGet(req, context);
  if (method === "POST") return handlePost(req, context);
  return json({ ok: false, error: "Method not allowed" }, 405);
}

const ROUTE = "xadmin-api-recent-activity";

if (!hasRoute(ROUTE)) {
  app.http("adminRecentActivity", {
    route: ROUTE,
    methods: ["GET", "POST", "OPTIONS"],
    authLevel: "anonymous",
    handler,
  });
}

module.exports = {
  handler,
  _test: { handleGet, handlePost, projectRow, ALLOWED_SUMMARY_ACTIONS },
};
