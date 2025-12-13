const { app } = require("@azure/functions");
const { CosmosClient } = require("@azure/cosmos");
const axios = require("axios");
const { geocodeLocationArray, pickPrimaryLatLng } = require("../_geocode");

function env(k, d = "") {
  const v = process.env[k];
  return (v == null ? d : String(v)).trim();
}

function json(obj, status = 200, extraHeaders) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-functions-key",
      ...(extraHeaders || {}),
    },
    body: JSON.stringify(obj),
  };
}

function newTraceId(req) {
  const fromQuery = String(req.query?.trace || req.query?.trace_id || "").trim();
  if (fromQuery) return fromQuery;
  return `trace_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function isBlank(val) {
  if (val === null || val === undefined) return true;
  if (typeof val === "string" && !val.trim()) return true;
  if (Array.isArray(val) && val.length === 0) return true;
  if (typeof val === "object" && Object.keys(val).length === 0) return true;
  return false;
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

function toStringArray(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(/[,;|]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function clampTimeoutMs(value, fallbackMs) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallbackMs;
  return Math.min(Math.max(Math.floor(n), 5000), 30000);
}

function getCompaniesContainer(context) {
  const endpoint = env("COSMOS_DB_ENDPOINT", "");
  const key = env("COSMOS_DB_KEY", "");
  const database = env("COSMOS_DB_DATABASE", "tabarnam-db");
  const container = env("COSMOS_DB_COMPANIES_CONTAINER", "companies");

  if (!endpoint || !key) return null;

  try {
    const client = new CosmosClient({ endpoint, key });
    return client.database(database).container(container);
  } catch (e) {
    context.log("[admin-refresh-import] Failed to create Cosmos client", {
      message: e?.message || String(e),
    });
    return null;
  }
}

async function geocodeHeadquarters(headquarters_location, timeoutMs, context) {
  const address = String(headquarters_location || "").trim();
  if (!address) return { hq_lat: undefined, hq_lng: undefined };

  const key = env("GOOGLE_MAPS_KEY", "") || env("GOOGLE_GEOCODE_KEY", "");
  if (!key) return { hq_lat: undefined, hq_lng: undefined };

  try {
    const url = "https://maps.googleapis.com/maps/api/geocode/json";
    const res = await axios.get(url, {
      params: {
        address,
        key,
      },
      timeout: Math.min(timeoutMs, 8000),
    });

    const loc = res?.data?.results?.[0]?.geometry?.location;
    const lat = Number(loc?.lat);
    const lng = Number(loc?.lng);

    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return { hq_lat: lat, hq_lng: lng };
    }
  } catch (e) {
    context.log("[admin-refresh-import] Geocode failed", {
      message: e?.message || String(e),
    });
  }

  return { hq_lat: undefined, hq_lng: undefined };
}

function normalizeReviewCandidate(r) {
  const url = String(r?.url || r?.source_url || "").trim();
  const text = String(r?.text || r?.excerpt || "").trim();
  const title = String(r?.title || "").trim();

  if (!url && !text && !title) return null;

  const ratingRaw = r?.rating;
  const rating = typeof ratingRaw === "number" && Number.isFinite(ratingRaw) ? Number(ratingRaw) : null;

  const reviewDate = String(r?.review_date || r?.date || "").trim() || null;

  return {
    source: String(r?.source || r?.platform || "external_review").trim() || "external_review",
    platform: String(r?.platform || "").trim() || null,
    url: url || null,
    text: text || null,
    title: title || null,
    rating,
    review_date: reviewDate,
  };
}

function buildDeltaFromBody(body) {
  const candidate = body && typeof body === "object" ? body : {};
  const nested = candidate.delta && typeof candidate.delta === "object" ? candidate.delta : null;
  const direct = {
    tagline: candidate.tagline,
    description: candidate.description,
    industries: candidate.industries,
    product_keywords: candidate.product_keywords,
    website_url: candidate.website_url,
    canonical_website: candidate.canonical_website,
    headquarters_location: candidate.headquarters_location,
    manufacturing_locations: candidate.manufacturing_locations,
    location_sources: candidate.location_sources,
    social: candidate.social,
    amazon_url: candidate.amazon_url,
    normalized_domain: candidate.normalized_domain,
  };

  return {
    ...(direct || {}),
    ...(nested || {}),
  };
}

async function findCompany(container, { companyId, hintDomain, hintName }) {
  if (companyId) {
    const queryById = {
      query: "SELECT * FROM c WHERE c.id = @id",
      parameters: [{ name: "@id", value: companyId }],
    };
    const { resources } = await container.items.query(queryById, { enableCrossPartitionQuery: true }).fetchAll();
    if (resources?.length) return resources[0];
  }

  if (hintDomain && hintName) {
    const queryByDomainAndName = {
      query: "SELECT * FROM c WHERE c.normalized_domain = @domain AND LOWER(c.company_name) = @name",
      parameters: [
        { name: "@domain", value: hintDomain },
        { name: "@name", value: hintName.toLowerCase() },
      ],
    };
    const { resources } = await container.items
      .query(queryByDomainAndName, { enableCrossPartitionQuery: true })
      .fetchAll();
    if (resources?.length) return resources[0];
  }

  if (hintDomain) {
    const queryByDomain = {
      query: "SELECT * FROM c WHERE c.normalized_domain = @domain",
      parameters: [{ name: "@domain", value: hintDomain }],
    };
    const { resources } = await container.items.query(queryByDomain, { enableCrossPartitionQuery: true }).fetchAll();
    if (resources?.length) return resources[0];
  }

  if (hintName) {
    const queryByName = {
      query: "SELECT * FROM c WHERE LOWER(c.company_name) = @name",
      parameters: [{ name: "@name", value: hintName.toLowerCase() }],
    };
    const { resources } = await container.items.query(queryByName, { enableCrossPartitionQuery: true }).fetchAll();
    if (resources?.length) return resources[0];
  }

  return null;
}

function createHandler(routeName) {
  return async (req, context) => {
    const startedAt = Date.now();
    const method = String(req.method || "").toUpperCase();

    if (method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, x-functions-key",
        },
      };
    }

    const traceId = newTraceId(req);

    if (method !== "POST") {
      return json(
        {
          ok: false,
          route: routeName,
          trace_id: traceId,
          error: "Method not allowed",
          elapsed_ms: Date.now() - startedAt,
        },
        405
      );
    }

    const container = getCompaniesContainer(context);
    if (!container) {
      return json(
        {
          ok: false,
          route: routeName,
          trace_id: traceId,
          error: "Cosmos DB not configured",
          elapsed_ms: Date.now() - startedAt,
        },
        503
      );
    }

    let body = {};
    try {
      body = await req.json();
    } catch (e) {
      return json(
        {
          ok: false,
          route: routeName,
          trace_id: traceId,
          error: "Invalid JSON",
          detail: e?.message || String(e),
          elapsed_ms: Date.now() - startedAt,
        },
        400
      );
    }

    const companyId = String(body.company_id || body.id || "").trim();
    const hintDomain = String(body.normalized_domain || "").trim();
    const hintName = String(body.company_name || "").trim();

    if (!companyId && !hintDomain && !hintName) {
      return json(
        {
          ok: false,
          route: routeName,
          trace_id: traceId,
          error: "company_id or (normalized_domain/company_name) required",
          elapsed_ms: Date.now() - startedAt,
        },
        400
      );
    }

    const timeoutMs = clampTimeoutMs(body.timeout_ms, 25000);

    try {
      const companyDoc = await findCompany(container, { companyId, hintDomain, hintName });
      if (!companyDoc) {
        return json(
          {
            ok: false,
            route: routeName,
            trace_id: traceId,
            error: "Company not found",
            elapsed_ms: Date.now() - startedAt,
          },
          404
        );
      }

      const delta = buildDeltaFromBody(body);
      const updated = { ...companyDoc };
      let updatedFieldCount = 0;

      const applyStringField = (field, value) => {
        if (typeof value !== "string" || !value.trim()) return;
        if (isBlank(updated[field])) {
          updated[field] = value.trim();
          updatedFieldCount++;
        }
      };

      applyStringField("tagline", delta.tagline);
      applyStringField("description", delta.description);

      const newIndustries = Array.isArray(delta.industries)
        ? delta.industries.map((v) => String(v).trim()).filter(Boolean)
        : [];
      if ((Array.isArray(updated.industries) ? updated.industries.length : 0) === 0 && newIndustries.length) {
        updated.industries = newIndustries;
        updatedFieldCount++;
      }

      const newKeywordsArray = toStringArray(delta.product_keywords);
      const existingKeywordsEmpty =
        isBlank(updated.product_keywords) ||
        (Array.isArray(updated.product_keywords) && updated.product_keywords.length === 0);
      if (existingKeywordsEmpty && newKeywordsArray.length) {
        updated.product_keywords = newKeywordsArray;
        updatedFieldCount++;
      }

      const websiteCandidate =
        (typeof delta.canonical_website === "string" && delta.canonical_website.trim()) ||
        (typeof delta.website_url === "string" && delta.website_url.trim()) ||
        null;
      if (websiteCandidate) {
        applyStringField("website_url", websiteCandidate);
        applyStringField("url", websiteCandidate);
      }

      const domainCandidate =
        (typeof delta.normalized_domain === "string" && delta.normalized_domain.trim()) ||
        (websiteCandidate ? toNormalizedDomain(websiteCandidate) : null);
      if (domainCandidate && (isBlank(updated.normalized_domain) || updated.normalized_domain === "unknown")) {
        updated.normalized_domain = domainCandidate;
        updatedFieldCount++;
      }

      applyStringField("headquarters_location", delta.headquarters_location);

      const newMfgArray = toStringArray(delta.manufacturing_locations);
      if ((!Array.isArray(updated.manufacturing_locations) || updated.manufacturing_locations.length === 0) && newMfgArray.length) {
        updated.manufacturing_locations = newMfgArray;
        updatedFieldCount++;
      }

      const newLocationSources = Array.isArray(delta.location_sources)
        ? delta.location_sources
            .filter((s) => s && s.location)
            .map((s) => ({
              location: String(s.location || "").trim(),
              source_url: String(s.source_url || "").trim(),
              source_type: String(s.source_type || "other"),
              location_type: String(s.location_type || "other"),
            }))
            .filter((s) => s.location)
        : [];
      if ((!Array.isArray(updated.location_sources) || updated.location_sources.length === 0) && newLocationSources.length) {
        updated.location_sources = newLocationSources;
        updatedFieldCount++;
      }

      const incomingSocial = delta.social && typeof delta.social === "object" ? delta.social : {};
      if (!updated.social || typeof updated.social !== "object") updated.social = {};
      for (const key of ["linkedin", "instagram", "x", "twitter", "facebook", "tiktok", "youtube"]) {
        const candidate = incomingSocial[key];
        if (typeof candidate === "string" && candidate.trim() && isBlank(updated.social[key])) {
          updated.social[key] = candidate.trim();
          updatedFieldCount++;
        }
      }

      applyStringField("amazon_url", delta.amazon_url);

      let geoUpdated = false;
      try {
        let headquarters_locations = Array.isArray(updated.headquarters_locations)
          ? updated.headquarters_locations
          : Array.isArray(updated.headquarters)
            ? updated.headquarters
            : [];

        if (updated.headquarters_location && String(updated.headquarters_location).trim()) {
          const primaryAddr = String(updated.headquarters_location).trim();
          const alreadyHasPrimary = headquarters_locations.some((hq) => {
            if (!hq) return false;
            if (typeof hq === "string") return hq.trim() === primaryAddr;
            return typeof hq.address === "string" && String(hq.address).trim() === primaryAddr;
          });
          if (!alreadyHasPrimary) {
            headquarters_locations = [{ address: primaryAddr }, ...headquarters_locations];
          }
        }

        const manufacturingBase =
          Array.isArray(updated.manufacturing_geocodes) && updated.manufacturing_geocodes.length > 0
            ? updated.manufacturing_geocodes
            : Array.isArray(updated.manufacturing_locations)
              ? updated.manufacturing_locations
                  .map((loc) => ({ address: String(loc || "").trim() }))
                  .filter((l) => l.address)
              : [];

        const [headquarters, manufacturing_geocodes] = await Promise.all([
          geocodeLocationArray(headquarters_locations, { timeoutMs, concurrency: 4 }),
          geocodeLocationArray(manufacturingBase, { timeoutMs, concurrency: 4 }),
        ]);

        if (headquarters.length) {
          updated.headquarters = headquarters;
          updated.headquarters_locations = headquarters;
          geoUpdated = true;
        }

        if (manufacturing_geocodes.length) {
          updated.manufacturing_geocodes = manufacturing_geocodes;
          geoUpdated = true;
        }

        const primary = pickPrimaryLatLng(headquarters);
        if (primary && (!Number.isFinite(updated.hq_lat) || !Number.isFinite(updated.hq_lng))) {
          updated.hq_lat = primary.lat;
          updated.hq_lng = primary.lng;
          geoUpdated = true;
        }
      } catch (e) {
        context.log("[admin-refresh-import] Per-location geocode failed", { message: e?.message || String(e) });
      }

      if (geoUpdated) updatedFieldCount++;

      let newReviewCount = 0;
      try {
        const incomingTopLevel = Array.isArray(body.fresh_reviews) ? body.fresh_reviews : [];
        const incomingDelta = Array.isArray(delta.fresh_reviews) ? delta.fresh_reviews : [];

        const candidates = incomingTopLevel
          .concat(incomingDelta)
          .map(normalizeReviewCandidate)
          .filter(Boolean);

        const existingCurated = Array.isArray(updated.curated_reviews) ? updated.curated_reviews : [];
        const existingKeys = new Set(
          existingCurated
            .map((r) => {
              const u = String(r.source_url || r.url || "").toLowerCase().trim();
              const t = String(r.title || r.excerpt || r.text || "").toLowerCase().trim();
              return `${u}|${t}`;
            })
            .filter((k) => k && k !== "|")
        );

        const nowIso = new Date().toISOString();
        const freshCurated = [];
        const maxNewReviews = 10;

        for (const r of candidates) {
          const sourceUrl = String(r.url || "").trim();
          const excerpt = String(r.text || "").trim();
          const title = String(r.title || "").trim() || excerpt.slice(0, 80);

          const key = `${sourceUrl.toLowerCase()}|${(title || excerpt).toLowerCase()}`;
          if (!key.trim() || key === "|") continue;
          if (existingKeys.has(key)) continue;
          existingKeys.add(key);

          freshCurated.push({
            id: `admin_refresh_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            source: r.source || "external_review",
            source_url: sourceUrl,
            title,
            excerpt,
            rating: r.rating,
            author: "",
            date: r.review_date,
            created_at: nowIso,
            last_updated_at: nowIso,
            imported_via: "admin_refresh_import",
          });

          if (freshCurated.length >= maxNewReviews) break;
        }

        if (freshCurated.length) {
          updated.curated_reviews = existingCurated.concat(freshCurated);
          newReviewCount = freshCurated.length;
        }
      } catch (e) {
        context.log("[admin-refresh-import] review merge failed", {
          trace_id: traceId,
          message: e?.message || String(e),
        });
      }

      const partitionKeyValue = String(
        updated.normalized_domain || toNormalizedDomain(updated.website_url || updated.canonical_url || updated.url || "") || "unknown"
      ).trim();
      updated.normalized_domain = partitionKeyValue || "unknown";
      updated.updated_at = new Date().toISOString();

      try {
        try {
          await container.items.upsert(updated, { partitionKey: partitionKeyValue || "unknown" });
        } catch (upsertError) {
          context.log("[admin-refresh-import] Upsert with partition key failed, retrying", {
            trace_id: traceId,
            message: upsertError?.message || String(upsertError),
          });
          await container.items.upsert(updated);
        }
      } catch (e) {
        return json(
          {
            ok: false,
            route: routeName,
            trace_id: traceId,
            error: "Failed to save refreshed company",
            detail: e?.message || String(e),
            elapsed_ms: Date.now() - startedAt,
          },
          500
        );
      }

      return json({
        ok: true,
        route: routeName,
        trace_id: traceId,
        elapsed_ms: Date.now() - startedAt,
        company: updated,
        summary: {
          updated_field_count: updatedFieldCount,
          new_review_count: newReviewCount,
        },
      });
    } catch (e) {
      return json(
        {
          ok: false,
          route: routeName,
          trace_id: traceId,
          error: e?.message || "Internal error",
          elapsed_ms: Date.now() - startedAt,
        },
        500
      );
    }
  };
}

app.http("adminRefreshImport", {
  route: "xadmin-api-refresh-import",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: createHandler("xadmin-api-refresh-import"),
});

app.http("adminRefreshImportAlias", {
  route: "admin-refresh-import",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: createHandler("admin-refresh-import"),
});

app.http("adminRefreshImportAdminSlash", {
  route: "admin/refresh-import",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: createHandler("admin/refresh-import"),
});
