import React, { useCallback, useEffect, useRef } from "react";

/**
 * Draggable divider between the results list and the map. The 60/40 default
 * was an arbitrary pick — this lets each user set the balance they want, and
 * the choice persists (see useSplitRatio).
 *
 * Accessible as a real separator: focusable, arrow keys nudge, Home/End jump
 * to the bounds, and it reports its position via aria-valuenow.
 */
// How far the map may grow: the list stops at a third of the row, which is
// the narrowest the company cards still read at (below 50% their 6-column
// grid already stacks into a single column — see .results-list--narrow).
// The map never takes the whole width; the drag simply runs out of room here,
// so there is no second layout to switch into and nothing to warn about.
export const SPLIT_MIN = 33;
export const SPLIT_MAX = 80;

export default function SplitHandle({ ratio, onRatio, containerRef }) {
  const draggingRef = useRef(false);

  const ratioFromClientX = useCallback(
    (clientX) => {
      const el = containerRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return null;
      const pct = ((clientX - rect.left) / rect.width) * 100;
      return Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, Math.round(pct)));
    },
    [containerRef]
  );

  const handlePointerDown = useCallback((e) => {
    draggingRef.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    // Stop the drag from selecting list text under the cursor.
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  }, []);

  const handlePointerMove = useCallback(
    (e) => {
      if (!draggingRef.current) return;
      const next = ratioFromClientX(e.clientX);
      if (next != null) onRatio(next);
    },
    [ratioFromClientX, onRatio]
  );

  const endDrag = useCallback((e) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    e.currentTarget?.releasePointerCapture?.(e.pointerId);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  }, []);

  useEffect(
    () => () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    },
    []
  );

  const handleKeyDown = useCallback(
    (e) => {
      const step = e.shiftKey ? 10 : 2;
      let next = null;
      if (e.key === "ArrowLeft") next = ratio - step;
      else if (e.key === "ArrowRight") next = ratio + step;
      else if (e.key === "Home") next = SPLIT_MIN;
      else if (e.key === "End") next = SPLIT_MAX;
      else return;
      e.preventDefault();
      onRatio(Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, next)));
    },
    [ratio, onRatio]
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the results list and map"
      aria-valuenow={ratio}
      aria-valuemin={SPLIT_MIN}
      aria-valuemax={SPLIT_MAX}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
      onDoubleClick={() => {
        onRatio(60);
      }}
      title="Drag to resize · double-click to reset"
      // Sticky + full-column height: the rail stays reachable after the user
      // scrolls into the results, instead of being stranded at the top.
      className="hidden lg:flex items-start justify-center cursor-col-resize group touch-none select-none focus:outline-none sticky top-4 h-[calc(100vh-6rem)]"
    >
      {/* Thin rail that thickens on hover/focus so the target is easy to grab
          without the divider shouting for attention at rest. Centred in the
          sticky column so it sits mid-viewport while scrolling. */}
      <div className="mt-[45vh] h-16 w-1 rounded-full bg-border transition-colors group-hover:bg-primary/60 group-focus:bg-primary group-active:bg-primary" />
    </div>
  );
}
