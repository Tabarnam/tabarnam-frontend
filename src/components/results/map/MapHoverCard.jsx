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
  onOpenProfile = null,
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
  // The company's home base, from whichever source this marker came from:
  // page results carry the full doc, index pins carry the pins-index label.
  const hqLine = (() => {
    if (marker.hqLabel) return marker.hqLabel;
    const raw = company.headquarters_location;
    if (typeof raw !== "string" || !raw.trim()) return null;
    const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
    return parts.length >= 2 ? `${parts[0]}, ${parts[1]}` : parts[0];
  })();

  const domain = String(company.normalized_domain || "").trim();

  const href = (() => {
    // ONE url for both kinds of pin: the user's current search, plus the
    // company to open. `expand` promotes it and renders it as a profile;
    // `expandDomain` lets the page fetch it first when it isn't among the
    // loaded results. The search rides along, so whatever the user was
    // looking at stays underneath as comparables — which is the difference
    // between a profile and a page showing one company in isolation.
    const params = new URLSearchParams(linkParams || "");
    params.set("expand", String(marker.companyId));
    if (marker.index && domain) params.set("expandDomain", domain);

    // No search to carry (the map opened without one): fall back to the
    // pasted-URL exact-match flow, or a name search for the rare company
    // with no domain on file.
    const hasSearch = ["q", "city", "state", "country", "lat", "domain"].some((k) => params.get(k));
    if (!hasSearch) {
      const expand = encodeURIComponent(String(marker.companyId));
      if (domain) return `/results?domain=${encodeURIComponent(domain)}&expand=${expand}`;
      return `/results?q=${encodeURIComponent(name)}&expand=${expand}`;
    }
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
      {/* On a manufacturing pin, name the company's home base too — "made
          here, based there" is the comparison the whole product exists for,
          and the card is where a user actually asks it. */}
      {marker.kind === "mfg" && hqLine && (
        <div className="text-xs mt-0.5">
          <span className="font-medium">Home/HQ</span>
          <span className="text-muted-foreground"> · {hqLine}</span>
        </div>
      )}
      {marker.lowPrecision && (
        <div className="text-[11px] text-muted-foreground/80 mt-1 italic">
          Approximate — country/region-level location
        </div>
      )}
      {/* When the results column is beside the map, the profile opens THERE:
          the company floats to the top of the list, expanded, with the
          search still beneath it as comparables. A new tab would throw that
          context away. The href stays real either way, so ctrl/middle-click
          still opens a tab and the link remains copyable. */}
      <a
        href={href}
        {...(onOpenProfile
          ? {
              onClick: (e) => {
                // Let the browser handle deliberate new-tab gestures.
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                e.preventDefault();
                onOpenProfile({
                  companyId: String(marker.companyId),
                  domain,
                });
                onClose?.();
              },
            }
          : { target: "_blank", rel: "noopener noreferrer" })}
        className="inline-block mt-2 text-xs font-semibold text-primary underline underline-offset-2 hover:opacity-80"
      >
        View company profile {onOpenProfile ? "→" : "↗"}
      </a>
    </div>
  );
}
