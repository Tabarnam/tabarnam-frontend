import React from "react";
import { RatingDots } from "@/components/Stars";
import { getQQScore } from "@/lib/stars/qqRating";

const CARD_WIDTH = 264;

/**
 * Hover/tap card for a map pin. A plain absolutely-positioned overlay rather
 * than a Leaflet <Popup>: hover semantics need open/close grace timers either
 * way, and a plain div gets the app's Tailwind/CSS-var theming for free.
 * The parent computes `point` (container px of the pin tip) and re-renders on
 * map move/zoom; this component just clamps and paints.
 */
export default function MapHoverCard({
  marker,
  point,
  containerSize,
  unit,
  linkParams,
  onMouseEnter,
  onMouseLeave,
  onClose,
}) {
  if (!marker || !point) return null;

  const company = marker.company || {};
  const name = company.display_name || company.company_name || "Company";
  const tagline = typeof company.tagline === "string" ? company.tagline.trim() : "";
  const qq = getQQScore(company);
  const kindLabel = marker.kind === "mfg" ? "Manufacturing" : "Home/HQ";

  const href = (() => {
    const params = new URLSearchParams(linkParams || "");
    params.set("expand", String(marker.companyId));
    return `/results?${params.toString()}`;
  })();

  const w = containerSize?.w || 0;
  const left = Math.max(8, Math.min(point.x - CARD_WIDTH / 2, Math.max(8, w - CARD_WIDTH - 8)));
  // Anchored above the pin; if the pin sits near the top edge, flip below it.
  const flip = point.y < 190;

  return (
    <div
      className="absolute z-[1100] rounded-lg border border-border bg-card text-card-foreground shadow-lg p-3 text-sm"
      style={{
        width: CARD_WIDTH,
        left,
        ...(flip ? { top: point.y + 10 } : { top: point.y - 44, transform: "translateY(-100%)" }),
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      role="dialog"
      aria-label={`${name} details`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="font-semibold leading-tight">{name}</div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="text-muted-foreground hover:text-foreground -mt-0.5 -mr-1 px-1"
        >
          ×
        </button>
      </div>
      {tagline && <div className="text-xs text-muted-foreground mt-1 line-clamp-2">{tagline}</div>}
      {Number.isFinite(qq) && qq > 0 && (
        <div className="mt-1.5">
          <RatingDots value={qq} size={13} />
        </div>
      )}
      <div className="text-xs mt-1.5">
        <span className="font-medium">{kindLabel}</span>
        {marker.label ? <span className="text-muted-foreground"> · {marker.label}</span> : null}
        {marker.dist != null && Number.isFinite(marker.dist) ? (
          <span className="text-muted-foreground"> · {marker.dist.toFixed(1)} {unit}</span>
        ) : null}
      </div>
      {marker.lowPrecision && (
        <div className="text-[11px] text-muted-foreground/80 mt-1 italic">
          Approximate — country/region-level location
        </div>
      )}
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block mt-2 text-xs font-semibold text-primary underline underline-offset-2 hover:opacity-80"
      >
        View &amp; compare ↗
      </a>
    </div>
  );
}
