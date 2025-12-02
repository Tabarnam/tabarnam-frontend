const { app } = require("@azure/functions");

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
  try {
    const endpoint = env("COSMOS_DB_ENDPOINT", "");
    const key = env("COSMOS_DB_KEY", "");
    const databaseId = env("COSMOS_DB_DATABASE", "tabarnam-db");
    const containerId = env("COSMOS_DB_COMPANIES_CONTAINER", "companies");

    if (!endpoint || !key) return null;

    const { CosmosClient } = require("@azure/cosmos");
    const client = new CosmosClient({ endpoint, key });
    return client.database(databaseId).container(containerId);
  } catch (err) {
    console.error("Failed to initialize Cosmos container:", err);
    return null;
  }
}

app.http("suggest-states", {
  route: "suggest-states",
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
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    const country = (url.searchParams.get("country") || "").trim();

    if (!q || q.length < 1) {
      return json({ ok: true, success: true, suggestions: [] }, 200, req);
    }

    const container = getCompaniesContainer();
    if (!container) {
      return json({ ok: true, success: true, suggestions: [] }, 200, req);
    }

    try {
      const params = [{ name: "@q", value: q }];
      let countryFilter = "";
      
      if (country) {
        params.push({ name: "@country", value: country });
        countryFilter = " AND (IS_DEFINED(c.country) AND c.country = @country)";
      }

      // Query to get all distinct states that match the search term
      const sql = `
        SELECT DISTINCT c.state
        FROM c
        WHERE IS_DEFINED(c.state) 
        AND c.state != null 
        AND c.state != ''
        AND CONTAINS(LOWER(c.state), @q)
        AND (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true)
        ${countryFilter}
        ORDER BY c.state ASC
      `;

      const res = await container.items
        .query({ query: sql, parameters: params }, { enableCrossPartitionQuery: true })
        .fetchAll();

      const states = res.resources || [];
      
      // Extract unique state names and convert to suggestions
      const stateSet = new Set();
      const suggestions = [];
      
      states.forEach((item) => {
        if (item.state && typeof item.state === "string") {
          const stateName = item.state.trim();
          if (stateName && !stateSet.has(stateName)) {
            stateSet.add(stateName);
            suggestions.push({
              value: stateName,
              type: "State",
            });
          }
        }
      });

      // Limit to 20 suggestions
      const limited = suggestions.slice(0, 20);

      return json(
        {
          ok: true,
          success: true,
          suggestions: limited,
          meta: { q, country },
        },
        200,
        req
      );
    } catch (e) {
      context.log("suggest-states error:", e?.message || e, e?.stack);
      console.error("suggest-states error details:", {
        message: e?.message,
        stack: e?.stack,
        q,
        country,
      });
      return json({ ok: true, success: true, suggestions: [] }, 200, req);
    }
  },
});
