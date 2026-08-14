// GET /api/xadmin-api-audit-actors
//
// Everyone who has EVER written to the activity log, whether or not they still
// have access.
//
// The audit log's person filter used to be built from the live roster, which
// meant a contributor's name vanished from the filter the moment they were
// removed from CONTRIBUTOR_EMAILS — while their entries stayed in the log,
// now unreachable through the UI. An audit trail you cannot filter by the
// person who left is the audit trail you most needed.
//
// The entries themselves were never at risk: actor_email is stamped onto each
// history document at write time and read straight back, never resolved
// against the roster. This endpoint only restores the ability to FIND them.
//
// COST: a DISTINCT over the whole container. The composite index on
// (actor_email, created_at) from migration 0003 means it is served from the
// index rather than by reading documents, and the result is cached in-worker,
// so the real-world cost is one indexed scan per worker per TTL.

const { app, hasRoute } = require("../_app");
const { getBuildInfo } = require("../_buildInfo");
const { getCompanyEditHistoryContainer } = require("../_companyEditHistory");
const { withAdminGuard } = require("../_adminAuth");

const BUILD_INFO = getBuildInfo();
const HANDLER_ID = "xadmin-api-audit-actors";

// The set of people who have ever acted changes on the order of months. A long
// TTL is correct; someone new appears in the filter within the hour.
const CACHE_TTL_MS = 60 * 60 * 1000;

let cache = { actors: null, at: 0 };

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

function isFresh(now) {
  return Array.isArray(cache.actors) && now - cache.at < CACHE_TTL_MS;
}

async function handleGet(req, context, deps = {}) {
  const now = typeof deps.now === "number" ? deps.now : Date.now();
  const force = String(deps.force || "").trim() === "1";

  if (!force && isFresh(now)) {
    return json({ ok: true, actors: cache.actors, cached: true });
  }

  const container = deps.container || (await getCompanyEditHistoryContainer());
  if (!container) {
    // Serve a stale list rather than none — an unreachable container should not
    // make people disappear from the filter.
    if (Array.isArray(cache.actors)) {
      return json({ ok: true, actors: cache.actors, cached: true, stale: true });
    }
    return json({ ok: false, actors: [], error: "Cosmos DB not configured" }, 503);
  }

  try {
    const { resources } = await container.items
      .query(
        {
          query:
            "SELECT DISTINCT VALUE c.actor_email FROM c WHERE IS_DEFINED(c.actor_email) AND c.actor_email != null",
        },
        { enableCrossPartitionQuery: true }
      )
      .fetchAll();

    const actors = [
      ...new Set(
        (Array.isArray(resources) ? resources : [])
          .map((v) => String(v || "").trim().toLowerCase())
          .filter(Boolean)
      ),
    ].sort();

    cache = { actors, at: now };

    return json({ ok: true, actors, cached: false });
  } catch (e) {
    try {
      context?.log?.("[audit-actors] query failed", { error: e?.message });
    } catch {}

    if (Array.isArray(cache.actors)) {
      return json({ ok: true, actors: cache.actors, cached: true, stale: true });
    }
    return json({ ok: false, actors: [], error: "query_failed" }, 500);
  }
}

async function handler(req, context, deps = {}) {
  const method = String(req?.method || "GET").toUpperCase();
  if (method === "OPTIONS") return json({ ok: true, actors: [] });
  if (method !== "GET") return json({ ok: false, error: "Method not allowed" }, 405);
  return handleGet(req, context, deps);
}

const ROUTE = "xadmin-api-audit-actors";

if (!hasRoute(ROUTE)) {
  app.http("xadminApiAuditActors", {
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
    CACHE_TTL_MS,
    __resetCache: () => {
      cache = { actors: null, at: 0 };
    },
  },
};
