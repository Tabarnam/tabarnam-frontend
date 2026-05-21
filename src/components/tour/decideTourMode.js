// Pure decision logic for the first-visit tour, extracted from TourController
// so it can be unit-tested without Shepherd, the DOM, or React.

export const TOUR_SEEN_KEY = 'tabarnam_tour_v1_seen';
export const TOUR_PROGRESS_KEY = 'tabarnam_tour_v1_progress';
export const CANNED_QUERY = 'organic soap';
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
  // Already completed or dismissed — never auto-fire again.
  if (seen) return null;

  const isHome = pathname === HOME_PATH;
  const isResults = pathname === RESULTS_PATH;
  if (!isHome && !isResults) return null;

  if (isHome) {
    // Mid-flight (handoff to /results underway) — don't restart from home.
    return progress ? null : 'home';
  }

  // On /results: only resume if mid-tour, or via an explicit ?tour=1 deep link.
  const tourParam = new URLSearchParams(search || '').get('tour') === '1';
  if (!progress && !tourParam) return null;
  return 'results';
}
