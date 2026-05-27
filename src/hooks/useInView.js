import { useEffect, useRef, useState } from "react";

/**
 * useInView — IntersectionObserver hook with sticky-once-seen semantics.
 *
 * Returns a [ref, inView] pair. Attach the ref to a DOM element. `inView`
 * starts as false and flips to true the first time the element intersects
 * the viewport (expanded by `rootMargin`). When `once` is true (default),
 * `inView` stays true after that — useful for "fetch data the first time
 * this row scrolls near the viewport, then never refetch."
 *
 * Why this matters (Phase 4.28):
 *   The /results page used to fire 50× /api/get-reviews + 50× /api/company-logo
 *   at mount time, swamping the single warm Function App worker. This hook
 *   lets each row trigger its own data fetch lazily, with a generous 1000px
 *   `rootMargin` so the request lands while the row is still ~3 screens
 *   below the viewport — by the time the user scrolls down to see it, the
 *   reviews are already loaded.
 *
 * Default rootMargin is "1000px 0px" (1000px vertical buffer, 0px horizontal).
 * Override per call site if a different pre-fetch distance is needed.
 *
 * Server-side rendering: if IntersectionObserver is undefined (SSR / very
 * old browser), we fall back to setting inView=true immediately so the
 * UI degrades gracefully.
 */
export default function useInView({
  rootMargin = "1000px 0px",
  threshold = 0,
  once = true,
} = {}) {
  const ref = useRef(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    if (inView && once) return; // sticky — never re-observe after first hit

    const el = ref.current;
    if (!el) return;

    if (typeof window === "undefined" || typeof window.IntersectionObserver === "undefined") {
      // Fallback: no IntersectionObserver support. Show everything.
      setInView(true);
      return;
    }

    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true);
            if (once) obs.disconnect();
            break;
          }
        }
      },
      { rootMargin, threshold }
    );

    obs.observe(el);
    return () => obs.disconnect();
  }, [inView, once, rootMargin, threshold]);

  return [ref, inView];
}
