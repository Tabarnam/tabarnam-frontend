const assert = require("node:assert/strict");
const { test } = require("node:test");

const { countVisibleReviews, isVisibleCurated } = require("./_visibleReviewCount");

test("counts visible curated reviews, ignoring hidden ones", () => {
  const doc = {
    curated_reviews: [
      { source_url: "https://a.com", show_to_users: true },
      { source_url: "https://b.com" }, // no flag → visible
      { source_url: "https://c.com", show_to_users: false }, // hidden
      { source_url: "https://d.com", is_public: "false" }, // hidden (string)
    ],
  };
  assert.equal(countVisibleReviews(doc), 2);
});

test("Douglas Smith case: curated-only after user reviews removed", () => {
  // 8 visible curated, no embedded user reviews left → 8 (not the stale 13/5).
  const doc = {
    curated_reviews: Array.from({ length: 8 }, (_, i) => ({ source_url: `https://s${i}.com` })),
    reviews: [],
    review_count: 13,
    public_review_count: 5,
  };
  assert.equal(countVisibleReviews(doc), 8);
});

test("counts embedded approved user reviews plus visible curated", () => {
  const doc = {
    curated_reviews: [{ source_url: "https://a.com" }],
    reviews: [
      { type: "user", review_id: "r1", text: "great", is_public: true },
      { type: "user", review_id: "r2", text: "good" }, // no flag → visible
      { type: "user", review_id: "r3", text: "hidden", is_public: false },
    ],
  };
  // 1 curated + 2 visible user = 3
  assert.equal(countVisibleReviews(doc), 3);
});

test("does not double-count embedded user reviews via the curated fallback", () => {
  // No curated_reviews → curated source falls back to reviews, but user entries
  // are skipped by the curated pass and counted once by the user pass.
  const doc = {
    reviews: [
      { type: "user", review_id: "r1", is_public: true },
      { type: "user", review_id: "r2", is_public: true },
    ],
  };
  assert.equal(countVisibleReviews(doc), 2);
});

test("curated review with an invalid (non-http) URL is hidden", () => {
  assert.equal(isVisibleCurated({ source_url: "ftp://x" }), false);
  assert.equal(isVisibleCurated({ source_url: "https://x.com" }), true);
  assert.equal(isVisibleCurated({}), true); // no URL, no flag → visible
});

test("empty / missing docs return 0", () => {
  assert.equal(countVisibleReviews(null), 0);
  assert.equal(countVisibleReviews({}), 0);
  assert.equal(countVisibleReviews({ curated_reviews: [], reviews: [] }), 0);
});
