import { CosmosClient } from "@azure/cosmos";
import fs from "fs";

function loadSettings() {
  try {
    const raw = fs.readFileSync("./local.settings.json", "utf8");
    const j = JSON.parse(raw);
    return j?.Values || {};
  } catch (e) {
    console.warn("local.settings.json parse failed; falling back to process.env:", e.message);
    return {
      COSMOS_DB_ENDPOINT: process.env.COSMOS_DB_ENDPOINT,
      COSMOS_DB_KEY: process.env.COSMOS_DB_KEY,
      COSMOS_DB_DATABASE: process.env.COSMOS_DB_DATABASE,
      COSMOS_DB_CONTAINER: process.env.COSMOS_DB_CONTAINER,
    };
  }
}

const v = loadSettings();
if (!v.COSMOS_DB_ENDPOINT || !v.COSMOS_DB_KEY) {
  console.error("Missing Cosmos settings. Check local.settings.json or environment variables.");
  process.exit(1);
}

(async () => {
  const client = new CosmosClient({ endpoint: v.COSMOS_DB_ENDPOINT, key: v.COSMOS_DB_KEY });
  const c = client.database(v.COSMOS_DB_DATABASE).container(v.COSMOS_DB_CONTAINER);
  const { resources } = await c.items
    .query("SELECT TOP 20 c.company_name, c.normalized_domain, c.amazon_url, c._ts FROM c ORDER BY c._ts DESC")
    .fetchAll();
  console.table(resources);
})();
