import React, { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { calculateInitialRating, clampStarValue, normalizeRating } from "@/lib/stars/calculateRating";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  normalizeRatingIconType,
  computeAutoRatingInput,
} from "./dashboardUtils";

const STARS = [
  { key: "star1", label: "Mfg", fullLabel: "Manufacturing", hasAuto: true },
  { key: "star2", label: "HQ", fullLabel: "HQ/Home", hasAuto: true },
  { key: "star3", label: "Reviews", fullLabel: "Reviews", hasAuto: true },
  { key: "star4", label: "Admin1", fullLabel: "Admin1", hasAuto: false },
  { key: "star5", label: "Admin2", fullLabel: "Admin2", hasAuto: false },
];

export default function RatingEditor({ draft, onChange, StarNotesEditor }) {
  const [expandedStar, setExpandedStar] = useState(null);

  const rating = normalizeRating(draft?.rating);
  const auto = calculateInitialRating(computeAutoRatingInput(draft));
  const defaultIconType = normalizeRatingIconType(draft?.rating_icon_type, rating);
  const reviewsStarSource = String(draft?.reviews_star_source || "").toLowerCase() === "manual" ? "manual" : "auto";

  const setDefaultIconType = (iconType) => {
    const next = iconType === "heart" ? "heart" : "star";
    onChange({ ...(draft || {}), rating_icon_type: next });
  };

  const matchAllStarsToDefault = () => {
    const starKeys = ["star1", "star2", "star3", "star4", "star5"];
    const nextRating = { ...rating };
    for (const k of starKeys) {
      nextRating[k] = { ...(nextRating[k] || {}), icon_type: defaultIconType };
    }
    onChange({ ...(draft || {}), rating_icon_type: defaultIconType, rating: nextRating });
  };

  const setStar = (starKey, patch) => {
    const nextRating = {
      ...rating,
      [starKey]: {
        ...(rating[starKey] || {}),
        ...(patch || {}),
      },
    };
    onChange({ ...(draft || {}), rating: nextRating });
  };

  const setStarValue = (starKey, value) => {
    if (starKey === "star3") {
      const nextRating = {
        ...rating,
        star3: { ...(rating.star3 || {}), value },
      };
      onChange({
        ...(draft || {}),
        rating: nextRating,
        reviews_star_value: value,
        reviews_star_source: "manual",
      });
      return;
    }
    setStar(starKey, { value });
  };

  const setStarAuto = (starKey, autoValue) => {
    const next = clampStarValue(Number(autoValue));
    if (starKey === "star3") {
      const nextRating = {
        ...rating,
        star3: { ...(rating.star3 || {}), value: next },
      };
      onChange({
        ...(draft || {}),
        rating: nextRating,
        reviews_star_value: next,
        reviews_star_source: "auto",
      });
      return;
    }
    setStar(starKey, { value: next });
  };

  return (
    <div className="space-y-2">
      {/* Header: label + frontend icon config */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-slate-700 dark:text-muted-foreground font-medium">Stars</div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground mr-0.5">Icon:</span>
          <Button
            type="button"
            size="sm"
            variant={defaultIconType === "star" ? "default" : "outline"}
            className="h-6 px-2 text-xs"
            onClick={() => setDefaultIconType("star")}
          >
            ●
          </Button>
          <Button
            type="button"
            size="sm"
            variant={defaultIconType === "heart" ? "default" : "outline"}
            className="h-6 px-2 text-xs"
            onClick={() => setDefaultIconType("heart")}
          >
            ♥
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            onClick={matchAllStarsToDefault}
          >
            Match all
          </Button>
        </div>
      </div>

      {/* Compact star table */}
      <div className="rounded-lg border border-slate-200 dark:border-border bg-white dark:bg-card overflow-hidden">
        {STARS.map(({ key: starKey, label, hasAuto }, idx) => {
          const star = rating[starKey] || { value: 0, notes: [] };
          const autoValue = hasAuto ? auto[starKey]?.value : null;
          const currentValue = clampStarValue(Number(star.value ?? 0));
          const notes = Array.isArray(star.notes) ? star.notes : [];
          const isExpanded = expandedStar === starKey;

          return (
            <React.Fragment key={starKey}>
              {/* Row */}
              <div
                className={`flex items-center gap-2 px-3 py-2 ${
                  idx > 0 ? "border-t border-slate-100 dark:border-border" : ""
                }`}
              >
                {/* Star label */}
                <div className="w-[72px] flex-none">
                  <div className="text-xs font-medium text-slate-900 dark:text-foreground leading-tight">
                    {label}
                  </div>
                  <div className="text-[10px] text-muted-foreground leading-tight">
                    {hasAuto ? "auto" : "manual"}
                    {starKey === "star3" && reviewsStarSource === "manual" ? (
                      <span className="ml-1 text-amber-600">ovr</span>
                    ) : null}
                  </div>
                </div>

                {/* Value input */}
                <Input
                  value={String(currentValue)}
                  inputMode="decimal"
                  className="w-14 h-7 text-xs text-center flex-none"
                  onChange={(e) => {
                    setStarValue(starKey, clampStarValue(Number(e.target.value)));
                  }}
                />

                {/* Quick set buttons */}
                <div className="flex items-center gap-1 flex-none">
                  {[0, 0.5, 1].map((v) => (
                    <button
                      key={v}
                      type="button"
                      className={`h-6 w-6 rounded text-[10px] font-medium border transition-colors ${
                        currentValue === v
                          ? "bg-slate-900 text-white border-slate-900 dark:bg-foreground dark:text-background dark:border-foreground"
                          : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50 dark:bg-card dark:text-muted-foreground dark:border-border dark:hover:bg-muted"
                      }`}
                      onClick={() => setStarValue(starKey, v)}
                      title={`Set to ${v.toFixed(1)}`}
                    >
                      {v === 0.5 ? "½" : v}
                    </button>
                  ))}
                  {autoValue != null ? (
                    <button
                      type="button"
                      className={`h-6 px-1.5 rounded text-[10px] font-medium border transition-colors ${
                        starKey === "star3" && reviewsStarSource !== "manual"
                          ? "bg-emerald-600 text-white border-emerald-600"
                          : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50 dark:bg-card dark:text-muted-foreground dark:border-border dark:hover:bg-muted"
                      }`}
                      onClick={() => setStarAuto(starKey, autoValue)}
                      title="Use auto value"
                    >
                      ↻
                    </button>
                  ) : null}
                </div>

                {/* Icon toggles */}
                <div className="flex items-center gap-0.5 flex-none">
                  <button
                    type="button"
                    className={`h-6 w-6 rounded text-xs transition-colors ${
                      star.icon_type !== "heart"
                        ? "bg-slate-900 text-white dark:bg-foreground dark:text-background"
                        : "text-slate-400 hover:text-slate-600 dark:text-muted-foreground dark:hover:text-foreground"
                    }`}
                    onClick={() => setStar(starKey, { icon_type: "star" })}
                    title="Circle icon"
                  >
                    ●
                  </button>
                  <button
                    type="button"
                    className={`h-6 w-6 rounded text-xs transition-colors ${
                      star.icon_type === "heart"
                        ? "bg-slate-900 text-white dark:bg-foreground dark:text-background"
                        : "text-slate-400 hover:text-slate-600 dark:text-muted-foreground dark:hover:text-foreground"
                    }`}
                    onClick={() => setStar(starKey, { icon_type: "heart" })}
                    title="Heart icon"
                  >
                    ♥
                  </button>
                </div>

                {/* Notes expand toggle */}
                <button
                  type="button"
                  className="flex items-center gap-0.5 h-6 px-1 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-slate-50 dark:hover:bg-muted transition-colors ml-auto flex-none"
                  onClick={() => setExpandedStar(isExpanded ? null : starKey)}
                  title={`${notes.length} note${notes.length !== 1 ? "s" : ""}`}
                >
                  <span className={`font-medium ${notes.length > 0 ? "text-slate-700 dark:text-foreground" : ""}`}>
                    {notes.length}
                  </span>
                  {isExpanded
                    ? <ChevronDown className="h-3 w-3" />
                    : <ChevronRight className="h-3 w-3" />}
                </button>
              </div>

              {/* Expanded notes section */}
              {isExpanded ? (
                <div className="border-t border-slate-100 dark:border-border bg-slate-50 dark:bg-muted px-3 py-2">
                  <StarNotesEditor star={star} onChange={(nextStar) => setStar(starKey, nextStar)} />
                </div>
              ) : null}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
