import { useState, useCallback, useMemo, useRef } from "react";

/**
 * Drop-in replacement for useState that tracks undo/redo history.
 *
 * Returns `[state, setState, history]` where:
 *   - `state` / `setState` work identically to React's useState
 *   - `history` = { undo, redo, resetHistory, canUndo, canRedo }
 *
 * History is debounced — rapid changes (e.g. typing) within `debounceMs`
 * are grouped into a single undo step.  Transitions from `null` are not
 * recorded (use `resetHistory` for initial loads).
 *
 * @param {*} initialValue — initial state
 * @param {object} [options]
 * @param {number} [options.limit=50] — max history entries
 * @param {number} [options.debounceMs=300] — debounce window for grouping rapid changes
 */
export default function useUndoableState(initialValue, { limit = 50, debounceMs = 300 } = {}) {
  const [state, setStateRaw] = useState(initialValue);
  // Version counter triggers re-renders when history changes (refs alone don't).
  const [version, setVersion] = useState(0);

  const pastRef = useRef([]);
  const futureRef = useRef([]);

  // Debounce bookkeeping
  const debounceTimerRef = useRef(null);
  const pendingPrevRef = useRef(null); // the "before-the-burst" state

  // ── flush any pending debounced history entry ────────────────────
  const flushPending = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (pendingPrevRef.current !== null) {
      pastRef.current = [...pastRef.current, pendingPrevRef.current].slice(-limit);
      futureRef.current = [];
      pendingPrevRef.current = null;
    }
  }, [limit]);

  // ── history-aware setState (same API as React setState) ──────────
  const setState = useCallback((valueOrUpdater) => {
    setStateRaw((prevState) => {
      const nextState =
        typeof valueOrUpdater === "function"
          ? valueOrUpdater(prevState)
          : valueOrUpdater;

      // No change — skip
      if (nextState === prevState) return prevState;

      // Don't record null → X transitions (initial loads use resetHistory)
      if (prevState === null) return nextState;

      // Debounced history push: capture the state from before the first
      // change in a rapid burst, then push it once the burst settles.
      if (pendingPrevRef.current === null && debounceTimerRef.current === null) {
        pendingPrevRef.current = prevState;
      }

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        const toPush = pendingPrevRef.current;
        pendingPrevRef.current = null;
        if (toPush !== null) {
          pastRef.current = [...pastRef.current, toPush].slice(-limit);
          futureRef.current = [];
          setVersion((v) => v + 1);
        }
      }, debounceMs);

      return nextState;
    });
  }, [limit, debounceMs]);

  // ── undo ─────────────────────────────────────────────────────────
  const undo = useCallback(() => {
    flushPending();
    setStateRaw((currentState) => {
      if (pastRef.current.length === 0) return currentState;
      const past = [...pastRef.current];
      const previous = past.pop();
      pastRef.current = past;
      futureRef.current = [...futureRef.current, currentState];
      setVersion((v) => v + 1);
      return previous;
    });
  }, [flushPending]);

  // ── redo ─────────────────────────────────────────────────────────
  const redo = useCallback(() => {
    flushPending();
    setStateRaw((currentState) => {
      if (futureRef.current.length === 0) return currentState;
      const future = [...futureRef.current];
      const next = future.pop();
      futureRef.current = future;
      pastRef.current = [...pastRef.current, currentState];
      setVersion((v) => v + 1);
      return next;
    });
  }, [flushPending]);

  // ── resetHistory — clear all history and set a new baseline ──────
  const resetHistory = useCallback((newState) => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    pendingPrevRef.current = null;
    pastRef.current = [];
    futureRef.current = [];
    setStateRaw(newState);
    setVersion((v) => v + 1);
  }, []);

  // Memoize the history object so it's a stable reference between renders
  // (safe to use as a useCallback / useEffect dependency in consumers).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const history = useMemo(() => ({
    undo,
    redo,
    resetHistory,
    canUndo: pastRef.current.length > 0 || pendingPrevRef.current !== null,
    canRedo: futureRef.current.length > 0,
  }), [undo, redo, resetHistory, version]);

  return [state, setState, history];
}
