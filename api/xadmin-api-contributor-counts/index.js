// GET /api/xadmin-api-contributor-counts
//
// How many companies are currently assigned to each CONTRIBUTOR, so an admin
// can see the outstanding workload at a glance instead of filtering to find it.
//
// Contributors only — staff counts are deliberately omitted. Jon, Ben and Kels
// own thousands of rows between them and the number carries no signal; the
// question this answers is "how much work is sitting with outside help".
//
// Admin-only: contributors don't see the person filter at all, and telling one
// contributor how much another has would be pointless.
//
// One GROUP BY query, not one per person, so adding contributors doesn't add
// round trips.

const { app, hasRoute } = require("../_app");
const { getBuildInfo } = require("../_buildInfo");
const { withAdminGuard, getContributorEmails } = require("../_adminAuth");

const BUILD_INFO = getBuildInfo();
const HANDLER_ID = "xadmin-api-contributor-counts";

// MUST match the row filters admin-companies-v2 applies to its list and count,
// or the badge will disagree with what the admin sees after clicking through.
const ROW_FILTERS = [
  "(NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true)",
  "NOT STARTSWITH(c.id, '_import_')",
  "NOT STARTSWITH(c.id, 'refresh_job_')",
  "(NOT IS_DEFINED(c.type) OR c.type != 'import_control')",
].join(" AND ");

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

function getCompaniesContainer() {
  try {
    const client = require("../_cosmosConfig").getCosmosClient();
    if (!client) return null;
    const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
    const containerId = (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();
    return client.database(databaseId).container(containerId);
  } catch {
    return null;
  }
}

async function handleGet(req, context, deps = {}) {
  const contributors = (deps.contributors || getContributorEmails())
    .map((e) => String(e || "").trim().toLowerCase())
    .filter(Boolean);

  // No contributors configured — the tier is dormant, so there is nothing to
  // count and no reason to touch Cosmos.
  if (contributors.length === 0) {
    return json({ ok: true, counts: {}, contributors: [] });
  }

  const container = deps.container || getCompaniesContainer();
  if (!container) {
    return json({ ok: false, counts: {}, error: "Cosmos DB not configured" }, 503);
  }

  const parameters = contributors.map((email, i) => ({ name: `@e${i}`, value: email }));
  const placeholders = parameters.map((p) => p.name).join(", ");

  const query = `
    SELECT c.owner AS owner, COUNT(1) AS n
    FROM c
    WHERE ${ROW_FILTERS}
      AND IS_DEFINED(c.owner)
      AND c.owner IN (${placeholders})
    GROUP BY c.owner
  `;

  try {
    const { resources } = await container.items
      .query({ query, parameters }, { enableCrossPartitionQuery: true })
      .fetchAll();

    // Seed every contributor at zero. A person with no companies must report 0
    // rather than being absent — "no badge" and "badge showing 0" mean
    // different things to whoever is handing out work.
    const counts = Object.fromEntries(contributors.map((e) => [e, 0]));

    for (const row of Array.isArray(resources) ? resources : []) {
      const owner = String(row?.owner || "").trim().toLowerCase();
      if (owner && owner in counts) counts[owner] = Number(row.n) || 0;
    }

    return json({ ok: true, counts, contributors, build_id: String(BUILD_INFO.build_id || "") });
  } catch (e) {
    try {
      context?.log?.("[contributor-counts] query failed", { error: e?.message });
    } catch {}
    // Non-fatal for the caller: the dropdown simply renders without badges.
    return json({ ok: false, counts: {}, error: "query_failed" }, 500);
  }
}

async function handler(req, context, deps = {}) {
  const method = String(req?.method || "GET").toUpperCase();
  if (method === "OPTIONS") return json({ ok: true });
  if (method !== "GET") return json({ ok: false, error: "Method not allowed" }, 405);
  return handleGet(req, context, deps);
}

const ROUTE = "xadmin-api-contributor-counts";

if (!hasRoute(ROUTE)) {
  app.http("xadminApiContributorCounts", {
    route: ROUTE,
    methods: ["GET", "OPTIONS"],
    authLevel: "anonymous",
    handler: withAdminGuard(handler),
  });
}

module.exports = { handler, _test: { handleGet, ROW_FILTERS } };
