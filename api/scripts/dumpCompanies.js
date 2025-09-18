const { CosmosClient } = require("@azure/cosmos");
const fs = require("fs");

const ls = JSON.parse(fs.readFileSync("./local.settings.json","utf8"));
const v  = ls.Values || {};
(async () => {
  const client = new CosmosClient({ endpoint: v.COSMOS_DB_ENDPOINT, key: v.COSMOS_DB_KEY });
  const c = client.database(v.COSMOS_DB_DATABASE).container(v.COSMOS_DB_CONTAINER);
  const { resources } = await c.items
    .query("SELECT TOP 20 c.company_name, c.normalized_domain, c.amazon_url, c._ts FROM c ORDER BY c._ts DESC")
    .fetchAll();
  console.table(resources);
})();
