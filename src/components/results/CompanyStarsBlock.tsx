import React from "react";
import { Stars } from "@/components/Stars";
import { calcStars } from "@/lib/stars/calcStars";
import { getQQFilledCount, getQQScore, getQQStarIcons } from "@/lib/stars/qqRating";
import type { StarSignals } from "@/pages/types/stars";
import type { Company } from "@/types/company";

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
  const adminRatingPublic = (company as any)?.visibility?.admin_rating_public;
  const shouldShow = adminRatingPublic ?? true;
  if (!shouldShow) {
    return <span className="text-sm text-slate-400">—</span>;
  }

  const score = getQQScore(company);
  const filled = getQQFilledCount(company);
  const starIcons = getQQStarIcons(company);

  const publicNotes: StarSignals["notes"] = [];
  const rating = (company as any)?.rating;
  if (rating && typeof rating === "object") {
    for (const starKey of ["star1", "star2", "star3", "star4", "star5"] as const) {
      const star = (rating as any)[starKey];
      const notes = star?.notes && Array.isArray(star.notes) ? star.notes : [];

      for (const n of notes) {
        if (!n || typeof n !== "object") continue;
        const text = String(n.text || "").trim();
        if (!text) continue;

        const isPublic = n.is_public === true || String(n.is_public).toLowerCase() === "true";
        if (!isPublic) continue;

        const by = String(n.created_by || n.actor || "Admin").trim() || "Admin";
        const at = String(n.created_at || n.updated_at || new Date().toISOString()).trim();

        publicNotes.push({ text, public: true, by, at });
      }
    }
  }

  const signals: StarSignals = {
    hqEligible: !!company.hqVerified,
    manufacturingEligible: !!company.mfgVerified,
    approvedUserReviews: company.review_count_approved || 0,
    approvedEditorialReviews: company.editorial_review_count || 0,
    overrides: company.star_overrides ?? null,
    manualExtra: company.admin_manual_extra ?? 0,
    notes: company.star_notes ?? [],
  };

  const legacyBundle = calcStars(signals);

  const bundle = {
    ...legacyBundle,
    final: score,
  };

  const notesToUse = publicNotes.length > 0 ? publicNotes : signals.notes;

  return (
    <div className="flex items-center gap-2 justify-end">
      <Stars bundle={bundle} notes={notesToUse} size={18} starIcons={starIcons} />
      <span className="text-sm text-slate-600">{filled}/5</span>
    </div>
  );
}
