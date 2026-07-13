// api/_pinVisibleReviewCount.js
//
// Authoritative "reviews visible to users" count + the pin-on-write helper.
//
// The count is whatever get-reviews returns (curated + admin notes + public
// user reviews from the reviews container, with all its visibility/dedup rules)
// — we literally run get-reviews and read its `count`. So the value pinned onto
// a company doc, the value the batch /review-counts endpoint returns, and the
// list a user sees on open are guaranteed identical.
//
// Pin-on-write: every path that changes a company's reviews calls
// recomputeAndPinVisibleCount() after its writes land, storing the fresh count
// on company.visible_review_count. search-companies then returns that pinned
// field for free (no per-read computation). The batch endpoint stays as the
// fallback for any company whose field isn't pinned yet.

const { handler: getReviewsHandler } = require("./get-reviews");

/**
 * Compute the visible-review count for a company by running get-reviews.
 * @param {string|object} idOrParams company id, or {companyId, companyName, normalizedDomain}
 * @param {object} deps optional { reviewsContainer, companiesContainer, ... } for get-reviews
 * @returns {Promise<number|null>} count, or null if it couldn't be computed
 */
async function computeVisibleReviewCount(idOrParams, deps = {}) {
  const p = typeof idOrParams === "string" ? { companyId: idOrParams } : idOrParams || {};
  const params = new URLSearchParams();
  if (p.companyId) params.set("company_id", String(p.companyId));
  else if (p.normalizedDomain) params.set("normalized_domain", String(p.normalizedDomain));
  else if (p.companyName) params.set("company", String(p.companyName));
  else return null;

  const req = {
    method: "GET",
    url: `https://internal/api/get-reviews?${params.toString()}`,
    headers: new Headers(),
  };
  try {
    const res = await getReviewsHandler(req, {}, deps);
    if (!res || res.status !== 200) return null;
    const body = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
    if (typeof body?.count === "number") return body.count;
    if (Array.isArray(body?.items)) return body.items.length;
    return null;
  } catch {
    return null;
  }
}

/**
 * Recompute the visible-review count and pin it onto the company doc. Best-effort
 * — never throws, never blocks the caller's primary operation. Patches only the
 * one field so it can't clobber concurrent edits.
 * @returns {Promise<number|null>} the pinned count, or null on any failure
 */
async function recomputeAndPinVisibleCount(companiesContainer, companyDoc, deps = {}, context) {
  if (!companiesContainer || !companyDoc) return null;
  const id = companyDoc.id || companyDoc.company_id;
  const pk = String(companyDoc.normalized_domain || "").trim();
  if (!id || !pk) return null;

  const count = await computeVisibleReviewCount(
    { companyId: id, companyName: companyDoc.company_name, normalizedDomain: pk },
    { companiesContainer, ...deps }
  );
  if (typeof count !== "number") return null;

  try {
    await companiesContainer.item(id, pk).patch([{ op: "set", path: "/visible_review_count", value: count }]);
    return count;
  } catch (e) {
    context?.log?.(`[pin-visible-count] patch failed for ${id}: ${e?.message || e}`);
    return null;
  }
}

module.exports = { computeVisibleReviewCount, recomputeAndPinVisibleCount };
