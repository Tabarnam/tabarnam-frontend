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
    console.log(JSON.stringify({
      id: c.id,
      company_name: c.company_name,
      headquarters: c.headquarters,
      headquarters_location: c.headquarters_location,
      manufacturing_locations: c.manufacturing_locations ? c.manufacturing_locations.slice(0, 1) : undefined,
    }, null, 2));
  }
  process.exit(0);
}

check();
