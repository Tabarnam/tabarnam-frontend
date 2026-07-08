// api/_reviewDecide.js
//
// Shared core for approving/rejecting a user-submitted review, used by BOTH the
// admin queue (api/admin-review-decide, admin-authed) and one-click inbox
// approval (api/review-action, token-authed).
//
// decideReview() does everything: update the review doc, embed/unembed it in the
// company doc, adjust public counts, immediately recompute Reputation/Quality
// scores, write a score-history entry, and email the submitter the decision.

const { findCompanyByIdOrName } = require("./_reviewCounts");
const { computeReputationQualityScores } = require("./_companyScoring");
const { isEmailConfigured, sendEmail } = require("./_graphEmail");
const { renderEmail, esc } = require("./_emailLayout");
const { writeCompanyEditHistoryEntry } = require("./_companyEditHistory");

function nonNegInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

// Normalize an approved user review into the shape buildReviewsSummary() reads.
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
    approved_at: nowIso,
  };
}

async function loadReview(reviewsContainer, id, companyPk) {
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
    company.rating.star4 = { ...existingStar4, value: scoring.reputation_score, reasoning: scoring.reputation_reasoning, insufficient_data: insufficientData };
    company.rating.star5 = { ...existingStar5, value: scoring.quality_score, reasoning: scoring.quality_reasoning, insufficient_data: insufficientData };
  } else {
    context?.log?.(`[review-decide] rescore failed: ${scoring.reason || "unknown"}`);
  }

  company.updated_at = nowIso;
  return scoring;
}

// Branded, logo'd decision email to the reviewer. Routed through the shared
// _emailLayout so it carries the Tabarnam wordmark + "Tabarnam Support"
// signature, matching the receipt and thank-you emails.
async function emailDecision(review, decision, adminMessage, companyName, context) {
  if (!review.user_email || !isEmailConfigured()) return;

  const firstName = String(review.user_name || "").trim().split(/\s+/)[0] || "";
  const greeting = firstName ? `Hi ${esc(firstName)},` : "Hi there,";
  const co = esc(companyName);
  const p = (html) =>
    `<tr><td style="padding:0 0 14px;"><div style="font:400 15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#41494D;">${html}</div></td></tr>`;
  const noteRows = adminMessage
    ? p("A note from our team:") +
      `<tr><td style="padding:0 0 14px;"><div style="border-left:3px solid #86C6CF;padding:2px 0 2px 14px;font:400 15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#41494D;">${esc(adminMessage).replace(/\n/g, "<br />")}</div></td></tr>`
    : "";

  let subject;
  let headerLabel;
  let contentHtml;
  if (decision === "approved") {
    subject = `Your review of ${companyName} is now live`;
    headerLabel = "REVIEW APPROVED";
    contentHtml =
      p(greeting) +
      p(`Good news — your review of <strong>${co}</strong> has been approved and is now published on Tabarnam. Thank you for helping other shoppers choose with confidence.`) +
      noteRows;
  } else {
    subject = `About your review of ${companyName}`;
    headerLabel = "REVIEW UPDATE";
    contentHtml =
      p(greeting) +
      p(`Thank you for taking the time to review <strong>${co}</strong>. After a look by our team, we aren't able to publish this submission.`) +
      (adminMessage
        ? p("Reason:") +
          `<tr><td style="padding:0 0 14px;"><div style="border-left:3px solid #86C6CF;padding:2px 0 2px 14px;font:400 15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#41494D;">${esc(adminMessage).replace(/\n/g, "<br />")}</div></td></tr>`
        : "") +
      p("You're welcome to submit an updated review anytime.");
  }

  const html = renderEmail({ headerLabel, contentHtml, signature: true, preheader: subject });

  try {
    await sendEmail({ to: review.user_email, toName: review.user_name || undefined, subject, html });
  } catch (e) {
    context?.log?.(`[review-decide] decision email failed: ${e?.message || e}`);
  }
}

