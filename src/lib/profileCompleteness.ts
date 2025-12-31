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

export function getProfileCompletenessLabel(score: number): string {
  const s = Math.max(0, Math.min(100, Math.round(score)));
  if (s >= 85) return "Complete";
  if (s >= 60) return "Mostly complete";
  if (s >= 35) return "Partial";
  return "Stub";
}
