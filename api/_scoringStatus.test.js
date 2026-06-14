const test = require("node:test");
const assert = require("node:assert/strict");

const { companyNeedsScoring, companyScoringState } = require("./_scoringStatus");

test("companyNeedsScoring: never-scored companies need scoring", () => {
  assert.equal(companyNeedsScoring({}), true);
  assert.equal(companyNeedsScoring({ rating: {} }), true);
  assert.equal(companyNeedsScoring({ rating: { star4: {} } }), true);
  assert.equal(companyNeedsScoring({ rating: { star4: { value: 0 } } }), true);
  assert.equal(companyNeedsScoring({ rating: { star4: { value: "0.7" } } }), true); // non-numeric
});

test("companyNeedsScoring: a real score does NOT need scoring", () => {
  assert.equal(
    companyNeedsScoring({ rating: { star4: { value: 0.7, reasoning: "- Strong reviews" } } }),
    false
  );
  // A real xAI score that happens to be 0.25 with real reasoning is kept.
  assert.equal(
    companyNeedsScoring({ rating: { star4: { value: 0.25, reasoning: "- Mixed sentiment; one recall noted" } } }),
    false
  );
});

test("companyNeedsScoring: 0.25 insufficient-data placeholder needs re-scoring", () => {
  // Existing stub detected by the placeholder reasoning text.
  assert.equal(
    companyNeedsScoring({ rating: { star4: { value: 0.25, reasoning: "- Not enough captured data to assess reputation." } } }),
    true
  );
  // Forward-looking marker.
  assert.equal(
    companyNeedsScoring({ rating: { star4: { value: 0.25, reasoning: "- whatever", insufficient_data: true } } }),
    true
  );
});

test("companyNeedsScoring: manual score (value, no reasoning, not insufficient) is left alone", () => {
  assert.equal(companyNeedsScoring({ rating: { star4: { value: 0.5 } } }), false);
  // A manual score that happens to be 0.25 with no placeholder reasoning is NOT re-scored.
  assert.equal(companyNeedsScoring({ rating: { star4: { value: 0.25 } } }), false);
});

test("companyScoringState classifies scored / manual / unscored", () => {
  assert.equal(companyScoringState({ rating: { star4: { value: 0.7, reasoning: "- x" } } }), "scored");
  assert.equal(companyScoringState({ rating: { star4: { value: 0.7 } } }), "manual");
  assert.equal(companyScoringState({ rating: { star4: { value: 0 } } }), "unscored");
  assert.equal(
    companyScoringState({ rating: { star4: { value: 0.25, reasoning: "- Not enough captured data to assess reputation." } } }),
    "unscored"
  );
});
