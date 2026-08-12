import { useEffect, useState } from "react";

const STORAGE_KEY = "tabarnam_results_map_split";
const DEFAULT_RATIO = 60; // % of the row given to the results list

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
      if (Number.isFinite(stored) && stored >= 20 && stored <= 80) return stored;
    } catch {
      /* private mode / storage disabled — fall through to the default */
    }
    return DEFAULT_RATIO;
  });

  useEffect(() => {
    // Debounced so a drag doesn't hammer localStorage on every pointermove.
    const t = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, String(ratio));
      } catch {
        /* non-fatal */
      }
    }, 250);
    return () => clearTimeout(t);
  }, [ratio]);

  return [ratio, setRatio];
}

export { DEFAULT_RATIO, STORAGE_KEY };
