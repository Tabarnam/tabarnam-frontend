import { CosmosClient } from "@azure/cosmos";
import * as dotenv from "dotenv";

dotenv.config();

const endpoint = process.env.COSMOS_DB_ENDPOINT || process.env.VITE_COSMOS_ENDPOINT;
const key = process.env.COSMOS_DB_KEY || process.env.VITE_COSMOS_KEY;
const databaseId = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
const containerId = process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies";

if (!endpoint || !key) {
  console.error("❌ Missing COSMOS_DB_ENDPOINT or COSMOS_DB_KEY");
  process.exit(1);
}

console.log("📋 Checking Cosmos DB for test companies...\n");
console.log(`Endpoint: ${endpoint}`);
console.log(`Database: ${databaseId}`);
console.log(`Container: ${containerId}\n`);

const client = new CosmosClient({ endpoint, key });
const database = client.database(databaseId);
const container = database.container(containerId);

async function findTestCompanies() {
  try {
    const sql = `
      SELECT c.id, c.company_name, c.industries, c.manufacturing_locations
      FROM c
      WHERE (CONTAINS(LOWER(c.company_name), 'test'))
      ORDER BY c.company_name
    `;

    const { resources } = await container.items
      .query(sql, { enableCrossPartitionQuery: true })
      .fetchAll();

    console.log(`Found ${resources.length} companies with 'test' in name:\n`);
    
    if (resources.length === 0) {
      console.log("❌ No test companies found!");
      console.log("\n📝 ACTION NEEDED:");
      console.log("   Run: node scripts/seed-test-companies.mjs");
      return null;
    }

    resources.forEach((c, idx) => {
      console.log(`${idx + 1}. ${c.company_name} (ID: ${c.id})`);
      if (c.industries) console.log(`   Industries: ${c.industries.join(", ")}`);
      if (c.manufacturing_locations) {
        console.log(`   Manufacturing Locations: ${c.manufacturing_locations.length}`);
      }
    });

    return resources;
  } catch (error) {
    console.error("❌ Error querying Cosmos:", error?.message || error);
    process.exit(1);
  }
}

await findTestCompanies();
