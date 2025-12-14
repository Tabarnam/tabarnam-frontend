const { CosmosClient } = require("@azure/cosmos");

const E = (k, d = "") => (process.env[k] ?? d).toString().trim();

let cosmosClient;
function getCosmosClient() {
  const endpoint = E("COSMOS_DB_ENDPOINT");
  const key = E("COSMOS_DB_KEY");
  if (!endpoint || !key) return null;
  cosmosClient ||= new CosmosClient({ endpoint, key });
  return cosmosClient;
}

function getCompaniesContainer() {
  const client = getCosmosClient();
  if (!client) return null;
  const databaseId = E("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = E("COSMOS_DB_COMPANIES_CONTAINER", "companies");
  return client.database(databaseId).container(containerId);
}

function getReviewsContainer() {
  const client = getCosmosClient();
  if (!client) return null;
  const databaseId = E("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = E("COSMOS_DB_REVIEWS_CONTAINER", "reviews");
  return client.database(databaseId).container(containerId);
}

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

function buildReviewMatchWhere({ companyId, companyName }) {
  const clauses = [];
  if (companyId) {
    clauses.push("(c.company_id = @id OR c.companyId = @id)");
  }
  if (companyName) {
    clauses.push("(c.company_name = @company OR c.company = @company)");
  }
  return clauses.length ? `(${clauses.join(" OR ")})` : "";
}

async function findCompanyByIdOrName(companiesContainer, { companyId, companyName }) {
  if (!companiesContainer) return null;
  const id = asString(companyId).trim();
  const name = asString(companyName).trim();

  const parameters = [];
  const where = [];

  if (id) {
    parameters.push({ name: "@id", value: id });
    where.push("(c.id = @id OR c.company_id = @id OR c.companyId = @id)");
  }

  if (name) {
    parameters.push({ name: "@company", value: name });
    where.push("(c.company_name = @company OR c.name = @company)");
  }

  if (!where.length) return null;

  const sql = `SELECT TOP 1 * FROM c WHERE ${where.join(" OR ")}
              AND (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true)
              ORDER BY c._ts DESC`;

  const { resources } = await companiesContainer.items
    .query({ query: sql, parameters }, { enableCrossPartitionQuery: true })
    .fetchAll();

  return Array.isArray(resources) && resources.length ? resources[0] : null;
}

async function getReviewCountsForCompany(reviewsContainer, { companyId, companyName }) {
  if (!reviewsContainer) {
    return { review_count: 0, public_review_count: 0, private_review_count: 0 };
  }

  const id = asString(companyId).trim();
  const name = asString(companyName).trim();
  const where = buildReviewMatchWhere({ companyId: id, companyName: name });
  if (!where) {
    return { review_count: 0, public_review_count: 0, private_review_count: 0 };
  }

  const params = [];
  if (id) params.push({ name: "@id", value: id });
  if (name) params.push({ name: "@company", value: name });

  const queryCount = async (extraWhere = "") => {
    const sql = `SELECT VALUE COUNT(1) FROM c WHERE ${where} ${extraWhere}`;
    const { resources } = await reviewsContainer.items
      .query({ query: sql, parameters: params }, { enableCrossPartitionQuery: true })
      .fetchAll();
    return asNonNegativeInt(resources?.[0] ?? 0, 0);
  };

  const [total, pub, priv] = await Promise.all([
    queryCount(""),
    queryCount("AND (NOT IS_DEFINED(c.is_public) OR c.is_public = true)"),
    queryCount("AND (IS_DEFINED(c.is_public) AND c.is_public = false)"),
  ]);

  return {
    review_count: total,
    public_review_count: pub,
    private_review_count: priv,
  };
}

function getCompanyItemRef(companiesContainer, companyDoc) {
  if (!companiesContainer || !companyDoc) return null;
  const id = asString(companyDoc.id).trim();
  const pk = asString(companyDoc.normalized_domain).trim();
  if (!id || !pk) return null;
  try {
    return companiesContainer.item(id, pk);
  } catch {
    return null;
  }
}

async function setCompanyReviewCounts(companiesContainer, companyDoc, counts) {
  if (!companiesContainer || !companyDoc) return { ok: false, updated: false };

  const next = {
    review_count: asNonNegativeInt(counts?.review_count, 0),
    public_review_count: asNonNegativeInt(counts?.public_review_count, 0),
    private_review_count: asNonNegativeInt(counts?.private_review_count, 0),
  };

  const itemRef = getCompanyItemRef(companiesContainer, companyDoc);
  if (itemRef && typeof itemRef.patch === "function") {
    try {
      await itemRef.patch([
        { op: "set", path: "/review_count", value: next.review_count },
        { op: "set", path: "/public_review_count", value: next.public_review_count },
        { op: "set", path: "/private_review_count", value: next.private_review_count },
      ]);
      return { ok: true, updated: true, counts: next };
    } catch {
      // fall through
    }
  }

  const merged = {
    ...companyDoc,
    review_count: next.review_count,
    public_review_count: next.public_review_count,
    private_review_count: next.private_review_count,
  };

  try {
    await companiesContainer.items.upsert(merged);
    return { ok: true, updated: true, counts: next };
  } catch (e) {
    return { ok: false, updated: false, error: e?.message || String(e) };
  }
}

async function incrementCompanyReviewCounts(companiesContainer, companyDoc, deltas) {
  if (!companiesContainer || !companyDoc) return { ok: false, updated: false };

  const deltaReview = Number(deltas?.review_count ?? 0) || 0;
  const deltaPublic = Number(deltas?.public_review_count ?? 0) || 0;
  const deltaPrivate = Number(deltas?.private_review_count ?? 0) || 0;

  if (!deltaReview && !deltaPublic && !deltaPrivate) {
    return { ok: true, updated: false };
  }

  const itemRef = getCompanyItemRef(companiesContainer, companyDoc);
  if (itemRef && typeof itemRef.patch === "function") {
    const ops = [];
    if (deltaReview) ops.push({ op: "incr", path: "/review_count", value: deltaReview });
    if (deltaPublic) ops.push({ op: "incr", path: "/public_review_count", value: deltaPublic });
    if (deltaPrivate) ops.push({ op: "incr", path: "/private_review_count", value: deltaPrivate });

    try {
      await itemRef.patch(ops);
      return { ok: true, updated: true };
    } catch {
      // fall through
    }
  }

  const existingReview = asNonNegativeInt(companyDoc.review_count, 0);
  const existingPublic = asNonNegativeInt(companyDoc.public_review_count, 0);
  const existingPrivate = asNonNegativeInt(companyDoc.private_review_count, 0);

  const merged = {
    ...companyDoc,
    review_count: Math.max(0, existingReview + deltaReview),
    public_review_count: Math.max(0, existingPublic + deltaPublic),
    private_review_count: Math.max(0, existingPrivate + deltaPrivate),
  };

  try {
    await companiesContainer.items.upsert(merged);
    return { ok: true, updated: true, counts: {
      review_count: merged.review_count,
      public_review_count: merged.public_review_count,
      private_review_count: merged.private_review_count,
    } };
  } catch (e) {
    return { ok: false, updated: false, error: e?.message || String(e) };
  }
}

module.exports = {
  getCosmosClient,
  getCompaniesContainer,
  getReviewsContainer,
  findCompanyByIdOrName,
  getReviewCountsForCompany,
  setCompanyReviewCounts,
  incrementCompanyReviewCounts,
  _test: { buildReviewMatchWhere, asNonNegativeInt },
};
