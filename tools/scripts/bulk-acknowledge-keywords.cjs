/**
 * Bulk-acknowledge +keywords for all companies where keywords_completeness === "incomplete".
 * Sets keywords_complete_acknowledged = true so the +keywords badge is cleared.
 *
 * Usage (PowerShell):
 *   node tools/scripts/bulk-acknowledge-keywords.js
 *
 * Uses Azure CLI credentials or env vars for Cosmos DB connection.
 */

const { CosmosClient } = require("@azure/cosmos");

const ENDPOINT = process.env.COSMOS_DB_ENDPOINT || "https://tabarnamcosmos2356.documents.azure.com:443/";
const KEY = process.env.COSMOS_DB_KEY || "";
const DATABASE = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
const CONTAINER = process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies";

async function main() {
  if (!KEY) {
    console.error("ERROR: Set COSMOS_DB_KEY env var first.\n  PowerShell: $env:COSMOS_DB_KEY = '<key>'");
    process.exit(1);
  }

  const client = new CosmosClient({ endpoint: ENDPOINT, key: KEY });
  const container = client.database(DATABASE).container(CONTAINER);

  // Query all companies with keywords_completeness = "incomplete" that haven't been acknowledged
  const query = `SELECT c.id, c.company_name, c.normalized_domain, c.keywords_completeness, c.keywords_complete_acknowledged
    FROM c
    WHERE c.keywords_completeness = "incomplete"
      AND (NOT IS_DEFINED(c.keywords_complete_acknowledged) OR c.keywords_complete_acknowledged = false OR c.keywords_complete_acknowledged = null)`;

  console.log("Querying companies with +keywords badge...");
  const { resources } = await container.items.query(query, { enableCrossPartitionQuery: true }).fetchAll();

  console.log(`Found ${resources.length} companies to acknowledge.\n`);

  if (resources.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  let updated = 0;
  let failed = 0;

  for (const company of resources) {
    try {
      const partitionKey = String(company.normalized_domain || "unknown").trim();

      // Read the full document first
      const { resource: fullDoc } = await container.item(company.id, partitionKey).read();
      if (!fullDoc) {
        console.warn(`  SKIP ${company.company_name} (${company.id}) — not found`);
        failed++;
        continue;
      }

      // Set acknowledged
      fullDoc.keywords_complete_acknowledged = true;
      fullDoc.updated_at = new Date().toISOString();

      await container.items.upsert(fullDoc, { partitionKey });
      updated++;
      console.log(`  ✓ ${company.company_name || company.id}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${company.company_name || company.id}: ${err.message}`);
    }
  }

  console.log(`\nDone. Updated: ${updated}, Failed: ${failed}`);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
