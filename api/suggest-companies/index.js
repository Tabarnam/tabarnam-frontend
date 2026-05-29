// api/suggest-companies/index.js
// Lightweight company name suggestions — returns only name + id (saves 40-60% RUs vs full search)
let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}

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
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "content-type,x-functions-key",
    },
    body: JSON.stringify(obj),
  };
}

function getCompaniesContainer() {
  try {
    const endpoint = env("COSMOS_DB_ENDPOINT", "");
    const key = env("COSMOS_DB_KEY", "");
    const databaseId = env("COSMOS_DB_DATABASE", "tabarnam-db");
    const containerId = env("COSMOS_DB_COMPANIES_CONTAINER", "companies");

    if (!endpoint || !key) return null;

    const { CosmosClient } = require("@azure/cosmos");
    const client = require("../_cosmosConfig").getCosmosClient();
    return client.database(databaseId).container(containerId);
  } catch (err) {
    console.error("Failed to initialize Cosmos container:", err);
    return null;
  }
}

async function suggestCompaniesHandler(req, context) {
  const method = String(req.method || "").toUpperCase();
  if (method === "OPTIONS") {
    return {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "content-type,x-functions-key",
        "Access-Control-Max-Age": "86400",
      },
    };
  }
  if (method !== "GET") {
    return json({ ok: false, error: "Method Not Allowed" }, 405);
  }

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  const take = Math.min(parseInt(url.searchParams.get("take") || "8", 10) || 8, 20);

  if (!q || q.length < 2) {
    return json({ ok: true, suggestions: [] });
  }

  const container = getCompaniesContainer();
  if (!container) {
    return json({ ok: true, suggestions: [] });
  }

  try {
    const q_lower = q.toLowerCase();
    const q_space = ` ${q_lower} `;

    // Two-pass query: word-boundary first, then substring fallback
    // Only select company_name, company_id, display_name (lightweight)
    const wordBoundarySQL = `
      SELECT TOP ${take} c.company_name, c.display_name, c.company_id, c.id
      FROM c
      WHERE CONTAINS(c.search_text_norm, @q_space)
      AND (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true)
      ORDER BY c._ts DESC
    `;

    const res = await container.items
      .query(
        { query: wordBoundarySQL, parameters: [{ name: "@q_space", value: q_space }] },
        { enableCrossPartitionQuery: true }
      )
      .fetchAll();

    let items = res.resources || [];

    // Fallback to substring match if word-boundary found too few
    if (items.length < take) {
      const substringSQL = `
        SELECT TOP ${take} c.company_name, c.display_name, c.company_id, c.id
        FROM c
        WHERE (
          CONTAINS(LOWER(c.company_name), @q) OR
          CONTAINS(LOWER(c.display_name), @q) OR
          CONTAINS(LOWER(c.normalized_domain), @q)
        )
        AND (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true)
        ORDER BY c._ts DESC
      `;

      const res2 = await container.items
        .query(
          { query: substringSQL, parameters: [{ name: "@q", value: q_lower }] },
          { enableCrossPartitionQuery: true }
        )
        .fetchAll();

      // Merge and deduplicate
      const seen = new Set(items.map((i) => i.company_id || i.id));
      for (const item of res2.resources || []) {
        const id = item.company_id || item.id;
        if (!seen.has(id)) {
          items.push(item);
          seen.add(id);
        }
        if (items.length >= take) break;
      }
    }

    const suggestions = items.slice(0, take).map((c) => ({
      value: c.company_name || c.display_name || "",
      type: "Company",
      id: c.company_id || c.id,
    }));

    return json({ ok: true, suggestions });
  } catch (e) {
    context.log("suggest-companies error:", e?.message || e);
    return json({ ok: true, suggestions: [] });
  }
}

app.http("suggest-companies", {
  route: "suggest-companies",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: suggestCompaniesHandler,
});

module.exports = { handler: suggestCompaniesHandler };
