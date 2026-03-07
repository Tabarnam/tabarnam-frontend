/**
 * Import Preflight Check — checks queued companies against the DB for duplicates.
 *
 * POST /api/import-preflight
 * Body: { entries: [{ company_name, url }] }
 * Response: { ok, results: [{ index, company_name, url, status, match }] }
 *
 * Status values: "exact_match" | "fuzzy_match" | "no_match"
 */

let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}

const { CosmosClient } = require("@azure/cosmos");
const { getBuildInfo } = require("../_buildInfo");
const { findExistingCompany } = require("../import-start/_importStartSaveCompanies");
const { fuzzyScore } = require("../_fuzzyMatch");
const { toNormalizedDomain } = require("../import-start/_importStartCompanyUtils");

const BUILD_INFO = getBuildInfo();
const HANDLER_ID = "import-preflight";
const MAX_ENTRIES = 50;

function env(k, d = "") {
  const v = process.env[k];
  return (v == null ? d : String(v)).trim();
}

function json(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-functions-key",
      "X-Api-Handler": HANDLER_ID,
      "X-Api-Build-Id": String(BUILD_INFO.build_id || ""),
    },
    body: JSON.stringify(obj),
  };
}

function getCompaniesContainer() {
  const endpoint = env("COSMOS_DB_ENDPOINT", "");
  const key = env("COSMOS_DB_KEY", "");
  const database = env("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerName = env("COSMOS_DB_COMPANIES_CONTAINER", "companies");

  if (!endpoint || !key) return null;

  try {
    const client = new CosmosClient({ endpoint, key });
    return client.database(database).container(containerName);
  } catch (e) {
    console.error("[import-preflight] Failed to create Cosmos client:", e?.message);
    return null;
  }
}

// ── Fuzzy name match (Tier 2) ───────────────────────────────────────────────

async function findFuzzyNameMatch(container, companyName) {
  const nameLower = companyName.toLowerCase().trim();
  const prefix = nameLower.slice(0, 3);
  if (!prefix) return null;

  const notDeletedClause = "(NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true)";
  const query = `
    SELECT TOP 50 c.id, c.company_name, c.normalized_domain, c.seed_ready, c.source_stage
    FROM c
    WHERE ${notDeletedClause}
      AND IS_DEFINED(c.company_name) AND IS_STRING(c.company_name)
      AND CONTAINS(LOWER(c.company_name), @prefix)
  `;

  const { resources } = await container.items
    .query({ query, parameters: [{ name: "@prefix", value: prefix }] }, { enableCrossPartitionQuery: true })
    .fetchAll();

  if (!Array.isArray(resources) || resources.length === 0) return null;

  let bestMatch = null;
  let bestScore = 0;

  for (const candidate of resources) {
    const candidateName = String(candidate.company_name || "").trim();
    if (!candidateName) continue;

    const score = fuzzyScore(candidateName, companyName);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = candidate;
    }
  }

  if (bestMatch && bestScore > 0) {
    return {
      id: bestMatch.id,
      company_name: bestMatch.company_name || "",
      normalized_domain: bestMatch.normalized_domain || "",
      match_type: "fuzzy_name",
      fuzzy_score: bestScore,
    };
  }

  return null;
}

// ── Domain substring match (Tier 3) ─────────────────────────────────────────

async function findDomainSubstringMatch(container, normalizedDomain) {
  const coreName = normalizedDomain.split(".")[0];
  if (!coreName || coreName.length < 3) return null;

  const notDeletedClause = "(NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true)";
  const query = `
    SELECT TOP 10 c.id, c.company_name, c.normalized_domain, c.seed_ready, c.source_stage
    FROM c
    WHERE ${notDeletedClause}
      AND IS_DEFINED(c.normalized_domain) AND IS_STRING(c.normalized_domain)
      AND CONTAINS(c.normalized_domain, @core)
      AND c.normalized_domain != @exactDomain
  `;

  const { resources } = await container.items
    .query({
      query,
      parameters: [
        { name: "@core", value: coreName },
        { name: "@exactDomain", value: normalizedDomain },
      ],
    }, { enableCrossPartitionQuery: true })
    .fetchAll();

  if (!Array.isArray(resources) || resources.length === 0) return null;

  const best = resources[0];
  return {
    id: best.id,
    company_name: best.company_name || "",
    normalized_domain: best.normalized_domain || "",
    match_type: "domain_substring",
  };
}

