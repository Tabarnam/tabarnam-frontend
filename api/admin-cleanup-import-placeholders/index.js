let app;
try {
  ({ app } = require("@azure/functions"));
} catch {
  app = { http() {} };
}

let CosmosClient;
try {
  ({ CosmosClient } = require("@azure/cosmos"));
} catch {
  CosmosClient = null;
}

const {
  getContainerPartitionKeyPath,
  buildPartitionKeyCandidates,
} = require("../_cosmosPartitionKey");

function env(key, fallback = "") {
  const v = process.env[key];
  return (v == null ? fallback : String(v)).trim();
}

function json(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-functions-key",
    },
    body: JSON.stringify(obj),
  };
}

async function readJson(req) {
  if (!req) return {};

  if (typeof req.json === "function") {
    try {
      const val = await req.json();
      return val && typeof val === "object" ? val : {};
    } catch {
      // fall through
    }
  }

  if (typeof req.text === "function") {
    const text = String(await req.text()).trim();
    if (!text) return {};
    return JSON.parse(text);
  }

  if (typeof req.body === "string" && req.body.trim()) {
    return JSON.parse(req.body);
  }

  return req.body && typeof req.body === "object" ? req.body : {};
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.trunc(n);
}

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (!v) return fallback;
    if (["1", "true", "yes", "y", "on"].includes(v)) return true;
    if (["0", "false", "no", "n", "off"].includes(v)) return false;
  }
  return fallback;
}

function getCompaniesContainer() {
  const endpoint = env("COSMOS_DB_ENDPOINT") || env("COSMOS_ENDPOINT");
  const key = env("COSMOS_DB_KEY") || env("COSMOS_KEY");
  const database = env("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = env("COSMOS_DB_COMPANIES_CONTAINER", "companies");

  if (!endpoint || !key) return null;
  if (!CosmosClient) return null;

  const client = new CosmosClient({ endpoint, key });
  return client.database(database).container(containerId);
}

function buildCleanupQuery({ sessionId }) {
  const where = [
    "(NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true)",
    "((IS_DEFINED(c.created_at) AND c.created_at >= @cutoff) OR (IS_DEFINED(c.updated_at) AND c.updated_at >= @cutoff))",
    "(STARTSWITH(c.id, '_import_') OR (IS_DEFINED(c.type) AND c.type = 'import_control') OR ((IS_DEFINED(c.source) AND (c.source = 'admin_import' OR c.source = 'manual_import' OR c.source = 'xai_import')) AND ((NOT IS_DEFINED(c.company_name) OR c.company_name = '') OR (NOT IS_DEFINED(c.website_url) OR c.website_url = '') OR (NOT IS_DEFINED(c.url) OR c.url = ''))))",
  ];

  const parameters = [{ name: "@cutoff", value: "" }];

  if (sessionId) {
    where.push("c.session_id = @sid");
    parameters.push({ name: "@sid", value: sessionId });
  }

  const sql = `SELECT c.id, c.session_id, c.type, c.source, c.company_name, c.name, c.website_url, c.url, c.normalized_domain, c.partition_key, c.created_at, c.updated_at FROM c WHERE ${where.join(
    " AND "
  )} ORDER BY c._ts DESC`;

  return { sql, parameters };
}

async function deleteDocWithPkCandidates({ container, containerPkPath, doc, context }) {
  const candidates = buildPartitionKeyCandidates({
    doc,
    containerPkPath,
    requestedId: doc?.id,
  });

  for (const partitionKeyValue of candidates) {
    try {
      await container.item(doc.id, partitionKeyValue).delete();
      return { ok: true, partitionKeyValue };
    } catch {
      // continue
    }
  }

  context?.log?.("[admin-cleanup-import-placeholders] delete failed", {
    id: doc?.id,
    candidateCount: candidates.length,
  });
  return { ok: false, candidateCount: candidates.length };
}

async function cleanupHandler(req, context) {
  const method = String(req?.method || "POST").toUpperCase();
  if (method === "OPTIONS") return json({ ok: true }, 200);
  if (method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const body = await readJson(req).catch((e) => {
    return { __parse_error: e?.message || String(e) };
  });

  if (body && body.__parse_error) {
    return json({ ok: false, error: "Invalid JSON", detail: body.__parse_error }, 400);
  }

  const hours = toPositiveInt(body?.hours ?? req?.query?.hours ?? 6, 6);
  const dry_run = parseBoolean(body?.dry_run ?? body?.dryRun ?? req?.query?.dry_run ?? req?.query?.dryRun, false);
  const sessionId = String(body?.session_id || body?.sessionId || req?.query?.session_id || req?.query?.sessionId || "").trim();

  const cutoffMs = Date.now() - Math.max(0, hours) * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  const container = getCompaniesContainer();
  if (!container) {
    return json({ ok: false, error: "Cosmos DB not configured" }, 503);
  }

  const containerPkPath = await getContainerPartitionKeyPath(container, "/normalized_domain").catch(() => "/normalized_domain");

  const { sql, parameters } = buildCleanupQuery({ sessionId });
  parameters[0].value = cutoffIso;

  context?.log?.("[admin-cleanup-import-placeholders] starting", {
    hours,
    cutoffIso,
    dry_run,
    sessionId: sessionId || null,
    containerPkPath,
  });

  let resources = [];
  try {
    const res = await container.items
      .query({ query: sql, parameters }, { enableCrossPartitionQuery: true })
      .fetchAll();
    resources = Array.isArray(res?.resources) ? res.resources : [];
  } catch (e) {
    context?.log?.("[admin-cleanup-import-placeholders] query failed", { message: e?.message || String(e) });
    return json({ ok: false, error: "Query failed", detail: e?.message || String(e) }, 500);
  }

  const matched = resources.length;
  if (dry_run) {
    return json({
      ok: true,
      dry_run: true,
      hours,
      cutoff_iso: cutoffIso,
      session_id: sessionId || null,
      matched,
      items: resources,
    });
  }

  let deleted = 0;
  const failures = [];

  for (const doc of resources) {
    const result = await deleteDocWithPkCandidates({ container, containerPkPath, doc, context });
    if (result.ok) {
      deleted++;
      continue;
    }
    failures.push({ id: doc?.id, candidateCount: result.candidateCount || 0 });
  }

  context?.log?.("[admin-cleanup-import-placeholders] completed", {
    matched,
    deleted,
    failures: failures.length,
  });

  return json({
    ok: failures.length === 0,
    hours,
    cutoff_iso: cutoffIso,
    session_id: sessionId || null,
    matched,
    deleted,
    failures,
  }, failures.length ? 500 : 200);
}

app.http("admin-cleanup-import-placeholders", {
  route: "admin/cleanup-import-placeholders",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: cleanupHandler,
});

module.exports = {
  _test: {
    buildCleanupQuery,
    cleanupHandler,
  },
};
