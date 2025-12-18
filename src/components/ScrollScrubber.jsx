import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function getScrollMetrics(el) {
  if (!el) {
    return {
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
    };
  }

  return {
    scrollTop: el.scrollTop || 0,
    scrollHeight: el.scrollHeight || 0,
    clientHeight: el.clientHeight || 0,
  };
}

export default function ScrollScrubber({
  scrollRef,
  className = "",
  minThumbPx = 28,
  pageScrollRatio = 0.9,
}) {
  const [metrics, setMetrics] = useState(() => getScrollMetrics(scrollRef?.current));
  const trackRef = useRef(null);
  const dragRef = useRef({
    active: false,
    pointerId: null,
    startY: 0,
    startScrollTop: 0,
  });
  const rafRef = useRef(0);

  const updateMetrics = useCallback(() => {
    const el = scrollRef?.current;
    if (!el) return;
    setMetrics(getScrollMetrics(el));
  }, [scrollRef]);

  useEffect(() => {
    const el = scrollRef?.current;
    if (!el) return;

    const onScroll = () => {
      if (rafRef.current) return;
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = 0;
        updateMetrics();
      });
    };

    el.addEventListener("scroll", onScroll, { passive: true });

    let ro;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => updateMetrics());
      ro.observe(el);
    }

    updateMetrics();

    return () => {
      el.removeEventListener("scroll", onScroll);
      if (ro) ro.disconnect();
      if (rafRef.current) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };
  }, [scrollRef, updateMetrics]);

  const scrollRange = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  const canScroll = scrollRange > 1;

  const geometry = useMemo(() => {
    const trackEl = trackRef.current;
    const trackHeight = trackEl?.clientHeight || 0;

    if (!canScroll || trackHeight <= 0) {
      return {
        trackHeight,
        thumbHeight: trackHeight,
        thumbTop: 0,
      };
    }

    const rawThumb = (metrics.clientHeight / metrics.scrollHeight) * trackHeight;
    const thumbHeight = clamp(Math.round(rawThumb), minThumbPx, trackHeight);

    const maxThumbTravel = Math.max(0, trackHeight - thumbHeight);
    const progress = scrollRange > 0 ? clamp(metrics.scrollTop / scrollRange, 0, 1) : 0;
    const thumbTop = Math.round(progress * maxThumbTravel);

    return {
      trackHeight,
      thumbHeight,
      thumbTop,
    };
  }, [canScroll, metrics.clientHeight, metrics.scrollHeight, metrics.scrollTop, minThumbPx, scrollRange]);

  const scrollTo = useCallback(
    (top, behavior = "auto") => {
      const el = scrollRef?.current;
      if (!el) return;
      el.scrollTo({ top: clamp(top, 0, scrollRange), behavior });
    },
    [scrollRef, scrollRange]
  );

  const pageScrollBy = useCallback(
    (direction) => {
      const el = scrollRef?.current;
      if (!el) return;
      const delta = el.clientHeight * pageScrollRatio * direction;
      el.scrollBy({ top: delta, behavior: "smooth" });
    },
    [scrollRef, pageScrollRatio]
  );


  const onThumbPointerDown = useCallback(
    (e) => {
      const el = scrollRef?.current;
      if (!el || !canScroll) return;
      e.preventDefault();
      e.stopPropagation();

      dragRef.current = {
        active: true,
        pointerId: e.pointerId,
        startY: e.clientY,
        startScrollTop: el.scrollTop,
      };

      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }

      document.body.style.userSelect = "none";
      document.body.style.webkitUserSelect = "none";
    },
    [scrollRef, canScroll]
  );

  const onThumbPointerMove = useCallback(
    (e) => {
      const el = scrollRef?.current;
      const state = dragRef.current;
      if (!el || !state.active || state.pointerId !== e.pointerId || !canScroll) return;

      const trackEl = trackRef.current;
      const trackHeight = trackEl?.clientHeight || 0;
      const maxThumbTravel = trackHeight - geometry.thumbHeight;
      if (maxThumbTravel <= 0) return;

      const pixelsPerScroll = scrollRange / maxThumbTravel;

      const deltaY = e.clientY - state.startY;
      scrollTo(state.startScrollTop + deltaY * pixelsPerScroll);
    },
    [scrollRef, canScroll, geometry.thumbHeight, scrollRange, scrollTo]
  );

  const endDrag = useCallback((e) => {
    const state = dragRef.current;
    if (!state.active) return;
    if (e && state.pointerId != null && e.pointerId !== state.pointerId) return;

    dragRef.current = { active: false, pointerId: null, startY: 0, startScrollTop: 0 };
    document.body.style.userSelect = "";
    document.body.style.webkitUserSelect = "";
  }, []);

  const onTrackPointerDown = useCallback(
    (e) => {
      const el = scrollRef?.current;
      const trackEl = trackRef.current;
      if (!el || !trackEl || !canScroll) return;
      if (e.target !== trackEl) return;

      const rect = trackEl.getBoundingClientRect();
      const y = e.clientY - rect.top;

      const above = y < geometry.thumbTop;
      const below = y > geometry.thumbTop + geometry.thumbHeight;

      if (above) {
        pageScrollBy(-1);
      } else if (below) {
        pageScrollBy(1);
      }
    },
    [scrollRef, canScroll, geometry.thumbHeight, geometry.thumbTop, pageScrollBy]
  );

  if (!canScroll) return null;

  return (
    <div
      className={`pointer-events-auto flex w-8 select-none flex-col items-center gap-2 ${className}`}
      aria-label="Scroll controls"
    >
      <button
        type="button"
        className="h-7 w-7 rounded-md border border-slate-200 bg-white text-slate-700 shadow-sm hover:bg-slate-50 active:bg-slate-100"
        onClick={() => scrollTo(0, "smooth")}
        aria-label="Scroll to top"
        title="Scroll to top"
      >
        <ChevronUp className="mx-auto h-4 w-4" />
      </button>

      <div
        ref={trackRef}
        className="relative w-2 flex-1 rounded-full bg-slate-200"
        style={{ touchAction: "none" }}
        onPointerDown={onTrackPointerDown}
        aria-hidden="true"
      >
        <div
          role="scrollbar"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, Math.round(scrollRange))}
          aria-valuenow={Math.round(metrics.scrollTop)}
          tabIndex={-1}
          className="absolute left-0 right-0 rounded-full bg-slate-500"
          style={{
            top: geometry.thumbTop,
            height: geometry.thumbHeight,
            touchAction: "none",
          }}
          onPointerDown={onThumbPointerDown}
          onPointerMove={onThumbPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
        />
      </div>

      <button
        type="button"
        className="h-7 w-7 rounded-md border border-slate-200 bg-white text-slate-700 shadow-sm hover:bg-slate-50 active:bg-slate-100"
        onClick={() => scrollTo(scrollRange, "smooth")}
        aria-label="Scroll to bottom"
        title="Scroll to bottom"
      >
        <ChevronDown className="mx-auto h-4 w-4" />
      </button>
    </div>
  );
}
