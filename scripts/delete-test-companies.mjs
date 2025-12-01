import { CosmosClient } from "@azure/cosmos";
import * as dotenv from "dotenv";

dotenv.config();

const endpoint = process.env.COSMOS_DB_ENDPOINT;
const key = process.env.COSMOS_DB_KEY;
const databaseId = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
const containerId = process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies";

if (!endpoint || !key) {
  console.error("❌ Missing COSMOS_DB_ENDPOINT or COSMOS_DB_KEY");
  process.exit(1);
}

console.log("🗑️  Deleting TEST companies from Cosmos DB...\n");
console.log(`Endpoint: ${endpoint}`);
console.log(`Database: ${databaseId}`);
console.log(`Container: ${containerId}\n`);

const client = new CosmosClient({ endpoint, key });
const database = client.database(databaseId);
const container = database.container(containerId);

async function deleteTestCompanies() {
  try {
    const sql = `
      SELECT c.id, c.company_name, c.normalized_domain
      FROM c
      WHERE STARTSWITH(LOWER(c.company_name), 'test company')
      ORDER BY c.company_name
    `;

    console.log("🔍 Searching for TEST companies...\n");
    const { resources: testCompanies } = await container.items
      .query(sql, { enableCrossPartitionQuery: true })
      .fetchAll();

    if (testCompanies.length === 0) {
      console.log("✅ No TEST companies found!");
      return;
    }

    console.log(`Found ${testCompanies.length} TEST companies:\n`);
    testCompanies.forEach((c, idx) => {
      console.log(`${idx + 1}. ${c.company_name} (ID: ${c.id})`);
    });

    console.log(`\n🗑️  Deleting ${testCompanies.length} TEST companies...\n`);

    let deletedCount = 0;
    let failedCount = 0;

    for (const company of testCompanies) {
      try {
        const partitionKeyValue = company.normalized_domain || "unknown";
        await container.item(company.id, partitionKeyValue).delete();
        console.log(`✓ Deleted: ${company.company_name}`);
        deletedCount += 1;
      } catch (error) {
        console.error(`✗ Failed to delete ${company.company_name}: ${error?.message}`);
        failedCount += 1;
      }
    }

    console.log(`\n✅ Deletion complete!`);
    console.log(`   Deleted: ${deletedCount}/${testCompanies.length}`);
    if (failedCount > 0) {
      console.log(`   Failed: ${failedCount}/${testCompanies.length}`);
      process.exit(1);
    }
  } catch (error) {
    console.error("❌ Error deleting TEST companies:", error?.message || error);
    process.exit(1);
  }
}

await deleteTestCompanies();
