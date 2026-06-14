// Single source of truth for "does this company still need Reputation/Quality
// scoring?" — shared by the backfill job creator, the batch worker's wave
// selection, and the status endpoint's counts so they never disagree.
//
// A company is "scored" when rating.star4.value is a real number > 0. The one
// wrinkle: computeReputationQualityScores (api/_companyScoring.js) has a
// skip-short-circuit that writes the placeholder 0.25/0.25 *without* an xAI call
// when there's essentially no data (reviews <40ch AND about <40ch AND no admin
// notes). Those placeholders should be re-scored — once a company gains
// reviews/about they get a real score; if still data-less the skip path returns
// 0.25 again for free (no xAI call), so re-checking them is cheap.

const INSUFFICIENT_DATA_REASON = /not enough captured data/i;

function getStar4(company) {
  const rating =
    company && typeof company.rating === "object" && !Array.isArray(company.rating)
      ? company.rating
      : null;
  return rating && typeof rating.star4 === "object" && !Array.isArray(rating.star4)
    ? rating.star4
    : null;
}

// True when the company should be (re)scored.
function companyNeedsScoring(company) {
  const star4 = getStar4(company);
  const value = star4 && typeof star4.value === "number" ? star4.value : null;

  // Never scored — no numeric value > 0.
  if (!(typeof value === "number" && value > 0)) return true;

  // Forward-looking marker persisted when the scorer skipped for lack of data.
  if (star4.insufficient_data === true) return true;

  // Existing 0.25 "insufficient data" placeholders that predate the marker —
  // identified by the exact value plus the placeholder reasoning text. A real
  // xAI score that happens to be 0.25 carries real reasoning, so it won't match.
  if (value === 0.25) {
    const reasoning = typeof star4.reasoning === "string" ? star4.reasoning : "";
    if (INSUFFICIENT_DATA_REASON.test(reasoning)) return true;
  }

  return false;
}

// Display state for the admin Scores table.
//   "unscored" — needs scoring (never scored, or an insufficient-data placeholder)
//   "scored"   — has a value > 0 AND xAI reasoning
//   "manual"   — has a value > 0 but no reasoning (admin-set, leave alone)
function companyScoringState(company) {
  if (companyNeedsScoring(company)) return "unscored";
  const star4 = getStar4(company);
  const hasReasoning = Boolean(star4 && typeof star4.reasoning === "string" && star4.reasoning);
  return hasReasoning ? "scored" : "manual";
}

module.exports = { companyNeedsScoring, companyScoringState, INSUFFICIENT_DATA_REASON };
