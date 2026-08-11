import React from "react";
import { cn } from "@/lib/utils";

/**
 * Both / HQ / Mfg pill for the made-in pages — same control (and styling) as
 * the map panel's pin filter, so the two surfaces read as one system.
 *
 * "mfg" is the default because the page claims "Made in X"; Both and HQ are
 * opt-in widenings. The mode lives in the URL (?show=) for shareability, but
 * the canonical link and head tags stay pinned to the manufacturing view so
 * the three modes never split search-engine equity.
 */
const MODES = [
  ["both", "Both"],
  ["hq", "HQ"],
  ["mfg", "Mfg"],
];

export default function ViewToggle({ mode, onChange, counts }) {
  return (
    <div
      className="inline-flex gap-1 bg-muted rounded-lg p-0.5 border border-border"
      role="group"
      aria-label="Show companies by"
    >
      {MODES.map(([val, label]) => (
        <button
          key={val}
          type="button"
          onClick={() => onChange(val)}
          aria-pressed={mode === val}
          className={cn(
            "text-xs px-2.5 py-1.5 rounded-md transition-colors",
            mode === val
              ? "bg-card shadow-sm font-medium text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {label}
          {counts && Number.isFinite(counts[val]) && (
            <span className="ml-1 opacity-70">{counts[val].toLocaleString()}</span>
          )}
        </button>
      ))}
    </div>
  );
}
