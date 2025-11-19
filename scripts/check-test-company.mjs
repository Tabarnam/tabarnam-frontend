import { CosmosClient } from "@azure/cosmos";
import * as dotenv from "dotenv";

dotenv.config();

const endpoint = process.env.COSMOS_DB_ENDPOINT;
const key = process.env.COSMOS_DB_KEY;
const databaseId = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
const containerId = process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies";

const client = new CosmosClient({ endpoint, key });
const container = client.database(databaseId).container(containerId);

async function check() {
  const sql = `SELECT * FROM c WHERE c.id = "test-company-1"`;
  const { resources } = await container.items.query(sql).fetchAll();
  
  if (resources.length > 0) {
    const c = resources[0];
    const hqCount = c.headquarters ? c.headquarters.length : 0;
    const manuCount = c.manufacturing_locations ? c.manufacturing_locations.length : 0;

    console.log(`✅ TEST Company 1 Location Data:`);
    console.log(`   Headquarters: ${hqCount} locations`);
    console.log(`   Manufacturing: ${manuCount} locations`);

    if (hqCount > 0) {
      console.log(`\n   HQ Locations:`);
      c.headquarters.forEach((hq, i) => {
        console.log(`   ${i + 1}. ${hq.address} (${hq.city}, ${hq.postal_code})`);
      });
    }

    if (manuCount > 0) {
      console.log(`\n   Manufacturing Locations:`);
      c.manufacturing_locations.forEach((manu, i) => {
        console.log(`   ${i + 1}. ${manu.address} (${manu.city}, ${manu.postal_code})`);
      });
    }
  }
  process.exit(0);
}

check();
