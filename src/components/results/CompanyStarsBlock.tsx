import React from "react";
import { Stars } from "@/components/Stars";
import { calcStars } from "@/lib/stars/calcStars";
import { calculateTotalScore, getOrCalculateRating } from "@/lib/stars/calculateRating";
import type { StarSignals } from "@/pages/types/stars";
import type { Company, RatingIconType } from "@/types/company";

type StarExplanation = {
  star_level: number;
  note: string;
  is_public: boolean;
  icon?: 'star' | 'heart';
};

type CompanyLike = Company & {
  hqVerified?: boolean;
  mfgVerified?: boolean;
  review_count_approved?: number;
  editorial_review_count?: number;
  star_overrides?: StarSignals["overrides"];
  admin_manual_extra?: number | null;
  star_notes?: StarSignals["notes"];
  star_explanation?: StarExplanation[];
};

export function CompanyStarsBlock({ company }: { company: CompanyLike }) {
  // Try new rating schema first
  if (company.rating) {
    const totalScore = calculateTotalScore(company.rating);
    const iconType = (company.rating_icon_type || "star") as RatingIconType;

    // Build starIcons map based on rating_icon_type
    const starIcons: Record<number, 'star' | 'heart'> = {};
    for (let i = 1; i <= 5; i++) {
      starIcons[i] = iconType;
    }

    // Create a bundle-like object for the Stars component
    const mockBundle = {
      autoSubtotal: 0,
      manualExtra: 0,
      final: totalScore,
      reasons: [],
      overrides: { hq: null, manufacturing: null, review: null },
    };

    // Collect public notes from all stars
    const publicNotes: StarSignals["notes"] = [];
    if (company.rating) {
      for (const starKey of ["star1", "star2", "star3", "star4", "star5"] as const) {
        const star = company.rating[starKey];
        if (star?.notes) {
          publicNotes.push(...star.notes.filter((n) => n.is_public));
        }
      }
    }

    return (
      <div className="flex items-center gap-2 justify-end">
        <Stars bundle={mockBundle} notes={publicNotes} size={18} starIcons={starIcons} />
        <span className="text-sm text-slate-600">{totalScore.toFixed(0)}/5</span>
      </div>
    );
  }

  // Fallback to legacy rating system
  const signals: StarSignals = {
    hqEligible: !!company.hqVerified,
    manufacturingEligible: !!company.mfgVerified,
    approvedUserReviews: company.review_count_approved || 0,
    approvedEditorialReviews: company.editorial_review_count || 0,
    overrides: company.star_overrides ?? null,
    manualExtra: company.admin_manual_extra ?? 0,
    notes: company.star_notes ?? [],
  };

  const bundle = calcStars(signals);

  // Build starIcons map from star_explanation
  const starIcons: Record<number, 'star' | 'heart'> = {};
  if (Array.isArray(company.star_explanation)) {
    for (const exp of company.star_explanation) {
      if (exp.star_level >= 1 && exp.star_level <= 5) {
        starIcons[exp.star_level] = (exp.icon === 'heart' ? 'heart' : 'star');
      }
    }
  }

  return (
    <div className="flex items-center gap-2 justify-end">
      <Stars bundle={bundle} notes={signals.notes} size={18} starIcons={starIcons} />
      <span className="text-sm text-slate-600">{bundle.final.toFixed(0)}/5</span>
    </div>
  );
}
