import React from "react";
import { Stars } from "@/components/Stars";
import { calcStars } from "@/lib/stars/calcStars";
import type { StarSignals } from "@/pages/types/stars";

type CompanyLike = {
  name: string;
  hqVerified: boolean;
  mfgVerified: boolean;
  review_count_approved: number;
  editorial_review_count?: number;
  star_overrides?: StarSignals["overrides"];
  admin_manual_extra?: number | null;
  star_notes?: StarSignals["notes"];
};

export function CompanyStarsBlock({ company }: { company: CompanyLike }) {
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

  return (
    <div className="flex items-center gap-2 justify-end">
      <Stars bundle={bundle} notes={signals.notes} size={18} />
      <span className="text-sm text-slate-600">{bundle.final.toFixed(0)}/5</span>
    </div>
  );
}
