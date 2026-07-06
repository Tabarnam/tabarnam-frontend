// api/admin-review-decide/index.js
//
// Admin-only: approve or reject a pending user review.
// Route: POST /xadmin-api-review-decide
// Body: { id, company, decision: "approved"|"rejected", admin_message? }
//
// On approve:  flip the review to public, embed it into the company doc's
//              reviews[] array, bump review counts, immediately recompute the
//              Reputation/Quality (star4/star5) scores, and email the submitter.
// On reject:   mark rejected with the admin's reason and email the submitter.
//
// The admin's free-text message feeds the automated decision email. Guarded by
// withAdminGuard. Emails are best-effort and only sent when the submitter left
// an email address.

const { app } = require("../_app");
const {
  getReviewsContainer,
  getCompaniesContainer,
  findCompanyByIdOrName,
} = require("../_reviewCounts");
const { withAdminGuard } = require("../_adminAuth");
const { computeReputationQualityScores } = require("../_companyScoring");
const { isEmailConfigured, sendEmail, escapeHtml } = require("../_graphEmail");

const cors = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-ms-client-principal, x-session-id",
  "Content-Type": "application/json",
});

const json = (obj, status = 200) => ({ status, headers: cors(), body: JSON.stringify(obj) });

function nonNegInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

// Normalize an approved user review into the shape buildReviewsSummary()
// (api/_companyScoring.js) reads when scoring, and get-reviews-style display.
function toEmbeddedReview(review, nowIso) {
  return {
    review_id: review.id,
    type: "user",
    // Uniform public attribution label. The reviewer's real name/email are NOT
    // embedded in the company doc (which can be returned to clients) — they live
    // only in the reviews container for admin use.
    source_name: "Tabarnam Transparency Advocate",
    source: "Tabarnam Transparency Advocate",
    title: review.subject || "",
    text: review.text,
    rating: review.rating ?? null,
    is_public: true,
    show_to_users: true,
    // Display date = submission date, not approval date.
    created_at: review.created_at || nowIso,
    approved_at: nowIso,
  };
}