// ── Per-entry check ─────────────────────────────────────────────────────────

async function checkSingleEntry(container, entry, index) {
  const companyName = String(entry?.company_name || "").trim();
  const url = String(entry?.url || "").trim();

  const result = {
    index,
    company_name: companyName,
    url,
    status: "no_match",
    match: null,
  };

  try {
    const normalizedDomain = toNormalizedDomain(url);

    // Tier 1: Exact match (domain / URL variants / exact name)
    const exactMatch = await findExistingCompany(container, normalizedDomain, companyName, url);

    if (exactMatch) {
      result.status = "exact_match";
      result.match = {
        id: exactMatch.id,
        company_name: exactMatch.company_name || "",
        normalized_domain: exactMatch.normalized_domain || "",
        match_type: exactMatch.duplicate_match_key || "unknown",
      };
      return result;
    }

    // Tier 2: Fuzzy name match
    if (companyName && companyName.length >= 3) {
      const fuzzyMatch = await findFuzzyNameMatch(container, companyName);
      if (fuzzyMatch) {
        result.status = "fuzzy_match";
        result.match = fuzzyMatch;
        return result;
      }
    }

    // Tier 3: Domain substring match
    if (normalizedDomain && normalizedDomain !== "unknown") {
      const domainMatch = await findDomainSubstringMatch(container, normalizedDomain);
      if (domainMatch) {
        result.status = "fuzzy_match";
        result.match = domainMatch;
        return result;
      }
    }
  } catch (e) {
    console.warn(`[import-preflight] Error checking entry ${index}: ${e.message}`);
    // Return no_match on error rather than failing the whole batch
  }

  return result;
}

// ── Main handler ────────────────────────────────────────────────────────────

async function importPreflightHandler(req, context) {
  const method = (req.method || "").toUpperCase();

  if (method === "OPTIONS") {
    return json({}, 204);
  }

  // ── Admin auth gate ──────────────────────────────────────────
  const { adminGuard } = require("../_adminAuth");
  const authError = adminGuard(req, context);
  if (authError) return authError;
  // ─────────────────────────────────────────────────────────────

  if (method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  let body;
  try {
    // v4 model: req.json() returns parsed body
    if (typeof req.json === "function") {
      body = await req.json();
    } else if (typeof req.text === "function") {
      const raw = String(await req.text()).trim();
      body = raw ? JSON.parse(raw) : {};
    } else if (typeof req.body === "string" && req.body.trim()) {
      body = JSON.parse(req.body);
    } else if (req.body && typeof req.body === "object") {
      body = req.body;
    } else {
      body = {};
    }
  } catch (e) {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const entries = Array.isArray(body?.entries) ? body.entries : [];
  if (entries.length === 0) {
    return json({ ok: false, error: "No entries provided" }, 400);
  }
  if (entries.length > MAX_ENTRIES) {
    return json({ ok: false, error: `Too many entries (max ${MAX_ENTRIES})` }, 400);
  }

  const container = getCompaniesContainer();
  if (!container) {
    return json({ ok: false, error: "Database not configured" }, 503);
  }

  console.log(`[import-preflight] Checking ${entries.length} entries`);

  const results = await Promise.all(
    entries.map((entry, index) => checkSingleEntry(container, entry, index))
  );

  const exactCount = results.filter((r) => r.status === "exact_match").length;
  const fuzzyCount = results.filter((r) => r.status === "fuzzy_match").length;
  const clearCount = results.filter((r) => r.status === "no_match").length;

  console.log(`[import-preflight] Results: ${exactCount} exact, ${fuzzyCount} fuzzy, ${clearCount} clear`);

  return json({ ok: true, results });
}

// ── Azure Functions v4 registration ─────────────────────────────────────────

app.http("importPreflight", {
  route: "import-preflight",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: (req, context) => importPreflightHandler(req, context),
});

module.exports = {
  handler: importPreflightHandler,
};
