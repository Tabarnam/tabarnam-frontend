import * as dotenv from "dotenv";
import { CosmosClient } from "@azure/cosmos";
import { createRequire } from "module";

dotenv.config();

const require = createRequire(import.meta.url);
const {
  getContainerPartitionKeyPath,
  buildPartitionKeyCandidates,
} = require("../api/_cosmosPartitionKey.js");

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

const companiesPkPath = await getContainerPartitionKeyPath(companiesContainer, "/normalized_domain");

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

function buildIsPublicExpr() {
  return (
    "(IIF(IS_DEFINED(c.public), c.public, " +
    "IIF(IS_DEFINED(c.is_public), c.is_public, " +
    "IIF(IS_DEFINED(c.isPublic), c.isPublic, " +
    "IIF(IS_DEFINED(c.visible_to_users), c.visible_to_users, " +
    "IIF(IS_DEFINED(c.show_to_users), c.show_to_users, true))))) )"
  );
}

function buildWhere({ companyId, companyName, normalizedDomain }) {
  const clauses = [];

  if (companyId)
    clauses.push(
      "(c.company_id = @id OR c.companyId = @id OR c.companyID = @id OR c.companyid = @id OR c.company_id_str = @id)"
    );

  if (companyName) clauses.push("(c.company_name = @company OR c.company = @company)");

  if (normalizedDomain)
    clauses.push(
      "(c.normalized_domain = @domain OR c.domain = @domain OR " +
        "(IS_DEFINED(c.normalized_domain) AND LOWER(c.normalized_domain) = @domainLower) OR " +
        "(IS_DEFINED(c.domain) AND LOWER(c.domain) = @domainLower))"
    );

  return clauses.length ? `(${clauses.join(" OR ")})` : "";
}

async function countReviews({ companyId, companyName, normalizedDomain }) {
  const id = asString(companyId).trim();
  const name = asString(companyName).trim();
  const domain = asString(normalizedDomain).trim();
  const where = buildWhere({ companyId: id, companyName: name, normalizedDomain: domain });
  if (!where) return { total: 0, pub: 0, priv: 0 };

  const parameters = [];
  if (id) parameters.push({ name: "@id", value: id });
  if (name) parameters.push({ name: "@company", value: name });
  if (domain) {
    parameters.push({ name: "@domain", value: domain });
    parameters.push({ name: "@domainLower", value: domain.toLowerCase() });
  }

  const isPublicExpr = buildIsPublicExpr();

  const queryCount = async (extraWhere = "") => {
    const sql = `SELECT VALUE COUNT(1) FROM c WHERE ${where} ${extraWhere}`;
    const { resources } = await reviewsContainer.items
      .query({ query: sql, parameters }, { enableCrossPartitionQuery: true })
      .fetchAll();
    return asNonNegativeInt(resources?.[0] ?? 0, 0);
  };

  const [total, pub, priv] = await Promise.all([
    queryCount(""),
    queryCount(`AND ${isPublicExpr} = true`),
    queryCount(`AND ${isPublicExpr} = false`),
  ]);

  return { total, pub, priv };
}

async function patchCompanyCountsForDoc(doc, counts) {
  const id = asString(doc?.id).trim();
  if (!id) return { ok: false, error: "Missing id" };

  if (DRY_RUN) return { ok: true, dryRun: true };

  const ops = [
    { op: "set", path: "/review_count", value: counts.total },
    { op: "set", path: "/public_review_count", value: counts.pub },
    { op: "set", path: "/private_review_count", value: counts.priv },
  ];

  const candidates = buildPartitionKeyCandidates({ doc, containerPkPath: companiesPkPath, requestedId: id });
  let lastErr;

  for (const pk of candidates) {
    try {
      const item = companiesContainer.item(id, pk);
      await item.patch(ops);
      return { ok: true };
    } catch (e) {
      lastErr = e;
    }
  }

  return { ok: false, error: lastErr?.message || String(lastErr || "patch failed") };
}

async function patchCompanyCountsById(id, counts) {
  const requestedId = asString(id).trim();
  if (!requestedId) return { ok: false, error: "Missing id" };

  const res = await patchCompanyCountsForDoc({ id: requestedId }, counts);
  if (res.ok) return res;

  try {
    const { resources } = await companiesContainer.items
      .query(
        { query: "SELECT * FROM c WHERE c.id = @id", parameters: [{ name: "@id", value: requestedId }] },
        { enableCrossPartitionQuery: true }
      )
      .fetchAll();

    const docs = Array.isArray(resources) ? resources : [];
    for (const doc of docs) {
      const r = await patchCompanyCountsForDoc(doc, counts);
      if (r.ok) return r;
    }

    return { ok: false, error: res.error || "Unable to patch company counts" };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

let processed = 0;
let updated = 0;
let failed = 0;

const companyQuery = {
  query:
    `SELECT c.id, c.company_name, c.normalized_domain, c.company_id, c.companyId, ` +
    `IIF(IS_DEFINED(c.curated_reviews), ARRAY_LENGTH(c.curated_reviews), 0) AS curated_review_count ` +
    `FROM c WHERE (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true) ORDER BY c._ts DESC`,
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

    const countsFromReviews = await countReviews({ companyId: id, companyName, normalizedDomain: c.normalized_domain });
    const curatedTotal = asNonNegativeInt(c.curated_review_count, 0);

    const counts = {
      total: countsFromReviews.total + curatedTotal,
      pub: countsFromReviews.pub + curatedTotal,
      priv: countsFromReviews.priv,
    };

    const res = await patchCompanyCountsById(id, counts);

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
