function asString(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => asString(v).trim()).filter(Boolean);
  }

  const s = asString(value).trim();
  if (!s) return [];

  return s
    .split(/\s*[,;|]\s*/g)
    .map((v) => v.trim())
    .filter(Boolean);
}

function hasStructuredLocations(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(asString(value).trim());
}

function hasManufacturing(company: any): boolean {
  return (
    (Array.isArray(company?.manufacturing_geocodes) && company.manufacturing_geocodes.length > 0) ||
    (Array.isArray(company?.manufacturing_locations) && company.manufacturing_locations.length > 0)
  );
}

function hasHeadquarters(company: any): boolean {
  return (
    hasStructuredLocations(company?.headquarters_locations) ||
    hasStructuredLocations(company?.headquarters) ||
    Boolean(asString(company?.headquarters_location).trim())
  );
}

function hasReviews(company: any): boolean {
  if (Array.isArray(company?.curated_reviews) && company.curated_reviews.length > 0) return true;
  if (Array.isArray(company?.reviews) && company.reviews.length > 0) return true;

  const n = Number(company?.editorial_review_count || company?.review_count || 0);
  return Number.isFinite(n) && n > 0;
}

export function getProfileCompleteness(company: any): number {
  const raw = (company as any)?.profile_completeness;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(0, Math.min(100, Math.round(raw)));
  }

  if (!company || typeof company !== "object") return 0;

  const hasTagline = Boolean(asString(company.tagline).trim());
  const industries = Array.isArray(company.industries) ? company.industries.filter(Boolean) : [];
  const hasIndustries = industries.length > 0;

  const keywords = normalizeStringList(Array.isArray(company.keywords) ? company.keywords : company.product_keywords || company.keywords);
  const keywordCount = keywords.length;

  const hqOk = hasHeadquarters(company);
  const mfgOk = hasManufacturing(company);
  const reviewsOk = hasReviews(company);

  let score = 0;
  if (hasTagline) score += 20;
  if (hasIndustries) score += 15;

  if (keywordCount >= 15) score += 20;
  else if (keywordCount >= 8) score += 15;
  else if (keywordCount >= 3) score += 8;

  if (hqOk) score += 15;
  if (mfgOk) score += 15;
  if (reviewsOk) score += 15;

  return Math.max(0, Math.min(100, Math.round(score)));
}

export interface ProfileGap {
  label: string;
  points: number;
}

export function getProfileGaps(company: any): ProfileGap[] {
  if (!company || typeof company !== "object") return [];

  const gaps: ProfileGap[] = [];

  if (!Boolean(asString(company.tagline).trim())) {
    gaps.push({ label: "Missing tagline", points: 20 });
  }

  const industries = Array.isArray(company.industries) ? company.industries.filter(Boolean) : [];
  if (industries.length === 0) {
    gaps.push({ label: "No industries", points: 15 });
  }

  const keywords = normalizeStringList(
    Array.isArray(company.keywords) ? company.keywords : company.product_keywords || company.keywords,
  );
  const kw = keywords.length;
  if (kw < 15) {
    const earned = kw >= 8 ? 15 : kw >= 3 ? 8 : 0;
    gaps.push({ label: kw === 0 ? "No products" : `Only ${kw} product${kw === 1 ? "" : "s"} (15 for full score)`, points: 20 - earned });
  }

  if (!hasHeadquarters(company)) {
    gaps.push({ label: "No headquarters location", points: 15 });
  }

  if (!hasManufacturing(company)) {
    gaps.push({ label: "No manufacturing locations", points: 15 });
  }

  if (!hasReviews(company)) {
    gaps.push({ label: "No reviews", points: 15 });
  }

  return gaps;
}

// Missing-field reasons that mean "the pipeline has concluded" — a field in
// this state is a permanent gap (surfaced via issue chips), not in-flight work.
const TERMINAL_MISSING_REASONS = new Set([
  "not_disclosed",
  "exhausted",
  "low_quality_terminal",
  "not_found_terminal",
  "no_synthesis",
  "empty",
  "upstream_timeout_terminal",
  "second_look_exhausted",
  "cycle_cap_exhausted",
]);

