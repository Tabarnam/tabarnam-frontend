import * as dotenv from "dotenv";
import { CosmosClient } from "@azure/cosmos";

dotenv.config();

const endpoint = process.env.COSMOS_DB_ENDPOINT;
const key = process.env.COSMOS_DB_KEY;
const databaseId = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
const companiesContainerId = process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies";
const reviewsContainerId = process.env.COSMOS_DB_REVIEWS_CONTAINER || "reviews";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? Math.max(1, Number(limitArg.split("=")[1]) || 0) : Infinity;

if (!endpoint || !key) {
  console.error("❌ Missing COSMOS_DB_ENDPOINT or COSMOS_DB_KEY");
  process.exit(1);
}

console.log("🔁 Backfilling company review_count fields (denormalized)\n");
console.log(`Endpoint: ${endpoint}`);
console.log(`Database: ${databaseId}`);
console.log(`Companies Container: ${companiesContainerId}`);
console.log(`Reviews Container: ${reviewsContainerId}`);
console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "WRITE"}`);
console.log(`Limit: ${Number.isFinite(LIMIT) ? LIMIT : "∞"}\n`);

const client = new CosmosClient({ endpoint, key });
const db = client.database(databaseId);
const companiesContainer = db.container(companiesContainerId);
const reviewsContainer = db.container(reviewsContainerId);

function asString(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function asNonNegativeInt(v, fallback = 0) {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.trunc(v));
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.max(0, Math.trunc(n));
  }
  return fallback;
}

function buildWhere({ companyId, companyName }) {
  const clauses = [];
  if (companyId) clauses.push("(c.company_id = @id OR c.companyId = @id)");
  if (companyName) clauses.push("(c.company_name = @company OR c.company = @company)");
  return clauses.length ? `(${clauses.join(" OR ")})` : "";
}

async function countReviews({ companyId, companyName }) {
  const id = asString(companyId).trim();
  const name = asString(companyName).trim();
  const where = buildWhere({ companyId: id, companyName: name });
  if (!where) return { total: 0, pub: 0, priv: 0 };

  const parameters = [];
  if (id) parameters.push({ name: "@id", value: id });
  if (name) parameters.push({ name: "@company", value: name });

  const queryCount = async (extraWhere = "") => {
    const sql = `SELECT VALUE COUNT(1) FROM c WHERE ${where} ${extraWhere}`;
    const { resources } = await reviewsContainer.items
      .query({ query: sql, parameters }, { enableCrossPartitionQuery: true })
      .fetchAll();
    return asNonNegativeInt(resources?.[0] ?? 0, 0);
  };

  const [total, pub, priv] = await Promise.all([
    queryCount(""),
    queryCount("AND (NOT IS_DEFINED(c.is_public) OR c.is_public = true)"),
    queryCount("AND (IS_DEFINED(c.is_public) AND c.is_public = false)"),
  ]);

  return { total, pub, priv };
}

async function patchCompanyCounts({ id, normalized_domain, counts }) {
  const pk = asString(normalized_domain).trim();
  if (!id || !pk) return { ok: false, error: "Missing id or partition key" };

  try {
    if (DRY_RUN) return { ok: true, dryRun: true };

    const item = companiesContainer.item(id, pk);
    await item.patch([
      { op: "set", path: "/review_count", value: counts.total },
      { op: "set", path: "/public_review_count", value: counts.pub },
      { op: "set", path: "/private_review_count", value: counts.priv },
    ]);

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

let processed = 0;
let updated = 0;
let failed = 0;

const companyQuery = {
  query: `SELECT c.id, c.company_name, c.normalized_domain, c.company_id, c.companyId FROM c WHERE (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true) ORDER BY c._ts DESC`,
};

const iterator = companiesContainer.items.query(companyQuery, { enableCrossPartitionQuery: true });

while (processed < LIMIT) {
  const { resources } = await iterator.fetchNext();
  const batch = Array.isArray(resources) ? resources : [];
  if (!batch.length) break;

  for (const c of batch) {
    if (processed >= LIMIT) break;
    processed += 1;

    const id = asString(c.id || c.company_id || c.companyId).trim();
    const companyName = asString(c.company_name).trim();

    const counts = await countReviews({ companyId: id, companyName });

    const res = await patchCompanyCounts({
      id: asString(c.id).trim() || id,
      normalized_domain: c.normalized_domain,
      counts,
    });

    if (res.ok) {
      updated += DRY_RUN ? 0 : 1;
      if (processed % 25 === 0 || processed === 1) {
        console.log(
          `${DRY_RUN ? "🔎" : "✓"} ${processed} processed | ${companyName || id} => review_count=${counts.total} (public=${counts.pub}, private=${counts.priv})`
        );
      }
    } else {
      failed += 1;
      console.error(`✗ Failed: ${companyName || id} (${id}): ${res.error}`);
    }
  }
}

console.log("\n✅ Backfill finished");
console.log(`Processed: ${processed}`);
console.log(`Updated:   ${updated}`);
console.log(`Failed:    ${failed}`);

if (failed > 0) process.exit(1);
