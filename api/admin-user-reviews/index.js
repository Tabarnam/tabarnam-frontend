// api/admin-user-reviews/index.js
//
// Admin management of APPROVED user-submitted reviews from the company profile
// editor — list / edit / remove. This complements the Review Queue (which is the
// pending-intake for approve/reject); here admins manage reviews that are already
// live on a company.
//
// Route: /xadmin-api-user-reviews  (withAdminGuard)
//   GET    ?company_id=|company=      → approved user reviews for the company
//   PUT    { id, company, subject?, text?, rating? }  → edit a review
//   DELETE { id, company }            → remove (unpublish) a review
//
// Every edit/remove keeps three things in sync: the review doc in the `reviews`
// container, its embedded copy in company.reviews[], and the company's
// Reputation/Quality scores (immediate rescore). PII (name/email) lives only on
// the reviews-container doc, never in the company embed.

const { app } = require("../_app");
const {
  getReviewsContainer,
  getCompaniesContainer,
  findCompanyByIdOrName,
} = require("../_reviewCounts");
const { withAdminGuard } = require("../_adminAuth");
const { computeReputationQualityScores } = require("../_companyScoring");

const cors = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-ms-client-principal, x-session-id",
  "Content-Type": "application/json",
});
const json = (obj, status = 200) => ({ status, headers: cors(), body: JSON.stringify(obj) });

function nonNegInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

// Mirror of admin-review-decide's embed shape: uniform public label, no PII, and
// display date = submission date (created_at), not the approval/edit time.
function toEmbeddedReview(review, nowIso) {
  return {
    review_id: review.id,
    type: "user",
    source_name: review.source_name || "Tabarnam Transparency Advocate",
    source: review.source_name || "Tabarnam Transparency Advocate",
    author: review.user_name || "",
    title: review.subject || "",
    text: review.text,
    rating: review.rating ?? null,
    is_public: true,
    show_to_users: true,
    created_at: review.created_at || nowIso,
    approved_at: review.decided_at || nowIso,
  };
}

async function loadReview(reviewsContainer, id, companyPk) {
  if (companyPk) {
    try {
      const { resource } = await reviewsContainer.item(id, companyPk).read();
      if (resource) return resource;
    } catch {
      /* fall through */
    }
  }
  const { resources } = await reviewsContainer.items
    .query(
      { query: "SELECT TOP 1 * FROM c WHERE c.id = @id", parameters: [{ name: "@id", value: id }] },
      { enableCrossPartitionQuery: true }
    )
    .fetchAll();
  return Array.isArray(resources) && resources.length ? resources[0] : null;
}

async function rescoreCompany(company, nowIso, context) {
  const scoring = await computeReputationQualityScores(company, { timeoutMs: 60000 }).catch((e) => ({
    ok: false,
    reason: e?.message || "scoring_exception",
  }));
  if (scoring.ok) {
    if (!company.rating || typeof company.rating !== "object") company.rating = {};
    const s4 = company.rating.star4 && typeof company.rating.star4 === "object" ? company.rating.star4 : { value: 0, notes: [] };
    const s5 = company.rating.star5 && typeof company.rating.star5 === "object" ? company.rating.star5 : { value: 0, notes: [] };
    const insufficient = scoring.skipped_xai_call === true;
    company.rating.star4 = { ...s4, value: scoring.reputation_score, reasoning: scoring.reputation_reasoning, insufficient_data: insufficient };
    company.rating.star5 = { ...s5, value: scoring.quality_score, reasoning: scoring.quality_reasoning, insufficient_data: insufficient };
  } else {
    context?.log?.(`[admin-user-reviews] rescore failed: ${scoring.reason || "unknown"}`);
  }
  company.updated_at = nowIso;
  return scoring;
}

// Re-sync the company doc after a review edit/removal: replace/drop the embed,
// adjust public counts, rescore, and upsert. Returns { scoring, companyUpdated }.
async function syncCompany(companiesContainer, review, mode, nowIso, context) {
  const out = { scoring: null, companyUpdated: false };
  if (!companiesContainer) return out;

  const company = await findCompanyByIdOrName(companiesContainer, {
    companyId: review.company_id || "",
    companyName: review.company_name || review.company || "",
  }).catch(() => null);

  if (!company || !String(company.normalized_domain || "").trim()) {
    context?.log?.(`[admin-user-reviews] no matching company doc for review ${review.id}; scores not recalculated`);
    return out;
  }

  const existing = Array.isArray(company.reviews) ? company.reviews : [];
  const withoutThis = existing.filter((r) => r && r.review_id !== review.id);
  const wasEmbedded = existing.length !== withoutThis.length;

  if (mode === "remove") {
    company.reviews = withoutThis;
    if (wasEmbedded) {
      company.review_count = Math.max(0, nonNegInt(company.review_count) - 1);
      company.public_review_count = Math.max(0, nonNegInt(company.public_review_count) - 1);
    }
  } else {
    // edit → replace the embed with the updated content (keep count unchanged)
    company.reviews = [toEmbeddedReview(review, nowIso), ...withoutThis];
  }

  out.scoring = await rescoreCompany(company, nowIso, context);
  try {
    await companiesContainer.items.upsert(company, { partitionKey: String(company.normalized_domain).trim() });
    out.companyUpdated = true;
  } catch (e) {
    context?.log?.(`[admin-user-reviews] company upsert failed: ${e?.message || e}`);
  }
  return out;
}

