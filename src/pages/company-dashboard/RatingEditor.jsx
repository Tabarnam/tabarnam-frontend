import React from "react";

import { calculateInitialRating, clampStarValue, normalizeRating } from "@/lib/stars/calculateRating";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  normalizeRatingIconType,
  computeAutoRatingInput,
} from "./dashboardUtils";

export default function RatingEditor({ draft, onChange, StarNotesEditor }) {
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

  const renderRow = (starKey, label, autoValue) => {
    const star = rating[starKey] || { value: 0, notes: [] };
    const autoText = typeof autoValue === "number" ? String(autoValue.toFixed(1)) : null;
    const currentValue = clampStarValue(Number(star.value ?? 0));

    return (
      <div className="rounded-lg border border-slate-200 dark:border-border bg-white dark:bg-card p-3 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-semibold text-slate-900 dark:text-foreground">{label}</div>
          <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-muted-foreground">
            {autoText != null ? <span>Auto: {autoText}</span> : <span>Manual</span>}
            {starKey === "star3" ? (
              reviewsStarSource === "manual" ? (
                <span className="rounded border border-amber-200 bg-amber-50 px-2 py-0.5 text-amber-700">
                  Manual override
                </span>
              ) : (
                <span className="rounded border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-emerald-700">Auto</span>
              )
            ) : null}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:items-end">
          <div className="space-y-1">
            <label className="text-xs font-medium text-slate-700 dark:text-muted-foreground">Value (0.0–1.0)</label>
            <Input
              value={String(currentValue)}
              inputMode="decimal"
              onChange={(e) => {
                const nextValue = clampStarValue(Number(e.target.value));
                if (starKey === "star3") {
                  const nextRating = {
                    ...rating,
                    star3: {
                      ...(rating.star3 || {}),
                      value: nextValue,
                    },
                  };

                  onChange({
                    ...(draft || {}),
                    rating: nextRating,
                    reviews_star_value: nextValue,
                    reviews_star_source: "manual",
                  });
                  return;
                }

                setStar(starKey, { value: nextValue });
              }}
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-slate-700 dark:text-muted-foreground">Icon</label>
            <div className="flex gap-2">
              <Button
                type="button"
                variant={star.icon_type === "heart" ? "outline" : "default"}
                onClick={() => {
                  if (starKey === "star3") {
                    setStar("star3", { icon_type: "star" });
                    return;
                  }
                  setStar(starKey, { icon_type: "star" });
                }}
              >
                Circle
              </Button>
              <Button
                type="button"
                variant={star.icon_type === "heart" ? "default" : "outline"}
                onClick={() => {
                  if (starKey === "star3") {
                    setStar("star3", { icon_type: "heart" });
                    return;
                  }
                  setStar(starKey, { icon_type: "heart" });
                }}
              >
                Heart
              </Button>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-slate-700 dark:text-muted-foreground">Quick set</label>
            <div className="flex gap-2 flex-wrap">
              {[0, 0.5, 1].map((v) => (
                <Button
                  key={v}
                  type="button"
                  variant="outline"
                  onClick={() => {
                    if (starKey === "star3") {
                      const nextRating = {
                        ...rating,
                        star3: {
                          ...(rating.star3 || {}),
                          value: v,
                        },
                      };

                      onChange({
                        ...(draft || {}),
                        rating: nextRating,
                        reviews_star_value: v,
                        reviews_star_source: "manual",
                      });
                      return;
                    }

                    setStar(starKey, { value: v });
                  }}
                >
                  {v.toFixed(1)}
                </Button>
              ))}
              {autoValue != null ? (
                <Button
                  type="button"
                  variant={starKey === "star3" && reviewsStarSource !== "manual" ? "default" : "outline"}
                  onClick={() => {
                    if (starKey === "star3") {
                      const next = clampStarValue(Number(autoValue));
                      const nextRating = {
                        ...rating,
                        star3: {
                          ...(rating.star3 || {}),
                          value: next,
                        },
                      };

                      onChange({
                        ...(draft || {}),
                        rating: nextRating,
                        reviews_star_value: next,
                        reviews_star_source: "auto",
                      });
                      return;
                    }

                    setStar(starKey, { value: autoValue });
                  }}
                >
                  Use auto
                </Button>
              ) : null}
            </div>
          </div>
        </div>

        <StarNotesEditor star={star} onChange={(nextStar) => setStar(starKey, nextStar)} />
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <div className="text-sm text-slate-700 dark:text-muted-foreground font-medium">Stars</div>

      <div className="rounded-lg border border-slate-200 dark:border-border bg-white dark:bg-card p-3 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="text-sm font-semibold text-slate-900 dark:text-foreground">Frontend icon</div>
            <div className="text-xs text-slate-600 dark:text-muted-foreground">
              Used on cards and other places that don't support per-star icon overrides.
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant={defaultIconType === "star" ? "default" : "outline"}
              onClick={() => setDefaultIconType("star")}
            >
              Circle
            </Button>
            <Button
              type="button"
              variant={defaultIconType === "heart" ? "default" : "outline"}
              onClick={() => setDefaultIconType("heart")}
            >
              Heart
            </Button>
            <Button type="button" variant="outline" onClick={matchAllStarsToDefault}>
              Match all stars
            </Button>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        {renderRow("star1", "Manufacturing (auto)", auto.star1.value)}
        {renderRow("star2", "HQ/Home (auto)", auto.star2.value)}
        {renderRow("star3", "Reviews (auto)", auto.star3.value)}
        {renderRow("star4", "Admin1 (manual)", null)}
        {renderRow("star5", "Admin2 (manual)", null)}
      </div>
    </div>
  );
}