// Fields whose absence never means "still importing": amazon_url is
// admin-entered by design.
const NON_PIPELINE_FIELDS = new Set(["amazon_url"]);

const FINISHING_WINDOW_MS = 24 * 60 * 60 * 1000;

// The homepage screenshot and logo are fetched by background workers AFTER the
// import contract is satisfied, and they are NOT part of import_missing_fields
// — which is why a row could read "Complete · 95%" while its homepage was
// still landing (Garrett Popcorn, 2026-08-09: created 02:23:09, homepage
// written 02:24:51). Measured lag across a day of imports: 52s min, 101s
// median, 200s max — so a 15-minute window covers the pipeline with wide
// margin while never touching the legacy catalog.
const IMAGE_FINISHING_WINDOW_MS = 15 * 60 * 1000;

// States that mean the image pipeline is still going to act. Anything else
// (failed / not_found_on_site / not_found_terminal / no_candidates /
// budget_exhausted) is a concluded outcome and belongs in the issue chips.
const LOGO_IN_FLIGHT_STATUSES = new Set(["", "pending", "queued", "deferred", "in_progress"]);

function imageStillArriving(company: any, createdAt: number): string[] {
  if (Date.now() - createdAt > IMAGE_FINISHING_WINDOW_MS) return [];
  const pending: string[] = [];

  // Homepage screenshot: absent status means the worker has not reported yet.
  const hasHomepage = Boolean(asString(company?.homepage_image_url).trim());
  const homepageCleared = Boolean(company?.homepage_issue_cleared);
  const homepageStatus = asString(company?.homepage_fetch_status).trim().toLowerCase();
  if (!hasHomepage && !homepageCleared && homepageStatus === "") pending.push("homepage");

  // Logo: an explicit in-flight status, or no status recorded yet.
  const hasLogo = Boolean(asString(company?.logo_url).trim());
  if (!hasLogo) {
    const logoStatus = asString(company?.logo_status).trim().toLowerCase();
    const logoStage = asString(company?.logo_stage_status).trim().toLowerCase();
    if (LOGO_IN_FLIGHT_STATUSES.has(logoStatus) || LOGO_IN_FLIGHT_STATUSES.has(logoStage)) pending.push("logo");
  }

  return pending;
}

/**
 * Which fields are still being populated, for the "Finishing…" chip tooltip.
 * Empty array when nothing is in flight.
 */
export function getFinishingFields(company: any): string[] {
  if (!company || typeof company !== "object") return [];
  const createdAt = Date.parse(asString(company.created_at));
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > FINISHING_WINDOW_MS) return [];

  const pending = imageStillArriving(company, createdAt);

  const missing: string[] = Array.isArray(company?.enrichment_health?.missing_fields)
    ? company.enrichment_health.missing_fields
    : Array.isArray(company?.import_missing_fields)
      ? company.import_missing_fields
      : [];
  const reasons =
    company.import_missing_reason && typeof company.import_missing_reason === "object" ? company.import_missing_reason : {};

  for (const f of missing) {
    const field = asString(f).trim();
    if (!field || NON_PIPELINE_FIELDS.has(field)) continue;
    const reason = asString(reasons[field]).trim().toLowerCase();
    if (!TERMINAL_MISSING_REASONS.has(reason) && !pending.includes(field)) pending.push(field);
  }

  return pending;
}

/**
 * True while a recently imported company is still having fields populated —
 * either non-terminal missing import-contract fields, or the async image
 * pipeline (homepage screenshot / logo) still in flight. The Profile chip
 * shows "Finishing…" instead of a final-sounding "Complete".
 *
 * Both checks are time-boxed from created_at so the legacy catalog (old rows
 * with permanent gaps) is never re-flagged: 24h for contract fields, 15min
 * for the image pipeline.
 */
export function isImportFinishing(company: any): boolean {
  return getFinishingFields(company).length > 0;
}

export function getProfileCompletenessLabel(score: number): string {
  const s = Math.max(0, Math.min(100, Math.round(score)));
  if (s >= 85) return "Complete";
  if (s >= 60) return "Mostly complete";
  if (s >= 35) return "Partial";
  return "Stub";
}
