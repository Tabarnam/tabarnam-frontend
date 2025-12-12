import React from "react";
import { DotGlyph } from "./RatingDots";

export function CompactStars({
  value,
  className = "",
}: {
  value: number;
  className?: string;
}) {
  const full = Math.max(0, Math.min(5, Math.round(value)));
  return (
    <div className={`inline-flex items-center gap-1 ${className}`} aria-label={`${full} out of 5`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <DotGlyph key={i} fraction={i < full ? 1 : 0} />
      ))}
    </div>
  );
}
