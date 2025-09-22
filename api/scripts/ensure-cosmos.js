// node api/scripts/ensure-cosmos.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { CosmosClient } from "@azure/cosmos";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Try to hydrate process.env from api/local.settings.json if needed
function hydrateFromLocalSettings() {
  try {
    const settingsPath = path.resolve(__dirname, "..", "local.settings.json");
    if (!fs.existsSync(settingsPath)) return;
    const raw = fs.readFileSync(settingsPath, "utf-8");
    const json = JSON.parse(raw);
    const vals = json?.Values || {};
    for (const [k, v] of Object.entries(vals)) {
      if (process.env[k] == null && typeof v === "string") {
        process.env[k] = v;
      }
    }
  } catch (e) {
    console.warn("Could not read local.settings.json:", e.message);
  }
}
hydrateFromLocalSettings();

const endpoint   = process.env.COSMOS_DB_ENDPOINT;
const key        = process.env.COSMOS_DB_KEY;
const databaseId = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
const companiesId= process.env.COSMOS_DB_CONTAINER || "companies";
const reviewsId  = process.env.COSMOS_DB_REVIEWS_CONTAINER || "reviews";

if (!endpoint || !key) {
  console.error("Missing COSMOS_DB_ENDPOINT or COSMOS_DB_KEY");
  console.error("Tip: put them under Values{} in api/local.settings.json, e.g.:");
  console.error(`{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "COSMOS_DB_ENDPOINT": "https://<your-account>.documents.azure.com:443/",
    "COSMOS_DB_KEY": "<primary-key>",
    "COSMOS_DB_DATABASE": "tabarnam-db",
    "COSMOS_DB_CONTAINER": "companies",
    "COSMOS_DB_REVIEWS_CONTAINER": "reviews"
  }
}`);
  process.exit(1);
}

(async () => {
  const client = new CosmosClient({ endpoint, key });

  // DB
  const { database } = await client.databases.createIfNotExists({ id: databaseId });
  console.log(`✔ Database ready: ${databaseId}`);

  // companies (partition on /id)
  const { container: companies } = await database.containers.createIfNotExists({
    id: companiesId,
    partitionKey: { kind: "Hash", paths: ["/id"] },
  });
  console.log(`✔ Container ready: ${companiesId} (pk=/id)`);

  // reviews (partition on /company)
  const { container: reviews } = await database.containers.createIfNotExists({
    id: reviewsId,
    partitionKey: { kind: "Hash", paths: ["/company"] },
  });
  console.log(`✔ Container ready: ${reviewsId} (pk=/company)`);

  console.log("✅ Cosmos init complete.");
})().catch(e => {
  console.error("❌ Cosmos init failed:", e.message);
  process.exit(1);
});
