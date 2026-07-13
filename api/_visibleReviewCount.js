// api/_visibleReviewCount.js
//
// Single source of truth for "how many reviews can a user actually see for this
// company". Computed FRESH from the company document every time it's read, so it
// can never drift out of sync with reality and never needs an admin recount:
// the number shown on a card always equals what the reviews list will show.
//
// Sources (matching the visibility rules get-reviews applies):
//   - curated/editorial reviews (company.curated_reviews, or company.reviews as
//     a legacy fallback): visible unless explicitly hidden, and if they carry a
//     URL it must be a valid http(s) one.
//   - embedded approved user reviews (company.reviews with type:"user" /
//     review_id): these are added to the doc only on approval and removed on
//     reject/remove, so their presence == a publicly visible user review.
//
// NOTE: admin rating notes (a separate, rarely-visible construct get-reviews can
// also surface) are intentionally not counted here; if a company ever needs them
// reflected, extend this helper — do not reintroduce a maintained aggregate.

// Visible unless the flag is explicitly false / "false". Absent flag → visible.
function isVisibleFlag(flag) {
  if (flag === false) return false;
  if (typeof flag === "string" && flag.trim().toLowerCase() === "false") return false;
  return true;
}

function isEmbeddedUserReview(r) {
  return Boolean(r && (r.type === "user" || r.review_id));
}

function isVisibleCurated(r) {
  if (!r || typeof r !== "object") return false;
  // Embedded user reviews are counted separately — don't double-count them here.
  if (isEmbeddedUserReview(r)) return false;
  const flag = r.show_to_users ?? r.showToUsers ?? r.is_public ?? r.visible_to_users ?? r.visible;
  if (!isVisibleFlag(flag)) return false;
  // A curated review with a URL must have a valid http(s) one; no URL is fine.
  const url = r.source_url || r.url || "";
  if (typeof url === "string" && url.trim() && !/^https?:\/\//i.test(url.trim())) return false;
  return true;
}

function isVisibleEmbeddedUserReview(r) {
  if (!isEmbeddedUserReview(r)) return false;
  const flag = r.public ?? r.is_public ?? r.isPublic ?? r.visible_to_users ?? r.show_to_users;
  return isVisibleFlag(flag);
}

/**
 * Count reviews visible to end users for a company document.
 * @param {object} doc company document (needs curated_reviews and/or reviews)
 * @returns {number}
 */
function countVisibleReviews(doc) {
  if (!doc || typeof doc !== "object") return 0;

  const curatedSource = Array.isArray(doc.curated_reviews)
    ? doc.curated_reviews
    : Array.isArray(doc.reviews)
      ? doc.reviews
      : [];
  let n = 0;
  for (const r of curatedSource) if (isVisibleCurated(r)) n++;

  const embedded = Array.isArray(doc.reviews) ? doc.reviews : [];
  for (const r of embedded) if (isVisibleEmbeddedUserReview(r)) n++;

  return n;
}

module.exports = { countVisibleReviews, isVisibleCurated, isVisibleEmbeddedUserReview };
