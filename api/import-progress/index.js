// api/import-progress/index.js
import { app } from "@azure/functions";
import { CosmosClient } from "@azure/cosmos";

const getEnv = (k, d = "") => (process.env[k] ?? d);

function cors(req) {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}
function json(obj, status, req) {
  return {
    status,
    headers: { ...cors(req), "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

function getCosmos() {
  const endpoint    = getEnv("COSMOS_DB_ENDPOINT");
  const key         = getEnv("COSMOS_DB_KEY");
  const databaseId  = getEnv("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = getEnv("COSMOS_DB_CONTAINER", "companies_ingest");
  const logsId      = getEnv("COSMOS_DB_LOGS_CONTAINER", "import_logs");
  if (!endpoint || !key) return null;

  const client = new CosmosClient({ endpoint, key });
  const db = client.database(databaseId);
  return {
    client,
    db,
    container: db.container(containerId),
    logs: db.container(logsId),
  };
}

app.http("importProgress", {
  route: "import-progress",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    if (req.method === "OPTIONS") return { status: 204, headers: cors(req) };

    const url   = new URL(req.url);
    const sid   = url.searchParams.get("session_id") || url.searchParams.get("sessionId") || "";
    const take  = Math.min(Math.max(parseInt(url.searchParams.get("take") || "200", 10) || 200, 1), 1000);
    const since = url.searchParams.get("since") || ""; // ISO

    const cos = getCosmos();
    if (!cos) return json({ error: "Cosmos not configured" }, 500, req);

    try {
      // -------- (1) Companies (kept behavior) --------
      let query;
      let params = [{ name: "@take", value: take }];

      if (sid) {
        if (since) {
          query = `
            SELECT TOP @take c.id, c.company_name, c.industries, c.url, c.amazon_url,
                   c.created_at, c.session_id
            FROM c
            WHERE ISDEFINED(c.session_id) AND c.session_id = @sid
              AND ISDEFINED(c.created_at) AND c.created_at > @since
            ORDER BY c.created_at ASC
          `;
          params.push({ name: "@sid", value: sid }, { name: "@since", value: since });
        } else {
          query = `
            SELECT TOP @take c.id, c.company_name, c.industries, c.url, c.amazon_url,
                   c.created_at, c.session_id
            FROM c
            WHERE ISDEFINED(c.session_id) AND c.session_id = @sid
            ORDER BY c.created_at ASC
          `;
          params.push({ name: "@sid", value: sid });
        }
      } else {
        query = `
          SELECT TOP @take c.id, c.company_name, c.industries, c.url, c.amazon_url,
                 c.created_at, c.session_id
          FROM c
          WHERE ISDEFINED(c.created_at)
          ORDER BY c.created_at DESC
        `;
      }

      let { resources } = await cos.container.items
        .query({ query, parameters: params }, { enableCrossPartitionQuery: true })
        .fetchAll();

      // UX fallback: if a session filter returns nothing on a fresh run, show latest rows
      if (sid && !since && (!resources || resources.length === 0)) {
        const rFb = await cos.container.items.query({
          query: `
            SELECT TOP @take c.id, c.company_name, c.industries, c.url, c.amazon_url,
                   c.created_at, c.session_id
            FROM c
            ORDER BY c._ts DESC
          `,
          parameters: [{ name: "@take", value: take }],
        }, { enableCrossPartitionQuery: true }).fetchAll();
        resources = rFb.resources || [];
      }

      // -------- (2) NEW: recent steps + stopped flag from import_logs --------
      let steps = [];
      let stopped = false;

      if (sid) {
        try {
          const { resources: logRows } = await cos.logs.items
            .query({
              query: `
                SELECT TOP 10 l.step, l.msg, l.saved, l.mode, l.expanded, l.ts, l._ts
                FROM l
                WHERE l.session_id = @sid
                ORDER BY l._ts DESC
              `,
              parameters: [{ name: "@sid", value: sid }],
            }, { enableCrossPartitionQuery: true })
            .fetchAll();

          steps = logRows || [];
          stopped = steps.some((s) => s?.step === "done");
        } catch (e) {
          // Non-fatal: if logs container/partitioning differs locally, just skip steps
          ctx.log(`import-progress: logs query skipped: ${e?.message || e}`);
        }
      }

      return json({ items: resources || [], count: (resources || []).length, steps, stopped }, 200, req);
    } catch (e) {
      ctx.log.error(`import-progress error: ${e?.stack || e?.message || e}`);
      return json({ error: e?.message || "query failed" }, 500, req);
    }
  },
});
