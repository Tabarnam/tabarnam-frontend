import React from "react";

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ verticalAlign: "text-bottom" }}
      className={filled ? "fill-[rgb(177,221,227)] stroke-[rgb(101,188,200)]" : "fill-slate-100 stroke-[rgb(101,188,200)]"}
    >
      <path
        strokeWidth="1.2"
        d="M12 17.27L18.18 21l-1.64-7.03L22 9.245l-7.19-.62L12 2 9.19 8.625 2 9.245l5.46 4.725L5.82 21z"
      />
    </svg>
  );
}

export function CompactStars({
  value,
  className = "",
}: {
  value: number;
  className?: string;
}) {
  const full = Math.max(0, Math.min(5, Math.round(value)));
  return (
    <div className={`inline-flex items-center gap-0.5 ${className}`} aria-label={`${full} out of 5 stars`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <StarIcon key={i} filled={i < full} />
      ))}
    </div>
  );
}
