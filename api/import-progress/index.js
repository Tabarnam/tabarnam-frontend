// api/import-progress/index.js
import { app } from "@azure/functions";
import { CosmosClient } from "@azure/cosmos";

const cors = (req) => {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
};
const json = (obj, status = 200, req) => ({
  status,
  headers: { ...cors(req), "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});

app.http("importProgress", {
  route: "import/progress",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    if (req.method === "OPTIONS") return { status: 204, headers: cors(req) };

    const jobId = new URL(req.url).searchParams.get("jobId");
    if (!jobId) return json({ error: "jobId is required" }, 400, req);

    const endpoint   = (process.env.COSMOS_DB_ENDPOINT || "").trim();
    const key        = (process.env.COSMOS_DB_KEY || "").trim();
    const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
    const containerId= (process.env.COSMOS_DB_LOGS_CONTAINER || "import_logs").trim();

    if (!endpoint || !key) return json({ error: "Cosmos not configured" }, 500, req);

    const client    = new CosmosClient({ endpoint, key });
    const container = client.database(databaseId).container(containerId);

    try {
      // last log for this job/session
      const q = {
        query: `
          SELECT TOP 1 c.id, c.step, c.msg, c.ts, c.saved, c.page
          FROM c
          WHERE c.session_id = @sid
          ORDER BY c._ts DESC
        `,
        parameters: [{ name: "@sid", value: jobId }],
      };
      const { resources } = await container.items.query(q, { enableCrossPartitionQuery: true }).fetchAll();
      const last = resources?.[0] || null;
      return json({ ok: true, jobId, last }, 200, req);
    } catch (e) {
      return json({ error: "query failed", detail: e?.message || String(e) }, 500, req);
    }
  },
});
