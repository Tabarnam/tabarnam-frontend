import * as React from "react";
import { TAB_BLUE, TAB_BLUE_OUTLINE, clampRating } from "./RatingDots";

export function HeartGlyph({ filled }: { filled: boolean }) {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      style={{ verticalAlign: "text-bottom" }}
    >
      <path
        d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"
        fill={filled ? TAB_BLUE : "transparent"}
        stroke={TAB_BLUE_OUTLINE}
        strokeWidth={2}
      />
    </svg>
  );
}

function formatA11yValue(value: number) {
  if (Math.abs(value - Math.round(value)) < 1e-9) return String(Math.round(value));
  return value.toFixed(1);
}

export function RatingHearts({
  value = 0,
  max = 5,
  size = 14,
  className = "",
}: {
  value?: number;
  max?: number;
  size?: number;
  className?: string;
}) {
  const safe = clampRating(value, max);
  const full = Math.max(0, Math.min(max, Math.round(safe)));

  return (
    <div
      className={`inline-flex items-center gap-1 ${className}`}
      aria-label={`${formatA11yValue(safe)} out of ${max}`}
      style={{ fontSize: `${size}px`, lineHeight: 1 }}
    >
      {Array.from({ length: max }).map((_, i) => (
        <HeartGlyph key={i} filled={i < full} />
      ))}
    </div>
  );
}
