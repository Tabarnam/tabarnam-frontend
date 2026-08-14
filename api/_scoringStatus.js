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

// "Fully settled" — is every async post-import writer done, so an admin can
// edit the company without a late backfill clobbering the edit? Composed from
// the company doc only (no extra Cosmos reads). The contract is
// TERMINAL-EVIDENCE, not mere absence: a field that is empty *with no terminal
// marker* counts as still-pending (otherwise a row would flash "safe to edit"
// the instant enrichment returns, before scoring/logo/geocode have run — the
// exact bug this guards against). A terminal *failure* counts as settled.
//
//   scoring  — companyNeedsScoring(doc) === false (handles 0.25 placeholders)
//   logo     — logo_url set, OR logo_status is any value except "pending"
//              (every failure value — not_found_on_site, error, url_dead,
//              skipped, … — is terminal; only "pending"/absent is in-flight)
//   geocode  — manufacturing_geocodes populated, OR mfg_unknown === true, OR
//              there are no manufacturing_locations to geocode
//
// Homepage image (homepage_image_url) is intentionally NOT gated on: there is
// no homepage_status terminal marker in the schema, so blocking on it would
// risk a permanently-"settling" row. Admins rarely hand-edit that field, and
// the caller applies a poll-exhaustion fallback as a backstop. If a homepage
// terminal marker is added later, fold it in here.
//
// Returns { settled: boolean, pending: string[] } — booleans/labels only, so a
// caller can safely surface it on an unauthenticated endpoint without leaking
// raw scoring values or internals.
function companyFullySettled(company) {
  const pending = [];

  if (companyNeedsScoring(company)) pending.push("scoring");

  const logoUrl = company && typeof company.logo_url === "string" ? company.logo_url.trim() : "";
  const logoStatus = company && typeof company.logo_status === "string" ? company.logo_status.trim().toLowerCase() : "";
  const logoTerminal = Boolean(logoUrl) || (logoStatus !== "" && logoStatus !== "pending");
  if (!logoTerminal) pending.push("logo");

  const mfgLocations = company && Array.isArray(company.manufacturing_locations) ? company.manufacturing_locations : [];
  const mfgGeocodes = company && Array.isArray(company.manufacturing_geocodes) ? company.manufacturing_geocodes : [];
  const geocodeTerminal = mfgGeocodes.length > 0 || company?.mfg_unknown === true || mfgLocations.length === 0;
  if (!geocodeTerminal) pending.push("geocode");

  return { settled: pending.length === 0, pending };
}

module.exports = { companyNeedsScoring, companyScoringState, companyFullySettled, INSUFFICIENT_DATA_REASON };
