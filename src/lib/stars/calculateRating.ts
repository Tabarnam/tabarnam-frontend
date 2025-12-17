import { CompanyRating, Company, emptyStar, defaultRating } from "@/types/company";

export interface StarCalculationInput {
  hasManufacturingLocations: boolean;
  hasHeadquarters: boolean;
  hasReviews: boolean;
}

/**
 * Calculate initial rating values based on company data.
 * This implements the explicit business rules:
 * - Star 1: 1.0 if manufacturing locations exist, else 0.0
 * - Star 2: 1.0 if headquarters location exists, else 0.0
 * - Star 3: 1.0 if reviews exist, else 0.0
 * - Stars 4-5: Default to 0.0 (manual admin adjustment only)
 */
export function calculateInitialRating(input: StarCalculationInput): CompanyRating {
  return {
    star1: {
      value: input.hasManufacturingLocations ? 1.0 : 0.0,
      notes: [],
    },
    star2: {
      value: input.hasHeadquarters ? 1.0 : 0.0,
      notes: [],
    },
    star3: {
      value: input.hasReviews ? 1.0 : 0.0,
      notes: [],
    },
    star4: {
      value: 0.0,
      notes: [],
    },
    star5: {
      value: 0.0,
      notes: [],
    },
  };
}

/**
 * Calculate total star score from a CompanyRating object.
 * Sums all 5 star values.
 */
export function calculateTotalScore(rating: CompanyRating | undefined): number {
  if (!rating) return 0;
  const sum = (rating.star1?.value || 0) +
    (rating.star2?.value || 0) +
    (rating.star3?.value || 0) +
    (rating.star4?.value || 0) +
    (rating.star5?.value || 0);
  return Math.max(0, Math.min(5, sum)); // Clamp between 0-5
}

/**
 * Derive initial rating from a company object.
 * If company.rating exists, return it as-is.
 * Otherwise, calculate it from company data.
 */
export function getOrCalculateRating(company: Company): CompanyRating {
  if (company.rating) {
    return company.rating;
  }

  // Calculate from company data
  const hasManufacturingLocations =
    (Array.isArray(company.manufacturing_geocodes) && company.manufacturing_geocodes.length > 0) ||
    (Array.isArray(company.manufacturing_locations) && company.manufacturing_locations.length > 0);

  const hqList =
    (Array.isArray((company as any).headquarters_locations) && (company as any).headquarters_locations) ||
    (Array.isArray((company as any).headquarters) && (company as any).headquarters) ||
    [];

  const hasHeadquarters =
    (Array.isArray(hqList) && hqList.length > 0) ||
    (!!company.headquarters_location && company.headquarters_location.trim().length > 0);

  const reviewCount =
    Number((company as any).review_count ?? (company as any).reviews_count ?? (company as any).review_count_approved ?? 0) ||
    Number((company as any).editorial_review_count ?? 0) ||
    Number((company as any).amazon_review_count ?? 0) ||
    Number((company as any).public_review_count ?? 0) ||
    Number((company as any).private_review_count ?? 0) ||
    0;

  const input: StarCalculationInput = {
    hasManufacturingLocations,
    hasHeadquarters,
    hasReviews:
      reviewCount >= 1 ||
      (Array.isArray((company as any).reviews) && (company as any).reviews.length > 0),
  };

  return calculateInitialRating(input);
}

/**
 * Clamp a star value to valid range (0.0 - 1.0), rounded to 2 decimals.
 */
export function clampStarValue(value: number): number {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return Math.round(clamped * 100) / 100;
}

/**
 * Validate and normalize a rating object.
 * Ensures all stars have valid values and note arrays.
 */
export function normalizeRating(rating: any): CompanyRating {
  if (!rating || typeof rating !== "object") {
    return defaultRating();
  }

  const normalized = defaultRating();
  
  for (const starKey of ["star1", "star2", "star3", "star4", "star5"] as const) {
    const star = rating[starKey];
    if (star && typeof star === "object") {
      normalized[starKey].value = clampStarValue(star.value ?? 0);
      normalized[starKey].notes = Array.isArray(star.notes) ? star.notes : [];
    }
  }

  return normalized;
}
