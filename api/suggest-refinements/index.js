// api/suggest-refinements/index.js
const { app } = require("@azure/functions");

let CosmosClientCtor = null;
function loadCosmosCtor() {
  if (CosmosClientCtor !== null) return CosmosClientCtor;
  try {
    CosmosClientCtor = require("@azure/cosmos").CosmosClient;
  } catch {
    CosmosClientCtor = undefined;
  }
  return CosmosClientCtor;
}

function env(k, d = "") {
  const v = process.env[k];
  return (v == null ? d : String(v)).trim();
}

function json(obj, status = 200, req) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "content-type,x-functions-key",
    },
    body: JSON.stringify(obj),
  };
}

function getCompaniesContainer() {
  const endpoint = env("COSMOS_DB_ENDPOINT", "");
  const key = env("COSMOS_DB_KEY", "");
  const databaseId = env("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = env("COSMOS_DB_COMPANIES_CONTAINER", "companies");

  if (!endpoint || !key) return null;
  const C = loadCosmosCtor();
  if (!C) return null;

  const client = new C({ endpoint, key });
  return client.database(databaseId).container(containerId);
}

// Extract and count all unique keywords/industries that match query
async function getKeywordRefinements(container, q, country, state, city) {
  const container_ref = container;
  if (!container_ref) return { keywords: [], industries: [] };

  try {
    const q_lower = q.toLowerCase();
    const params = [{ name: "@q", value: q_lower }];

    // Build WHERE clause for location filters
    let locationFilter = "";
    if (country) {
      params.push({ name: "@country", value: country });
      locationFilter += " AND (IS_DEFINED(c.country) AND c.country = @country)";
    }
    if (state) {
      params.push({ name: "@state", value: state });
      locationFilter += " AND (IS_DEFINED(c.state) AND c.state = @state)";
    }
    if (city) {
      params.push({ name: "@city", value: city });
      locationFilter += " AND (IS_DEFINED(c.city) AND CONTAINS(LOWER(c.city), @city))";
    }

    // Query to get all matching companies with their keywords and industries
    const sql = `
      SELECT c.product_keywords, c.industries
      FROM c
      WHERE (
        CONTAINS(LOWER(c.company_name), @q) OR
        CONTAINS(LOWER(c.product_keywords), @q) OR
        ARRAY_LENGTH(
          ARRAY(SELECT VALUE i FROM i IN c.industries WHERE CONTAINS(LOWER(i), @q))
        ) > 0 OR
        CONTAINS(LOWER(c.normalized_domain), @q)
      )
      ${locationFilter}
    `;

    const res = await container_ref.items
      .query({ query: sql, parameters: params }, { enableCrossPartitionQuery: true })
      .fetchAll();

    const companies = res.resources || [];

    // Aggregate keywords and industries with counts
    const keywordMap = {};
    const industryMap = {};

    companies.forEach((company) => {
      // Process product_keywords (comma-separated string)
      if (company.product_keywords && typeof company.product_keywords === "string") {
        const keywords = company.product_keywords
          .split(",")
          .map((k) => k.trim().toLowerCase())
          .filter((k) => k && k !== q_lower);
        keywords.forEach((kw) => {
          keywordMap[kw] = (keywordMap[kw] || 0) + 1;
        });
      }

      // Process industries (array)
      if (Array.isArray(company.industries)) {
        company.industries.forEach((ind) => {
          const normalized = String(ind).trim().toLowerCase();
          if (normalized && normalized !== q_lower) {
            industryMap[normalized] = (industryMap[normalized] || 0) + 1;
          }
        });
      }
    });

    // Convert to sorted arrays
    const keywords = Object.entries(keywordMap)
      .sort((a, b) => b[1] - a[1]) // Sort by frequency (count) descending
      .map(([value, count]) => ({ value, type: "Keyword", count }));

    const industries = Object.entries(industryMap)
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({ value, type: "Industry", count }));

    return { keywords, industries };
  } catch (e) {
    console.error("getKeywordRefinements error:", e?.message || e);
    return { keywords: [], industries: [] };
  }
}

app.http("suggestRefinements", {
  route: "suggest-refinements",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    const method = String(req.method || "").toUpperCase();
    if (method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Access-Control-Allow-Headers": "content-type,x-functions-key",
          "Access-Control-Max-Age": "86400",
        },
      };
    }
    if (method !== "GET") {
      return json({ ok: false, success: false, error: "Method Not Allowed" }, 405, req);
    }

    const url = new URL(req.url);
    const q = (url.searchParams.get("q") || "").trim();
    const country = (url.searchParams.get("country") || "").trim();
    const state = (url.searchParams.get("state") || "").trim();
    const city = (url.searchParams.get("city") || "").trim();

    if (!q || q.length < 2) {
      return json({ ok: true, success: true, suggestions: [] }, 200, req);
    }

    const container = getCompaniesContainer();
    if (!container) {
      return json({ ok: true, success: true, suggestions: [] }, 200, req);
    }

    try {
      const { keywords, industries } = await getKeywordRefinements(container, q, country, state, city);

      // Merge and limit to total of results (keywords + industries combined)
      // Interleave them for better UX (keyword, industry, keyword, industry...)
      const suggestions = [];
      const maxLen = Math.max(keywords.length, industries.length);
      for (let i = 0; i < maxLen; i++) {
        if (keywords[i]) suggestions.push(keywords[i]);
        if (industries[i]) suggestions.push(industries[i]);
      }

      return json(
        {
          ok: true,
          success: true,
          suggestions: suggestions.slice(0, 12), // Limit to 12 total
          meta: { q, country, state, city },
        },
        200,
        req
      );
    } catch (e) {
      context.log("suggest-refinements error:", e?.message || e);
      return json({ ok: true, success: true, suggestions: [] }, 200, req);
    }
  },
});
