const { CosmosClient } = require('@azure/cosmos');

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

module.exports = async function (context, req) {
  context.log("[admin-recent-imports] Handler invoked");

  if (req.method === "OPTIONS") {
    context.res = {
      status: 204,
      headers: cors,
      body: "",
    };
    return;
  }

  const take = Number(new URL(`https://placeholder${req.url}`).searchParams.get("take") || "25") || 25;
  context.log(`[admin-recent-imports] Fetching ${take} most recent imports`);

  const endpoint = (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim();
  const key = (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim();
  const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
  const containerId = (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();

  if (!endpoint || !key) {
    context.log("[admin-recent-imports] Cosmos DB not configured");
    context.res = {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Cosmos not configured" }),
    };
    return;
  }

  const client = new CosmosClient({ endpoint, key });
  const container = client.database(databaseId).container(containerId);

  try {
    const q = {
      query: `
        SELECT TOP @take
          c.id, 
          c.company_name, 
          c.name, 
          c.url, 
          c.website_url, 
          c.created_at,
          c.session_id
        FROM c
        WHERE c.created_at != null
        ORDER BY c.created_at DESC
      `,
      parameters: [
        { name: "@take", value: take }
      ],
    };

    const { resources } = await container.items.query(q, { enableCrossPartitionQuery: true }).fetchAll();
    context.log(`[admin-recent-imports] Found ${resources.length} recent imports`);

    const imports = resources.map(r => ({
      id: r.id,
      company_name: r.company_name || r.name || "",
      url: r.url || r.website_url || "",
      website_url: r.website_url || r.url || "",
      created_at: r.created_at || "",
      imported_by: r.session_id ? "Admin" : "System",
      session_id: r.session_id || ""
    }));

    context.res = {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: true,
        imports,
        count: imports.length
      }),
    };
  } catch (e) {
    context.log("[admin-recent-imports] Query error:", e.message);
    context.log("[admin-recent-imports] Full error:", e);
    context.res = {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "query failed",
        detail: e?.message || String(e)
      }),
    };
  }
};
