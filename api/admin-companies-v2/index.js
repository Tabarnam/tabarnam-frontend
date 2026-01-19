let app;
try {
  ({ app } = require("@azure/functions"));
} catch {
  app = { http() {} };
}
const { CosmosClient } = require("@azure/cosmos");
const { getBuildInfo } = require("../_buildInfo");
const { computeTopLevelDiff, writeCompanyEditHistoryEntry, getCompanyEditHistoryContainer } = require("../_companyEditHistory");
const { geocodeLocationArray, pickPrimaryLatLng, extractLatLng } = require("../_geocode");
const { computeProfileCompleteness } = require("../_profileCompleteness");
const { resolveReviewsStarState } = require("../_reviewsStarState");
const { computeEnrichmentHealth } = require("../_requiredFields");

const BUILD_INFO = getBuildInfo();
const HANDLER_ID = "admin-companies-v2";

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
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-functions-key",
      "X-Api-Handler": HANDLER_ID,
      "X-Api-Build-Id": String(BUILD_INFO.build_id || ""),
      "X-Api-Build-Source": String(BUILD_INFO.build_id_source || ""),
    },
    body: JSON.stringify(obj),
  };
}

function getCompaniesContainer() {
  const endpoint = env("COSMOS_DB_ENDPOINT", "");
  const key = env("COSMOS_DB_KEY", "");
  const database = env("COSMOS_DB_DATABASE", "tabarnam-db");
  const container = env("COSMOS_DB_COMPANIES_CONTAINER", "companies");

  if (!endpoint || !key) return null;

  try {
    const client = new CosmosClient({ endpoint, key });
    return client.database(database).container(container);
  } catch (e) {
    console.error("[admin-companies-v2] Failed to create Cosmos client:", e?.message);
    return null;
  }
}

let cosmosTargetPromise;

function redactHostForDiagnostics(value) {
  const host = typeof value === "string" ? value.trim() : "";
  if (!host) return "";
  if (host.length <= 12) return host;
  return `${host.slice(0, 8)}…${host.slice(-8)}`;
}

async function getCompaniesCosmosTargetDiagnostics(container) {
  cosmosTargetPromise ||= (async () => {
    const endpoint = env("COSMOS_DB_ENDPOINT", "");
    const database = env("COSMOS_DB_DATABASE", "tabarnam-db");
    const containerName = env("COSMOS_DB_COMPANIES_CONTAINER", "companies");

    let host = "";
    try {
      host = endpoint ? new URL(endpoint).host : "";
    } catch {
      host = "";
    }

    const { getContainerPartitionKeyPath } = require("../_cosmosPartitionKey");
    const pkPath = await getContainerPartitionKeyPath(container, "/normalized_domain");

    return {
      cosmos_account_host_redacted: redactHostForDiagnostics(host),
      cosmos_db_name: database,
      cosmos_container_name: containerName,
      cosmos_container_partition_key_path: pkPath,
    };
  })();

  try {
    return await cosmosTargetPromise;
  } catch {
    return {
      cosmos_account_host_redacted: "",
      cosmos_db_name: env("COSMOS_DB_DATABASE", "tabarnam-db"),
      cosmos_container_name: env("COSMOS_DB_COMPANIES_CONTAINER", "companies"),
      cosmos_container_partition_key_path: "/normalized_domain",
    };
  }
}

const toNormalizedDomain = (s = "") => {
  try {
    const u = s.startsWith("http") ? new URL(s) : new URL(`https://${s}`);
    let h = u.hostname.toLowerCase();
    if (h.startsWith("www.")) h = h.slice(4);
    return h || "unknown";
  } catch {
    return "unknown";
  }
};

