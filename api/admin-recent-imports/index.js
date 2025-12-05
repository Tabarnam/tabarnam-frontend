// api/admin-recent-imports/index.js
const { CosmosClient } = require("@azure/cosmos");

const endpoint = process.env.COSMOS_DB_ENDPOINT;
const key = process.env.COSMOS_DB_KEY;
const databaseId = process.env.COSMOS_DB_DATABASE;
const containerId = process.env.COSMOS_DB_COMPANIES_CONTAINER;

module.exports = async function (context, req) {
  const takeParam = parseInt((req.query && req.query.take) || "25", 10);
  const take = Number.isFinite(takeParam) ? Math.min(Math.max(takeParam, 1), 100) : 25;

  if (!endpoint || !key || !databaseId || !containerId) {
    context.log.error("Cosmos configuration missing in environment");
    context.res = {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: {
        ok: false,
        error: "Cosmos DB configuration missing"
      }
    };
    return;
  }

  try {
    const client = new CosmosClient({ endpoint, key });
    const container = client.database(databaseId).container(containerId);

    // Conservative query: use _ts so it works even if you don’t have a special field
    const querySpec = {
      query: "SELECT TOP @take c.id, c.normalized_domain, c._ts FROM c ORDER BY c._ts DESC",
      parameters: [
        { name: "@take", value: take }
      ]
    };

    const { resources } = await container.items.query(querySpec).fetchAll();

    context.res = {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: {
        ok: true,
        take,
        items: resources || []
      }
    };
  } catch (err) {
    context.log.error("Error in admin-recent-imports:", err);
    context.res = {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: {
        ok: false,
        error: "Failed to load recent imports"
      }
    };
  }
};
