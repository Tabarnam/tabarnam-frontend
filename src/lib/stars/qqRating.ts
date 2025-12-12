import type { Company, CompanyRating, RatingIconType } from "@/types/company";
import { calculateTotalScore, getOrCalculateRating } from "@/lib/stars/calculateRating";

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function toFiniteNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isCompanyRating(value: unknown): value is CompanyRating {
  if (!value || typeof value !== "object") return false;
  return (
    "star1" in value ||
    "star2" in value ||
    "star3" in value ||
    "star4" in value ||
    "star5" in value
  );
}

export function getQQDefaultIconType(company: Partial<Company> | null | undefined): RatingIconType {
  const t = (company as any)?.rating_icon_type;
  return t === "heart" ? "heart" : "star";
}

export function getQQScore(company: Partial<Company> | null | undefined): number {
  if (!company) return 0;

  const rating = (company as any).rating;

  if (isCompanyRating(rating)) {
    return clamp(calculateTotalScore(rating), 0, 5);
  }

  const ratingAsNumber = toFiniteNumber(rating);
  if (ratingAsNumber != null) {
    return clamp(ratingAsNumber, 0, 5);
  }

  const starRating = toFiniteNumber((company as any).star_rating);
  if (starRating != null) {
    return clamp(starRating, 0, 5);
  }

  const starScore = toFiniteNumber((company as any).star_score);
  if (starScore != null) {
    return clamp(starScore, 0, 5);
  }

  const stars = toFiniteNumber((company as any).stars);
  if (stars != null) {
    return clamp(stars, 0, 5);
  }

  const confidence = toFiniteNumber((company as any).confidence_score);
  if (confidence != null) {
    return clamp(confidence * 5, 0, 5);
  }

  const derivedRating = getOrCalculateRating(company as Company);
  return clamp(calculateTotalScore(derivedRating), 0, 5);
}

export function getQQFilledCount(company: Partial<Company> | null | undefined): number {
  return clamp(Math.round(getQQScore(company)), 0, 5);
}

export function getQQStarIcons(company: Partial<Company> | null | undefined): Record<number, "star" | "heart"> {
  const defaultType = getQQDefaultIconType(company);
  const starIcons: Record<number, "star" | "heart"> = {
    1: defaultType,
    2: defaultType,
    3: defaultType,
    4: defaultType,
    5: defaultType,
  };

  const rating = (company as any)?.rating;
  if (isCompanyRating(rating)) {
    const starKeys = ["star1", "star2", "star3", "star4", "star5"] as const;
    for (let i = 1; i <= 5; i++) {
      const starKey = starKeys[i - 1];
      const iconType = rating?.[starKey]?.icon_type;
      if (iconType === "heart" || iconType === "star") starIcons[i] = iconType;
    }
  }

  const explanation = (company as any)?.star_explanation;
  if (Array.isArray(explanation)) {
    for (const exp of explanation) {
      const lvl = toFiniteNumber(exp?.star_level);
      if (lvl == null || lvl < 1 || lvl > 5) continue;
      const icon = exp?.icon === "heart" ? "heart" : "star";
      starIcons[Math.round(lvl)] = icon;
    }
  }

  return starIcons;
}

export function hasQQRating(company: Partial<Company> | null | undefined): boolean {
  if (!company) return false;

  const rating = (company as any).rating;
  if (isCompanyRating(rating)) return calculateTotalScore(rating) > 0;

  const ratingAsNumber = toFiniteNumber(rating);
  if (ratingAsNumber != null) return ratingAsNumber > 0;

  const starRating = toFiniteNumber((company as any).star_rating);
  if (starRating != null) return starRating > 0;

  const starScore = toFiniteNumber((company as any).star_score);
  if (starScore != null) return starScore > 0;

  const stars = toFiniteNumber((company as any).stars);
  if (stars != null) return stars > 0;

  const confidence = toFiniteNumber((company as any).confidence_score);
  if (confidence != null) return confidence > 0;

  return false;
}
