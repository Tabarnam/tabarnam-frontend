import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import Shepherd from 'shepherd.js';

const TOUR_SEEN_KEY = 'tabarnam_tour_v1_seen';
const TOUR_PROGRESS_KEY = 'tabarnam_tour_v1_progress';
const CANNED_QUERY = 'organic soap';
const RESULTS_PATH = '/results';
const HOME_PATH = '/';

function safeRead(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeWrite(key, val) {
  try { localStorage.setItem(key, val); } catch {}
}
function safeRemove(key) {
  try { localStorage.removeItem(key); } catch {}
}

function learnMore(anchor) {
  return {
    text: 'Learn more',
    secondary: true,
    action() { window.open(`/help${anchor}`, '_blank', 'noopener'); },
  };
}

function buildHomeSteps(tour, onHandoff) {
  return [
    {
      id: 'search',
      title: 'Search anything',
      text: 'Type a company name, product, or industry. Try <strong>Jelly Belly</strong> or <strong>organic bar soap</strong>.',
      attachTo: { element: '[data-tour-step="search-input"]', on: 'bottom-start' },
      scrollTo: { behavior: 'smooth', block: 'nearest' },
      buttons: [
        { text: 'Skip tour', action: () => tour.cancel(), secondary: true },
        learnMore('#searching'),
        { text: 'Next', action: () => tour.next() },
      ],
    },
    {
      id: 'location',
      title: 'Add a location',
      text: 'Optional. Type a city, postal code, or country to orient results around that place.',
      attachTo: { element: '[data-tour-step="location-input"]', on: 'bottom-end' },
      scrollTo: { behavior: 'smooth', block: 'nearest' },
      buttons: [
        { text: 'Skip tour', action: () => tour.cancel(), secondary: true },
        { text: 'Back', action: () => tour.back(), secondary: true },
        learnMore('#location'),
        { text: 'Next', action: () => tour.next() },
      ],
    },
    {
      id: 'filter',
      title: 'Sort and filter',
      text: 'Open this menu to sort by nearest, highest rated, or filter to in-country only.',
      attachTo: { element: '[data-tour-step="filter-trigger"]', on: 'bottom-start' },
      scrollTo: { behavior: 'smooth', block: 'nearest' },
      buttons: [
        { text: 'Skip tour', action: () => tour.cancel(), secondary: true },
        { text: 'Back', action: () => tour.back(), secondary: true },
        learnMore('#sorting'),
        { text: 'See it', action: onHandoff },
      ],
    },
  ];
}

function buildResultsSteps(tour) {
  return [
    {
      id: 'sort',
      title: 'Click a column to re-sort',
      text: 'Click the <strong>QQ</strong> header to sort by score. Click <strong>HQ</strong> or <strong>Manufacturing</strong> to re-sort by proximity.',
      attachTo: { element: '[data-tour-step="sort-header-qq"]', on: 'bottom' },
      scrollTo: { behavior: 'smooth', block: 'start' },
      buttons: [
        { text: 'Skip tour', action: () => tour.cancel(), secondary: true },
        learnMore('#qq'),
        { text: 'Next', action: () => tour.next() },
      ],
    },
    {
      id: 'row',
      title: 'Open a result',
      text: 'Click any row to expand it into the full company profile, including all locations, reviews, and links.',
      attachTo: { element: '[data-tour-step="expandable-row"]', on: 'right' },
      scrollTo: { behavior: 'smooth', block: 'center' },
      buttons: [
        { text: 'Skip tour', action: () => tour.cancel(), secondary: true },
        { text: 'Back', action: () => tour.back(), secondary: true },
        learnMore('#row'),
        { text: 'Done', action: () => tour.complete() },
      ],
    },
  ];
}

function makeTour() {
  return new Shepherd.Tour({
    useModalOverlay: true,
    defaultStepOptions: {
      cancelIcon: { enabled: true },
      scrollTo: { behavior: 'smooth', block: 'nearest' },
      modalOverlayOpeningPadding: 4,
      modalOverlayOpeningRadius: 6,
    },
  });
}

function waitForElements(selectors, timeoutMs) {
  return new Promise((resolve) => {
    const allPresent = () => selectors.every((s) => document.querySelector(s));
    if (allPresent()) return resolve(true);
    const observer = new MutationObserver(() => {
      if (allPresent()) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(true);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => {
      observer.disconnect();
      resolve(false);
    }, timeoutMs);
  });
}

export default function TourController() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const tourRef = useRef(null);

  useEffect(() => {
    if (safeRead(TOUR_SEEN_KEY)) return;

    const isHome = pathname === HOME_PATH;
    const isResults = pathname === RESULTS_PATH;
    if (!isHome && !isResults) return;

    const progress = safeRead(TOUR_PROGRESS_KEY);
    const tourParam = new URLSearchParams(search).get('tour') === '1';

    // Home: only start fresh if no progress (avoid restarting after handoff back-nav)
    if (isHome && progress) return;
    // Results: only resume if mid-tour (progress) or explicit ?tour=1 deep link
    if (isResults && !progress && !tourParam) return;

    let cancelled = false;
    let isUnmounting = false;
    let idleHandle = null;

    const finalize = () => {
      if (!isUnmounting) {
        safeWrite(TOUR_SEEN_KEY, '1');
        safeRemove(TOUR_PROGRESS_KEY);
      }
      tourRef.current = null;
    };

    const startHome = () => {
      if (cancelled || tourRef.current) return;
      const tour = makeTour();
      const onHandoff = () => {
        // Mark progress so the results-mount knows to resume; do not write seen=1.
        safeWrite(TOUR_PROGRESS_KEY, 'results');
        // Detach finalize handlers so the upcoming cancel during cleanup doesn't trigger them.
        tour.off('complete', finalize);
        tour.off('cancel', finalize);
        navigate(`${RESULTS_PATH}?q=${encodeURIComponent(CANNED_QUERY)}&country=US&tour=1`);
      };
      buildHomeSteps(tour, onHandoff).forEach((step) => tour.addStep(step));
      tour.on('complete', finalize);
      tour.on('cancel', finalize);
      tourRef.current = tour;
      tour.start();
    };

    const startResults = async () => {
      if (cancelled || tourRef.current) return;
      const ready = await waitForElements(
        ['[data-tour-step="sort-header-qq"]', '[data-tour-step="expandable-row"]'],
        3000,
      );
      if (cancelled) return;
      if (!ready) {
        // No rows or no QQ header within 3s — gracefully end.
        safeWrite(TOUR_SEEN_KEY, '1');
        safeRemove(TOUR_PROGRESS_KEY);
        return;
      }
      const tour = makeTour();
      buildResultsSteps(tour).forEach((step) => tour.addStep(step));
      tour.on('complete', finalize);
      tour.on('cancel', finalize);
      tourRef.current = tour;
      tour.start();
    };

    const start = isHome ? startHome : startResults;

    if (window.requestIdleCallback) {
      idleHandle = window.requestIdleCallback(start, { timeout: 800 });
    } else {
      idleHandle = setTimeout(start, 400);
    }

    return () => {
      cancelled = true;
      isUnmounting = true;
      if (window.cancelIdleCallback && typeof idleHandle === 'number') {
        try { window.cancelIdleCallback(idleHandle); } catch {}
      } else if (idleHandle) {
        clearTimeout(idleHandle);
      }
      if (tourRef.current) {
        try { tourRef.current.cancel(); } catch {}
        tourRef.current = null;
      }
      // StrictMode safety: force-remove any shepherd DOM that lingered after cancel.
      document
        .querySelectorAll('.shepherd-element, .shepherd-modal-overlay-container')
        .forEach((el) => el.remove());
    };
  }, [pathname, search, navigate]);

  return null;
}
