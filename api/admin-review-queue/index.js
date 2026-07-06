// api/admin-review-queue/index.js
//
// Admin-only: list user-submitted reviews awaiting (or past) moderation.
// Route: GET /xadmin-api-review-queue?status=pending|approved|rejected|all
// Default status = pending. Guarded by withAdminGuard.

const { app } = require("../_app");
const { getReviewsContainer } = require("../_reviewCounts");
const { withAdminGuard } = require("../_adminAuth");

const cors = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-ms-client-principal, x-session-id",
  "Content-Type": "application/json",
});

const json = (obj, status = 200) => ({ status, headers: cors(), body: JSON.stringify(obj) });

async function adminReviewQueueHandler(req, context) {
  if (String(req.method || "").toUpperCase() === "OPTIONS") return { status: 200, headers: cors() };

  const reviewsContainer = getReviewsContainer();
  if (!reviewsContainer) return json({ error: "Cosmos env not configured" }, 500);

  let statusFilter = "pending";
  try {
    const url = new URL(req.url);
    const s = String(url.searchParams.get("status") || "").trim().toLowerCase();
    if (s) statusFilter = s;
  } catch {
    /* keep default */
  }

  try {
    let query;
    let parameters;
    if (statusFilter === "all") {
      query = "SELECT TOP 200 * FROM c ORDER BY c.created_at DESC";
      parameters = [];
    } else {
      query = "SELECT TOP 200 * FROM c WHERE c.status = @status ORDER BY c.created_at DESC";
      parameters = [{ name: "@status", value: statusFilter }];
    }

    const { resources } = await reviewsContainer.items
      .query({ query, parameters }, { enableCrossPartitionQuery: true })
      .fetchAll();

    return json({ ok: true, status: statusFilter, count: (resources || []).length, reviews: resources || [] });
  } catch (e) {
    context?.log?.("[admin-review-queue] query failed:", e?.message || e);
    return json({ error: e?.message || "query failed" }, 500);
  }
}

app.http("adminReviewQueue", {
  route: "xadmin-api-review-queue",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: withAdminGuard(adminReviewQueueHandler),
});

module.exports = { handler: adminReviewQueueHandler };
