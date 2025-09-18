// Azure Functions v4 HTTP: POST /api/save-import-log
import { app } from "@azure/functions";
import { CosmosClient } from "@azure/cosmos";

app.http("saveImportLog", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "save-import-log",
  handler: async (req) => {
    if (req.method === "OPTIONS") return { status: 204, headers: cors(req) };

    let body = {};
    try { body = await req.json(); } catch {}
    // Accept either {results: [...]} or a single result object.
    const results = Array.isArray(body?.results) ? body.results : [body].filter(Boolean);
    if (!results.length) return json({ error: "No results provided" }, 400, req);

    const endpoint = process.env.COSMOS_DB_ENDPOINT;
    const key = process.env.COSMOS_DB_KEY;
    const databaseId = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
    const companiesContainerId = process.env.COSMOS_DB_CONTAINER || "companies";
    const logsContainerId = process.env.IMPORT_LOGS_CONTAINER || "import_logs";
    const pkPath = process.env.COSMOS_PARTITION_KEY || "/normalized_domain";

    if (!endpoint || !key) return json({ error: "Server not configured (COSMOS_DB_ENDPOINT / COSMOS_DB_KEY)" }, 500, req);

    const client = new CosmosClient({ endpoint, key });
    const { database } = await client.databases.createIfNotExists({ id: databaseId });
    const { container: companies } = await database.containers.createIfNotExists({
      id: companiesContainerId,
      partitionKey: { kind: "Hash", paths: [pkPath] }
    });
    const { container: importLogs } = await database.containers.createIfNotExists({
      id: logsContainerId,
      partitionKey: { kind: "Hash", paths: ["/batch"] }
    });

    const outputs = [];
    for (const r of results) {
      // 1) upsert the log
      const logDoc = {
        id: String(r.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`),
        batch: String(new Date().toISOString().slice(0, 10)), // simple partition
        status: r.status || "Unknown",
        company: r.company || null,
        log: r.log || null,
        _ts: new Date().toISOString()
      };
      try { await importLogs.items.upsert(logDoc); }
      catch (e) { outputs.push({ id: logDoc.id, ok: false, error: "log_upsert_failed: " + e.message }); continue; }

      // 2) if logo_url is present, patch the company doc
      let patched = null;
      const logo = r?.company?.logo_url;
      const homepage = r?.company?.website_url || r?.company?.url;
      const providedND = r?.company?.normalized_domain || normalizeDomain(homepage);
      const companyId = r?.company?.id || null;

      if (logo && providedND) {
        try {
          let targetId = companyId;
          if (!targetId) {
            // Find a doc by normalized_domain if id is unknown
            const query = {
              query: "SELECT TOP 1 c.id FROM c WHERE c.normalized_domain = @nd",
              parameters: [{ name: "@nd", value: providedND }]
            };
            const { resources } = await companies.items.query(query, { maxItemCount: 1 }).fetchAll();
            targetId = resources?.[0]?.id || null;
          }

          if (targetId) {
            // Use patch (requires id + partition key)
            await companies.item(targetId, providedND).patch([
              { op: "set", path: "/logo_url", value: logo },
              { op: "set", path: "/_updated_at", value: new Date().toISOString() }
            ]);
            patched = { id: targetId, nd: providedND };
          }
        } catch (e) {
          outputs.push({ id: logDoc.id, ok: true, log_upsert: true, logo_patched: false, error: "patch_failed: " + e.message });
          continue;
        }
      }
      outputs.push({ id: logDoc.id, ok: true, log_upsert: true, logo_patched: !!patched });
    }

    return json({ ok: true, results: outputs }, 200, req);
  }
});

function normalizeDomain(u) {
  if (!u) return "";
  try {
    const url = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`);
    let host = url.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    return host;
  } catch { return ""; }
}

function cors(req) {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}
function json(obj, status = 200, req) {
  return { status, headers: { ...cors(req), "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
