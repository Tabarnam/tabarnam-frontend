const assert = require("node:assert/strict");
const { test } = require("node:test");

const { applyEnrichmentToCompany } = require("./_directEnrichment");

// ── Reviews field mapping ────────────────────────────────────────────────────

test("applyEnrichmentToCompany writes reviews to curated_reviews (not reviews)", async () => {
  const company = { id: "c1", name: "Test Co" };
  const enrichResult = {
    enriched: {
      reviews: {
        reviews: [
          { title: "Great product", source_url: "https://example.com/review" },
          { title: "Love it", source_url: "https://blog.example.com/review2" },
        ],
        reviews_status: "ok",
        searched_at: "2026-02-12T00:00:00Z",
      },
    },
    finished_at: "2026-02-12T00:00:00Z",
    elapsed_ms: 100,
    attempts: 1,
  };

  const updated = await applyEnrichmentToCompany(company, enrichResult);

  // Must write to curated_reviews, NOT reviews
  assert.equal(Array.isArray(updated.curated_reviews), true);
  assert.equal(updated.curated_reviews.length, 2);
  assert.equal(updated.curated_reviews[0].title, "Great product");

  // Must NOT write to plain "reviews" field
  assert.equal(updated.reviews, undefined);
});

test("applyEnrichmentToCompany sets review_count from reviews array", async () => {
  const company = { id: "c1" };
  const enrichResult = {
    enriched: {
      reviews: {
        reviews: [{ title: "R1" }, { title: "R2" }, { title: "R3" }],
        reviews_status: "ok",
      },
    },
  };

  const updated = await applyEnrichmentToCompany(company, enrichResult);
  assert.equal(updated.review_count, 3);
});

test("applyEnrichmentToCompany sets reviews_stage_status (not reviews_status)", async () => {
  const company = { id: "c1" };
  const enrichResult = {
    enriched: {
      reviews: {
        reviews: [{ title: "R1" }],
        reviews_status: "incomplete",
      },
    },
  };

  const updated = await applyEnrichmentToCompany(company, enrichResult);
  assert.equal(updated.reviews_stage_status, "incomplete");

  // Must NOT write the old field name
  assert.equal(updated.reviews_status, undefined);
});

test("applyEnrichmentToCompany falls back to review_candidates", async () => {
  const company = { id: "c1" };
  const enrichResult = {
    enriched: {
      reviews: {
        review_candidates: [{ title: "Candidate1" }],
        reviews_status: "ok",
      },
    },
  };

  const updated = await applyEnrichmentToCompany(company, enrichResult);
  assert.equal(Array.isArray(updated.curated_reviews), true);
  assert.equal(updated.curated_reviews.length, 1);
  assert.equal(updated.review_count, 1);
});

// ── No-op when no enrichment data ────────────────────────────────────────────

test("applyEnrichmentToCompany returns company unchanged when enriched is empty", async () => {
  const company = { id: "c1", name: "Test Co" };
  const enrichResult = { enriched: {} };

  const updated = await applyEnrichmentToCompany(company, enrichResult);
  assert.equal(updated.id, "c1");
  assert.equal(updated.name, "Test Co");
  assert.equal(updated.curated_reviews, undefined);
});

test("applyEnrichmentToCompany returns company as-is when enrichmentResult is null", async () => {
  const company = { id: "c1" };
  const result = await applyEnrichmentToCompany(company, null);
  assert.equal(result.id, "c1");
});

// ── Other fields still work (no regression) ──────────────────────────────────

test("applyEnrichmentToCompany still applies tagline correctly", async () => {
  const company = { id: "c1" };
  const enrichResult = {
    enriched: {
      tagline: {
        tagline: "Best organic products",
        tagline_status: "ok",
      },
    },
  };

  const updated = await applyEnrichmentToCompany(company, enrichResult);
  assert.equal(updated.tagline, "Best organic products");
  assert.equal(updated.tagline_status, "ok");
});

test("applyEnrichmentToCompany still applies industries correctly", async () => {
  const company = { id: "c1" };
  const enrichResult = {
    enriched: {
      industries: {
        industries: ["Food and Beverage", "Health"],
        industries_status: "ok",
      },
    },
  };

  const updated = await applyEnrichmentToCompany(company, enrichResult);
  assert.deepEqual(updated.industries, ["Food and Beverage", "Health"]);
});

test("applyEnrichmentToCompany still applies product_keywords correctly", async () => {
  const company = { id: "c1" };
  const enrichResult = {
    enriched: {
      product_keywords: {
        product_keywords: ["Widget A", "Widget B"],
        product_keywords_status: "ok",
      },
    },
  };

  const updated = await applyEnrichmentToCompany(company, enrichResult);
  assert.deepEqual(updated.product_keywords, ["Widget A", "Widget B"]);
  assert.equal(updated.product_keywords_status, "ok");
});
