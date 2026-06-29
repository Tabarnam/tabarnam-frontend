import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  decideTourMode,
  TOUR_SEEN_KEY,
  TOUR_PROGRESS_KEY,
  CANNED_QUERY,
  RESULTS_PATH,
} from './decideTourMode';
import { useBookmarks } from '@/hooks/useBookmarks';

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
    action() { window.open(`/how-it-works${anchor}`, '_blank', 'noopener'); },
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
      text: 'You can type a city, postal code, or country to orient results around that place.',
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

function waitForElement(selector, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);
    const observer = new MutationObserver(() => {
      const match = document.querySelector(selector);
      if (match) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(match);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => { observer.disconnect(); resolve(null); }, timeoutMs);
  });
}

function buildResultsSteps(tour, drawerRef) {
  const openDrawer = () => { try { drawerRef.current?.(true); } catch {} };
  const closeDrawer = () => { try { drawerRef.current?.(false); } catch {} };

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
        { text: 'Next', action: () => tour.next() },
      ],
    },
    {
      id: 'bookmark-save',
      title: 'Save it for later',
      text: 'Tap the bookmark icon to save any company. Tap it again to file it under a custom list.',
      attachTo: { element: '[data-tour-step="bookmark-button"]', on: 'left' },
      scrollTo: { behavior: 'smooth', block: 'center' },
      buttons: [
        { text: 'Skip tour', action: () => tour.cancel(), secondary: true },
        { text: 'Back', action: () => tour.back(), secondary: true },
        learnMore('#bookmarks'),
        { text: 'Next', action: () => tour.next() },
      ],
    },
    {
      id: 'bookmark-header',
      title: 'Find them anytime',
      text: 'Your saved companies live behind this bookmark icon in the header.',
      attachTo: { element: '[data-tour-step="bookmark-header-icon"]', on: 'bottom' },
      scrollTo: { behavior: 'smooth', block: 'nearest' },
      buttons: [
        { text: 'Skip tour', action: () => tour.cancel(), secondary: true },
        { text: 'Back', action: () => tour.back(), secondary: true },
        learnMore('#bookmarks'),
        { text: 'Next', action: () => tour.next() },
      ],
    },
    {
      id: 'bookmark-drawer',
      title: 'Organize and share',
      text: 'Group bookmarks into named lists, drag to reorder, and share a list as a compressed link — no account required.',
      attachTo: { element: '[data-tour-step="bookmark-drawer-root"]', on: 'left' },
      scrollTo: false,
      beforeShowPromise: async () => {
        openDrawer();
        // Wait for the drawer panel to mount and slide in before Shepherd measures it.
        await waitForElement('[data-tour-step="bookmark-drawer-root"]');
        await new Promise((r) => setTimeout(r, 350));
      },
      buttons: [
        { text: 'Skip tour', action: () => { closeDrawer(); tour.cancel(); }, secondary: true },
        { text: 'Back', action: () => { closeDrawer(); tour.back(); }, secondary: true },
        learnMore('#bookmarks'),
        { text: 'Done', action: () => { closeDrawer(); tour.complete(); } },
      ],
    },
  ];
}

function makeTour(Shepherd) {
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
  // Bridge: stash the latest setDrawerOpen in a ref so step callbacks
  // captured in the closure below always invoke the current setter.
  const { setDrawerOpen } = useBookmarks();
  const setDrawerOpenRef = useRef(setDrawerOpen);
  setDrawerOpenRef.current = setDrawerOpen;

  useEffect(() => {
    const mode = decideTourMode({
      pathname,
      search,
      seen: safeRead(TOUR_SEEN_KEY),
      progress: safeRead(TOUR_PROGRESS_KEY),
    });
    if (!mode) return;

    let cancelled = false;
    let isUnmounting = false;
    let idleHandle = null;

    const finalize = () => {
      if (!isUnmounting) {
        safeWrite(TOUR_SEEN_KEY, '1');
        safeRemove(TOUR_PROGRESS_KEY);
      }
      // If a step left the bookmark drawer open (e.g. cancelled during the
      // last results step), close it so the user lands back on the page.
      try { setDrawerOpenRef.current?.(false); } catch {}
      tourRef.current = null;
    };

    const startHome = (Shepherd) => {
      if (cancelled || tourRef.current) return;
      const tour = makeTour(Shepherd);
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

    const startResults = async (Shepherd) => {
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
      const tour = makeTour(Shepherd);
      buildResultsSteps(tour, setDrawerOpenRef).forEach((step) => tour.addStep(step));
      tour.on('complete', finalize);
      tour.on('cancel', finalize);
      tourRef.current = tour;
      tour.start();
    };

    const start = async () => {
      if (cancelled) return;
      // Lazy-load Shepherd so its ~50KB stays out of the main bundle — the
      // tour only runs for first-time visitors; returning visitors never
      // download it.
      const { default: Shepherd } = await import('shepherd.js');
      if (cancelled) return;
      if (mode === 'home') startHome(Shepherd);
      else await startResults(Shepherd);
    };

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
