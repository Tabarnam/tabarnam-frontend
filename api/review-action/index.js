// api/review-action/index.js
//
// One-click review approval/rejection from the admin notification email.
// Route: /review-action  (anonymous — the signed token IS the authorization)
//
//   GET  ?token=…  → verify token, render a CONFIRMATION page (no mutation).
//                    Email scanners prefetch links (GET) — so GET never decides.
//   POST token=…   → verify token, then (only if the review is still pending)
//                    perform the decision via the shared decideReview() core.
//
// The action is gated on the review's current status, so a token is effectively
// single-use and replays are idempotent.

const { app } = require("../_app");
const { getReviewsContainer, getCompaniesContainer } = require("../_reviewCounts");
const { verifyReviewToken } = require("../_reviewActionToken");
const { decideReview, loadReview } = require("../_reviewDecide");
const { esc } = require("../_emailLayout");

const SITE = (process.env.SITE_BASE_URL || "https://tabarnam.com").replace(/\/+$/, "");
const ACCENT = "#86C6CF";
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function html(body, status = 200) {
  return { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }, body };
}

function page(innerHtml, accent = ACCENT) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tabarnam review</title></head>
<body style="margin:0;background:#F2F4F5;font-family:${FONT};">
  <div style="max-width:560px;margin:40px auto;padding:0 16px;">
    <div style="background:#fff;border:1px solid #E6E9EA;border-radius:14px;overflow:hidden;">
      <div style="height:4px;background:${accent};"></div>
      <div style="padding:28px 30px;">${innerHtml}</div>
    </div>
    <div style="text-align:center;color:#8A949A;font-size:12px;margin-top:14px;">Tabarnam · community review moderation</div>
  </div>
