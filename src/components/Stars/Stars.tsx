import React, { useEffect, useId, useRef, useState } from "react";
import type { StarBundle, StarSignals } from "@/pages/types/stars";
import { StarsTooltip } from "./StarsTooltip";
import { DotGlyph } from "./RatingDots";
import { HeartGlyph } from "./RatingHearts";

export interface StarsProps {
  bundle: StarBundle;           // from calcStars()
  notes?: StarSignals["notes"]; // used for public admin tooltip lines
  /** Star glyph size expressed in CSS pixels (fallback); actual SVG uses 1em to track text size */
  size?: number;
  className?: string;
  starIcons?: Record<number, 'star' | 'heart'>; // icons for each star level 1-5
}


export const Stars: React.FC<StarsProps> = ({
  bundle,
  notes = [],
  size = 18,
  className = "",
  starIcons = {},
}) => {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const tooltipId = useId();

  // Close on outside click
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!open) return;
      const t = e.target as Node;
      if (
        triggerRef.current &&
        tooltipRef.current &&
        !triggerRef.current.contains(t) &&
        !tooltipRef.current.contains(t)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const safeFinal = (() => {
    const n = typeof bundle.final === "number" ? bundle.final : Number(bundle.final);
    return Number.isFinite(n) ? Math.max(0, Math.min(5, n)) : 0;
  })();


  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

  const formatA11yValue = (value: number) => {
    if (Math.abs(value - Math.round(value)) < 1e-9) return String(Math.round(value));
    return value.toFixed(2).replace(/\.00$/, "").replace(/(\.[0-9])0$/, "$1");
  };

  const renderIcon = (starLevel: number) => {
    const iconType = starIcons[starLevel] || "star";

    const fraction = clamp01(safeFinal - (starLevel - 1));

    if (iconType === "heart") {
      return <HeartGlyph key={starLevel} fraction={fraction} />;
    }

    return <DotGlyph key={starLevel} fraction={fraction} />;
  };

  return (
    <div className={`relative inline-flex ${className}`} style={{ fontSize: `${size}px`, lineHeight: 1 }}>
      {/* Trigger */}
      <button
        ref={triggerRef}
        type="button"
        className="group inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-2 py-1 hover:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-300"
        aria-describedby={open ? tooltipId : undefined}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={(e) => {
          const next = e.relatedTarget as Node | null;
          if (tooltipRef.current?.contains(next as Node)) return;
          setOpen(false);
        }}
      >
        <div className="flex">
          {Array.from({ length: 5 }).map((_, i) => renderIcon(i + 1))}
        </div>
        <span className="sr-only">{formatA11yValue(safeFinal)} out of 5</span>
      </button>

      {/* Tooltip */}
      {open && (
        <div
          ref={tooltipRef}
          id={tooltipId}
          className="absolute left-1/2 z-50 mt-2 -translate-x-1/2"
          tabIndex={-1}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >
          <StarsTooltip bundle={bundle} notes={notes} starIcons={starIcons} />
        </div>
      )}
    </div>
  );
};
