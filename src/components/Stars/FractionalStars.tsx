import * as React from "react";

function clamp01(v: number) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function StarGlyph({ fraction }: { fraction: number }) {
  const id = React.useId();
  const fillWidth = 24 * clamp01(fraction);

  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ verticalAlign: "text-bottom" }}
    >
      <defs>
        <clipPath id={id}>
          <rect x={0} y={0} width={fillWidth} height={24} />
        </clipPath>
      </defs>

      <path
        strokeWidth="1.2"
        className="fill-slate-100 stroke-[rgb(101,188,200)]"
        d="M12 17.27L18.18 21l-1.64-7.03L22 9.245l-7.19-.62L12 2 9.19 8.625 2 9.245l5.46 4.725L5.82 21z"
      />

      {fillWidth > 0 && (
        <g clipPath={`url(#${id})`}>
          <path
            strokeWidth={0}
            className="fill-[rgb(177,221,227)]"
            d="M12 17.27L18.18 21l-1.64-7.03L22 9.245l-7.19-.62L12 2 9.19 8.625 2 9.245l5.46 4.725L5.82 21z"
          />
        </g>
      )}
    </svg>
  );
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
  const safeValue = Number.isFinite(value) ? Math.max(0, Math.min(5, value)) : 0;

  return (
    <div
      className={`inline-flex items-center gap-0.5 ${className}`}
      aria-label={`${safeValue.toFixed(1)} out of 5 stars`}
      style={{ fontSize: `${size}px`, lineHeight: 1 }}
    >
      {Array.from({ length: 5 }).map((_, i) => {
        const fraction = clamp01(safeValue - i);
        return <StarGlyph key={i} fraction={fraction} />;
      })}
    </div>
  );
}
