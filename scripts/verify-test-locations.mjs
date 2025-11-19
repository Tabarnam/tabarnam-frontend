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

async function verifyLocations() {
  try {
    const client = new CosmosClient({ endpoint, key });
    const container = client.database(databaseId).container(containerId);

    const sql = `
      SELECT c.id, c.company_name, c.headquarters, c.manufacturing_locations
      FROM c
      WHERE CONTAINS(LOWER(c.company_name), 'test company')
      ORDER BY c.company_name
    `;

    const { resources } = await container.items
      .query(sql, { enableCrossPartitionQuery: true })
      .fetchAll();

    console.log(`✅ Verification Results:\n`);
    console.log(`Total TEST companies: ${resources.length}\n`);

    let allValid = true;
    resources.forEach((c, idx) => {
      const hqCount = (c.headquarters && Array.isArray(c.headquarters)) ? c.headquarters.length : 0;
      const manuCount = (c.manufacturing_locations && Array.isArray(c.manufacturing_locations)) ? c.manufacturing_locations.length : 0;
      const valid = hqCount >= 2 && manuCount >= 3;

      if (!valid) allValid = false;

      const status = valid ? "✓" : "✗";
      console.log(`${status} ${c.company_name}: ${hqCount} HQ, ${manuCount} Manufacturing`);
    });

    console.log(`\n${allValid ? "✅ All companies have complete location data!" : "⚠️  Some companies are missing location data"}`);
    
  } catch (error) {
    console.error("❌ Error verifying locations:", error?.message || error);
    process.exit(1);
  }
}

verifyLocations();