function slugifyCompanyId(value) {
  const s = String(value || "").trim().toLowerCase();
  if (!s) return "";
  const slug = s
    .replace(/['\u001a]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug;
}

function sqlContainsString(fieldExpr) {
  return `(IS_DEFINED(${fieldExpr}) AND IS_STRING(${fieldExpr}) AND CONTAINS(LOWER(${fieldExpr}), @q))`;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  if (typeof value.getReader === "function") return false; // ReadableStream
  if (typeof value.arrayBuffer === "function") return false;
  if (ArrayBuffer.isView(value)) return false;
  return Object.prototype.toString.call(value) === "[object Object]";
}

function toFiniteNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normalizeLocationList(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function hasAnyLatLng(list) {
  if (!Array.isArray(list) || list.length === 0) return false;
  return list.some((loc) => Boolean(extractLatLng(loc)));
}

function buildHeadquartersSeedFromDoc(doc) {
  const base = doc && typeof doc === "object" ? doc : {};

  const listRaw =
    Array.isArray(base.headquarters_locations) && base.headquarters_locations.length
      ? base.headquarters_locations
      : Array.isArray(base.headquarters) && base.headquarters.length
        ? base.headquarters
        : [];

  const list = normalizeLocationList(listRaw);

  const primaryRaw = typeof base.headquarters_location === "string" ? base.headquarters_location.trim() : "";
  if (!primaryRaw) return list;

  const already = list.some((h) => {
    if (!h) return false;
    if (typeof h === "string") return h.trim() === primaryRaw;
    if (typeof h !== "object") return false;
    const candidates = [h.address, h.full_address, h.formatted, h.location].map((v) => (typeof v === "string" ? v.trim() : ""));
    return candidates.some((c) => c === primaryRaw);
  });

  if (already) return list;

  return [{ address: primaryRaw }, ...list];
}

function buildManufacturingSeedFromDoc(doc) {
  const base = doc && typeof doc === "object" ? doc : {};

  const raw =
    Array.isArray(base.manufacturing_geocodes) && base.manufacturing_geocodes.length
      ? base.manufacturing_geocodes
      : Array.isArray(base.manufacturing_locations) && base.manufacturing_locations.length
        ? base.manufacturing_locations
        : [];

  return normalizeLocationList(raw);
}

async function maybeGeocodeLocationsForCompanyDoc(doc, { timeoutMs = 5000 } = {}) {
  if (!doc || typeof doc !== "object") return doc;

  const next = doc;

  // HQ
  const hqSeed = buildHeadquartersSeedFromDoc(next);
  const hasLegacyHq = toFiniteNumber(next.hq_lat) != null && toFiniteNumber(next.hq_lng) != null;
  const hasHqCoordsInList = hasAnyLatLng(hqSeed);

  if (!hasLegacyHq && !hasHqCoordsInList && hqSeed.length > 0) {
    const geocoded = await geocodeLocationArray(hqSeed, { timeoutMs, concurrency: 4 });
    const primary = pickPrimaryLatLng(geocoded);

    if (primary) {
      next.headquarters_locations = geocoded;
      next.headquarters = geocoded;
      next.hq_lat = primary.lat;
      next.hq_lng = primary.lng;
    }
  } else if (!hasLegacyHq && hasHqCoordsInList) {
    const primary = pickPrimaryLatLng(hqSeed);
    if (primary) {
      next.hq_lat = primary.lat;
      next.hq_lng = primary.lng;
    }
  }

  // Manufacturing
  const manuSeed = buildManufacturingSeedFromDoc(next);
  const hasManuCoords = hasAnyLatLng(manuSeed);

  if (!hasManuCoords && manuSeed.length > 0) {
    const geocoded = await geocodeLocationArray(manuSeed, { timeoutMs, concurrency: 4 });
    if (hasAnyLatLng(geocoded)) {
      next.manufacturing_geocodes = geocoded;
    }
  } else if (!Array.isArray(next.manufacturing_geocodes) || next.manufacturing_geocodes.length === 0) {
    // Ensure manufacturing_geocodes is present when the editor sends structured entries.
    next.manufacturing_geocodes = manuSeed;
  }

  return next;
}

function normalizeDisplayNameFromDoc(doc) {
  if (!doc || typeof doc !== "object") return "";
  const companyName = typeof doc.company_name === "string" ? doc.company_name.trim() : "";
  const explicit = typeof doc.display_name === "string" ? doc.display_name.trim() : "";
  if (explicit) return explicit;
  const name = typeof doc.name === "string" ? doc.name.trim() : "";
  if (!name) return "";
  if (!companyName) return name;
  return name !== companyName ? name : "";
}

function hasAzureSasParams(input) {
  const url = typeof input === "string" ? input : "";
  return /[?&](sv|sig|se)=/i.test(url);
}

function toStableLogoUrl(input) {
  const url = typeof input === "string" ? input.trim() : "";
  if (!url) return "";

  // Our logo proxy endpoint needs its query string preserved.
  if (url.startsWith("/api/company-logo?")) return url;

  // If the logo URL includes Azure SAS parameters, we must preserve the query string.
  if (hasAzureSasParams(url)) return url;

  const qIndex = url.indexOf("?");
  return qIndex === -1 ? url : url.slice(0, qIndex);
}

function looksLikeBlobHostWithoutProtocol(input) {
  return /^[a-z0-9-]+\.blob\.core\.windows\.net\//i.test(input);
}

function isAzureCompanyLogosBlobUrl(input) {
  try {
    const u = new URL(input);
    if (!u.hostname.toLowerCase().endsWith(".blob.core.windows.net")) return false;

    const path = u.pathname || "";
    return path === "/company-logos" || path.startsWith("/company-logos/");
  } catch {
    return false;
  }
}

function proxyAzureCompanyLogoUrlForClient(rawLogoUrl) {
  const raw = typeof rawLogoUrl === "string" ? rawLogoUrl.trim() : "";
  if (!raw) return "";

  if (raw.startsWith("/api/company-logo?")) return raw;
  if (hasAzureSasParams(raw)) return raw;

  const stable = toStableLogoUrl(raw);

  const absolute = looksLikeBlobHostWithoutProtocol(stable)
    ? `https://${stable}`
    : stable;

  if (!isAzureCompanyLogosBlobUrl(absolute)) return raw;

  return `/api/company-logo?src=${encodeURIComponent(absolute)}`;
}

function normalizeCompanyForResponse(doc) {
  if (!doc || typeof doc !== "object") return doc;
  const company_id = String(doc.company_id || doc.id || "").trim() || doc.company_id;
  const display_name = normalizeDisplayNameFromDoc(doc);

  const normalizedLogoUrl =
    typeof doc.logo_url === "string"
      ? proxyAzureCompanyLogoUrlForClient(doc.logo_url)
      : "";

  return {
    ...doc,
    company_id,
    ...(display_name ? { display_name } : {}),
    ...(typeof doc.logo_url === "string" ? { logo_url: normalizedLogoUrl } : {}),
  };
}

function hasAnyLocationDescriptor(value) {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];

  for (const loc of list) {
    if (typeof loc === "string") {
      if (loc.trim()) return true;
      continue;
    }

    if (isPlainObject(loc)) {
      const formatted =
        (typeof loc.formatted === "string" && loc.formatted.trim()) ||
        (typeof loc.full_address === "string" && loc.full_address.trim()) ||
        (typeof loc.address === "string" && loc.address.trim()) ||
        (typeof loc.location === "string" && loc.location.trim());

      if (formatted) return true;

      const city = typeof (loc.city || loc.locality) === "string" ? String(loc.city || loc.locality).trim() : "";
      const region = typeof (loc.state || loc.region || loc.province) === "string"
        ? String(loc.state || loc.region || loc.province).trim()
        : "";
      const country = typeof loc.country === "string" ? loc.country.trim() : "";

      if (city && (region || country)) return true;
    }
  }

  return false;
}

function normalizeKeywordList(value) {
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim()))
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(/\s*,\s*/g)
      .map((v) => v.trim())
      .filter(Boolean);
  }

  return [];
}

