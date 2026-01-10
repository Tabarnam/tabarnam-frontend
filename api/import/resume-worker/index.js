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
} = require("../../_cosmosPartitionKey");

function cors(req) {
  const origin = req?.headers?.get?.("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers":
      "content-type,authorization,x-functions-key,x-request-id,x-correlation-id,x-session-id,x-client-request-id",
  };
}

function json(obj, status = 200, req) {
  return {
    status,
    headers: { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(obj),
  };
}

function nowIso() {
  return new Date().toISOString();
}

let companiesPkPathPromise;
async function getCompaniesPkPath(container) {
  if (!container) return "/normalized_domain";
  companiesPkPathPromise ||= getContainerPartitionKeyPath(container, "/normalized_domain");
  try {
    return await companiesPkPathPromise;
  } catch {
    return "/normalized_domain";
  }
}

async function readControlDoc(container, id, sessionId) {
  if (!container) return null;
  const containerPkPath = await getCompaniesPkPath(container);

  const docForCandidates = {
    id,
    session_id: sessionId,
    normalized_domain: "import",
    partition_key: "import",
    type: "import_control",
  };

  const candidates = buildPartitionKeyCandidates({
    doc: docForCandidates,
    containerPkPath,
    requestedId: id,
  });

  for (const partitionKeyValue of candidates) {
    try {
      const item =
        partitionKeyValue !== undefined
          ? container.item(id, partitionKeyValue)
          : container.item(id);
      const { resource } = await item.read();
      return resource || null;
    } catch (e) {
      if (e?.code === 404) return null;
    }
  }

  return null;
}

async function upsertDoc(container, doc) {
  if (!container || !doc) return { ok: false, error: "no_container" };
  const id = String(doc?.id || "").trim();
  if (!id) return { ok: false, error: "missing_id" };

  const containerPkPath = await getCompaniesPkPath(container);
  const candidates = buildPartitionKeyCandidates({ doc, containerPkPath, requestedId: id });

  let lastErr = null;
  for (const partitionKeyValue of candidates) {
    try {
      if (partitionKeyValue !== undefined) {
        await container.items.upsert(doc, { partitionKey: partitionKeyValue });
      } else {
        await container.items.upsert(doc);
      }
      return { ok: true };
    } catch (e) {
      lastErr = e;
    }
  }

  return { ok: false, error: lastErr?.message || String(lastErr || "upsert_failed") };
}

async function fetchSeedCompanies(container, sessionId, limit = 25) {
  if (!container) return [];
  const n = Math.max(1, Math.min(Number(limit) || 10, 50));

  const q = {
    query: `
      SELECT TOP ${n}
        c.id, c.company_name, c.name, c.url, c.website_url, c.normalized_domain,
        c.industries, c.product_keywords, c.keywords,
        c.headquarters_location, c.manufacturing_locations,
        c.curated_reviews, c.review_count, c.review_cursor,
        c.red_flag, c.red_flag_reason,
        c.hq_unknown, c.hq_unknown_reason,
        c.mfg_unknown, c.mfg_unknown_reason
      FROM c
      WHERE (c.session_id = @sid OR c.import_session_id = @sid)
        AND NOT STARTSWITH(c.id, '_import_')
        AND (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true)
      ORDER BY c.created_at DESC
    `,
    parameters: [{ name: "@sid", value: sessionId }],
  };

  const { resources } = await container.items
    .query(q, { enableCrossPartitionQuery: true })
    .fetchAll();

  return Array.isArray(resources) ? resources : [];
}

async function handler(req, context) {
  const method = String(req?.method || "").toUpperCase();
  if (method === "OPTIONS") return { status: 200, headers: cors(req) };
  if (method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405, req);

  const url = new URL(req.url);
  const noCosmosMode = String(url.searchParams.get("no_cosmos") || "").trim() === "1";
  const cosmosEnabled = !noCosmosMode;

  let body = {};
  try {
    if (typeof req?.json === "function") {
      body = (await req.json().catch(() => ({}))) || {};
    } else {
      const txt = await req.text();
      if (txt) body = JSON.parse(txt);
    }
  } catch {}

  const sessionId = String(body?.session_id || body?.sessionId || url.searchParams.get("session_id") || "").trim();
  if (!sessionId) return json({ ok: false, error: "Missing session_id" }, 200, req);

  if (!cosmosEnabled) {
    return json({ ok: false, session_id: sessionId, root_cause: "no_cosmos", retryable: false }, 200, req);
  }

  const endpoint = (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim();
  const key = (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim();
  const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
  const containerId = (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();

  if (!endpoint || !key || !CosmosClient) {
    return json(
      {
        ok: false,
        session_id: sessionId,
        root_cause: "cosmos_not_configured",
        retryable: false,
        message: "Cosmos client not available or credentials missing",
      },
      200,
      req
    );
  }

  const client = new CosmosClient({ endpoint, key });
  const container = client.database(databaseId).container(containerId);

  const resumeDocId = `_import_resume_${sessionId}`;
  const sessionDocId = `_import_session_${sessionId}`;

  const [resumeDoc, sessionDoc] = await Promise.all([
    readControlDoc(container, resumeDocId, sessionId),
    readControlDoc(container, sessionDocId, sessionId),
  ]);

  if (!resumeDoc) {
    return json({ ok: false, session_id: sessionId, root_cause: "missing_resume_doc", retryable: false }, 200, req);
  }

  const lockUntil = Date.parse(String(resumeDoc?.lock_expires_at || "")) || 0;
  if (lockUntil && Date.now() < lockUntil) {
    return json(
      {
        ok: true,
        session_id: sessionId,
        skipped: true,
        reason: "resume_locked",
        lock_expires_at: resumeDoc.lock_expires_at,
      },
      200,
      req
    );
  }

  const attempt = Number.isFinite(Number(resumeDoc?.attempt)) ? Number(resumeDoc.attempt) : 0;
  const thisLockExpiresAt = new Date(Date.now() + 60_000).toISOString();

  await upsertDoc(container, {
    ...resumeDoc,
    status: "running",
    attempt: attempt + 1,
    last_invoked_at: nowIso(),
    lock_expires_at: thisLockExpiresAt,
    updated_at: nowIso(),
  }).catch(() => null);

  const seedDocs = await fetchSeedCompanies(container, sessionId, 25).catch(() => []);
  const companies = seedDocs
    .map((d) => {
      const company_name = String(d?.company_name || d?.name || "").trim();
      const website_url = String(d?.website_url || d?.url || "").trim();
      const normalized_domain = String(d?.normalized_domain || "").trim();
      if (!company_name && !website_url) return null;

      return {
        id: d.id,
        company_name,
        website_url,
        url: String(d?.url || website_url).trim(),
        normalized_domain,
        industries: Array.isArray(d?.industries) ? d.industries : [],
        product_keywords: typeof d?.product_keywords === "string" ? d.product_keywords : "",
        keywords: Array.isArray(d?.keywords) ? d.keywords : [],
        headquarters_location: typeof d?.headquarters_location === "string" ? d.headquarters_location : "",
        manufacturing_locations: Array.isArray(d?.manufacturing_locations) ? d.manufacturing_locations : [],
        curated_reviews: Array.isArray(d?.curated_reviews) ? d.curated_reviews : [],
        review_count: typeof d?.review_count === "number" ? d.review_count : 0,
        review_cursor: d?.review_cursor && typeof d.review_cursor === "object" ? d.review_cursor : undefined,
        red_flag: Boolean(d?.red_flag),
        red_flag_reason: String(d?.red_flag_reason || "").trim(),
        hq_unknown: Boolean(d?.hq_unknown),
        hq_unknown_reason: String(d?.hq_unknown_reason || "").trim(),
        mfg_unknown: Boolean(d?.mfg_unknown),
        mfg_unknown_reason: String(d?.mfg_unknown_reason || "").trim(),
      };
    })
    .filter(Boolean);

  if (companies.length === 0) {
    await upsertDoc(container, {
      ...resumeDoc,
      status: "error",
      last_error: { code: "missing_seed_companies", message: "No saved company docs found for session" },
      lock_expires_at: null,
      updated_at: nowIso(),
    }).catch(() => null);

    return json(
      {
        ok: false,
        session_id: sessionId,
        root_cause: "missing_seed_companies",
        retryable: true,
      },
      200,
      req
    );
  }

  const request = sessionDoc?.request && typeof sessionDoc.request === "object" ? sessionDoc.request : {};

  const startBody = {
    session_id: sessionId,
    query: String(request?.query || "resume").trim() || "resume",
    queryTypes: Array.isArray(request?.queryTypes) ? request.queryTypes : [String(request?.queryType || "product_keyword")],
    location: typeof request?.location === "string" && request.location.trim() ? request.location.trim() : undefined,
    limit: Number.isFinite(Number(request?.limit)) ? Number(request.limit) : Math.min(25, companies.length),
    expand_if_few: true,
    dry_run: false,
    companies,
  };

  const base = new URL(req.url);
  const startUrl = new URL("/api/import/start", base.origin);
  startUrl.searchParams.set("skip_stages", "primary");
  startUrl.searchParams.set("max_stage", "expand");

  const startRes = await fetch(startUrl.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(startBody),
  }).catch((e) => ({ ok: false, status: 0, _error: e }));

  const startText = await (async () => {
    try {
      if (startRes && typeof startRes.text === "function") return await startRes.text();
    } catch {}
    return "";
  })();

  const startJson = (() => {
    try {
      return startText ? JSON.parse(startText) : null;
    } catch {
      return null;
    }
  })();

  const ok = Boolean(startRes?.ok) && Boolean(startJson?.ok !== false);

  await upsertDoc(container, {
    ...resumeDoc,
    status: ok ? "triggered" : "error",
    last_trigger_result: {
      ok: Boolean(ok),
      status: Number(startRes?.status || 0) || 0,
      stage_beacon: startJson?.stage_beacon || null,
      resume_needed: Boolean(startJson?.resume_needed),
    },
    lock_expires_at: null,
    updated_at: nowIso(),
  }).catch(() => null);

  return json(
    {
      ok: true,
      session_id: sessionId,
      triggered: true,
      companies_seeded: companies.length,
      import_start_status: Number(startRes?.status || 0) || 0,
      import_start_ok: Boolean(startRes?.ok),
      import_start_body: startJson || (startText ? { text: startText.slice(0, 2000) } : null),
    },
    200,
    req
  );
}

app.http("import-resume-worker", {
  route: "import/resume-worker",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler,
});

module.exports = { _test: { handler } };
