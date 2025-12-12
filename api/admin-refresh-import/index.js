const { app } = require("@azure/functions");
const { CosmosClient } = require("@azure/cosmos");
const axios = require("axios");
const { getXAIEndpoint, getXAIKey } = require("../_shared");

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
    },
    body: JSON.stringify(obj),
  };
}

function isBlank(val) {
  if (val === null || val === undefined) return true;
  if (typeof val === "string" && !val.trim()) return true;
  if (Array.isArray(val) && val.length === 0) return true;
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
    console.error("[admin-refresh-import] Failed to create Cosmos client:", e?.message || e);
    return null;
  }
}

function clampTimeoutMs(value, fallbackMs) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallbackMs;
  return Math.min(Math.max(Math.floor(n), 5000), 30000);
}

async function geocodeHeadquarters(headquarters_location, timeoutMs) {
  const address = String(headquarters_location || "").trim();
  if (!address) return { hq_lat: undefined, hq_lng: undefined };

  const key = env("GOOGLE_MAPS_KEY", "");
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
    console.warn("[admin-refresh-import] Geocode failed:", e?.message || e);
  }

  return { hq_lat: undefined, hq_lng: undefined };
}

function normalizeReviewCandidate(r) {
  const url = String(r?.url || r?.source_url || "").trim();
  const text = String(r?.text || r?.excerpt || "").trim();
  const title = String(r?.title || "").trim();

  if (!url && !text && !title) return null;

  const ratingRaw = r?.rating;
  const rating =
    typeof ratingRaw === "number" && Number.isFinite(ratingRaw) ? Number(ratingRaw) : null;

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

app.http("adminRefreshImport", {
  route: "xadmin-api-refresh-import",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    const startedAt = Date.now();
    const method = String(req.method || "").toUpperCase();

    if (method === "OPTIONS") {
      return json({}, 204);
    }

    if (method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    const traceId =
      String(req.query?.trace || req.query?.trace_id || "").trim() ||
      `trace_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const container = getCompaniesContainer();
    if (!container) {
      return json({ ok: false, trace_id: traceId, error: "Cosmos DB not configured" }, 503);
    }

    let body = {};
    try {
      body = await req.json();
    } catch (e) {
      return json({ ok: false, trace_id: traceId, error: "Invalid JSON", detail: e?.message }, 400);
    }

    const companyId = String(body.company_id || body.id || "").trim();
    const hintDomain = String(body.normalized_domain || "").trim();
    const hintName = String(body.company_name || "").trim();

    if (!companyId && !hintDomain && !hintName) {
      return json(
        { ok: false, trace_id: traceId, error: "company_id or (normalized_domain/company_name) required" },
        400
      );
    }

    const xaiUrl = getXAIEndpoint();
    const xaiKey = getXAIKey();

    if (!xaiUrl || !xaiKey) {
      return json({ ok: false, trace_id: traceId, error: "XAI not configured" }, 500);
    }

    const timeoutMs = clampTimeoutMs(body.timeout_ms, 25000);

    try {
      let companyDoc = null;

      if (companyId) {
        const queryById = {
          query: "SELECT * FROM c WHERE c.id = @id",
          parameters: [{ name: "@id", value: companyId }],
        };
        const { resources } = await container.items
          .query(queryById, { enableCrossPartitionQuery: true })
          .fetchAll();
        if (resources?.length) companyDoc = resources[0];
      }

      if (!companyDoc && hintDomain && hintName) {
        const queryByDomainAndName = {
          query:
            "SELECT * FROM c WHERE c.normalized_domain = @domain AND LOWER(c.company_name) = @name",
          parameters: [
            { name: "@domain", value: hintDomain },
            { name: "@name", value: hintName.toLowerCase() },
          ],
        };
        const { resources } = await container.items
          .query(queryByDomainAndName, { enableCrossPartitionQuery: true })
          .fetchAll();
        if (resources?.length) companyDoc = resources[0];
      }

      if (!companyDoc && hintDomain) {
        const queryByDomain = {
          query: "SELECT * FROM c WHERE c.normalized_domain = @domain",
          parameters: [{ name: "@domain", value: hintDomain }],
        };
        const { resources } = await container.items
          .query(queryByDomain, { enableCrossPartitionQuery: true })
          .fetchAll();
        if (resources?.length) companyDoc = resources[0];
      }

      if (!companyDoc && hintName) {
        const queryByName = {
          query: "SELECT * FROM c WHERE LOWER(c.company_name) = @name",
          parameters: [{ name: "@name", value: hintName.toLowerCase() }],
        };
        const { resources } = await container.items
          .query(queryByName, { enableCrossPartitionQuery: true })
          .fetchAll();
        if (resources?.length) companyDoc = resources[0];
      }

      if (!companyDoc) {
        return json({ ok: false, trace_id: traceId, error: "Company not found" }, 404);
      }

      const snapshot = {
        company_name: companyDoc.company_name || companyDoc.name || "",
        website_url: companyDoc.website_url || companyDoc.canonical_url || companyDoc.url || "",
        tagline: companyDoc.tagline || "",
        description: companyDoc.description || "",
        industries: companyDoc.industries || [],
        product_keywords: companyDoc.product_keywords || [],
        normalized_domain:
          companyDoc.normalized_domain ||
          toNormalizedDomain(companyDoc.website_url || companyDoc.canonical_url || companyDoc.url || ""),
        headquarters_location: companyDoc.headquarters_location || "",
        manufacturing_locations: companyDoc.manufacturing_locations || [],
        location_sources: companyDoc.location_sources || [],
        social: companyDoc.social || {},
        amazon_url: companyDoc.amazon_url || "",
      };

      const message = {
        role: "user",
        content: `You are a business research assistant refreshing data for ONE EXISTING COMPANY.

You are given a snapshot of the current stored data:
${JSON.stringify(snapshot, null, 2)}

Your job:
- Perform an exhaustive, deep search across the internet for this specific company (official site, LinkedIn, Crunchbase, Google Maps, major retailers, marketplaces, etc.).
- ONLY FILL FIELDS THAT ARE CURRENTLY EMPTY OR MISSING in the snapshot.
- DO NOT change or contradict existing non-empty values.

Also, find up to 2 recent, high-quality reviews (not duplicates) from reputable sources.

OUTPUT FORMAT:
Return a single JSON object with ONLY the following top-level keys. For each key, either provide the new value or null if you found nothing credible:
{
  "tagline": string | null,
  "description": string | null,
  "industries": string[] | null,
  "product_keywords": string[] | string | null,
  "website_url": string | null,
  "canonical_website": string | null,
  "headquarters_location": string | null,
  "manufacturing_locations": string[] | string | null,
  "location_sources": Array<{ location: string; source_url: string; source_type: string; location_type: string }> | null,
  "social": {
    "linkedin"?: string | null,
    "instagram"?: string | null,
    "x"?: string | null,
    "twitter"?: string | null,
    "facebook"?: string | null,
    "tiktok"?: string | null,
    "youtube"?: string | null
  } | null,
  "amazon_url": string | null,
  "fresh_reviews": Array<{
    "source": "google"|"amazon"|"yelp"|"trustpilot"|"retailer"|"other",
    "platform": string,
    "url": string,
    "text": string,
    "rating": number|null,
    "review_date": string|null
  }> | null
}

Rules:
- Never fabricate precise street addresses.
- Respect existing non-empty values.
- If you cannot confidently find new information for a field, return null for that field.
- Return ONLY the JSON object.`,
      };

      const xaiPayload = {
        messages: [message],
        model: "grok-4-latest",
        temperature: 0.2,
        stream: false,
      };

      let delta = {};
      try {
        const res = await axios.post(xaiUrl, xaiPayload, {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${xaiKey}`,
          },
          timeout: timeoutMs,
        });

        if (res.status < 200 || res.status >= 300) {
          return json(
            {
              ok: false,
              trace_id: traceId,
              error: `XAI returned ${res.status}`,
              detail: res.statusText,
            },
            502
          );
        }

        const responseText = res.data?.choices?.[0]?.message?.content || "";
        const objMatch = responseText.match(/\{[\s\S]*\}/);
        if (objMatch) {
          try {
            delta = JSON.parse(objMatch[0]);
          } catch (e) {
            delta = {};
            context.log("[admin-refresh-import] Failed to parse XAI JSON", { traceId, err: e?.message });
          }
        }
      } catch (e) {
        return json(
          { ok: false, trace_id: traceId, error: `XAI call failed: ${e?.message || e}` },
          502
        );
      }

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
      if (
        (updated.hq_lat === undefined || updated.hq_lat === null || updated.hq_lng === undefined || updated.hq_lng === null) &&
        updated.headquarters_location &&
        String(updated.headquarters_location).trim()
      ) {
        const geo = await geocodeHeadquarters(String(updated.headquarters_location), timeoutMs);
        if (geo.hq_lat !== undefined && geo.hq_lng !== undefined) {
          updated.hq_lat = geo.hq_lat;
          updated.hq_lng = geo.hq_lng;
          geoUpdated = true;
        }
      }
      if (geoUpdated) updatedFieldCount++;

      let newReviewCount = 0;
      try {
        const incoming = Array.isArray(delta.fresh_reviews) ? delta.fresh_reviews : [];
        const candidates = incoming.map(normalizeReviewCandidate).filter(Boolean).slice(0, 2);

        const existingCurated = Array.isArray(updated.curated_reviews) ? updated.curated_reviews : [];
        const existingKeys = new Set(
          existingCurated
            .map((r) => `${String(r.source_url || r.url || "").toLowerCase()}|${String(r.title || r.excerpt || "").toLowerCase()}`)
            .filter(Boolean)
        );

        const nowIso = new Date().toISOString();
        const freshCurated = [];

        for (const r of candidates) {
          const sourceUrl = String(r.url || "").trim();
          const excerpt = String(r.text || "").trim();
          const title = String(r.title || "").trim() || excerpt.slice(0, 80);

          const key = `${sourceUrl.toLowerCase()}|${(title || excerpt).toLowerCase()}`;
          if (!key.trim()) continue;
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

          if (freshCurated.length >= 2) break;
        }

        if (freshCurated.length) {
          updated.curated_reviews = existingCurated.concat(freshCurated);
          newReviewCount = freshCurated.length;
        }
      } catch (e) {
        context.log("[admin-refresh-import] review merge failed", { traceId, err: e?.message || e });
      }

      const partitionKeyValue = String(
        updated.normalized_domain ||
          toNormalizedDomain(updated.website_url || updated.canonical_url || updated.url || "") ||
          "unknown"
      ).trim();
      updated.normalized_domain = partitionKeyValue || "unknown";
      updated.updated_at = new Date().toISOString();

      try {
        try {
          await container.items.upsert(updated, { partitionKey: partitionKeyValue || "unknown" });
        } catch (upsertError) {
          context.log("[admin-refresh-import] Upsert with partition key failed, retrying", {
            traceId,
            msg: upsertError?.message,
          });
          await container.items.upsert(updated);
        }
      } catch (e) {
        return json(
          { ok: false, trace_id: traceId, error: "Failed to save refreshed company", detail: e?.message },
          500
        );
      }

      const elapsedMs = Date.now() - startedAt;
      return json({
        ok: true,
        trace_id: traceId,
        elapsed_ms: elapsedMs,
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
          trace_id: traceId,
          error: e?.message || "Internal error",
          elapsed_ms: Date.now() - startedAt,
        },
        500
      );
    }
  },
});
