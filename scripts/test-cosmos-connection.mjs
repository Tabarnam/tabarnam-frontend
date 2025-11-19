import { CosmosClient } from "@azure/cosmos";
import * as dotenv from "dotenv";

dotenv.config();

const endpoint = process.env.COSMOS_DB_ENDPOINT;
const key = process.env.COSMOS_DB_KEY;
const databaseId = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
const containerId = process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies";

console.log("🔍 Cosmos DB Connection Test");
console.log("=============================");
console.log("Endpoint:", endpoint);
console.log("Key:", key ? `${key.substring(0, 20)}...` : "NOT SET");
console.log("Database:", databaseId);
console.log("Container:", containerId);
console.log("");

if (!endpoint || !key) {
  console.error("❌ Missing COSMOS_DB_ENDPOINT or COSMOS_DB_KEY");
  process.exit(1);
}

try {
  const client = new CosmosClient({ endpoint, key });
  console.log("✓ CosmosClient created");

  const database = client.database(databaseId);
  console.log("✓ Database reference created");

  const container = database.container(containerId);
  console.log("✓ Container reference created");

  console.log("\n📋 Testing query...");
  const { resources } = await container.items
    .query("SELECT TOP 5 c.id, c.company_name FROM c")
    .fetchAll();

  console.log(`✅ Query successful! Found ${resources.length} companies`);
  if (resources.length > 0) {
    console.log("\nSample companies:");
    resources.forEach(c => {
      console.log(`  - ${c.company_name}`);
    });
  }

  // Check if test companies exist
  const testCompanies = await container.items
    .query("SELECT c.id, c.company_name FROM c WHERE STARTSWITH(c.id, 'test-')")
    .fetchAll();

  console.log(`\n🧪 Test companies found: ${testCompanies.resources.length}`);
  if (testCompanies.resources.length > 0) {
    console.log("Test companies:");
    testCompanies.resources.forEach(c => {
      console.log(`  - ${c.company_name}`);
    });
  }

} catch (error) {
  console.error("❌ Connection failed:");
  console.error(error.message);
  process.exit(1);
}
