import * as React from "react";

export const TAB_BLUE = "#B1DDE3";
export const TAB_BLUE_OUTLINE = "#649BA0";

function clamp01(v: number) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

export function clampRating(value: unknown, max = 5) {
  const n = typeof value === "number" ? value : Number(value);
  const safe = Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.min(max, safe));
}

function formatA11yValue(value: number) {
  if (Math.abs(value - Math.round(value)) < 1e-9) return String(Math.round(value));
  return value.toFixed(1);
}

export function DotGlyph({ fraction }: { fraction: number }) {
  const id = React.useId();
  const fillWidth = 24 * clamp01(fraction);

  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      style={{ verticalAlign: "text-bottom" }}
    >
      <defs>
        <clipPath id={id}>
          <rect x={0} y={0} width={fillWidth} height={24} />
        </clipPath>
      </defs>

      <circle
        cx={12}
        cy={12}
        r={9}
        fill="transparent"
        stroke={TAB_BLUE_OUTLINE}
        strokeWidth={2}
      />

      {fillWidth > 0 && (
        <g clipPath={`url(#${id})`}>
          <circle cx={12} cy={12} r={9} fill={TAB_BLUE} />
        </g>
      )}
    </svg>
  );
}

export function RatingDots({
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

  return (
    <div
      className={`inline-flex items-center gap-1 ${className}`}
      aria-label={`${formatA11yValue(safe)} out of ${max}`}
      style={{ fontSize: `${size}px`, lineHeight: 1 }}
    >
      {Array.from({ length: max }).map((_, i) => {
        const fraction = clamp01(safe - i);
        return <DotGlyph key={i} fraction={fraction} />;
      })}
    </div>
  );
}
