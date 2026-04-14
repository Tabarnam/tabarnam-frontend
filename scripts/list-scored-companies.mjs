// List companies where rating.star4.value > 0, with diagnostic fields.
// Usage: node scripts/list-scored-companies.mjs
import { CosmosClient } from "@azure/cosmos";

const endpoint = process.env.COSMOS_DB_ENDPOINT;
const key = process.env.COSMOS_DB_KEY;
if (!endpoint || !key) {
  console.error("Missing COSMOS_DB_ENDPOINT or COSMOS_DB_KEY env var");
  process.exit(1);
}

const client = new CosmosClient({ endpoint, key });
const container = client
  .database(process.env.COSMOS_DB_DATABASE || "tabarnam-db")
  .container(process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies");

// Use the same admin filter as the status endpoint, project c.rating whole.
const query = `SELECT c.id, c.company_name, c.name, c.normalized_domain, c.domain, c.is_deleted, c.type, c.source, c.created_at, c.updated_at, c.rating FROM c WHERE (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true) AND NOT STARTSWITH(c.id, '_import_') AND NOT STARTSWITH(c.id, 'refresh_job_') AND (NOT IS_DEFINED(c.type) OR c.type != 'import_control')`;

const { resources } = await container.items.query(query, { enableCrossPartitionQuery: true }).fetchAll();

const scored = (resources || []).filter((r) => {
  const v =
    r && r.rating && typeof r.rating === "object" && !Array.isArray(r.rating) && r.rating.star4 && typeof r.rating.star4 === "object"
      ? r.rating.star4.value
      : undefined;
  return typeof v === "number" && v > 0;
});

console.log(`Found ${scored.length} scored companies (star4.value > 0)`);
console.log("");

// Group by is_deleted, source, type to see what they are
const byDeleted = { deleted: 0, undeleted: 0, undefined: 0 };
const bySource = {};
for (const c of scored) {
  if (c.is_deleted === true) byDeleted.deleted++;
  else if (c.is_deleted === false) byDeleted.undeleted++;
  else byDeleted.undefined++;
  const src = c.source || "(no source)";
  bySource[src] = (bySource[src] || 0) + 1;
}
console.log("By is_deleted:", byDeleted);
console.log("By source:", bySource);
console.log("");

// Print each scored company with its star4/star5 values + has-reasoning flags
console.log("id | is_deleted | source | name | domain | star4 | star5 | has_reasoning_star4 | has_reasoning_star5 | updated_at");
console.log("---");
for (const c of scored) {
  const star4 = c.rating?.star4?.value;
  const star5 = c.rating?.star5?.value;
  const r4 = c.rating?.star4?.reasoning ? "Y" : "n";
  const r5 = c.rating?.star5?.reasoning ? "Y" : "n";
  const name = c.company_name || c.name || "?";
  const domain = c.normalized_domain || c.domain || "?";
  console.log(
    `${c.id} | del=${c.is_deleted ?? "undef"} | src=${c.source ?? "?"} | ${name} | ${domain} | ${typeof star4 === "number" ? star4.toFixed(2) : star4} | ${typeof star5 === "number" ? star5.toFixed(2) : star5} | ${r4} | ${r5} | ${c.updated_at || "?"}`
  );
}
