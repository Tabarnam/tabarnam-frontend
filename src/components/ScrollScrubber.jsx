import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  scrollEl,
  scrollRef,
  className = "",
  minThumbPx = 28,
  pageScrollRatio = 0.9,
  position = "absolute",
}) {
  const [resolvedEl, setResolvedEl] = useState(() => scrollEl || scrollRef?.current || null);
  const [metrics, setMetrics] = useState(() => getScrollMetrics(scrollEl || scrollRef?.current));

  const trackRef = useRef(null);
  const dragRef = useRef({
    active: false,
    pointerId: null,
    startY: 0,
    startScrollTop: 0,
  });
  const rafRef = useRef(0);

  useEffect(() => {
    if (scrollEl) {
      setResolvedEl((prev) => (prev === scrollEl ? prev : scrollEl));
      return;
    }

    const raf = typeof window !== "undefined" ? window.requestAnimationFrame : null;
    const caf = typeof window !== "undefined" ? window.cancelAnimationFrame : null;

    const id = raf
      ? raf(() => {
          const next = scrollRef?.current || null;
          if (next) setResolvedEl((prev) => (prev === next ? prev : next));
        })
      : null;

    return () => {
      if (id != null && caf) caf(id);
    };
  }, [scrollEl, scrollRef]);

  const updateMetrics = useCallback(() => {
    setMetrics(getScrollMetrics(resolvedEl));
  }, [resolvedEl]);

  useEffect(() => {
    updateMetrics();
  }, [resolvedEl, updateMetrics]);

  useEffect(() => {
    const el = resolvedEl;
    const raf = typeof window !== "undefined" ? window.requestAnimationFrame : null;
    const caf = typeof window !== "undefined" ? window.cancelAnimationFrame : null;

    if (!el || typeof el.addEventListener !== "function") {
      updateMetrics();
      return;
    }

    const onScroll = () => {
      if (rafRef.current || !raf) {
        updateMetrics();
        return;
      }

      rafRef.current = raf(() => {
        rafRef.current = 0;
        updateMetrics();
      });
    };

    try {
      el.addEventListener("scroll", onScroll, { passive: true });
    } catch {
      // ignore
    }

    let ro;
    if (typeof ResizeObserver !== "undefined") {
      try {
        ro = new ResizeObserver(() => updateMetrics());
        ro.observe(el);
      } catch {
        ro = null;
      }
    }

    updateMetrics();

    return () => {
      try {
        el.removeEventListener("scroll", onScroll);
      } catch {
        // ignore
      }

      if (ro) {
        try {
          ro.disconnect();
        } catch {
          // ignore
        }
      }

      if (rafRef.current && caf) {
        caf(rafRef.current);
        rafRef.current = 0;
      }
    };
  }, [resolvedEl, updateMetrics]);

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
      const el = resolvedEl;
      if (!el) return;

      const nextTop = clamp(top, 0, scrollRange);
      try {
        if (typeof el.scrollTo === "function") {
          el.scrollTo({ top: nextTop, behavior });
        } else {
          el.scrollTop = nextTop;
        }
      } catch {
        try {
          el.scrollTop = nextTop;
        } catch {
          // ignore
        }
      }
    },
    [resolvedEl, scrollRange]
  );

  const pageScrollBy = useCallback(
    (direction) => {
      const el = resolvedEl;
      if (!el) return;
      const delta = el.clientHeight * pageScrollRatio * direction;
      try {
        if (typeof el.scrollBy === "function") {
          el.scrollBy({ top: delta, behavior: "smooth" });
        } else {
          el.scrollTop = (el.scrollTop || 0) + delta;
        }
      } catch {
        try {
          el.scrollTop = (el.scrollTop || 0) + delta;
        } catch {
          // ignore
        }
      }
    },
    [resolvedEl, pageScrollRatio]
  );

  const onThumbPointerDown = useCallback(
    (e) => {
      const el = resolvedEl;
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

      if (typeof document !== "undefined" && document.body) {
        document.body.style.userSelect = "none";
        document.body.style.webkitUserSelect = "none";
      }
    },
    [resolvedEl, canScroll]
  );

  const onThumbPointerMove = useCallback(
    (e) => {
      const el = resolvedEl;
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
    [resolvedEl, canScroll, geometry.thumbHeight, scrollRange, scrollTo]
  );

  const endDrag = useCallback((e) => {
    const state = dragRef.current;
    if (!state.active) return;
    if (e && state.pointerId != null && e.pointerId !== state.pointerId) return;

    dragRef.current = { active: false, pointerId: null, startY: 0, startScrollTop: 0 };
    if (typeof document !== "undefined" && document.body) {
      document.body.style.userSelect = "";
      document.body.style.webkitUserSelect = "";
    }
  }, []);

  const onTrackPointerDown = useCallback(
    (e) => {
      const el = resolvedEl;
      const trackEl = trackRef.current;
      if (!el || !trackEl || !canScroll) return;
      if (e.target !== trackEl) return;

      const rect = trackEl.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const trackHeight = trackEl.clientHeight || rect.height || 0;

      const maxThumbTravel = Math.max(0, trackHeight - geometry.thumbHeight);
      if (maxThumbTravel <= 0) return;

      const desiredThumbTop = clamp(y - geometry.thumbHeight / 2, 0, maxThumbTravel);
      const progress = clamp(desiredThumbTop / maxThumbTravel, 0, 1);

      scrollTo(progress * scrollRange, "smooth");
    },
    [resolvedEl, canScroll, geometry.thumbHeight, scrollRange, scrollTo]
  );

  const disabled = !resolvedEl || !canScroll;

  const rootStyle = {
    position: position === "relative" ? "relative" : "absolute",
    ...(position === "relative" ? {} : { top: 0, right: 0 }),
    height: "100%",
    width: "40px",
    zIndex: 50,
    pointerEvents: "auto",
    opacity: 1,
    display: "block",
  };

  return (
    <div
      className={`pointer-events-auto select-none ${className}`}
      aria-label="Scroll controls"
      data-disabled={disabled ? "true" : "false"}
      style={rootStyle}
    >
      <div
        data-testid="scroll-scrubber-rail"
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: "1px",
          right: "1px",
          background: "rgba(255, 0, 255, 0.22)",
          borderLeft: "1px solid rgba(255, 0, 255, 0.7)",
          boxSizing: "border-box",
          pointerEvents: "none",
        }}
        aria-hidden="true"
      />

      <div className="absolute inset-0 flex flex-col items-center justify-between py-2">
        <button
          type="button"
          className={`h-6 w-6 rounded-md border border-slate-200 bg-white text-slate-700 shadow-sm hover:bg-slate-50 active:bg-slate-100 ${
            disabled ? "opacity-40 pointer-events-none" : ""
          }`}
          onClick={() => scrollTo(0, "smooth")}
          onDoubleClick={() => pageScrollBy(-1)}
          aria-label="Scroll to top"
          title="Scroll to top"
          disabled={disabled}
        >
          <ChevronUp className="mx-auto h-4 w-4" />
        </button>

        <div
          ref={trackRef}
          className={`relative w-[10px] flex-1 rounded-full ${disabled ? "bg-slate-100" : "bg-slate-200"}`}
          style={{ touchAction: "none" }}
          onPointerDown={onTrackPointerDown}
          aria-hidden={disabled}
        >
          <div
            role="scrollbar"
            aria-valuemin={0}
            aria-valuemax={Math.max(0, Math.round(scrollRange))}
            aria-valuenow={Math.round(metrics.scrollTop)}
            tabIndex={-1}
            className={`absolute left-0 right-0 rounded-full ${disabled ? "bg-slate-300" : "bg-slate-500"}`}
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
          className={`h-6 w-6 rounded-md border border-slate-200 bg-white text-slate-700 shadow-sm hover:bg-slate-50 active:bg-slate-100 ${
            disabled ? "opacity-40 pointer-events-none" : ""
          }`}
          onClick={() => scrollTo(scrollRange, "smooth")}
          onDoubleClick={() => pageScrollBy(1)}
          aria-label="Scroll to bottom"
          title="Scroll to bottom"
          disabled={disabled}
        >
          <ChevronDown className="mx-auto h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
