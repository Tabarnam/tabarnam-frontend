import { useState, useMemo, useCallback, useEffect } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  getItemDisplayLabel,
  getItemDedupKey,
  normalizeArrayFieldItems,
} from "./dashboardUtils";

/**
 * Item-level merge UI for array fields in the refresh diff panel.
 *
 * Shows two columns — "Current" and "Proposed" — each with per-item checkboxes
 * and a select-all toggle. Duplicate items (same dedup key in both lists) are
 * flagged with a "dup" indicator and default to unchecked on the proposed side.
 *
 * The merged result (checked current ∪ checked proposed, deduplicated) is pushed
 * to the parent via `onMergedChange` so that the existing `applySelectedDiffs`
 * flow applies the merge seamlessly.
 *
 * @param {string}   fieldKey       – e.g. "manufacturing_locations"
 * @param {Array}    currentValue   – array from editorDraft
 * @param {Array}    proposedValue  – array from proposedDraft (original, before merge)
 * @param {Function} onMergedChange – (mergedArray) => void
 */
export default function MergeableArrayDiff({ fieldKey, currentValue, proposedValue, onMergedChange }) {
  // ── Normalize both arrays ──
  const currentItems = useMemo(() => normalizeArrayFieldItems(fieldKey, currentValue), [fieldKey, currentValue]);
  const proposedItems = useMemo(() => normalizeArrayFieldItems(fieldKey, proposedValue), [fieldKey, proposedValue]);

  // ── Build dedup index ──
  // For each item, compute its dedup key. Build a Set of current keys so we
  // can detect which proposed items are duplicates.
  const currentKeys = useMemo(
    () => new Set(currentItems.map((item) => getItemDedupKey(fieldKey, item)).filter(Boolean)),
    [fieldKey, currentItems],
  );

  const proposedDupFlags = useMemo(
    () =>
      proposedItems.map((item) => {
        const key = getItemDedupKey(fieldKey, item);
        return key ? currentKeys.has(key) : false;
      }),
    [fieldKey, proposedItems, currentKeys],
  );

  // ── Checkbox state: Sets of indices ──
  const [currentChecked, setCurrentChecked] = useState(() => new Set(currentItems.map((_, i) => i)));
  const [proposedChecked, setProposedChecked] = useState(() => {
    const initial = new Set();
    proposedItems.forEach((_, i) => {
      if (!proposedDupFlags[i]) initial.add(i); // new items checked, dupes unchecked
    });
    return initial;
  });

  // Reset checkbox state when the underlying arrays change (new refresh)
  const currentFingerprint = useMemo(() => currentItems.map((it) => getItemDedupKey(fieldKey, it)).join("\n"), [fieldKey, currentItems]);
  const proposedFingerprint = useMemo(() => proposedItems.map((it) => getItemDedupKey(fieldKey, it)).join("\n"), [fieldKey, proposedItems]);

  useEffect(() => {
    setCurrentChecked(new Set(currentItems.map((_, i) => i)));
    const initial = new Set();
    proposedItems.forEach((_, i) => {
      if (!proposedDupFlags[i]) initial.add(i);
    });
    setProposedChecked(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFingerprint, proposedFingerprint]);

  // ── Compute merged result and push to parent ──
  const computeMerged = useCallback(
    (curChecked, propChecked) => {
      const merged = [];
      const seenKeys = new Set();

      // Add checked current items first
      for (const i of curChecked) {
        if (i < currentItems.length) {
          const key = getItemDedupKey(fieldKey, currentItems[i]);
          if (key) seenKeys.add(key);
          merged.push(currentItems[i]);
        }
      }

      // Add checked proposed items (skip duplicates)
      for (const i of propChecked) {
        if (i < proposedItems.length) {
          const key = getItemDedupKey(fieldKey, proposedItems[i]);
          if (key && seenKeys.has(key)) continue;
          if (key) seenKeys.add(key);
          merged.push(proposedItems[i]);
        }
      }

      return merged;
    },
    [fieldKey, currentItems, proposedItems],
  );

  // Push merged result whenever checkboxes change
  useEffect(() => {
    onMergedChange(computeMerged(currentChecked, proposedChecked));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChecked, proposedChecked, computeMerged]);

  // ── Toggle helpers ──
  const toggleCurrent = useCallback((idx) => {
    setCurrentChecked((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);

  const toggleProposed = useCallback((idx) => {
    setProposedChecked((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);

  const selectAllCurrent = useCallback(() => {
    setCurrentChecked(new Set(currentItems.map((_, i) => i)));
  }, [currentItems]);

  const deselectAllCurrent = useCallback(() => {
    setCurrentChecked(new Set());
  }, []);

  const selectAllProposed = useCallback(() => {
    setProposedChecked(new Set(proposedItems.map((_, i) => i)));
  }, [proposedItems]);

  const deselectAllProposed = useCallback(() => {
    setProposedChecked(new Set());
  }, []);

  const allCurrentChecked = currentChecked.size === currentItems.length && currentItems.length > 0;
  const allProposedChecked = proposedChecked.size === proposedItems.length && proposedItems.length > 0;

  // ── Render ──
  return (
    <div className="mt-2 grid grid-cols-1 lg:grid-cols-2 gap-3">
      {/* ── Current column ── */}
      <div className="rounded border border-slate-200 dark:border-border bg-white dark:bg-card p-2">
        <div className="flex items-center justify-between mb-1">
          <div className="text-xs font-semibold text-slate-700 dark:text-muted-foreground">Current</div>
          {currentItems.length > 0 && (
            <button
              type="button"
              className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline"
              onClick={allCurrentChecked ? deselectAllCurrent : selectAllCurrent}
            >
              {allCurrentChecked ? "Deselect all" : "Select all"}
            </button>
          )}
        </div>
        {currentItems.length === 0 ? (
          <div className="text-xs text-slate-400 dark:text-muted-foreground italic">(empty)</div>
        ) : (
          <div className="space-y-1">
            {currentItems.map((item, i) => {
              const label = getItemDisplayLabel(fieldKey, item);
              const key = getItemDedupKey(fieldKey, item);
              const isDup = key ? proposedItems.some((p) => getItemDedupKey(fieldKey, p) === key) : false;
              return (
                <label key={`cur-${i}`} className="flex items-start gap-1.5 group cursor-pointer">
                  <Checkbox
                    checked={currentChecked.has(i)}
                    onCheckedChange={() => toggleCurrent(i)}
                    className="mt-0.5 h-3.5 w-3.5"
                  />
                  <span
                    className={`text-xs break-all leading-snug ${
                      currentChecked.has(i) ? "text-slate-800 dark:text-foreground" : "text-slate-400 dark:text-muted-foreground line-through"
                    }`}
                  >
                    {label}
                    {isDup && <span className="ml-1 text-amber-500 dark:text-amber-400" title="Also in proposed list">\u26A1</span>}
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Proposed column ── */}
      <div className="rounded border border-slate-200 dark:border-border bg-white dark:bg-card p-2">
        <div className="flex items-center justify-between mb-1">
          <div className="text-xs font-semibold text-slate-700 dark:text-muted-foreground">Proposed</div>
          {proposedItems.length > 0 && (
            <button
              type="button"
              className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline"
              onClick={allProposedChecked ? deselectAllProposed : selectAllProposed}
            >
              {allProposedChecked ? "Deselect all" : "Select all"}
            </button>
          )}
        </div>
        {proposedItems.length === 0 ? (
          <div className="text-xs text-slate-400 dark:text-muted-foreground italic">(empty)</div>
        ) : (
          <div className="space-y-1">
            {proposedItems.map((item, i) => {
              const label = getItemDisplayLabel(fieldKey, item);
              const isDup = proposedDupFlags[i];
              return (
                <label key={`prop-${i}`} className={`flex items-start gap-1.5 group cursor-pointer ${isDup ? "opacity-60" : ""}`}>
                  <Checkbox
                    checked={proposedChecked.has(i)}
                    onCheckedChange={() => toggleProposed(i)}
                    className="mt-0.5 h-3.5 w-3.5"
                  />
                  <span
                    className={`text-xs break-all leading-snug ${
                      proposedChecked.has(i) ? "text-slate-800 dark:text-foreground" : "text-slate-400 dark:text-muted-foreground line-through"
                    }`}
                  >
                    {label}
                    {isDup && <span className="ml-1 text-amber-500 dark:text-amber-400" title="Already in current list">\u26A1</span>}
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
