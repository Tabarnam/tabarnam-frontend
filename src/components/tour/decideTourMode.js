// Pure decision logic for the first-visit tour, extracted from TourController
// so it can be unit-tested without Shepherd, the DOM, or React.

export const TOUR_SEEN_KEY = 'tabarnam_tour_v1_seen';
export const TOUR_PROGRESS_KEY = 'tabarnam_tour_v1_progress';
// Optional single-use hint written by a step's Back action before it triggers
// a route change. The new results-leg tour reads and clears it, and jumps
// straight to the hinted step id instead of restarting from step 1.
export const TOUR_STEP_HINT_KEY = 'tabarnam_tour_v1_step_hint';
export const CANNED_QUERY = 'coffee';
export const HOME_PATH = '/';
export const RESULTS_PATH = '/results';

/**
 * Decide whether — and which leg of — the tour should run for a given
 * location and localStorage state.
 *
 * @param {object}  args
 * @param {string}  args.pathname  current route pathname
 * @param {string}  args.search    current route search string (e.g. "?tour=1")
 * @param {?string} args.seen      value of the "tour seen" localStorage key
 * @param {?string} args.progress  value of the "tour progress" localStorage key
 * @returns {'home'|'results'|null} which tour leg to start, or null for none
 */
export function decideTourMode({ pathname, search, seen, progress }) {
  const isHome = pathname === HOME_PATH;
  const isResults = pathname === RESULTS_PATH;
  if (!isHome && !isResults) return null;

  // Force-start via ?tour=1 — used by the "Take the tour" affordance on the
  // help page so returning visitors can replay without our needing to bump
  // the seen-key on every tour update.
  const tourParam = new URLSearchParams(search || '').get('tour') === '1';

  if (isHome) {
    if (tourParam) return 'home';
    // Already completed or dismissed — never auto-fire again.
    if (seen) return null;
    // Mid-flight (handoff to /results underway) — don't restart from home.
    return progress ? null : 'home';
  }

  // On /results: only resume if mid-tour, or via an explicit ?tour=1 deep link.
  if (!progress && !tourParam) return null;
  return 'results';
}
