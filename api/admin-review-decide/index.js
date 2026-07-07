// api/admin-review-decide/index.js
//
// Admin-only: approve or reject a pending user review from the admin queue.
// Route: POST /xadmin-api-review-decide
// Body: { id, company, decision: "approved"|"rejected", admin_message? }
//
// Thin wrapper over the shared decideReview() core (api/_reviewDecide.js), which
// publishes/unpublishes, embeds, bumps counts, rescores, writes score history,
// and emails the submitter. Guarded by withAdminGuard.

const { app } = require("../_app");
const { getReviewsContainer, getCompaniesContainer } = require("../_reviewCounts");
const { withAdminGuard } = require("../_adminAuth");
const { decideReview } = require("../_reviewDecide");

const cors = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-ms-client-principal, x-session-id",
  "Content-Type": "application/json",
});

const json = (obj, status = 200) => ({ status, headers: cors(), body: JSON.stringify(obj) });

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
  const company = String(body?.company || body?.company_name || "").trim();
  const decision = String(body?.decision || "").trim().toLowerCase();
  const admin_message = String(body?.admin_message || "").trim();

  if (!id) return json({ error: "id required" }, 400);
  if (decision !== "approved" && decision !== "rejected")
    return json({ error: "decision must be 'approved' or 'rejected'" }, 400);

  const decidedBy = (req && req.__admin_email) || null;

  const result = await decideReview({
    reviewsContainer,
    companiesContainer,
    id,
    company,
    decision,
    admin_message,
    decidedBy,
    context,
  });

  if (!result.ok) {
    const status =
      result.error === "not_found" ? 404 : String(result.error || "").startsWith("update_failed") ? 500 : 400;
    return json({ error: result.error || "decide failed" }, status);
  }

  return json({
    ok: true,
    id,
    decision: result.decision,
    company_updated: result.company_updated,
    star4: result.star4,
    star5: result.star5,
    review: result.review,
  });
}

app.http("adminReviewDecide", {
  route: "xadmin-api-review-decide",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: withAdminGuard(adminReviewDecideHandler),
});

module.exports = { handler: adminReviewDecideHandler };
