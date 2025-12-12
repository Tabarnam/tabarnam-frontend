import React, { useEffect, useId, useRef, useState } from "react";
import type { StarBundle, StarSignals } from "@/pages/types/stars";
import { StarsTooltip } from "./StarsTooltip";

export interface StarsProps {
  bundle: StarBundle;           // from calcStars()
  notes?: StarSignals["notes"]; // used for public admin tooltip lines
  /** Star glyph size expressed in CSS pixels (fallback); actual SVG uses 1em to track text size */
  size?: number;
  className?: string;
  starIcons?: Record<number, 'star' | 'heart'>; // icons for each star level 1-5
}

function StarIcon({ filled }: { filled: boolean }) {
  // Fill/Stroke from Tabarnam tokens; size follows surrounding text (1em)
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

function HeartIcon({ filled }: { filled: boolean }) {
  // Heart icon with Tabarnam colors
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
        d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"
      />
    </svg>
  );
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

  const full = Math.max(0, Math.min(5, Math.round(bundle.final))); // ensure 0..5 int

  const renderIcon = (starLevel: number, filled: boolean) => {
    const iconType = starIcons[starLevel] || 'star';
    if (iconType === 'heart') {
      return <HeartIcon key={starLevel} filled={filled} />;
    }
    return <StarIcon key={starLevel} filled={filled} />;
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
          {Array.from({ length: 5 }).map((_, i) => renderIcon(i + 1, i < full))}
        </div>
        <span className="sr-only">{full} out of 5 stars</span>
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
