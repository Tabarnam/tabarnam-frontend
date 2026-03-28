/**
 * Quick check: display key fields for a company by domain.
 *
 * Usage:
 *   node scripts/check-company.mjs yeti.com
 */

import { CosmosClient } from "@azure/cosmos";

const useBackup = process.argv.includes("--backup");
const COSMOS_ENDPOINT = useBackup
  ? (process.env.BACKUP_COSMOS_ENDPOINT || "")
  : (process.env.COSMOS_DB_ENDPOINT || "");
const COSMOS_KEY = useBackup
  ? (process.env.BACKUP_COSMOS_KEY || "")
  : (process.env.COSMOS_DB_KEY || "");

const domain = process.argv[2];
if (!domain) {
  console.error("Usage: node scripts/check-company.mjs <domain>");
  process.exit(1);
}

const client = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: COSMOS_KEY });
const container = client.database("tabarnam-db").container("companies");

const { resources } = await container.items.query({
  query: "SELECT c.company_name, c.industries, c.headquarters_location, c.manufacturing_locations, c.manufacturing_geocodes, c.product_keywords, c.tagline, c.logo_url, c.logo_url_dark, c.logo_approved, c.star_rating, c.review_count_approved FROM c WHERE c.normalized_domain = @domain",
  parameters: [{ name: "@domain", value: domain }],
}, { enableCrossPartitionQuery: true }).fetchAll();

if (resources.length === 0) {
  console.log(`No company found for domain: ${domain}`);
} else {
  console.log(JSON.stringify(resources[0], null, 2));
}
