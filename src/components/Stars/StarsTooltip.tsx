import React, { useMemo, useState } from "react";
import type { StarBundle, StarSignals } from "../../pages/types/stars";

/**
 * StarsTooltip
 * - Renders ✓HQ / ✓Manufacturing / ✓Reviews lines
 * - Appends public admin notes
 * - Truncates to 6 lines with a Show more/less toggle
 */
export interface StarsTooltipProps {
  bundle: StarBundle;
  notes?: StarSignals["notes"];
  maxLines?: number; // default 6
  starIcons?: Record<number, 'star' | 'heart'>; // icons for each star level 1-5
}

export const StarsTooltip: React.FC<StarsTooltipProps> = ({
  bundle,
  notes = [],
  maxLines = 6,
}) => {
  const lines = useMemo(() => {
    const base: string[] = [];
    const awarded = new Set(
      bundle.reasons.filter(
        (r: string) => r === "hq" || r === "manufacturing" || r === "review"
      )
    );
    base.push(`${awarded.has("hq") ? "✓" : "✗"} HQ`);
    base.push(`${awarded.has("manufacturing") ? "✓" : "✗"} Manufacturing`);
    base.push(`${awarded.has("review") ? "✓" : "✗"} Reviews`);

    // Only public notes inside the tooltip
    for (const n of notes || []) {
      if (n?.public && n.text?.trim()) {
        base.push(n.text.trim());
      }
    }
    return base;
  }, [bundle, notes]);

  const [expanded, setExpanded] = useState(false);

  const visible = expanded ? lines : lines.slice(0, maxLines);
  const overflow = lines.length > maxLines;

  return (
    <div
      role="tooltip"
      className="tab-tooltip rounded-2xl bg-white p-3 text-sm text-slate-700 w-72"
    >
      <ul className="space-y-1">
        {visible.map((l, idx) => (
          <li key={idx} className="leading-snug">{l}</li>
        ))}
      </ul>

      {overflow && (
        <button
          type="button"
          className="mt-2 text-xs underline text-slate-700 hover:text-slate-900"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? "Show less" : `Show more (+${lines.length - maxLines})`}
        </button>
      )}
    </div>
  );
};
