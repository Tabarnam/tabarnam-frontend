import { CosmosClient } from "@azure/cosmos";
import * as dotenv from "dotenv";

dotenv.config();

const endpoint = process.env.COSMOS_DB_ENDPOINT;
const key = process.env.COSMOS_DB_KEY;
const databaseId = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
const containerId = process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies";

const client = new CosmosClient({ endpoint, key });
const container = client.database(databaseId).container(containerId);

async function count() {
  const sql = `SELECT VALUE COUNT(1) FROM c WHERE CONTAINS(LOWER(c.company_name), 'test')`;
  const { resources } = await container.items.query(sql, { enableCrossPartitionQuery: true }).fetchAll();
  console.log(`Total TEST companies: ${resources[0]}`);
  
  const sql2 = `SELECT VALUE COUNT(1) FROM c WHERE CONTAINS(LOWER(c.company_name), 'test company')`;
  const { resources: r2 } = await container.items.query(sql2, { enableCrossPartitionQuery: true }).fetchAll();
  console.log(`TEST Company X companies: ${r2[0]}`);
  
  const sql3 = `SELECT c.id, c.company_name FROM c WHERE CONTAINS(LOWER(c.company_name), 'test company') ORDER BY c.id`;
  const { resources: r3 } = await container.items.query(sql3, { enableCrossPartitionQuery: true }).fetchAll();
  console.log(`\nAll TEST Company entries:`);
  r3.forEach(c => console.log(`  ${c.id} - ${c.company_name}`));
  
  process.exit(0);
}

count();
