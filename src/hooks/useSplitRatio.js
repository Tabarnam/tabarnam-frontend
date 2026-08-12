import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "tabarnam_results_map_split";
const DEFAULT_RATIO = 60; // % of the row given to the results list
// Mirrors SPLIT_MIN / SPLIT_MAX in SplitHandle — the range the drag allows.
const MIN_RATIO = 33;
const MAX_RATIO = 80;

/**
 * The list/map split percentage, remembered across searches and sessions.
 * It's a personal layout preference, not shareable state, so it lives in
 * localStorage rather than the URL.
 *
 * Persistence happens HERE, debounced, rather than through a commit callback
 * the caller supplies: a callback closes over the ratio from its render, so a
 * drag that ends in the same tick as its last move would write the previous
 * value. Writing from an effect always sees the committed state.
 */
export default function useSplitRatio() {
  const [ratio, setRatio] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(STORAGE_KEY));
      // Any width the drag can produce is a width worth remembering; anything
      // outside that range is stale (it predates the current bounds) and
      // restores as the default instead.
      if (Number.isFinite(stored) && stored >= MIN_RATIO && stored <= MAX_RATIO) return stored;
    } catch {
      /* private mode / storage disabled — fall through to the default */
    }
    return DEFAULT_RATIO;
  });

  const write = (value) => {
    try {
      localStorage.setItem(STORAGE_KEY, String(value));
    } catch {
      /* non-fatal */
    }
  };

  // Latest value, readable from the unmount cleanup below without making it
  // depend on (and re-run for) every ratio change.
  const latestRef = useRef(ratio);
  latestRef.current = ratio;

  useEffect(() => {
    // Debounced so a drag doesn't hammer localStorage on every pointermove.
    const t = setTimeout(() => write(ratio), 250);
    return () => clearTimeout(t);
  }, [ratio]);

  // Flush on unmount: closing the map or navigating within the debounce
  // window would otherwise drop the user's last adjustment.
  useEffect(() => () => write(latestRef.current), []);

  return [ratio, setRatio];
}

export { DEFAULT_RATIO, STORAGE_KEY };
