const assert = require("node:assert/strict");
const { test } = require("node:test");

const { mergeCompanyDocsForSession } = require("./_companyDocMerge");

test("mergeCompanyDocsForSession preserves existing HQ when incoming HQ is empty", () => {
  const existingDoc = {
    id: "company_1",
    normalized_domain: "example.com",
    company_name: "Example",
    headquarters_location: "Austin, TX, United States",
    hq_unknown: false,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
  };

  const incomingDoc = {
    id: "company_1",
    normalized_domain: "example.com",
    company_name: "Example",
    headquarters_location: "",
    hq_unknown: true,
    hq_unknown_reason: "not_found_after_location_enrichment",
    updated_at: "2026-01-01T00:00:00.000Z",
  };

  const merged = mergeCompanyDocsForSession({
    existingDoc,
    incomingDoc,
    finalNormalizedDomain: "example.com",
  });

  assert.equal(merged.headquarters_location, "Austin, TX, United States");
  assert.equal(merged.hq_unknown, false);
  assert.equal(merged.hq_unknown_reason, "");
  assert.equal(merged.created_at, "2025-01-01T00:00:00.000Z");
  assert.equal(merged.updated_at, "2026-01-01T00:00:00.000Z");
});

test("mergeCompanyDocsForSession preserves existing curated_reviews when incoming reviews are empty", () => {
  const existingDoc = {
    id: "company_2",
    normalized_domain: "reviews.com",
    company_name: "Reviews Inc",
    curated_reviews: [
      {
        source: "editorial_site",
        source_url: "https://example.com/review",
        title: "Great product",
        excerpt: "Solid performance",
        rating: 4.5,
        author: "Test",
        date: "2025-01-01",
        _dedupe_key: "abc",
      },
    ],
    review_count: 1,
    review_cursor: {
      last_attempt_at: "2025-01-01T00:00:00.000Z",
      exhausted: false,
    },
    reviews_last_updated_at: "2025-01-01T00:00:00.000Z",
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
  };

  const incomingDoc = {
    id: "company_2",
    normalized_domain: "reviews.com",
    company_name: "Reviews Inc",
    curated_reviews: [],
    review_count: 0,
    review_cursor: {
      last_attempt_at: "2025-12-31T00:00:00.000Z",
      exhausted: true,
    },
    reviews_last_updated_at: "2025-12-31T00:00:00.000Z",
    updated_at: "2025-12-31T00:00:00.000Z",
  };

  const merged = mergeCompanyDocsForSession({
    existingDoc,
    incomingDoc,
    finalNormalizedDomain: "reviews.com",
  });

  // New behavior: when an import/refresh runs later (reviews_last_updated_at newer),
  // curated_reviews is authoritative even if empty. This lets us clear stale/bad reviews.
  assert.equal(merged.curated_reviews.length, 0);
  assert.equal(merged.review_count, 0);
  assert.equal(merged.review_cursor.exhausted, true);
  assert.equal(merged.review_cursor.last_attempt_at, "2025-12-31T00:00:00.000Z");
});

test("mergeCompanyDocsForSession prefers incoming manufacturing_locations when provided", () => {
  const existingDoc = {
    id: "company_3",
    normalized_domain: "mfg.com",
    company_name: "MFG",
    manufacturing_locations: [],
    mfg_unknown: true,
    mfg_unknown_reason: "unknown",
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
  };

  const incomingDoc = {
    id: "company_3",
    normalized_domain: "mfg.com",
    company_name: "MFG",
    manufacturing_locations: ["United States"],
    mfg_unknown: false,
    mfg_unknown_reason: "",
    updated_at: "2025-02-01T00:00:00.000Z",
  };

  const merged = mergeCompanyDocsForSession({
    existingDoc,
    incomingDoc,
    finalNormalizedDomain: "mfg.com",
  });

  assert.deepEqual(merged.manufacturing_locations, ["United States"]);
  assert.equal(merged.mfg_unknown, false);
  assert.equal(merged.mfg_unknown_reason, "");
});

test("mergeCompanyDocsForSession preserves manual review star and admin stars when incoming provides default rating", () => {
  const existingDoc = {
    id: "company_4",
    normalized_domain: "stars.com",
    company_name: "Stars Inc",
    reviews_star_source: "manual",
    reviews_star_value: 0.5,
    rating: {
      star1: { value: 0.0, notes: [] },
      star2: { value: 0.0, notes: [] },
      star3: { value: 0.5, notes: [] },
      star4: { value: 1.0, notes: [{ id: "n1", source: "admin" }] },
      star5: { value: 1.0, notes: [] },
    },
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
  };

  const incomingDoc = {
    id: "company_4",
    normalized_domain: "stars.com",
    company_name: "Stars Inc",
    reviews_star_source: "auto",
    reviews_star_value: 1,
    rating: {
      star1: { value: 1.0, notes: [] },
      star2: { value: 1.0, notes: [] },
      star3: { value: 1.0, notes: [] },
      star4: { value: 0.0, notes: [] },
      star5: { value: 0.0, notes: [] },
    },
    updated_at: "2026-01-01T00:00:00.000Z",
  };

  const merged = mergeCompanyDocsForSession({
    existingDoc,
    incomingDoc,
    finalNormalizedDomain: "stars.com",
  });

  assert.equal(merged.reviews_star_source, "manual");
  assert.equal(merged.reviews_star_value, 0.5);

  // incoming star1/star2 can update, but star3/star4/star5 must preserve existing manual adjustments.
  assert.equal(merged.rating.star1.value, 1.0);
  assert.equal(merged.rating.star2.value, 1.0);
  assert.equal(merged.rating.star3.value, 0.5);
  assert.equal(merged.rating.star4.value, 1.0);
  assert.equal(merged.rating.star5.value, 1.0);
});