function getContractKeywordInputs(company) {
  const c = company && typeof company === "object" ? company : {};

  const keywordsDirect = normalizeKeywordList(c.keywords);
  const keywordsLegacy = normalizeKeywordList(c.keyword_list);
  const keywordsFromProductArray = Array.isArray(c.product_keywords) ? normalizeKeywordList(c.product_keywords) : [];

  const keywords = keywordsDirect.length > 0 ? keywordsDirect : keywordsLegacy.length > 0 ? keywordsLegacy : keywordsFromProductArray;

  let product_keywords = "";
  if (typeof c.product_keywords === "string") {
    product_keywords = c.product_keywords;
  } else if (Array.isArray(c.product_keywords)) {
    product_keywords = normalizeKeywordList(c.product_keywords).join(", ");
  } else if (typeof c.product_keywords_text === "string") {
    product_keywords = c.product_keywords_text;
  }

  if (!String(product_keywords || "").trim() && keywords.length > 0) {
    product_keywords = keywords.join(", ");
  }

  return { keywords, product_keywords };
}

function computeContractEnrichmentHealth(company) {
  const c = company && typeof company === "object" ? company : {};

  const inferredHq =
    (Array.isArray(c.headquarters_locations) ? c.headquarters_locations[0] : c.headquarters_locations) ??
    (Array.isArray(c.headquarters) ? c.headquarters[0] : c.headquarters);

  const inferredMfg =
    Array.isArray(c.manufacturing_geocodes) && c.manufacturing_geocodes.length > 0
      ? c.manufacturing_geocodes
      : c.manufacturing_locations;

  // NOTE: Using nullish coalescing (??) isn't enough here because many docs contain
  // empty strings/arrays for these fields. Those would incorrectly override populated
  // headquarters_locations / manufacturing_geocodes and create false-positive "HQ"/"MFG" issues.
  const primaryHq = Array.isArray(c.headquarters_location) ? c.headquarters_location[0] : c.headquarters_location;

  const { keywords: normalizedKeywords, product_keywords: normalizedProductKeywords } = getContractKeywordInputs(c);

  const industriesFallback =
    Array.isArray(c.industries) && c.industries.length > 0
      ? c.industries
      : Array.isArray(c.industry)
        ? c.industry
        : typeof c.industry === "string" && c.industry.trim()
          ? [c.industry.trim()]
          : [];

  const contractInput = {
    ...c,
    headquarters_location: hasAnyLocationDescriptor(primaryHq) ? primaryHq : inferredHq,
    manufacturing_locations: hasAnyLocationDescriptor(c.manufacturing_locations) ? c.manufacturing_locations : inferredMfg,
    industries: industriesFallback,

    // Ensure keywords are evaluated correctly even when older docs store them as arrays (or in keyword_list).
    keywords: normalizedKeywords,
    product_keywords: normalizedProductKeywords,
  };

  return computeEnrichmentHealth(contractInput);
}

function normalizeCompanyForResponseWithContractIssues(doc) {
  const base = normalizeCompanyForResponse(doc);
  if (!base || typeof base !== "object") return base;

  let health = null;
  try {
    health = computeContractEnrichmentHealth(base);
  } catch {
    health = null;
  }

  const safeHealth =
    health && typeof health === "object"
      ? health
      : base.enrichment_health && typeof base.enrichment_health === "object"
        ? base.enrichment_health
        : { missing_fields: [] };

  const missing = Array.isArray(safeHealth.missing_fields)
    ? safeHealth.missing_fields.filter((v) => typeof v === "string" && v.trim())
    : [];

  return {
    ...base,
    enrichment_health: { ...safeHealth, missing_fields: missing },
    issues: missing,
  };
}

async function getJson(req) {
  if (!req) return {};

  if (typeof req.json === "function") {
    try {
      const val = await req.json();
      if (val && typeof val === "object") return val;
      return {};
    } catch {
      // fall through
    }
  }

  if (typeof req.text === "function") {
    let text = "";
    try {
      text = String(await req.text()).trim();
    } catch {
      text = "";
    }
    if (text) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") return parsed;
        return {};
      } catch (e) {
        throw e;
      }
    }
  }

  if (typeof req.rawBody === "string" && req.rawBody.trim()) {
    try {
      const parsed = JSON.parse(req.rawBody);
      if (parsed && typeof parsed === "object") return parsed;
      return {};
    } catch (e) {
      throw e;
    }
  }

  if (typeof req.body === "string" && req.body.trim()) {
    try {
      const parsed = JSON.parse(req.body);
      if (parsed && typeof parsed === "object") return parsed;
      return {};
    } catch (e) {
      throw e;
    }
  }

  if (req.body && typeof Buffer !== "undefined" && Buffer.isBuffer(req.body) && req.body.length) {
    try {
      const parsed = JSON.parse(req.body.toString("utf8"));
      if (parsed && typeof parsed === "object") return parsed;
      return {};
    } catch (e) {
      throw e;
    }
  }

  if (req.body && ArrayBuffer.isView(req.body) && req.body.byteLength) {
    try {
      const text = new TextDecoder().decode(req.body);
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") return parsed;
      return {};
    } catch (e) {
      throw e;
    }
  }

  if (isPlainObject(req.body)) return req.body;

  return {};
}

function sqlContainsStringOrArray(fieldExpr) {
  return `(
    IS_DEFINED(${fieldExpr}) AND (
      (IS_STRING(${fieldExpr}) AND CONTAINS(LOWER(${fieldExpr}), @q)) OR
      (IS_ARRAY(${fieldExpr}) AND ARRAY_LENGTH(
        ARRAY(SELECT VALUE v FROM v IN ${fieldExpr} WHERE IS_STRING(v) AND CONTAINS(LOWER(v), @q))
      ) > 0)
    )
  )`;
}