async function handleGet(req, reviewsContainer) {
  const url = new URL(req.url);
  const companyId = String(url.searchParams.get("company_id") || "").trim();
  const company = String(url.searchParams.get("company") || url.searchParams.get("company_name") || "").trim();
  const status = String(url.searchParams.get("status") || "approved").trim().toLowerCase();

  if (!companyId && !company) return json({ error: "company_id or company required" }, 400);

  // User-submitted reviews have no `type` field. In Cosmos, `c.type != 'curated'`
  // is UNDEFINED (not true) when the field is absent, which would drop every
  // user review — so guard with IS_DEFINED.
  const where = ["(NOT IS_DEFINED(c.type) OR c.type != 'curated')"];
  const parameters = [];
  const idOrName = [];
  if (companyId) {
    idOrName.push("c.company_id = @cid");
    parameters.push({ name: "@cid", value: companyId });
  }
  if (company) {
    idOrName.push("(c.company_name = @cname OR c.company = @cname)");
    parameters.push({ name: "@cname", value: company });
  }
  where.push(`(${idOrName.join(" OR ")})`);
  if (status !== "all") {
    where.push("c.status = @status");
    parameters.push({ name: "@status", value: status });
  }

  const query = `SELECT * FROM c WHERE ${where.join(" AND ")} ORDER BY c.created_at DESC`;
  const { resources } = await reviewsContainer.items
    .query({ query, parameters }, { enableCrossPartitionQuery: true })
    .fetchAll();

  return json({ ok: true, count: (resources || []).length, reviews: resources || [] });
}

async function adminUserReviewsHandler(req, context) {
  const method = String(req.method || "").toUpperCase();
  if (method === "OPTIONS") return { status: 200, headers: cors() };

  const reviewsContainer = getReviewsContainer();
  if (!reviewsContainer) return json({ error: "Cosmos env not configured" }, 500);
  const companiesContainer = getCompaniesContainer();

  if (method === "GET") {
    try {
      return await handleGet(req, reviewsContainer);
    } catch (e) {
      context?.log?.(`[admin-user-reviews] GET failed: ${e?.message || e}`);
      return json({ error: e?.message || "query failed" }, 500);
    }
  }

  if (method !== "PUT" && method !== "DELETE") {
    return json({ error: "method not allowed" }, 405);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const id = String(body?.id || "").trim();
  const companyPk = String(body?.company || body?.company_name || "").trim();
  if (!id) return json({ error: "id required" }, 400);

  const review = await loadReview(reviewsContainer, id, companyPk).catch(() => null);
  if (!review) return json({ error: "review not found" }, 404);

  const nowIso = new Date().toISOString();

  if (method === "DELETE") {
    // Soft-remove: unpublish + mark removed (doc retained for audit), de-embed, rescore.
    review.status = "removed";
    review.is_public = false;
    review.removed_at = nowIso;
    review.removed_by = (req && req.__admin_email) || null;
    try {
      await reviewsContainer.items.upsert(review, { partitionKey: review.company || "reviews" });
    } catch (e) {
      return json({ error: `Failed to update review: ${e?.message || e}` }, 500);
    }
    const { scoring, companyUpdated } = await syncCompany(companiesContainer, review, "remove", nowIso, context);
    return json({
      ok: true,
      id,
      removed: true,
      company_updated: companyUpdated,
      star4: scoring?.ok ? scoring.reputation_score : undefined,
      star5: scoring?.ok ? scoring.quality_score : undefined,
    });
  }

  // PUT — edit fields (only those provided are changed)
  if (typeof body.subject === "string") review.subject = body.subject.trim() || null;
  if (typeof body.source_name === "string")
    review.source_name = body.source_name.trim() || "Tabarnam Transparency Advocate";
  if (typeof body.user_name === "string") review.user_name = body.user_name.trim() || null;
  if (typeof body.text === "string") {
    const t = body.text.trim();
    if (t.length < 10) return json({ error: "review text too short" }, 400);
    review.text = t;
  }
  if (body.rating !== undefined) {
    if (body.rating === null || body.rating === "") {
      review.rating = null;
    } else {
      const n = Number(body.rating);
      if (!(Number.isFinite(n) && n >= 0 && n <= 5)) return json({ error: "rating must be 0–5" }, 400);
      review.rating = n;
    }
  }
  review.edited_at = nowIso;
  review.edited_by = (req && req.__admin_email) || null;

  try {
    await reviewsContainer.items.upsert(review, { partitionKey: review.company || "reviews" });
  } catch (e) {
    return json({ error: `Failed to update review: ${e?.message || e}` }, 500);
  }

  // Only re-embed + rescore if the review is currently public/approved.
  let scoring = null;
  let companyUpdated = false;
  if (review.status === "approved" && review.is_public) {
    ({ scoring, companyUpdated } = await syncCompany(companiesContainer, review, "edit", nowIso, context));
  }

  return json({
    ok: true,
    id,
    review,
    company_updated: companyUpdated,
    star4: scoring?.ok ? scoring.reputation_score : undefined,
    star5: scoring?.ok ? scoring.quality_score : undefined,
  });
}

app.http("adminUserReviews", {
  route: "xadmin-api-user-reviews",
  methods: ["GET", "PUT", "DELETE", "OPTIONS"],
  authLevel: "anonymous",
  handler: withAdminGuard(adminUserReviewsHandler),
});

module.exports = { handler: adminUserReviewsHandler };
