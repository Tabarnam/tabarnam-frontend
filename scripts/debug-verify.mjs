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
  const sql = `SELECT TOP 3 c.id, c.company_name, c.headquarters, c.manufacturing_locations FROM c WHERE CONTAINS(LOWER(c.company_name), 'test company') ORDER BY c.company_name`;
  const { resources } = await container.items.query(sql, { enableCrossPartitionQuery: true }).fetchAll();
  
  resources.forEach((c) => {
    const hqCount = (c.headquarters && Array.isArray(c.headquarters)) ? c.headquarters.length : 0;
    const manuCount = (c.manufacturing_locations && Array.isArray(c.manufacturing_locations)) ? c.manufacturing_locations.length : 0;
    console.log(`${c.company_name}: HQ=${hqCount}, Manu=${manuCount}`);
    if (hqCount > 0) console.log('  First HQ:', c.headquarters[0].address);
    if (manuCount > 0) console.log('  First Manu:', c.manufacturing_locations[0].address);
  });
  
  process.exit(0);
}

check();