</body></html>`;
}

function reviewSummary(review) {
  const company = esc(review.company_name || review.company || "");
  const subject = review.subject ? `<div style="font:600 16px/1.4 ${FONT};color:#1B2124;margin:0 0 10px;">${esc(review.subject)}</div>` : "";
  const who = review.source_name ? `<div style="font:400 13px/1.3 ${FONT};color:#7A858B;margin:10px 0 0;">Who: ${esc(review.source_name)}</div>` : "";
  return `<div style="font:400 13px/1.3 ${FONT};color:#7A858B;">Company</div>
    <div style="font:700 18px/1.3 ${FONT};color:#1B2124;margin:2px 0 16px;">${company}</div>
    ${subject}
    <div style="border-left:3px solid ${ACCENT};padding:2px 0 2px 14px;font:400 15px/1.6 ${FONT};color:#41494D;">${esc(review.text || "")}</div>
    ${who}`;
}

// Landing page for the Approve/Reject email link. It AUTO-SUBMITS the decision
// (one human tap on the email button = done). Scanner-safe: email link-preview
// bots do a bare GET and don't run JS, so the auto-submit never fires for them;
// they only ever see this static page (no mutation). A <noscript> fallback lets
// a JS-off human finish with one tap.
function autoActPage(review, action) {
  const isApprove = action === "approved";
  const accent = isApprove ? "#2E9E4F" : "#E0433E";
  const verbing = isApprove ? "Approving" : "Rejecting";
  const verb = isApprove ? "Approve" : "Reject";
  const token = review.__token;
  const inner = `
    <div style="font:700 14px/1 ${FONT};letter-spacing:2px;color:${accent};">${verbing.toUpperCase()} REVIEW…</div>
    <div style="height:1px;background:#E6E9EA;margin:16px 0 22px;"></div>
    ${reviewSummary(review)}
    <p style="font:400 14px/1.6 ${FONT};color:#5A646A;margin:22px 0 0;">Applying your decision…</p>
    <form id="ra-form" method="POST" action="/api/review-action" style="margin:16px 0 0;">
      <input type="hidden" name="token" value="${esc(token)}" />
      <noscript>
        <button type="submit" style="display:inline-block;background:${accent};color:#fff;border:0;cursor:pointer;font:700 15px/1 ${FONT};padding:14px 26px;border-radius:10px;">${verb} review</button>
        <div style="font:400 13px/1.5 ${FONT};color:#8A949A;margin-top:8px;">Tap the button to finish.</div>
      </noscript>
    </form>
    <script>window.addEventListener("load",function(){try{document.getElementById("ra-form").submit();}catch(e){}});</script>`;
  return page(inner, accent);
}

function resultPage({ title, message, accent = ACCENT }) {
  const inner = `
    <div style="font:700 20px/1.3 ${FONT};color:#1B2124;margin:0 0 8px;">${esc(title)}</div>
    <p style="font:400 15px/1.6 ${FONT};color:#5A646A;margin:0 0 20px;">${esc(message)}</p>
    <a href="${SITE}/admin/review-queue" style="display:inline-block;background:#333B41;color:#fff;text-decoration:none;font:700 15px/1 ${FONT};padding:13px 22px;border-radius:10px;">Open review queue</a>`;
  return page(inner, accent);
}

const STATUS_LABEL = { approved: "approved", rejected: "rejected", removed: "removed" };

async function reviewActionHandler(req, context) {
  const method = String(req.method || "").toUpperCase();
  if (method === "OPTIONS") return { status: 200 };

  const reviewsContainer = getReviewsContainer();
  if (!reviewsContainer) return html(resultPage({ title: "Temporarily unavailable", message: "The review service isn't configured right now." }), 500);

  // Read the token from the query (GET) or the form/JSON body (POST).
  let token = "";
  if (method === "GET") {
    try {
      token = String(new URL(req.url).searchParams.get("token") || "").trim();
    } catch {
      token = "";
    }
  } else if (method === "POST") {
    try {
      const text = await req.text();
      const params = new URLSearchParams(text);
      token = String(params.get("token") || "").trim();
      if (!token) {
        try {
          token = String(JSON.parse(text)?.token || "").trim();
        } catch {
          /* ignore */
        }
      }
    } catch {
      token = "";
    }
  } else {
    return html(resultPage({ title: "Not allowed", message: "Unsupported request." }), 405);
  }

  const v = verifyReviewToken(token);
  if (!v.ok) {
    const msg =
      v.reason === "expired"
        ? "This link has expired. Open the review queue to act on it."
        : v.reason === "not_configured"
          ? "One-click actions aren't enabled. Open the review queue instead."
          : "This link is invalid. Open the review queue to act on it.";
    return html(resultPage({ title: "Link not usable", message: msg }), 400);
  }

  const review = await loadReview(reviewsContainer, v.reviewId, v.company).catch(() => null);
  if (!review) return html(resultPage({ title: "Review not found", message: "This review no longer exists." }), 404);

  // Already decided → idempotent, show status (works for both GET and POST).
  if (String(review.status || "").toLowerCase() !== "pending") {
    const label = STATUS_LABEL[String(review.status || "").toLowerCase()] || String(review.status || "decided");
    return html(
      resultPage({ title: `Already ${label}`, message: `This review was already ${label}. No change was made.` })
    );
  }

  if (method === "GET") {
    // Auto-submitting page — no mutation happens on this GET itself.
    review.__token = token;
    return html(autoActPage(review, v.action));
  }

  // POST → perform the decision.
  const companiesContainer = getCompaniesContainer();
  const result = await decideReview({
    reviewsContainer,
    companiesContainer,
    id: v.reviewId,
    company: v.company,
    decision: v.action,
    admin_message: "",
    decidedBy: "inbox:duh@tabarnam.com",
    context,
  });

  if (!result.ok) {
    return html(resultPage({ title: "Couldn't complete that", message: "Something went wrong applying the decision. Try the review queue." }), 500);
  }

  if (result.decision === "approved") {
    return html(
      resultPage({
        title: "Review approved",
        message: "It's now live on the company profile and the Reputation and Quality scores were recalculated.",
        accent: "#2E9E4F",
      })
    );
  }
  return html(
    resultPage({ title: "Review rejected", message: "It won't be published. The reviewer has been notified if they left an email.", accent: "#E0433E" })
  );
}

app.http("reviewAction", {
  route: "review-action",
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: reviewActionHandler,
});

module.exports = { handler: reviewActionHandler };