async function loadReview(reviewsContainer, id, companyPk) {
  // Fast path: read by (id, partitionKey=company).
  if (companyPk) {
    try {
      const { resource } = await reviewsContainer.item(id, companyPk).read();
      if (resource) return resource;
    } catch {
      /* fall through to cross-partition query */
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
    const existingStar4 =
      company.rating.star4 && typeof company.rating.star4 === "object" ? company.rating.star4 : { value: 0, notes: [] };
    const existingStar5 =
      company.rating.star5 && typeof company.rating.star5 === "object" ? company.rating.star5 : { value: 0, notes: [] };
    const insufficientData = scoring.skipped_xai_call === true;
    company.rating.star4 = {
      ...existingStar4,
      value: scoring.reputation_score,
      reasoning: scoring.reputation_reasoning,
      insufficient_data: insufficientData,
    };
    company.rating.star5 = {
      ...existingStar5,
      value: scoring.quality_score,
      reasoning: scoring.quality_reasoning,
      insufficient_data: insufficientData,
    };
  } else {
    context?.log?.(`[admin-review-decide] rescore failed: ${scoring.reason || "unknown"}`);
  }

  company.updated_at = nowIso;
  return scoring;
}

async function emailDecision(review, decision, adminMessage, companyName, context) {
  if (!review.user_email || !isEmailConfigured()) return;

  const name = review.user_name ? " " + escapeHtml(review.user_name) : "";
  const noteBlock = adminMessage
    ? `<blockquote style="border-left:3px solid #ccc;padding-left:12px;margin:12px 0;color:#555;">${escapeHtml(
        adminMessage
      ).replace(/\n/g, "<br />")}</blockquote>`
    : "";

  let subject;
  let html;
  if (decision === "approved") {
    subject = `Your review of ${companyName} is now live`;
    html = `<p>Hi${name},</p>
<p>Good news — your review of <strong>${escapeHtml(companyName)}</strong> has been approved and is now published on Tabarnam. Thanks for helping other shoppers.</p>
${adminMessage ? `<p>A note from our team:</p>${noteBlock}` : ""}
<p>Best,<br />The Tabarnam Team</p>`;
  } else {
    subject = `About your review of ${companyName}`;
    html = `<p>Hi${name},</p>
<p>Thanks for taking the time to review <strong>${escapeHtml(companyName)}</strong>. After a look by our team, we aren't able to publish this submission.</p>
${adminMessage ? `<p>Reason:</p>${noteBlock}` : ""}
<p>You're welcome to submit an updated review anytime.</p>
<p>Best,<br />The Tabarnam Team</p>`;
  }

  try {
    await sendEmail({ to: review.user_email, toName: review.user_name || undefined, subject, html });
  } catch (e) {
    context?.log?.(`[admin-review-decide] decision email failed: ${e?.message || e}`);
  }
}

async function adminReviewDecideHandler(req, context) {
  if (String(req.method || "").toUpperCase() === "OPTIONS") return { status: 200, headers: cors() };

  const reviewsContainer = getReviewsContainer();
  if (!reviewsContainer) return json({ error: "Cosmos env not configured" }, 500);
  const companiesContainer = getCompaniesContainer();

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const id = String(body?.id || "").trim();
  const companyPk = String(body?.company || body?.company_name || "").trim();
  const decision = String(body?.decision || "").trim().toLowerCase();
  const adminMessage = String(body?.admin_message || "").trim();

  if (!id) return json({ error: "id required" }, 400);
  if (decision !== "approved" && decision !== "rejected")
    return json({ error: "decision must be 'approved' or 'rejected'" }, 400);

  const review = await loadReview(reviewsContainer, id, companyPk).catch(() => null);
  if (!review) return json({ error: "review not found" }, 404);

  const nowIso = new Date().toISOString();
  const prevApproved = review.status === "approved";
  const decidedBy = (req && req.__admin_email) || null;

  // ---- update the review doc
  review.status = decision;
  review.is_public = decision === "approved";
  review.admin_message = adminMessage || null;
  review.reason = decision === "rejected" ? adminMessage || null : null;
  review.decided_at = nowIso;
  review.decided_by = decidedBy;

  try {
    await reviewsContainer.items.upsert(review, { partitionKey: review.company || "reviews" });
  } catch (e) {
    return json({ error: `Failed to update review: ${e?.message || e}` }, 500);
  }

  // ---- reflect the decision on the company doc (embed + counts + rescore)
  let scoring = null;
  let companyUpdated = false;
  const companyName = review.company_name || review.company || "";

  const needsCompanyWrite =
    (decision === "approved") || (decision === "rejected" && prevApproved);

  if (needsCompanyWrite && companiesContainer) {
    const company = await findCompanyByIdOrName(companiesContainer, {
      companyId: review.company_id || "",
      companyName,
    }).catch(() => null);

    if (company && String(company.normalized_domain || "").trim()) {
      const existingReviews = Array.isArray(company.reviews) ? company.reviews : [];
      // Drop any prior embed of this same review so re-decisions stay idempotent.
      const withoutThis = existingReviews.filter((r) => r && r.review_id !== review.id);

      if (decision === "approved") {
        company.reviews = [toEmbeddedReview(review, nowIso), ...withoutThis];
        if (!prevApproved) {
          company.review_count = nonNegInt(company.review_count) + 1;
          company.public_review_count = nonNegInt(company.public_review_count) + 1;
        }
      } else {
        // rejected a previously-approved review → unpublish it from the doc
        company.reviews = withoutThis;
        company.review_count = Math.max(0, nonNegInt(company.review_count) - 1);
        company.public_review_count = Math.max(0, nonNegInt(company.public_review_count) - 1);
      }

      scoring = await rescoreCompany(company, nowIso, context);

      try {
        await companiesContainer.items.upsert(company, {
          partitionKey: String(company.normalized_domain).trim(),
        });
        companyUpdated = true;
      } catch (e) {
        context?.log?.(`[admin-review-decide] company upsert failed: ${e?.message || e}`);
      }
    } else {
      context?.log?.(
        `[admin-review-decide] no matching company doc for review ${review.id} (${companyName}); review status updated but scores not recalculated`
      );
    }
  }

  // ---- notify the submitter (best-effort)
  await emailDecision(review, decision, adminMessage, companyName, context);

  return json({
    ok: true,
    id: review.id,
    decision,
    company_updated: companyUpdated,
    star4: scoring?.ok ? scoring.reputation_score : undefined,
    star5: scoring?.ok ? scoring.quality_score : undefined,
    review,
  });
}

app.http("adminReviewDecide", {
  route: "xadmin-api-review-decide",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: withAdminGuard(adminReviewDecideHandler),
});

module.exports = { handler: adminReviewDecideHandler };
