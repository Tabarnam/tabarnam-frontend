// api/admin-review-reply/index.js
//
// Admin-only: send a thank-you / reply email to the person who submitted a
// review. Independent of approve/reject — an admin can thank a reviewer at any
// time (pending or already decided), and send more than one note. The message
// defaults to a standard community thank-you and can be personalized per send.
//
// Route: POST /xadmin-api-review-reply
// Body:  { id, company?, message? }   (message omitted → default thank-you)
//
// Sends the branded, logo'd email via Microsoft Graph and records the reply on
// the review doc (replies[] + last_reply_at/by). It does NOT change the review
// status, embed, counts, or scores. Guarded by withAdminGuard.

const { app } = require("../_app");
const { getReviewsContainer } = require("../_reviewCounts");
const { withAdminGuard } = require("../_adminAuth");
const { loadReview } = require("../_reviewDecide");
const { isEmailConfigured, sendEmail } = require("../_graphEmail");
const { buildThankYouEmail, DEFAULT_THANKYOU_MESSAGE } = require("../_reviewReplyTemplate");

const cors = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-ms-client-principal, x-session-id",
  "Content-Type": "application/json",
});

const json = (obj, status = 200) => ({ status, headers: cors(), body: JSON.stringify(obj) });

async function adminReviewReplyHandler(req, context) {
  if (String(req.method || "").toUpperCase() === "OPTIONS") return { status: 200, headers: cors() };

  const reviewsContainer = getReviewsContainer();
  if (!reviewsContainer) return json({ error: "Cosmos env not configured" }, 500);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const id = String(body?.id || "").trim();
  const companyPk = String(body?.company || body?.company_name || "").trim();
  // Empty/whitespace message → send the standard community thank-you.
  const message = String(body?.message || "").trim() || DEFAULT_THANKYOU_MESSAGE;

  if (!id) return json({ error: "id required" }, 400);
  if (!isEmailConfigured()) return json({ error: "email_not_configured" }, 503);

  const review = await loadReview(reviewsContainer, id, companyPk).catch(() => null);
  if (!review) return json({ error: "not_found" }, 404);
  if (!review.user_email) return json({ error: "no_reviewer_email" }, 422);

  const { subject, html } = buildThankYouEmail({ userName: review.user_name, message });

  try {
    const sent = await sendEmail({
      to: review.user_email,
      toName: review.user_name || undefined,
      subject,
      html,
    });
    if (!sent?.ok) return json({ error: `email_failed: ${sent?.error || "unknown"}` }, 502);
  } catch (e) {
    context?.log?.(`[admin-review-reply] send failed: ${e?.message || e}`);
    return json({ error: "email_failed" }, 502);
  }

  // Record the reply on the review doc (audit trail; drives the "Reply sent" UI).
  const nowIso = new Date().toISOString();
  const sentBy = (req && req.__admin_email) || null;
  const entry = { message, sent_at: nowIso, sent_by: sentBy };
  review.replies = Array.isArray(review.replies) ? [...review.replies, entry] : [entry];
  review.last_reply_at = nowIso;
  review.last_reply_by = sentBy;

  try {
    await reviewsContainer.items.upsert(review, { partitionKey: review.company || "reviews" });
  } catch (e) {
    // Email already went out; surface a soft warning but don't fail the send.
    context?.log?.(`[admin-review-reply] reply record upsert failed: ${e?.message || e}`);
    return json({ ok: true, id, emailed: true, recorded: false });
  }

  return json({ ok: true, id, emailed: true, recorded: true, last_reply_at: nowIso });
}

app.http("adminReviewReply", {
  route: "xadmin-api-review-reply",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: withAdminGuard(adminReviewReplyHandler),
});

module.exports = { handler: adminReviewReplyHandler };
