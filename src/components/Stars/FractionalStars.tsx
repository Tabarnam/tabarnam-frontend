import * as React from "react";
import { DotGlyph, clampRating } from "./RatingDots";

function clamp01(v: number) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

export function FractionalStars({
  value,
  size = 18,
  className = "",
}: {
  value: number;
  size?: number;
  className?: string;
}) {
  const safeValue = clampRating(value, 5);

  return (
    <div
      className={`inline-flex items-center gap-1 ${className}`}
      aria-label={`${safeValue.toFixed(1)} out of 5`}
      style={{ fontSize: `${size}px`, lineHeight: 1 }}
    >
      {Array.from({ length: 5 }).map((_, i) => {
        const fraction = clamp01(safeValue - i);
        return <DotGlyph key={i} fraction={fraction} />;
      })}
    </div>
  );
}
