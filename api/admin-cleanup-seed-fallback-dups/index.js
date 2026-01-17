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

function toPositiveInt(value, fallback, { min = 0, max = 5000 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const t = Math.trunc(n);
  return Math.max(min, Math.min(t, max));
}

function nowIso() {
  return new Date().toISOString();
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

function isMeaningfulString(value) {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) return false;
  if (s.toLowerCase() === "unknown") return false;
  return true;
}

function normalizeStringList(value) {
  const list = Array.isArray(value) ? value : [];
  return Array.from(
    new Set(
      list
        .map((v) => (typeof v === "string" ? v.trim() : ""))
        .filter((v) => isMeaningfulString(v))
    )
  );
}

function mergeCuratedReviews(base, incoming) {
  const a = Array.isArray(base) ? base : [];
  const b = Array.isArray(incoming) ? incoming : [];
  const out = [];
  const seen = new Set();

  for (const r of a.concat(b)) {
    if (!r || typeof r !== "object") continue;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    const url = typeof r.source_url === "string" ? r.source_url.trim() : typeof r.url === "string" ? r.url.trim() : "";
    const key = (id || url || "").toLowerCase();
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(r);
  }

  return out;
}

function scoreCompanyDoc(doc) {
  const d = doc && typeof doc === "object" ? doc : {};

  let score = 0;

  const industries = normalizeStringList(d.industries);
  const hasIndustries = industries.length > 0;

  const keywordsStr = typeof d.product_keywords === "string" ? d.product_keywords.trim() : "";
  const keywordsArr = normalizeStringList(d.keywords);
  const hasKeywords = isMeaningfulString(keywordsStr) || keywordsArr.length > 0;

  const hasHq = isMeaningfulString(d.headquarters_location) || Boolean(d.hq_unknown);
  const mfg = normalizeStringList(d.manufacturing_locations);
  const hasMfg = mfg.length > 0 || Boolean(d.mfg_unknown);

  if (isMeaningfulString(d.company_name) || isMeaningfulString(d.name)) score += 5;
  if (isMeaningfulString(d.website_url) || isMeaningfulString(d.url) || isMeaningfulString(d.canonical_url)) score += 2;

  if (hasIndustries) score += 5;
  if (hasKeywords) score += 5;
  if (hasHq) score += 4;
  if (hasMfg) score += 4;

  const curated = Array.isArray(d.curated_reviews) ? d.curated_reviews : [];
  if (curated.length > 0) score += 1;

  if (isMeaningfulString(d.logo_url)) score += 1;

  if (typeof d.updated_at === "string" && d.updated_at.trim()) score += 0.1;

  return score;
}

function mergeBestFields(canonical, other) {
  const base = canonical && typeof canonical === "object" ? canonical : {};
  const src = other && typeof other === "object" ? other : {};

  const out = { ...base };

  // Strings: only fill if missing/placeholder.
  if (!isMeaningfulString(out.company_name) && isMeaningfulString(src.company_name)) out.company_name = src.company_name;
  if (!isMeaningfulString(out.name) && isMeaningfulString(src.name)) out.name = src.name;
  if (!isMeaningfulString(out.website_url) && isMeaningfulString(src.website_url)) out.website_url = src.website_url;
  if (!isMeaningfulString(out.url) && isMeaningfulString(src.url)) out.url = src.url;
  if (!isMeaningfulString(out.canonical_url) && isMeaningfulString(src.canonical_url)) out.canonical_url = src.canonical_url;

  if (!isMeaningfulString(out.tagline) && isMeaningfulString(src.tagline)) out.tagline = src.tagline;

  if (!isMeaningfulString(out.headquarters_location) && isMeaningfulString(src.headquarters_location)) {
    out.headquarters_location = src.headquarters_location;
    if (out.hq_unknown) out.hq_unknown = false;
    if (out.hq_unknown_reason) out.hq_unknown_reason = "";
  }

  if (!Array.isArray(out.manufacturing_locations) || normalizeStringList(out.manufacturing_locations).length === 0) {
    const nextMfg = normalizeStringList(src.manufacturing_locations);
    if (nextMfg.length > 0) {
      out.manufacturing_locations = nextMfg;
      if (out.mfg_unknown) out.mfg_unknown = false;
      if (out.mfg_unknown_reason) out.mfg_unknown_reason = "";
    }
  } else {
    const mergedMfg = normalizeStringList(out.manufacturing_locations).concat(normalizeStringList(src.manufacturing_locations));
    out.manufacturing_locations = Array.from(new Set(mergedMfg));
  }

  // Arrays: merge unique meaningful values.
  const mergedIndustries = normalizeStringList(out.industries).concat(normalizeStringList(src.industries));
  if (mergedIndustries.length > 0) out.industries = Array.from(new Set(mergedIndustries));

  const mergedKeywords = normalizeStringList(out.keywords).concat(normalizeStringList(src.keywords));
  if (mergedKeywords.length > 0) out.keywords = Array.from(new Set(mergedKeywords));

  // product_keywords: keep the longer meaningful string.
  const a = typeof out.product_keywords === "string" ? out.product_keywords.trim() : "";
  const b = typeof src.product_keywords === "string" ? src.product_keywords.trim() : "";
  if (isMeaningfulString(b) && (!isMeaningfulString(a) || b.length > a.length)) out.product_keywords = b;

  // Reviews: union.
  out.curated_reviews = mergeCuratedReviews(out.curated_reviews, src.curated_reviews);

  // Logo: only fill if missing.
  if (!isMeaningfulString(out.logo_url) && isMeaningfulString(src.logo_url)) {
    out.logo_url = src.logo_url;
    if (typeof src.logo_status === "string") out.logo_status = src.logo_status;
    if (typeof src.logo_stage_status === "string") out.logo_stage_status = src.logo_stage_status;
  }

  // Missing fields bookkeeping: if either doc says missing, keep union.
  const missing = Array.isArray(out.import_missing_fields) ? out.import_missing_fields : [];
  const missing2 = Array.isArray(src.import_missing_fields) ? src.import_missing_fields : [];
  const mergedMissing = Array.from(new Set(missing.concat(missing2).map((v) => String(v || "").trim()).filter(Boolean)));
  if (mergedMissing.length > 0) out.import_missing_fields = mergedMissing;

  return out;
}

async function upsertDocWithPkCandidates({ container, containerPkPath, doc }) {
  const candidates = buildPartitionKeyCandidates({ doc, containerPkPath, requestedId: doc?.id });
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

  return { ok: false, error: lastErr?.message || String(lastErr || "upsert_failed"), candidateCount: candidates.length };
}

async function cleanupHandler(req, context) {
  const method = String(req?.method || "POST").toUpperCase();
  if (method === "OPTIONS") return json({ ok: true }, 200);
  if (method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const body = await readJson(req).catch((e) => ({ __parse_error: e?.message || String(e) }));
  if (body && body.__parse_error) return json({ ok: false, error: "Invalid JSON", detail: body.__parse_error }, 400);

  const dry_run = parseBoolean(body?.dry_run ?? body?.dryRun, true);

  const domainPrefix = String(body?.domain_prefix ?? body?.domainPrefix ?? "seed-fallback-dup").trim().toLowerCase();
  const exactDomain = String(body?.normalized_domain ?? body?.normalizedDomain ?? "").trim().toLowerCase();

  const processAll = parseBoolean(body?.process_all ?? body?.processAll, false);
  const sinceHours = toPositiveInt(body?.since_hours ?? body?.sinceHours, 0, { min: 0, max: 24 * 365 });

  const maxDocs = toPositiveInt(body?.max_docs ?? body?.maxDocs, 2000, { min: 1, max: 20000 });
  const maxGroups = toPositiveInt(body?.max_groups ?? body?.maxGroups, 100, { min: 1, max: 2000 });

  if (!processAll && !exactDomain && !domainPrefix) {
    return json({ ok: false, error: "Provide domain_prefix or normalized_domain, or set process_all=true" }, 400);
  }

  const container = getCompaniesContainer();
  if (!container) return json({ ok: false, error: "Cosmos DB not configured" }, 503);

  const containerPkPath = await getContainerPartitionKeyPath(container, "/normalized_domain").catch(() => "/normalized_domain");

  const where = [
    "(NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true)",
    "NOT STARTSWITH(c.id, '_import_')",
    "IS_DEFINED(c.normalized_domain)",
    "c.normalized_domain != 'unknown'",
  ];

  const parameters = [];

  if (exactDomain) {
    where.push("LOWER(c.normalized_domain) = @exact");
    parameters.push({ name: "@exact", value: exactDomain });
  } else if (domainPrefix) {
    where.push("STARTSWITH(LOWER(c.normalized_domain), @prefix)");
    parameters.push({ name: "@prefix", value: domainPrefix });
  }

  if (sinceHours > 0) {
    const cutoffIso = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();
    where.push("((IS_DEFINED(c.updated_at) AND c.updated_at >= @cutoff) OR (IS_DEFINED(c.created_at) AND c.created_at >= @cutoff))");
    parameters.push({ name: "@cutoff", value: cutoffIso });
  }

  const q = {
    query: `SELECT TOP ${maxDocs} c.id, c.normalized_domain, c.created_at, c.updated_at, c.source, c.company_name, c.name, c.website_url, c.url, c.canonical_url FROM c WHERE ${where.join(
      " AND "
    )} ORDER BY c._ts DESC`,
    parameters,
  };

  let resources = [];
  try {
    const res = await container.items.query(q, { enableCrossPartitionQuery: true }).fetchAll();
    resources = Array.isArray(res?.resources) ? res.resources : [];
  } catch (e) {
    context?.log?.("[admin-cleanup-seed-fallback-dups] query failed", { message: e?.message || String(e) });
    return json({ ok: false, error: "Query failed", detail: e?.message || String(e) }, 500);
  }

  const byDomain = new Map();
  for (const row of resources) {
    const d = String(row?.normalized_domain || "").trim().toLowerCase();
    if (!d || d === "unknown") continue;
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d).push(row);
  }

  const dupDomains = Array.from(byDomain.entries())
    .filter(([, rows]) => rows.length > 1)
    .map(([d, rows]) => ({ normalized_domain: d, count: rows.length, ids: rows.map((r) => r.id) }))
    .slice(0, maxGroups);

  if (dupDomains.length === 0) {
    return json({
      ok: true,
      dry_run,
      matched_docs: resources.length,
      duplicate_domains: 0,
      processed_domains: 0,
      message: "No duplicate normalized_domain groups found in the scanned window",
    });
  }

  const plan = [];

  for (const group of dupDomains) {
    const ids = Array.isArray(group.ids) ? group.ids.map((v) => String(v || "").trim()).filter(Boolean) : [];
    if (ids.length < 2) continue;

    const params = ids.map((id, idx) => ({ name: `@id${idx}`, value: id }));
    const inClause = ids.map((_, idx) => `@id${idx}`).join(", ");

    const fullQ = {
      query: `SELECT * FROM c WHERE c.id IN (${inClause})`,
      parameters: params,
    };

    let docs = [];
    try {
      const res = await container.items.query(fullQ, { enableCrossPartitionQuery: true }).fetchAll();
      docs = Array.isArray(res?.resources) ? res.resources : [];
    } catch {
      docs = [];
    }

    if (docs.length < 2) continue;

    const sorted = docs
      .slice()
      .sort((a, b) => {
        const sa = scoreCompanyDoc(a);
        const sb = scoreCompanyDoc(b);
        if (sb !== sa) return sb - sa;

        const ca = Date.parse(String(a?.created_at || "")) || 0;
        const cb = Date.parse(String(b?.created_at || "")) || 0;
        if (ca !== cb) return ca - cb;

        const ida = String(a?.id || "");
        const idb = String(b?.id || "");
        return ida.localeCompare(idb);
      });

    const canonical = sorted[0];
    const losers = sorted.slice(1);

    let mergedCanonical = { ...canonical };
    for (const other of losers) {
      mergedCanonical = mergeBestFields(mergedCanonical, other);
    }

    const updatedAt = nowIso();
    mergedCanonical.updated_at = updatedAt;
    mergedCanonical.merge_note = {
      reason: "seed_fallback_duplicate_cleanup",
      merged_at: updatedAt,
      merged_from_ids: losers.map((d) => String(d?.id || "").trim()).filter(Boolean),
    };

    const deletions = losers.map((d) => {
      return {
        ...d,
        is_deleted: true,
        deleted_at: updatedAt,
        deleted_reason: "seed_fallback_duplicate",
        merged_into: String(mergedCanonical.id || "").trim(),
        merged_into_domain: String(mergedCanonical.normalized_domain || "").trim(),
        updated_at: updatedAt,
      };
    });

    plan.push({
      normalized_domain: String(group.normalized_domain || ""),
      canonical_id: String(mergedCanonical.id || ""),
      delete_ids: deletions.map((d) => d.id),
    });

    if (dry_run) continue;

    const up1 = await upsertDocWithPkCandidates({ container, containerPkPath, doc: mergedCanonical });
    if (!up1.ok) {
      return json({ ok: false, error: "Failed to upsert canonical", details: { domain: group.normalized_domain, canonical_id: mergedCanonical.id, upsert_error: up1.error } }, 500);
    }

    for (const del of deletions) {
      const up2 = await upsertDocWithPkCandidates({ container, containerPkPath, doc: del });
      if (!up2.ok) {
        return json({ ok: false, error: "Failed to upsert deletion", details: { domain: group.normalized_domain, delete_id: del.id, upsert_error: up2.error } }, 500);
      }
    }
  }

  return json({
    ok: true,
    dry_run,
    domain_prefix: domainPrefix || null,
    normalized_domain: exactDomain || null,
    process_all: processAll,
    since_hours: sinceHours,
    matched_docs: resources.length,
    duplicate_domains: dupDomains.length,
    processed_domains: plan.length,
    plan,
  });
}

app.http("admin-cleanup-seed-fallback-dups", {
  route: "admin/cleanup-seed-fallback-dups",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: cleanupHandler,
});

module.exports = {
  _test: {
    cleanupHandler,
  },
};
