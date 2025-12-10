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

function isBlank(val) {
  if (val === null || val === undefined) return true;
  if (typeof val === "string" && !val.trim()) return true;
  if (Array.isArray(val) && val.length === 0) return true;
  return false;
}

function toStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[,;|]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

async function geocodeHQLocation(headquarters_location) {
  if (!headquarters_location || headquarters_location.trim() === "") {
    return { hq_lat: undefined, hq_lng: undefined };
  }

  try {
    const proxyBase = (process.env.XAI_EXTERNAL_BASE || process.env.XAI_PROXY_BASE || "").trim();
    const baseUrl = proxyBase ? `${proxyBase.replace(/\/api$/, "")}/api` : "/api";
    const geocodeUrl = `${baseUrl}/google/geocode`;

    const response = await axios.post(
      geocodeUrl,
      {
        address: headquarters_location,
        ipLookup: false,
      },
      {
        timeout: 5000,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    if (response.data && response.data.best && response.data.best.location) {
      const { lat, lng } = response.data.best.location;
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        return { hq_lat: lat, hq_lng: lng };
      }
    }
  } catch (e) {
    console.log(`[admin-refresh-import] Geocoding failed for "${headquarters_location}": ${e.message}`);
  }

  return { hq_lat: undefined, hq_lng: undefined };
}

async function fetchFreshReviews(company, xaiUrl, xaiKey, timeout) {
  const name = (company.company_name || company.name || "").trim();
  const website = (company.website_url || company.url || "").trim();

  if (!name && !website) {
    return [];
  }

  try {
    const message = {
      role: "user",
      content: `You are a research assistant finding recent, high-quality reviews for a single company.

Company name: ${name || "(unknown)"}
Company website: ${website || "(unknown)"}

Search broadly across the public internet for up to 2 of the most recent, high-quality reviews of this company or its primary products.

Allowed review sources include:
- Google Maps / Google Business
- Amazon product reviews
- Yelp, Trustpilot, G2, Capterra, App Store, Play Store
- Major retailer product reviews (Target, Walmart, Costco, etc.)
- Other reputable review platforms or marketplaces

For each review you find, return an object with:
{
  "source": "google|amazon|yelp|trustpilot|retailer|other",
  "platform": "Google Maps" (human-readable source label),
  "url": "https://example.com/review-or-listing",
  "text": "short 1-3 sentence summary of the review in your own words",
  "rating": number or null,
  "review_date": "YYYY-MM-DD" or null
}

Return ONLY a JSON array with 0-2 review objects. If you find nothing credible, return an empty array [].`,
    };

    const payload = {
      messages: [message],
      model: "grok-4-latest",
      temperature: 0.2,
      stream: false,
    };

    const res = await axios.post(xaiUrl, payload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${xaiKey}`,
      },
      timeout,
    });

    if (res.status < 200 || res.status >= 300) {
      console.warn("[admin-refresh-import] Fresh review fetch non-2xx:", res.status);
      return [];
    }

    const responseText = res.data?.choices?.[0]?.message?.content || "";
    let arr = [];
    try {
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        arr = JSON.parse(jsonMatch[0]);
        if (!Array.isArray(arr)) arr = [];
      }
    } catch (e) {
      console.warn("[admin-refresh-import] Failed to parse fresh reviews:", e.message);
      arr = [];
    }

    return arr
      .filter((r) => r && (r.text || r.excerpt || r.url))
      .slice(0, 2);
  } catch (e) {
    console.warn("[admin-refresh-import] Error fetching fresh reviews:", e.message);
    return [];
  }
}

app.http("adminRefreshImport", {
  route: "xadmin-api-refresh-import",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    const method = String(req.method || "").toUpperCase();

    if (method === "OPTIONS") {
      return json({}, 204);
    }

    if (method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const container = getCompaniesContainer();
    if (!container) {
      return json({ error: "Cosmos DB not configured" }, 503);
    }

    let body = {};
    try {
      body = await req.json();
    } catch (e) {
      return json({ error: "Invalid JSON", detail: e?.message }, 400);
    }

    const companyId = String(body.company_id || body.id || "").trim();
    const hintDomain = String(body.normalized_domain || "").trim();
    const hintName = String(body.company_name || "").trim();

    if (!companyId && !hintDomain && !hintName) {
      return json({ error: "company_id or (normalized_domain and company_name) required" }, 400);
    }

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
        if (resources && resources.length > 0) {
          companyDoc = resources[0];
        }
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
        if (resources && resources.length > 0) {
          companyDoc = resources[0];
        }
      }

      if (!companyDoc && hintDomain) {
        const queryByDomain = {
          query: "SELECT * FROM c WHERE c.normalized_domain = @domain",
          parameters: [{ name: "@domain", value: hintDomain }],
        };
        const { resources } = await container.items
          .query(queryByDomain, { enableCrossPartitionQuery: true })
          .fetchAll();
        if (resources && resources.length > 0) {
          companyDoc = resources[0];
        }
      }

      if (!companyDoc && hintName) {
        const queryByName = {
          query: "SELECT * FROM c WHERE LOWER(c.company_name) = @name",
          parameters: [{ name: "@name", value: hintName.toLowerCase() }],
        };
        const { resources } = await container.items
          .query(queryByName, { enableCrossPartitionQuery: true })
          .fetchAll();
        if (resources && resources.length > 0) {
          companyDoc = resources[0];
        }
      }

      if (!companyDoc) {
        return json({ error: "Company not found" }, 404);
      }

      const xaiUrl = getXAIEndpoint();
      const xaiKey = getXAIKey();

      if (!xaiUrl || !xaiKey) {
        return json({ error: "XAI not configured" }, 500);
      }

      const timeout = Math.min(Number(body.timeout_ms) || 90000, 180000);

      const snapshot = {
        company_name: companyDoc.company_name || companyDoc.name || "",
        website_url:
          companyDoc.website_url || companyDoc.canonical_url || companyDoc.url || "",
        tagline: companyDoc.tagline || "",
        description: companyDoc.description || "",
        industries: companyDoc.industries || [],
        product_keywords: companyDoc.product_keywords || [],
        normalized_domain:
          companyDoc.normalized_domain ||
          toNormalizedDomain(
            companyDoc.website_url || companyDoc.canonical_url || companyDoc.url || ""
          ),
        headquarters_location: companyDoc.headquarters_location || "",
        manufacturing_locations: companyDoc.manufacturing_locations || [],
        location_sources: companyDoc.location_sources || [],
        social: companyDoc.social || {},
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

Focus on filling or enriching the following fields IF they are empty or missing:
- tagline (short brand tagline or slogan)
- description (1-3 sentence description of the company)
- industries (array of industry labels)
- product_keywords (array or comma-separated keywords describing products)
- website_url / canonical_website (canonical public website URL)
- headquarters_location (string, e.g. "City, State/Region, Country")
- manufacturing_locations (array of locations or countries)
- location_sources (array of objects { location, source_url, source_type, location_type })
- social URLs (linkedin, instagram, x/twitter, facebook, tiktok, youtube)
- amazon_url or other marketplace URLs if clearly associated with the brand

IMPORTANT RULES:
- Never fabricate precise street addresses. City + region + country or country-only is acceptable when that is all that is confidently known.
- Respect existing non-empty values in the snapshot. If a value is non-empty, keep it as-is and do not attempt to override it.
- If you cannot confidently find new information for a field, return null for that field.

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
  "amazon_url": string | null
}

Return ONLY this JSON object, with nulls for any fields you could not improve.`,
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
          timeout,
        });

        if (res.status < 200 || res.status >= 300) {
          return json(
            { error: `XAI returned ${res.status}`, detail: res.statusText },
            502
          );
        }

        const responseText = res.data?.choices?.[0]?.message?.content || "";
        try {
          const objMatch = responseText.match(/\{[\s\S]*\}/);
          if (objMatch) {
            delta = JSON.parse(objMatch[0]);
          }
        } catch (e) {
          console.warn("[admin-refresh-import] Failed to parse XAI refresh JSON:", e.message);
          delta = {};
        }
      } catch (e) {
        console.error("[admin-refresh-import] XAI deep refresh call failed:", e.message);
        return json({ error: `XAI call failed: ${e.message}` }, 502);
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
      if ((Array.isArray(updated.industries) ? updated.industries.length : 0) === 0 && newIndustries.length > 0) {
        updated.industries = newIndustries;
        updatedFieldCount++;
      }

      const newKeywordsArray = toStringArray(delta.product_keywords);
      const existingKeywordsEmpty = isBlank(updated.product_keywords) ||
        (Array.isArray(updated.product_keywords) && updated.product_keywords.length === 0);
      if (existingKeywordsEmpty && newKeywordsArray.length > 0) {
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
      if (
        domainCandidate &&
        (isBlank(updated.normalized_domain) || updated.normalized_domain === "unknown")
      ) {
        updated.normalized_domain = domainCandidate;
        updatedFieldCount++;
      }

      applyStringField("headquarters_location", delta.headquarters_location);

      const newMfgArray = toStringArray(delta.manufacturing_locations);
      if (
        (!Array.isArray(updated.manufacturing_locations) ||
          updated.manufacturing_locations.length === 0) &&
        newMfgArray.length > 0
      ) {
        updated.manufacturing_locations = newMfgArray;
        updatedFieldCount++;
      }

      const newLocationSources = Array.isArray(delta.location_sources)
        ? delta.location_sources
            .filter((s) => s && s.location)
            .map((s) => ({
              location: String(s.location || "").trim(),
              source_url: String(s.source_url || "").trim(),
              source_type: s.source_type || "other",
              location_type: s.location_type || "other",
            }))
        : [];
      if (
        (!Array.isArray(updated.location_sources) ||
          updated.location_sources.length === 0) &&
        newLocationSources.length > 0
      ) {
        updated.location_sources = newLocationSources;
        updatedFieldCount++;
      }

      const incomingSocial = delta.social && typeof delta.social === "object" ? delta.social : {};
      if (!updated.social || typeof updated.social !== "object") {
        updated.social = {};
      }
      const socialKeys = [
        "linkedin",
        "instagram",
        "x",
        "twitter",
        "facebook",
        "tiktok",
        "youtube",
      ];
      for (const key of socialKeys) {
        const candidate = incomingSocial[key];
        if (typeof candidate === "string" && candidate.trim()) {
          if (isBlank(updated.social[key])) {
            updated.social[key] = candidate.trim();
            updatedFieldCount++;
          }
        }
      }

      applyStringField("amazon_url", delta.amazon_url);

      let geoUpdated = false;
      if (
        (updated.hq_lat === undefined || updated.hq_lat === null ||
          updated.hq_lng === undefined || updated.hq_lng === null) &&
        updated.headquarters_location &&
        String(updated.headquarters_location).trim()
      ) {
        const geo = await geocodeHQLocation(String(updated.headquarters_location));
        if (geo.hq_lat !== undefined && geo.hq_lng !== undefined) {
          updated.hq_lat = geo.hq_lat;
          updated.hq_lng = geo.hq_lng;
          geoUpdated = true;
        }
      }
      if (geoUpdated) {
        updatedFieldCount++;
      }

      let newReviewCount = 0;
      try {
        const freshRaw = await fetchFreshReviews(updated, xaiUrl, xaiKey, timeout);
        const existingCurated = Array.isArray(updated.curated_reviews)
          ? updated.curated_reviews
          : [];

        const existingKeys = new Set(
          existingCurated
            .map((r) => {
              const key = `${(r.source_url || r.url || "").toLowerCase()}|${
                (r.title || r.excerpt || "").toLowerCase()
              }`;
              return key;
            })
            .filter(Boolean)
        );

        const nowIso = new Date().toISOString();
        const freshCurated = [];

        for (const r of freshRaw || []) {
          const sourceUrl = String(r.url || r.source_url || "").trim();
          const title = String(r.title || "").trim();
          const excerpt = String(r.text || r.excerpt || "").trim();
          const key = `${sourceUrl.toLowerCase()}|${(title || excerpt).toLowerCase()}`;
          if (!key.trim()) continue;
          if (existingKeys.has(key)) continue;
          existingKeys.add(key);

          freshCurated.push({
            id: `admin_refresh_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            source: r.source || r.platform || "external_review",
            source_url: sourceUrl,
            title: title || excerpt.slice(0, 80),
            excerpt,
            rating:
              typeof r.rating === "number" && Number.isFinite(r.rating)
                ? Number(r.rating)
                : null,
            author: r.author || "",
            date: r.review_date || r.date || null,
            created_at: nowIso,
            last_updated_at: nowIso,
            imported_via: "admin_refresh_import",
          });

          if (freshCurated.length >= 2) break;
        }

        if (freshCurated.length > 0) {
          updated.curated_reviews = existingCurated.concat(freshCurated);
          newReviewCount = freshCurated.length;
        }
      } catch (e) {
        console.warn("[admin-refresh-import] Fresh review enrichment failed:", e.message);
      }

      const partitionKeyValue = String(
        updated.normalized_domain ||
          toNormalizedDomain(
            updated.website_url || updated.canonical_url || updated.url || ""
          ) ||
          "unknown"
      ).trim();
      updated.normalized_domain = partitionKeyValue || "unknown";

      updated.updated_at = new Date().toISOString();

      try {
        let result;
        try {
          result = await container.items.upsert(updated, {
            partitionKey: partitionKeyValue || "unknown",
          });
        } catch (upsertError) {
          context.log(
            "[admin-refresh-import] Upsert with partition key failed, retrying without explicit key",
            upsertError?.message
          );
          result = await container.items.upsert(updated);
        }

        context.log("[admin-refresh-import] Company updated", {
          id: updated.id,
          company_name: updated.company_name,
          statusCode: result?.statusCode,
        });
      } catch (e) {
        context.log("[admin-refresh-import] Failed to save refreshed company:", e?.message);
        return json({ error: "Failed to save refreshed company", detail: e?.message }, 500);
      }

      return json({
        ok: true,
        company: updated,
        summary: {
          updated_field_count: updatedFieldCount,
          new_review_count: newReviewCount,
        },
      });
    } catch (e) {
      context.log("[admin-refresh-import] Unexpected error:", e?.message || e);
      return json({ error: e?.message || "Internal error" }, 500);
    }
  },
});
