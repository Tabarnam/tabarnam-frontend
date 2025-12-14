const { CosmosClient } = require("@azure/cosmos");
const {
  getContainerPartitionKeyPath,
  buildPartitionKeyCandidates,
  getValueAtPath,
} = require("./_cosmosPartitionKey");

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

function buildIsPublicExpr() {
  // Match frontend precedence: public ?? is_public ?? isPublic ?? visible_to_users ?? show_to_users ?? true
  return (
    "(IIF(IS_DEFINED(c.public), c.public, " +
    "IIF(IS_DEFINED(c.is_public), c.is_public, " +
    "IIF(IS_DEFINED(c.isPublic), c.isPublic, " +
    "IIF(IS_DEFINED(c.visible_to_users), c.visible_to_users, " +
    "IIF(IS_DEFINED(c.show_to_users), c.show_to_users, true))))) )"
  );
}

function buildReviewMatchQuerySpec({ companyId, companyName, normalizedDomain }) {
  const id = asString(companyId).trim();
  const name = asString(companyName).trim();
  const domain = asString(normalizedDomain).trim();
  const domainLower = domain.toLowerCase();

  const clauses = [];
  const parameters = [];

  if (id) {
    parameters.push({ name: "@id", value: id });
    clauses.push(
      "(c.company_id = @id OR c.companyId = @id OR c.companyID = @id OR c.companyid = @id OR c.company_id_str = @id)"
    );
  }

  if (name) {
    parameters.push({ name: "@company", value: name });
    clauses.push("(c.company_name = @company OR c.company = @company)");
  }

  if (domain) {
    parameters.push({ name: "@domain", value: domain });
    parameters.push({ name: "@domainLower", value: domainLower });
    clauses.push(
      "(c.normalized_domain = @domain OR c.domain = @domain OR " +
        "(IS_DEFINED(c.normalized_domain) AND LOWER(c.normalized_domain) = @domainLower) OR " +
        "(IS_DEFINED(c.domain) AND LOWER(c.domain) = @domainLower))"
    );
  }

  const where = clauses.length ? `(${clauses.join(" OR ")})` : "";
  return { where, parameters, _debug: { id: id || null, name: name || null, domain: domain || null } };
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

async function getReviewCountsForCompany(reviewsContainer, { companyId, companyName, normalizedDomain }) {
  if (!reviewsContainer) {
    return { review_count: 0, public_review_count: 0, private_review_count: 0, total: 0, public: 0, private: 0 };
  }

  const { where, parameters } = buildReviewMatchQuerySpec({
    companyId,
    companyName,
    normalizedDomain,
  });

  if (!where) {
    return { review_count: 0, public_review_count: 0, private_review_count: 0, total: 0, public: 0, private: 0 };
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

  return {
    review_count: total,
    public_review_count: pub,
    private_review_count: priv,
    total,
    public: pub,
    private: priv,
  };
}

let companiesPkPathPromise;
async function getCompaniesPartitionKeyPath(companiesContainer) {
  if (!companiesContainer) return "/normalized_domain";
  companiesPkPathPromise ||= getContainerPartitionKeyPath(companiesContainer, "/normalized_domain");
  try {
    return await companiesPkPathPromise;
  } catch {
    return "/normalized_domain";
  }
}

async function listCompanyDocsById(companiesContainer, id) {
  if (!companiesContainer) return [];
  const requestedId = asString(id).trim();
  if (!requestedId) return [];

  const sql = `SELECT * FROM c WHERE (c.id = @id OR c.company_id = @id OR c.companyId = @id)
               AND (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true)
               ORDER BY c._ts DESC`;

  try {
    const { resources } = await companiesContainer.items
      .query({ query: sql, parameters: [{ name: "@id", value: requestedId }] }, { enableCrossPartitionQuery: true })
      .fetchAll();
    return Array.isArray(resources) ? resources : [];
  } catch {
    return [];
  }
}

async function patchByCandidates(companiesContainer, id, containerPkPath, docForCandidates, ops) {
  const requestedId = asString(id).trim();
  if (!requestedId) return { ok: false };

  const candidates = buildPartitionKeyCandidates({
    doc: docForCandidates,
    containerPkPath,
    requestedId,
  });

  let lastError;
  for (const pk of candidates) {
    try {
      const itemRef = companiesContainer.item(requestedId, pk);
      await itemRef.patch(ops);
      return { ok: true, pk };
    } catch (e) {
      lastError = e;
    }
  }

  return { ok: false, error: lastError?.message || String(lastError || "patch failed"), candidates };
}

async function setCompanyReviewCounts(companiesContainer, companyDoc, counts) {
  if (!companiesContainer || !companyDoc) return { ok: false, updated: false };

  const next = {
    review_count: asNonNegativeInt(counts?.review_count, 0),
    public_review_count: asNonNegativeInt(counts?.public_review_count, 0),
    private_review_count: asNonNegativeInt(counts?.private_review_count, 0),
  };

  const id = asString(companyDoc.id).trim();
  if (!id) return { ok: false, updated: false, error: "Missing company id" };

  const containerPkPath = await getCompaniesPartitionKeyPath(companiesContainer);

  const docs = await listCompanyDocsById(companiesContainer, id);
  const docsToUpdate = docs.length ? docs : [companyDoc];

  let patched = 0;
  let lastError;

  for (const doc of docsToUpdate) {
    const patchRes = await patchByCandidates(companiesContainer, id, containerPkPath, doc, [
      { op: "set", path: "/review_count", value: next.review_count },
      { op: "set", path: "/public_review_count", value: next.public_review_count },
      { op: "set", path: "/private_review_count", value: next.private_review_count },
    ]);

    if (patchRes.ok) {
      patched += 1;
      continue;
    }

    lastError = patchRes.error;
  }

  if (patched > 0) {
    return {
      ok: true,
      updated: true,
      counts: next,
      meta: { containerPkPath, matched_docs: docs.length, patched_docs: patched },
    };
  }

  return {
    ok: false,
    updated: false,
    error: lastError || "Failed to update company review counts",
    meta: { containerPkPath, matched_docs: docs.length, patched_docs: patched },
  };
}

async function incrementCompanyReviewCounts(companiesContainer, companyDoc, deltas) {
  if (!companiesContainer || !companyDoc) return { ok: false, updated: false };

  const deltaReview = Number(deltas?.review_count ?? 0) || 0;
  const deltaPublic = Number(deltas?.public_review_count ?? 0) || 0;
  const deltaPrivate = Number(deltas?.private_review_count ?? 0) || 0;

  if (!deltaReview && !deltaPublic && !deltaPrivate) {
    return { ok: true, updated: false };
  }

  const id = asString(companyDoc.id).trim();
  if (!id) return { ok: false, updated: false, error: "Missing company id" };

  const containerPkPath = await getCompaniesPartitionKeyPath(companiesContainer);

  const ops = [];
  if (deltaReview) ops.push({ op: "incr", path: "/review_count", value: deltaReview });
  if (deltaPublic) ops.push({ op: "incr", path: "/public_review_count", value: deltaPublic });
  if (deltaPrivate) ops.push({ op: "incr", path: "/private_review_count", value: deltaPrivate });

  const patchRes = await patchByCandidates(companiesContainer, id, containerPkPath, companyDoc, ops);
  if (patchRes.ok) return { ok: true, updated: true, meta: { containerPkPath, pk: patchRes.pk } };

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
    const pkValue = getValueAtPath(merged, containerPkPath);
    if (pkValue !== undefined) {
      await companiesContainer.items.upsert(merged, { partitionKey: pkValue });
    } else {
      await companiesContainer.items.upsert(merged);
    }
    return {
      ok: true,
      updated: true,
      counts: {
        review_count: merged.review_count,
        public_review_count: merged.public_review_count,
        private_review_count: merged.private_review_count,
      },
      meta: { containerPkPath },
    };
  } catch (e) {
    return { ok: false, updated: false, error: e?.message || String(e), meta: { containerPkPath } };
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
  buildReviewMatchQuerySpec,
  _test: { asNonNegativeInt },
};
