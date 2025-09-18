// node api/scripts/ensure-cosmos.js
import { CosmosClient } from "@azure/cosmos";

const endpoint = process.env.COSMOS_DB_ENDPOINT;
const key = process.env.COSMOS_DB_KEY;
const databaseId = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
const companiesId = process.env.COSMOS_DB_CONTAINER || "companies";
const reviewsId = process.env.COSMOS_DB_REVIEWS_CONTAINER || "reviews";

if (!endpoint || !key) {
  console.error("Missing COSMOS_DB_ENDPOINT or COSMOS_DB_KEY");
  process.exit(1);
}

(async () => {
  const client = new CosmosClient({ endpoint, key });

  // DB
  const { database } = await client.databases.createIfNotExists({ id: databaseId });
  console.log(`✔ Database ready: ${databaseId}`);

  // companies (partition on /id)
  const { container: companies } = await database.containers.createIfNotExists({
    id: companiesId,
    partitionKey: { kind: "Hash", paths: ["/id"] },
  });
  console.log(`✔ Container ready: ${companiesId} (pk=/id)`);

  // reviews (partition on /company)
  const { container: reviews } = await database.containers.createIfNotExists({
    id: reviewsId,
    partitionKey: { kind: "Hash", paths: ["/company"] },
  });
  console.log(`✔ Container ready: ${reviewsId} (pk=/company)`);

  console.log("✅ Cosmos init complete.");
})();