function sqlLocationObjectContains(alias) {
  const parts = [
    "address",
    "full_address",
    "formatted",
    "location",
    "city",
    "region",
    "state",
    "country",
  ];

  return (
    "(" +
    parts
      .map(
        (p) =>
          `(IS_DEFINED(${alias}.${p}) AND IS_STRING(${alias}.${p}) AND CONTAINS(LOWER(${alias}.${p}), @q))`
      )
      .join(" OR ") +
    ")"
  );
}

function sqlContainsLocationArray(fieldExpr) {
  return `(
    IS_DEFINED(${fieldExpr}) AND IS_ARRAY(${fieldExpr}) AND ARRAY_LENGTH(
      ARRAY(
        SELECT VALUE l
        FROM l IN ${fieldExpr}
        WHERE
          (IS_STRING(l) AND CONTAINS(LOWER(l), @q)) OR
          (IS_OBJECT(l) AND ${sqlLocationObjectContains("l")})
      )
    ) > 0
  )`;
}

function sqlContainsNotesArray(fieldExpr) {
  return `(
    IS_DEFINED(${fieldExpr}) AND IS_ARRAY(${fieldExpr}) AND ARRAY_LENGTH(
      ARRAY(
        SELECT VALUE n
        FROM n IN ${fieldExpr}
        WHERE
          (IS_STRING(n) AND CONTAINS(LOWER(n), @q)) OR
          (IS_OBJECT(n) AND IS_DEFINED(n.text) AND IS_STRING(n.text) AND CONTAINS(LOWER(n.text), @q))
      )
    ) > 0
  )`;
}

function sqlContainsStructuredNotesArray(fieldExpr) {
  return `(
    IS_DEFINED(${fieldExpr}) AND IS_ARRAY(${fieldExpr}) AND ARRAY_LENGTH(
      ARRAY(
        SELECT VALUE n
        FROM n IN ${fieldExpr}
        WHERE
          (IS_OBJECT(n) AND (
            (IS_DEFINED(n.title) AND IS_STRING(n.title) AND CONTAINS(LOWER(n.title), @q)) OR
            (IS_DEFINED(n.body) AND IS_STRING(n.body) AND CONTAINS(LOWER(n.body), @q))
          ))
      )
    ) > 0
  )`;
}

function sqlContainsRatingNotes() {
  const stars = ["star1", "star2", "star3", "star4", "star5"];
  const clauses = stars.map((s) => sqlContainsNotesArray(`c.rating.${s}.notes`));
  return `(IS_DEFINED(c.rating) AND IS_OBJECT(c.rating) AND (${clauses.join(" OR ")}))`;
}

function buildSearchWhereClause() {
  const clauses = [
    sqlContainsString("c.company_name"),
    sqlContainsString("c.name"),
    sqlContainsString("c.company_id"),
    sqlContainsString("c.id"),
    sqlContainsString("c.normalized_domain"),
    sqlContainsString("c.website_url"),
    sqlContainsString("c.url"),
    sqlContainsString("c.canonical_url"),
    sqlContainsString("c.website"),
    sqlContainsStringOrArray("c.product_keywords"),
    sqlContainsStringOrArray("c.keywords"),
    `(
      IS_DEFINED(c.industries) AND IS_ARRAY(c.industries) AND ARRAY_LENGTH(
        ARRAY(SELECT VALUE i FROM i IN c.industries WHERE IS_STRING(i) AND CONTAINS(LOWER(i), @q))
      ) > 0
    )`,
    sqlContainsString("c.headquarters_location"),
    sqlContainsLocationArray("c.headquarters_locations"),
    sqlContainsLocationArray("c.headquarters"),
    sqlContainsStringOrArray("c.manufacturing_locations"),
    sqlContainsLocationArray("c.manufacturing_locations"),
    sqlContainsLocationArray("c.manufacturing_geocodes"),
    sqlContainsString("c.notes"),
    sqlContainsNotesArray("c.star_notes"),
    sqlContainsStructuredNotesArray("c.notes_entries"),
    sqlContainsRatingNotes(),
  ];

  return `(${clauses.join(" OR ")})`;
}

async function doesCompanyIdExist(container, id) {
  if (!id) return false;
  try {
    const { resources } = await container.items
      .query(
        {
          query: "SELECT TOP 1 c.id FROM c WHERE c.id = @id",
          parameters: [{ name: "@id", value: String(id).trim() }],
        },
        { enableCrossPartitionQuery: true }
      )
      .fetchAll();
    return Array.isArray(resources) && resources.length > 0;
  } catch {
    return false;
  }
}

/**
 * Admin Companies API (xadmin-api-companies)
 *
 * Deletion contract (Option A):
 * - DELETE /api/xadmin-api-companies/{id} performs a soft-delete (sets company.is_deleted = true).
 * - After a successful DELETE, GET /api/xadmin-api-companies/{id} MUST return 404 NotFound (deleted records are filtered out).
 * - Search GET /api/xadmin-api-companies?q=... excludes deleted records by default.
 *
 * The Admin UI relies on this behavior to avoid guessing after deletion.
 */