/**
 * Approve or reject a review and reflect it everywhere.
 * @returns {Promise<{ok:boolean, error?:string, decision?:string, company_updated?:boolean, star4?:number, star5?:number, review?:object}>}
 */
async function decideReview({ reviewsContainer, companiesContainer, id, company: companyPk, decision, admin_message, decidedBy, context }) {
  if (!reviewsContainer) return { ok: false, error: "cosmos_unavailable" };

  const dec = String(decision || "").trim().toLowerCase();
  if (dec !== "approved" && dec !== "rejected") return { ok: false, error: "bad_decision" };

  const reviewId = String(id || "").trim();
  if (!reviewId) return { ok: false, error: "id_required" };

  const review = await loadReview(reviewsContainer, reviewId, String(companyPk || "").trim()).catch(() => null);
  if (!review) return { ok: false, error: "not_found" };

  const nowIso = new Date().toISOString();
  const prevApproved = review.status === "approved";
  const adminMessage = String(admin_message || "").trim();

  review.status = dec;
  review.is_public = dec === "approved";
  review.admin_message = adminMessage || null;
  review.reason = dec === "rejected" ? adminMessage || null : null;
  review.decided_at = nowIso;
  review.decided_by = decidedBy || null;

  try {
    await reviewsContainer.items.upsert(review, { partitionKey: review.company || "reviews" });
  } catch (e) {
    return { ok: false, error: `update_failed: ${e?.message || e}` };
  }

  let scoring = null;
  let companyUpdated = false;
  const companyName = review.company_name || review.company || "";
  const needsCompanyWrite = dec === "approved" || (dec === "rejected" && prevApproved);

  if (needsCompanyWrite && companiesContainer) {
    const company = await findCompanyByIdOrName(companiesContainer, {
      companyId: review.company_id || "",
      companyName,
    }).catch(() => null);

    if (company && String(company.normalized_domain || "").trim()) {
      const companyBefore = JSON.parse(JSON.stringify(company));
      const existingReviews = Array.isArray(company.reviews) ? company.reviews : [];
      const withoutThis = existingReviews.filter((r) => r && r.review_id !== review.id);

      if (dec === "approved") {
        company.reviews = [toEmbeddedReview(review, nowIso), ...withoutThis];
        if (!prevApproved) {
          company.review_count = nonNegInt(company.review_count) + 1;
          company.public_review_count = nonNegInt(company.public_review_count) + 1;
        }
      } else {
        company.reviews = withoutThis;
        company.review_count = Math.max(0, nonNegInt(company.review_count) - 1);
        company.public_review_count = Math.max(0, nonNegInt(company.public_review_count) - 1);
      }

      scoring = await rescoreCompany(company, nowIso, context);

      try {
        await companiesContainer.items.upsert(company, { partitionKey: String(company.normalized_domain).trim() });
        companyUpdated = true;
      } catch (e) {
        context?.log?.(`[review-decide] company upsert failed: ${e?.message || e}`);
      }

      if (companyUpdated) {
        try {
          await writeCompanyEditHistoryEntry({
            company_id: String(company.company_id || company.id || review.company_id || "").trim(),
            actor_email: decidedBy || undefined,
            actor_user_id: decidedBy || undefined,
            action: "score_rescore",
            source: `review-${dec}`,
            before: companyBefore,
            after: company,
            trigger: { type: `review_${dec}`, review_id: review.id, review_subject: review.subject || null },
          });
        } catch (e) {
          context?.log?.(`[review-decide] history write failed: ${e?.message || e}`);
        }
      }
    } else {
      context?.log?.(`[review-decide] no matching company doc for review ${review.id} (${companyName}); scores not recalculated`);
    }
  }

  await emailDecision(review, dec, adminMessage, companyName, context);

  return {
    ok: true,
    decision: dec,
    company_updated: companyUpdated,
    star4: scoring?.ok ? scoring.reputation_score : undefined,
    star5: scoring?.ok ? scoring.quality_score : undefined,
    review,
  };
}

module.exports = { decideReview, loadReview };
