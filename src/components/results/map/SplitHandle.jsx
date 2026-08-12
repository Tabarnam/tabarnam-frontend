import React, { useCallback, useEffect, useRef } from "react";

/**
 * Draggable divider between the results list and the map. The 60/40 default
 * was an arbitrary pick — this lets each user set the balance they want, and
 * the choice persists (see useSplitRatio).
 *
 * Accessible as a real separator: focusable, arrow keys nudge, Home/End jump
 * to the bounds, and it reports its position via aria-valuenow.
 */
// The list can shrink to a third of the row (map takes two thirds) — the
// product owner's call, favouring user autonomy. Below that the company
// cards' 6/5-column grid wraps into unreadable slivers.
export const SPLIT_MIN = 33;
export const SPLIT_MAX = 80;

export default function SplitHandle({
  ratio,
  onRatio,
  containerRef,
  /** Called with true on pointer-down, false on release. Lets the page hold
   *  off a layout switch until the gesture ends. */
  onDragStateChange,
  /** Short text shown beside the rail mid-drag, telling the user what
   *  releasing here will do. Null hides it. */
  hint = null,
  /** "column" is the divider between list and map; "edge" is the rail pinned
   *  to the left of a stacked (full-width) map, which drags the list back. */
  variant = "column",
}) {
  const draggingRef = useRef(false);
  const isEdge = variant === "edge";

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

  const handlePointerDown = useCallback(
    (e) => {
      draggingRef.current = true;
      onDragStateChange?.(true);
      e.currentTarget.setPointerCapture?.(e.pointerId);
      // Stop the drag from selecting list text under the cursor.
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
    },
    [onDragStateChange]
  );

  const handlePointerMove = useCallback(
    (e) => {
      if (!draggingRef.current) return;
      const next = ratioFromClientX(e.clientX);
      if (next != null) onRatio(next);
    },
    [ratioFromClientX, onRatio]
  );

  const endDrag = useCallback(
    (e) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      e.currentTarget?.releasePointerCapture?.(e.pointerId);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      // Release is the commit point: the page reads the final ratio now and
      // decides whether to switch layouts.
      onDragStateChange?.(false);
    },
    [onDragStateChange]
  );

  useEffect(
    () => () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      // Unmounting mid-drag (layout switch, navigation) must not strand the
      // page in a permanent "dragging" state.
      if (draggingRef.current) {
        draggingRef.current = false;
        onDragStateChange?.(false);
      }
    },
    [onDragStateChange]
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
      title={
        isEdge
          ? "Drag right to bring the results back beside the map"
          : "Drag to resize · double-click to reset"
      }
      // Sticky + full-column height: the rail stays reachable after the user
      // scrolls into the results, instead of being stranded at the top.
      // The edge variant rides the left border of a stacked map, which is
      // exactly where the divider went when the list collapsed — so the
      // gesture that collapsed it is also the gesture that undoes it.
      className={
        isEdge
          ? "hidden lg:flex absolute left-0 inset-y-0 z-[500] w-4 items-center justify-center cursor-col-resize group touch-none select-none focus:outline-none"
          : "hidden lg:flex relative items-start justify-center cursor-col-resize group touch-none select-none focus:outline-none sticky top-4 h-[calc(100vh-6rem)]"
      }
    >
      {/* Thin rail that thickens on hover/focus so the target is easy to grab
          without the divider shouting for attention at rest. Centred in the
          sticky column so it sits mid-viewport while scrolling. */}
      <div
        className={
          isEdge
            ? "h-16 w-1 rounded-full bg-border/80 transition-colors group-hover:bg-primary/60 group-focus:bg-primary group-active:bg-primary"
            : "mt-[45vh] h-16 w-1 rounded-full bg-border transition-colors group-hover:bg-primary/60 group-focus:bg-primary group-active:bg-primary"
        }
      />
      {/* Mid-drag preview: says what releasing here will do, so a layout
          switch is never a surprise. Nothing changes until the pointer is
          released, so dragging back out of range simply cancels it. */}
      {hint && (
        <div
          className={
            isEdge
              ? "absolute left-5 top-1/2 -translate-y-1/2 z-[501] whitespace-nowrap rounded-md border border-primary/40 bg-card/95 px-2 py-1 text-[11px] font-medium text-foreground shadow-lg pointer-events-none"
              : "absolute left-1/2 top-[45vh] mt-6 -translate-x-1/2 z-[501] whitespace-nowrap rounded-md border border-primary/40 bg-card/95 px-2 py-1 text-[11px] font-medium text-foreground shadow-lg pointer-events-none"
          }
        >
          {hint}
        </div>
      )}
    </div>
  );
}