async function adminCompaniesHandler(req, context, deps = {}) {
    console.log("[admin-companies-v2-handler] Request received:", { method: req.method, url: req.url });
    context.log("admin-companies-v2 function invoked");

    const method = (req.method || "").toUpperCase();

    // Normalize query params across Azure Functions versions
    try {
      if (req && req.query && typeof req.query.get === "function") {
        const queryObj = Object.fromEntries(req.query.entries());
        try {
          req.query = queryObj;
        } catch {
          req = { ...req, query: queryObj };
        }
      }
    } catch {
      // ignore
    }

    if (method === "OPTIONS") {
      return json({}, 200);
    }

    const container = deps.container || getCompaniesContainer();
    if (!container) {
      return json({ error: "Cosmos DB not configured" }, 503);
    }

    try {
      if (method === "GET") {
        const routeIdRaw =
          (context && context.bindingData && context.bindingData.id) || (req && req.params && req.params.id) || "";
        const routeId = String(routeIdRaw || "").trim();

        const cosmosTarget = await getCompaniesCosmosTargetDiagnostics(container).catch(() => null);
        if (cosmosTarget) {
          try {
            context.log("[admin-companies-v2] cosmos_target", cosmosTarget);
          } catch {}
        }

        if (routeId) {
          const querySpec = {
            query:
              "SELECT TOP 1 * FROM c WHERE c.id = @id AND (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true) AND NOT STARTSWITH(c.id, '_import_') AND (NOT IS_DEFINED(c.type) OR c.type != 'import_control') ORDER BY c._ts DESC",
            parameters: [{ name: "@id", value: routeId }],
          };

          const { resources } = await container.items
            .query(querySpec, { enableCrossPartitionQuery: true })
            .fetchAll();

          const found = (resources && resources[0]) || null;
          if (!found) {
            return json({ ok: false, error: "not_found" }, 404);
          }

          const company = normalizeCompanyForResponseWithContractIssues(found);

          return json({ ok: true, company, ...(cosmosTarget ? cosmosTarget : {}) }, 200);
        }

        const search = (req.query?.search || req.query?.q || "").toString().toLowerCase().trim();
        const take = Math.min(500, Math.max(1, parseInt((req.query?.take || "200").toString())));

        const parameters = [{ name: "@take", value: take }];
        const whereClauses = [
          "(NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true)",
          "NOT STARTSWITH(c.id, '_import_')",
          "(NOT IS_DEFINED(c.type) OR c.type != 'import_control')",
        ];

        if (search) {
          parameters.push({ name: "@q", value: search });
          whereClauses.push(buildSearchWhereClause());
        }

        const whereClause = whereClauses.length > 0 ? "WHERE " + whereClauses.join(" AND ") : "";
        const sql = "SELECT TOP @take * FROM c " + whereClause + " ORDER BY c._ts DESC";

        const { resources } = await container.items
          .query({ query: sql, parameters }, { enableCrossPartitionQuery: true })
          .fetchAll();

        const raw = resources || [];
        const items = raw
          .filter((d) => d && typeof d === "object")
          .map((d) => normalizeCompanyForResponseWithContractIssues(d));

        context.log("[admin-companies-v2] GET count after soft-delete filter:", items.length);
        return json({ items, count: items.length, ...(cosmosTarget ? cosmosTarget : {}) }, 200);
      }

      if (method === "POST" || method === "PUT") {
        let body = {};
        try {
          body = await getJson(req);
        } catch (e) {
          return json({ error: "Invalid JSON", detail: e?.message }, 400);
        }

        const meta = isPlainObject(body)
          ? {
              actor_user_id: String(body.actor_user_id ?? body.actorUserId ?? body.actor ?? "").trim(),
              actor_email: String(body.actor_email ?? body.actorEmail ?? "").trim(),
              source: String(body.source ?? body.audit_source ?? body.auditSource ?? "").trim(),
              action: String(body.action ?? body.audit_action ?? body.auditAction ?? "").trim(),
              request_id: String(body.request_id ?? body.requestId ?? "").trim(),
            }
          : {
              actor_user_id: "",
              actor_email: "",
              source: "",
              action: "",
              request_id: "",
            };

        const incomingRaw = (body && body.company) || body;
        if (!incomingRaw || typeof incomingRaw !== "object") {
          return json({ error: "company payload required" }, 400);
        }

        const incoming = isPlainObject(incomingRaw) ? { ...incomingRaw } : incomingRaw;

        if (isPlainObject(incoming)) {
          const META_KEYS = [
            "actor",
            "actor_email",
            "actorEmail",
            "actor_user_id",
            "actorUserId",
            "source",
            "audit_source",
            "auditSource",
            "action",
            "audit_action",
            "auditAction",
            "request_id",
            "requestId",
          ];
          for (const k of META_KEYS) {
            if (Object.prototype.hasOwnProperty.call(incoming, k)) delete incoming[k];
          }
        }

        const incomingName = String(incoming.company_name || incoming.name || "").trim();
        const incomingUrl = String(
          incoming.website_url || incoming.canonical_url || incoming.url || incoming.website || ""
        ).trim();

        const pathId =
          (context && context.bindingData && context.bindingData.id) ||
          (req && req.params && req.params.id) ||
          "";

        const providedCompanyId = String(incoming.company_id || "").trim();
        const providedId = String(incoming.id || pathId || "").trim();

        let id = String(providedId || providedCompanyId || "").trim();
        const generatedFromName = !id && Boolean(incomingName);

        if (!id) {
          id = slugifyCompanyId(incomingName);
        }
        if (!id) {
          id = `company_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        }

        if (method === "POST" && generatedFromName) {
          const exists = await doesCompanyIdExist(container, id);
          if (exists) {
            id = `${id}-${Date.now().toString(36)}`;
          }
        }

        let existingDoc = null;
        if (method === "PUT") {
          try {
            const querySpec = {
              query: "SELECT TOP 1 * FROM c WHERE c.id = @id ORDER BY c._ts DESC",
              parameters: [{ name: "@id", value: String(id).trim() }],
            };

            const { resources } = await container.items
              .query(querySpec, { enableCrossPartitionQuery: true })
              .fetchAll();

            existingDoc = resources?.[0] || null;
          } catch (e) {
            context.log("[admin-companies-v2] PUT: Failed to lookup existing document", {
              id: String(id).trim(),
              error: e?.message,
            });
          }
        }

        const base = existingDoc ? { ...existingDoc, ...incoming } : { ...incoming };

        const incomingHasDisplayName =
          isPlainObject(incoming) && (Object.prototype.hasOwnProperty.call(incoming, "display_name") || Object.prototype.hasOwnProperty.call(incoming, "displayName"));

        const explicitIncomingDisplayName = incomingHasDisplayName
          ? String((incoming.display_name ?? incoming.displayName ?? "") || "").trim()
          : null;

        const urlForDomain =
          base.website_url || base.canonical_url || base.url || base.website || incomingUrl || "unknown";

        const computedDomain = toNormalizedDomain(urlForDomain);
        const incomingDomain =
          computedDomain !== "unknown" ? computedDomain : incoming.normalized_domain || computedDomain;

        const normalizedDomain = String((existingDoc && existingDoc.normalized_domain) || incomingDomain || "unknown").trim();

        if (!normalizedDomain) {
          return json({ error: "Unable to determine company domain for partition key" }, 400);
        }

        const partitionKeyValue = normalizedDomain;

        const reviewCountRaw =
          (typeof base.review_count === "number" ? base.review_count : null) ??
          (typeof base.reviews_count === "number" ? base.reviews_count : null) ??
          (typeof base.review_count_approved === "number" ? base.review_count_approved : null) ??
          0;

        const now = new Date().toISOString();

        const resolvedName =
          String(base.company_name || "").trim() || String(base.name || "").trim() || incomingName;

        const inferredDisplayName = (() => {
          const name = String(base.name || "").trim();
          if (!name) return "";
          if (!resolvedName) return name;
          return name !== resolvedName ? name : "";
        })();

        const resolvedDisplayName = explicitIncomingDisplayName !== null ? explicitIncomingDisplayName : inferredDisplayName;

        const baseCompanyId = String(base.company_id || "").trim();
        const resolvedCompanyId = providedCompanyId || baseCompanyId || String(id).trim();

        const doc = {
          ...base,
          id: String(id).trim(),
          company_id: resolvedCompanyId,
          normalized_domain: normalizedDomain,
          company_name: resolvedName,
          name: resolvedDisplayName || resolvedName,
          review_count: Math.max(0, Math.trunc(Number(reviewCountRaw) || 0)),
          public_review_count: Math.max(0, Math.trunc(Number(base.public_review_count) || 0)),
          private_review_count: Math.max(0, Math.trunc(Number(base.private_review_count) || 0)),
          updated_at: now,
          created_at: (existingDoc && existingDoc.created_at) || base.created_at || now,
        };

        // Keep review_count consistent with curated reviews + public/private counts.
        const incomingHasCuratedReviews = isPlainObject(incoming) && Object.prototype.hasOwnProperty.call(incoming, "curated_reviews");
        const curatedCount = Array.isArray(doc.curated_reviews)
          ? doc.curated_reviews.filter((r) => r && typeof r === "object").length
          : 0;
        const derivedReviewCount = Math.max(0, (doc.public_review_count || 0) + (doc.private_review_count || 0) + curatedCount);

        doc.review_count = incomingHasCuratedReviews ? derivedReviewCount : Math.max(doc.review_count, derivedReviewCount);

        // Deterministic review-star state (manual override takes precedence).
        const reviewsStarState = resolveReviewsStarState(doc);
        doc.reviews_star_value = reviewsStarState.next_value;
        doc.reviews_star_source = reviewsStarState.next_source;
        doc.rating = reviewsStarState.next_rating;

        // Ensure HQ/manufacturing have coordinates so the public Results page can compute distances.
        // This is especially important for locations manually entered in the admin editor.
        try {
          await maybeGeocodeLocationsForCompanyDoc(doc, { timeoutMs: 5000 });
        } catch (e) {
          context.log("[admin-companies-v2] geocode_on_save_failed", {
            company_id: String(doc.company_id || doc.id || "").trim(),
            error: e?.message || String(e),
          });
        }

        if (resolvedDisplayName) {
          doc.display_name = resolvedDisplayName;
        } else {
          if (Object.prototype.hasOwnProperty.call(doc, "display_name")) delete doc.display_name;
          if (Object.prototype.hasOwnProperty.call(doc, "displayName")) delete doc.displayName;
        }

        try {
          const completeness = computeProfileCompleteness(doc);
          doc.profile_completeness = completeness.profile_completeness;
          doc.profile_completeness_version = completeness.profile_completeness_version;
          doc.profile_completeness_meta = completeness.profile_completeness_meta;
        } catch {}

        context.log("[admin-companies-v2] Upserting company", {
          id: partitionKeyValue,
          method,
          company_id: doc.company_id,
          company_name: doc.company_name,
        });

        try {
          let result;
          try {
            result = await container.items.upsert(doc, { partitionKey: partitionKeyValue });
          } catch (upsertError) {
            context.log(
              "[admin-companies-v2] First upsert attempt failed, retrying without partition key",
              { error: upsertError?.message }
            );
            result = await container.items.upsert(doc);
          }
          context.log("[admin-companies-v2] Upsert completed successfully", {
            id: partitionKeyValue,
            statusCode: result.statusCode,
            resourceId: result.resource?.id,
          });

          try {
            const auditAction = String(meta.action || (existingDoc ? "update" : "create")).trim() || (existingDoc ? "update" : "create");
            const auditSource = String(meta.source || "admin-ui").trim() || "admin-ui";
            const actor_email = meta.actor_email || (meta.actor_user_id.includes("@") ? meta.actor_user_id : "");
            const actor_user_id = meta.actor_user_id || actor_email;
            const request_id = meta.request_id;

            const { changed_fields } = computeTopLevelDiff(existingDoc, doc, {
              ignoreKeys: ["id", "company_id", "deleted_at", "deleted_by"],
            });

            if (auditAction !== "update" || changed_fields.length > 0) {
              await writeCompanyEditHistoryEntry({
                company_id: String(doc.company_id || doc.id || "").trim(),
                actor_user_id: actor_user_id || undefined,
                actor_email: actor_email || undefined,
                action: auditAction,
                source: auditSource,
                request_id: request_id || undefined,
                before: existingDoc,
                after: doc,
              });
            }
          } catch (e) {
            context.log("[admin-companies-v2] Audit log write failed", { error: e?.message });
          }

          return json({ ok: true, company: normalizeCompanyForResponseWithContractIssues(doc) }, 200);
        } catch (e) {
          context.log("[admin-companies-v2] Upsert failed completely", {
            id: partitionKeyValue,
            message: e?.message,
            code: e?.code,
            statusCode: e?.statusCode,
          });
          return json({ error: "Failed to save company", detail: e?.message }, 500);
        }
      }

      if (method === "DELETE") {
        let body = {};
        try {
          body = await getJson(req);
        } catch (e) {
          return json({ error: "Invalid JSON", detail: e?.message }, 400);
        }

        const { getContainerPartitionKeyPath, buildPartitionKeyCandidates } = require("../_cosmosPartitionKey");

        // ---- ID resolution (path param > query > body) ----
        const rawPathId =
          (context && context.bindingData && context.bindingData.id) ||
          (req && req.params && req.params.id) ||
          null;

        const rawQueryId =
          (req && req.query && (req.query.id || req.query.company_id)) || null;

        const rawBodyId =
          (body && (body.company_id || body.id || body.companyId)) ||
          (body && body.company && (body.company.company_id || body.company.id)) ||
          null;

        const resolvedId = rawPathId || rawQueryId || rawBodyId;

        if (!resolvedId) {
          return json({ error: "company_id required" }, 400);
        }

        const requestedId = String(resolvedId).trim();
        if (!requestedId) {
          return json({ error: "Invalid company ID" }, 400);
        }
        // -----------------------------------------------

        context.log("[admin-companies-v2] DELETE: Deleting company", { id: requestedId });

        try {
          const containerPkPath = await getContainerPartitionKeyPath(container, "/normalized_domain");
          context.log("[admin-companies-v2] DELETE: container partition key path resolved", { containerPkPath });

          const querySpec = {
            query: "SELECT * FROM c WHERE c.id = @id",
            parameters: [{ name: "@id", value: requestedId }],
          };

          const { resources } = await container.items
            .query(querySpec, { enableCrossPartitionQuery: true })
            .fetchAll();

          const docs = Array.isArray(resources) ? resources : [];
          context.log("[admin-companies-v2] DELETE query result count:", docs.length);

          if (docs.length === 0) {
            return json({ error: "Company not found", id: requestedId }, 404);
          }

          const now = new Date().toISOString();
          const actor = (body && (body.actor || body.actor_email || body.actorEmail || body.actor_user_id || body.actorUserId)) || "admin_ui";
          const actor_email = String(body?.actor_email || body?.actorEmail || "").trim() || (typeof actor === "string" && actor.includes("@") ? actor : "");
          const actor_user_id = String(body?.actor_user_id || body?.actorUserId || "").trim() || String(actor || "").trim();
          const audit_source = String(body?.source || body?.audit_source || body?.auditSource || "admin-ui").trim() || "admin-ui";
          const request_id = String(body?.request_id || body?.requestId || "").trim();

          let softDeleted = 0;
          let hardDeleted = 0;
          const failures = [];

          let deleteAuditWritten = false;
          const maybeWriteDeleteAudit = async (beforeDoc, afterDoc) => {
            if (deleteAuditWritten) return;
            deleteAuditWritten = true;

            try {
              await writeCompanyEditHistoryEntry({
                company_id: String(afterDoc?.company_id || afterDoc?.id || requestedId || "").trim(),
                actor_user_id: actor_user_id || undefined,
                actor_email: actor_email || undefined,
                action: "delete",
                source: audit_source,
                request_id: request_id || undefined,
                before: beforeDoc,
                after: afterDoc,
              });
            } catch (e) {
              context.log("[admin-companies-v2] Delete audit log write failed", { error: e?.message });
            }
          };

          for (const doc of docs) {
            const updatedDoc = {
              ...doc,
              is_deleted: true,
              deleted_at: now,
              deleted_by: actor,
            };

            const candidates = buildPartitionKeyCandidates({ doc, containerPkPath, requestedId });
            let deletedThisDoc = false;

            try {
              await container.items.upsert(updatedDoc);
              softDeleted++;
              deletedThisDoc = true;
              await maybeWriteDeleteAudit(doc, updatedDoc);
              continue;
            } catch {
              // continue
            }

            for (const partitionKeyValue of candidates) {
              if (deletedThisDoc) break;
              try {
                await container.items.upsert(updatedDoc, { partitionKey: partitionKeyValue });
                softDeleted++;
                deletedThisDoc = true;
                await maybeWriteDeleteAudit(doc, updatedDoc);
                break;
              } catch {
                // continue
              }

              try {
                await container.item(doc.id, partitionKeyValue).replace(updatedDoc);
                softDeleted++;
                deletedThisDoc = true;
                await maybeWriteDeleteAudit(doc, updatedDoc);
                break;
              } catch {
                // continue
              }
            }

            if (deletedThisDoc) continue;

            for (const partitionKeyValue of candidates) {
              if (deletedThisDoc) break;
              try {
                await container.item(doc.id, partitionKeyValue).delete();
                hardDeleted++;
                deletedThisDoc = true;
                await maybeWriteDeleteAudit(doc, updatedDoc);
                break;
              } catch {
                // continue
              }
            }

            if (!deletedThisDoc) {
              failures.push({ itemId: doc.id, attemptedPartitionKeyCount: candidates.length });
            }
          }

          if (failures.length > 0) {
            return json(
              {
                error: "Failed to delete one or more matching documents",
                id: requestedId,
                softDeleted,
                hardDeleted,
                failures,
              },
              500
            );
          }

          return json({ ok: true, id: requestedId, softDeleted, hardDeleted }, 200);
        } catch (e) {
          context.log("[admin-companies-v2] DELETE error", {
            id: requestedId,
            code: e?.code,
            statusCode: e?.statusCode,
            message: e?.message,
            stack: e?.stack,
          });
          return json({ error: "Failed to delete company", detail: e?.message }, 500);
        }
      }

      return json({ error: "Method not allowed" }, 405);
    } catch (e) {
      context.log("[admin-companies-v2] Error", e?.message || e);
      return json({ error: e?.message || "Internal error" }, 500);
    }
}

function decodeHistoryCursor(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const jsonStr = Buffer.from(raw, "base64").toString("utf8");
    const parsed = JSON.parse(jsonStr);
    const created_at = typeof parsed?.created_at === "string" ? parsed.created_at : "";
    const id = typeof parsed?.id === "string" ? parsed.id : "";
    if (!created_at || !id) return null;
    return { created_at, id };
  } catch {
    return null;
  }
}

function encodeHistoryCursor(value) {
  if (!value || typeof value !== "object") return "";
  const created_at = typeof value.created_at === "string" ? value.created_at : "";
  const id = typeof value.id === "string" ? value.id : "";
  if (!created_at || !id) return "";
  try {
    return Buffer.from(JSON.stringify({ created_at, id }), "utf8").toString("base64");
  } catch {
    return "";
  }
}

function clampHistoryLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 50;
  return Math.max(1, Math.min(200, Math.trunc(n)));
}

function getHistoryQueryParam(req, name) {
  const q = (req && req.query) || {};
  const v = q && typeof q === "object" ? q?.[name] : undefined;
  return v == null ? "" : String(v);
}

function historyJson(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-functions-key",
      "X-Api-Handler": "admin-company-history",
      "X-Api-Build-Id": String(BUILD_INFO.build_id || ""),
      "X-Api-Build-Source": String(BUILD_INFO.build_id_source || ""),
    },
    body: JSON.stringify(obj),
  };
}

async function adminCompanyHistoryFallbackHandler(req, context) {
  const method = String(req?.method || "GET").toUpperCase();
  if (method === "OPTIONS") return historyJson({ ok: true }, 200);
  if (method !== "GET") return historyJson({ error: "Method not allowed" }, 405);

  const company_id = String(
    (context && context.bindingData && (context.bindingData.company_id || context.bindingData.companyId)) ||
      (req && req.params && (req.params.company_id || req.params.companyId)) ||
      ""
  ).trim();

  if (!company_id) return historyJson({ error: "company_id required" }, 400);

  const container = await getCompanyEditHistoryContainer();
  if (!container) return historyJson({ error: "Cosmos DB not configured" }, 503);

  const limit = clampHistoryLimit(getHistoryQueryParam(req, "limit") || 50);
  const cursor = decodeHistoryCursor(getHistoryQueryParam(req, "cursor"));
  const field = String(getHistoryQueryParam(req, "field") || "").trim();
  const search = String(getHistoryQueryParam(req, "q") || "").trim().toLowerCase();

  const parameters = [{ name: "@company_id", value: company_id }, { name: "@limit", value: limit }];
  const where = ["c.company_id = @company_id"];

  if (cursor) {
    where.push("(c.created_at < @cursor_created_at OR (c.created_at = @cursor_created_at AND c.id < @cursor_id))");
    parameters.push({ name: "@cursor_created_at", value: cursor.created_at });
    parameters.push({ name: "@cursor_id", value: cursor.id });
  }

  if (field) {
    where.push(
      "(IS_DEFINED(c.changed_fields) AND IS_ARRAY(c.changed_fields) AND ARRAY_CONTAINS(c.changed_fields, @field, true))"
    );
    parameters.push({ name: "@field", value: field });
  }

  if (search) {
    where.push(
      "(CONTAINS(LOWER(c.action), @q) OR CONTAINS(LOWER(c.source), @q) OR (IS_DEFINED(c.actor_email) AND CONTAINS(LOWER(c.actor_email), @q)) OR (IS_DEFINED(c.actor_user_id) AND CONTAINS(LOWER(c.actor_user_id), @q)) OR (IS_DEFINED(c.changed_fields) AND IS_ARRAY(c.changed_fields) AND ARRAY_LENGTH(ARRAY(SELECT VALUE f FROM f IN c.changed_fields WHERE IS_STRING(f) AND CONTAINS(LOWER(f), @q))) > 0))"
    );
    parameters.push({ name: "@q", value: search });
  }

  const sql = `SELECT TOP @limit * FROM c WHERE ${where.join(
    " AND "
  )} ORDER BY c.created_at DESC, c.id DESC`;

  try {
    const { resources } = await container.items
      .query({ query: sql, parameters }, { partitionKey: company_id })
      .fetchAll();

    const items = Array.isArray(resources) ? resources : [];
    const last = items.length > 0 ? items[items.length - 1] : null;
    const next_cursor = items.length === limit && last
      ? encodeHistoryCursor({ created_at: last.created_at, id: last.id })
      : "";

    return historyJson({ ok: true, items, next_cursor: next_cursor || null }, 200);
  } catch (e) {
    context?.log?.("[admin-company-history:fallback] query error", e?.message || e);
    return historyJson({ error: "Failed to load history", detail: e?.message || String(e) }, 500);
  }
}


app.http("adminCompanies", {
  route: "xadmin-api-companies/{id?}",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  authLevel: "anonymous",
  handler: (req, context) => adminCompaniesHandler(req, context),
});

module.exports._test = {
  adminCompaniesHandler,
  adminCompanyHistoryFallbackHandler,
};
