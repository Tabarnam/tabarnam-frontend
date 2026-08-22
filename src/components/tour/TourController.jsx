import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  decideTourMode,
  TOUR_SEEN_KEY,
  TOUR_PROGRESS_KEY,
  TOUR_STEP_HINT_KEY,
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
      id: 'filter',
      title: 'Sort and filter',
      text: 'Open this menu to sort by nearest, highest rated, or filter to in-country only.',
      attachTo: { element: '[data-tour-step="filter-trigger"]', on: 'bottom-start' },
      scrollTo: { behavior: 'smooth', block: 'nearest' },
      buttons: [
        { text: 'Skip tour', action: () => tour.cancel(), secondary: true },
        { text: 'Back', action: () => tour.back(), secondary: true },
        learnMore('#sorting'),
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
        { text: 'Next', action: onHandoff },
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

// Four demo tiles the cover-image step injects into the "All Bookmarks"
// folder card when it's empty, so the visitor sees a filled folder's visual
// language instead of four identical building placeholders. Mixed on purpose:
//
//   Slot 0: Real photo of a product (soap)  — public-domain image bundled
//   Slot 1: Real photo of a product (coffee) — under /public/tour-demo/
//   Slot 2: Icon fallback (wrench)          — LogoCell renders demoIcon
//   Slot 3: Blank                           — LogoCell renders Building2
//
// The mix teaches: "your saved bookmarks can be anything, and some slots
// might just show a category icon or a placeholder if the source has no
// product image."
const TOUR_DEMO_FOLDER_ITEMS = [
  { logo_url: '/tour-demo/soap.jpg', name: 'Soap' },
  { logo_url: '/tour-demo/coffee.jpg', name: 'Coffee' },
  { logo_url: '/tour-demo/tools.jpg', name: 'Tools' },
  { name: 'Blank slot' },
];

function buildResultsSteps(tour, drawerRef, navigateRef, floatingUi) {
  const openDrawer = () => { try { drawerRef.current?.(true); } catch {} };
  const closeDrawer = () => { try { drawerRef.current?.(false); } catch {} };
  const go = (path) => { try { navigateRef.current?.(path); } catch {} };
  const setMap = (open) => {
    try { window.dispatchEvent(new CustomEvent('tour:set-map', { detail: { open } })); } catch {}
  };
  const setDensity = (mode) => {
    try { window.dispatchEvent(new CustomEvent('tour:set-density', { detail: { mode } })); } catch {}
  };
  const showDemoFolders = (show) => {
    try {
      window.dispatchEvent(new CustomEvent('tour:show-demo-folders', {
        detail: { items: show ? TOUR_DEMO_FOLDER_ITEMS : null },
      }));
    } catch {}
  };
  // Snapshot the visitor's saved density so we can restore it after the
  // "Comfortable or Compact" step's live demo.
  const readDensity = () => {
    try {
      return localStorage.getItem('tabarnam_density') === 'compact' ? 'compact' : 'comfortable';
    } catch { return 'comfortable'; }
  };
  let originalDensity = null;
  const captureDensity = () => { if (originalDensity === null) originalDensity = readDensity(); };
  const restoreDensity = () => {
    if (originalDensity !== null) {
      setDensity(originalDensity);
      originalDensity = null;
    }
  };

  return [
    {
      id: 'sort',
      title: 'Click a column to re-sort',
      text: 'Click the <strong>QQ</strong> header to sort by score. Click <strong>HQ</strong> or <strong>Manufacturing</strong> to re-sort by proximity.',
      attachTo: { element: '[data-tour-step="sort-header-qq"]', on: 'bottom' },
      scrollTo: { behavior: 'smooth', block: 'center' },
      buttons: [
        { text: 'Skip tour', action: () => tour.cancel(), secondary: true },
        {
          text: 'Back',
          action: () => {
            // Sort is the first results-leg step, so Back has to cross legs —
            // navigate to /?tour=1 and leave a step-hint pointing at the home
            // leg's last step (location). startHome reads and clears the hint
            // and jumps straight there instead of restarting at step 1 (search).
            safeWrite(TOUR_STEP_HINT_KEY, 'location');
            go('/?tour=1');
          },
          secondary: true,
        },
        learnMore('#qq'),
        { text: 'Next', action: () => tour.next() },
      ],
    },
    {
      id: 'row',
      title: 'Open a result',
      text: 'Click any row to expand it into the full company profile, including all locations, reviews, and links.',
      attachTo: { element: '[data-tour-step="expandable-row"]', on: 'top' },
      scrollTo: { behavior: 'smooth', block: 'center' },
      buttons: [
        { text: 'Skip tour', action: () => tour.cancel(), secondary: true },
        { text: 'Back', action: () => tour.back(), secondary: true },
        learnMore('#row'),
        { text: 'Next', action: () => tour.next() },
      ],
    },
    {
      id: 'density',
      title: 'Comfortable or Compact',
      text: 'Rows just got denser — that\'s <strong>Compact</strong>. Toggle to fit more results on screen. Your choice sticks between visits; we\'ll flip back to whatever you had when you move on.',
      attachTo: { element: '[data-tour-step="density-toggle"]', on: 'bottom' },
      scrollTo: { behavior: 'smooth', block: 'nearest' },
      beforeShowPromise: async () => {
        // Snapshot the visitor's current preference, then flip to compact so
        // the change is visible under the popover. Restored on Skip/Back/Next.
        captureDensity();
        setDensity('compact');
        await new Promise((r) => setTimeout(r, 200));
      },
      buttons: [
        { text: 'Skip tour', action: () => { restoreDensity(); tour.cancel(); }, secondary: true },
        { text: 'Back', action: () => { restoreDensity(); tour.back(); }, secondary: true },
        { text: 'Next', action: () => { restoreDensity(); tour.next(); } },
      ],
    },
    {
      id: 'map',
      title: 'See it on a map',
      text: 'Every result also has a place on the map. Pins mark headquarters and factories; the red teardrop is your search origin. Hover a pin to preview a company; click to focus it.',
      attachTo: { element: '[data-tour-step="results-map-panel"]', on: 'left' },
      scrollTo: { behavior: 'smooth', block: 'center' },
      beforeShowPromise: async () => {
        setMap(true);
        // Wait for the map panel to mount, then give Leaflet a beat to render
        // its tiles + pins before Shepherd measures the popover.
        await waitForElement('[data-tour-step="results-map-panel"]');
        await new Promise((r) => setTimeout(r, 800));
      },
      buttons: [
        { text: 'Skip tour', action: () => { setMap(false); tour.cancel(); }, secondary: true },
        { text: 'Back', action: () => { setMap(false); tour.back(); }, secondary: true },
        learnMore('#map'),
        { text: 'Next', action: () => { setMap(false); tour.next(); } },
      ],
    },
    {
      id: 'bookmark-save',
      title: 'Bookmarks',
      text: 'Tap the bookmark icon to save any company. Tap it again to file it under a custom list.',
      attachTo: { element: '[data-tour-step="bookmark-button"]', on: 'top' },
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
      title: 'Bookmarks',
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
        { text: 'Next', action: () => tour.next() },
      ],
    },
    {
      id: 'bookmark-folder-cover',
      title: 'Set bookmark folder images',
      text: 'Give any list a personal cover. Open the folder, then choose <strong>⋯ → Set Cover Image</strong> to upload one or paste a URL.',
      attachTo: { element: '[data-tour-step="bookmark-folder-card"]', on: 'right-start' },
      // Floating UI's flip middleware kept redirecting right -> bottom
      // (which dropped the popover on top of the tile grid) regardless of
      // step-level middleware overrides — Shepherd v15's merging isn't
      // additive the way we need for this to fully lock. Add a class so
      // CSS can pin the popover to the right side of the tile grid
      // directly, so this step's layout is deterministic.
      classes: 'shepherd-cover-image-step',
      scrollTo: { behavior: 'smooth', block: 'center' },
      beforeShowPromise: async () => {
        // Close the drawer (the previous step left it open) before switching pages,
        // then land on the folder grid. If the visitor has no custom lists yet, the
        // anchor won't be found and Shepherd falls back to a centered modal — which
        // still teaches the feature.
        closeDrawer();
        go('/bookmarks');
        await Promise.race([
          waitForElement('[data-tour-step="bookmark-folder-card"]', 1500),
          new Promise((r) => setTimeout(r, 800)),
        ]);
        // Dispatch AFTER the wait — BookmarksPage's event listener isn't
        // attached until it mounts, so a dispatch before the route commit
        // is lost. Populate the "All Bookmarks" card with 4 demo covers
        // so the visitor sees the 4-image grid format instead of empty
        // placeholder buildings. Cleared on Skip/Back/Done below.
        showDemoFolders(true);
      },
      buttons: [
        { text: 'Skip tour', action: () => { showDemoFolders(false); tour.cancel(); }, secondary: true },
        {
          text: 'Back',
          action: () => {
            // The Back button on this step needs to walk BOTH the tour and
            // the page back. tour.back() alone would rewind the step index
            // while leaving the visitor stranded on /bookmarks, and the
            // subsequent route change (whenever they finally make one) would
            // fire the useEffect and restart the tour from step 1.
            //
            // Instead: leave a step-hint so the new tour instance can jump
            // straight to bookmark-drawer once /results re-mounts, then
            // route back with the tour flag preserved so decideTourMode
            // still returns 'results'.
            showDemoFolders(false);
            safeWrite(TOUR_STEP_HINT_KEY, 'bookmark-drawer');
            go(`${RESULTS_PATH}?q=${encodeURIComponent(CANNED_QUERY)}&country=US&tour=1`);
          },
          secondary: true,
        },
        learnMore('#bookmarks'),
        {
          text: 'Done',
          action: () => {
            // Ending on /bookmarks with an empty folder card is a dead-end
            // feel — route home so the visitor lands somewhere useful.
            //
            // Write the completion state inline BEFORE navigating. The
            // route change fires the useEffect cleanup which marks
            // isUnmounting=true, and any finalize() that runs after that
            // guard skips the seen/progress writes — leaving the tour
            // eligible to auto-fire again on the next home visit.
            safeWrite(TOUR_SEEN_KEY, '1');
            safeRemove(TOUR_PROGRESS_KEY);
            safeRemove(TOUR_STEP_HINT_KEY);
            showDemoFolders(false);
            tour.complete();
            go('/');
          },
        },
      ],
    },
  ];
}

function makeTour(Shepherd, floatingOffset) {
  return new Shepherd.Tour({
    useModalOverlay: true,
    defaultStepOptions: {
      cancelIcon: { enabled: true },
      scrollTo: { behavior: 'smooth', block: 'nearest' },
      // Pad the modal cutout further from the target's edges so the halo
      // ring has room to breathe and the icon isn't visually cramped.
      modalOverlayOpeningPadding: 8,
      modalOverlayOpeningRadius: 8,
      // Shepherd v15 wraps Floating UI; the correct API is
      // floatingUIOptions.middleware (the old popperOptions.modifiers
      // is silently ignored). Push the popover ~24px from the target
      // so the halo has clear breathing room around every icon.
      floatingUIOptions: {
        middleware: [floatingOffset(24)],
      },
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
  const { pathname, search, state } = useLocation();
  const navigate = useNavigate();
  const tourRef = useRef(null);
  // Bridge: stash the latest setDrawerOpen in a ref so step callbacks
  // captured in the closure below always invoke the current setter.
  const { setDrawerOpen } = useBookmarks();
  const setDrawerOpenRef = useRef(setDrawerOpen);
  setDrawerOpenRef.current = setDrawerOpen;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // Only re-decide the tour when the route or the tour force-flag changes.
  // The results-leg's map step toggles ?map=1 on and off — including all of
  // `search` in the deps would tear down and restart the tour every time.
  const forceTourParam = new URLSearchParams(search || '').get('tour') === '1' ? '1' : '';

  useEffect(() => {
    // Landing here via an explicit "Clear" (or any nav that asks to skip the
    // tour) should not auto-launch onboarding. Transient router state only —
    // a later organic visit still gets the tour.
    if (state?.skipTour) return;
    // Read search fresh so an in-flight ?map=1 flip doesn't affect the
    // decision (decideTourMode only cares about the tour flag itself, which
    // is captured in forceTourParam above and drives the effect deps).
    const currentSearch = window.location.search;
    const mode = decideTourMode({
      pathname,
      search: currentSearch,
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
        // Any pending step hint dies with the tour — it's only meant to
        // survive a single intra-tour route change.
        safeRemove(TOUR_STEP_HINT_KEY);
      }
      // If a step left the bookmark drawer open (e.g. cancelled during the
      // last results step), close it so the user lands back on the page.
      try { setDrawerOpenRef.current?.(false); } catch {}
      tourRef.current = null;
    };

    const startHome = (Shepherd, floatingUi) => {
      if (cancelled || tourRef.current) return;
      const tour = makeTour(Shepherd, floatingUi.offset);
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
      // A cross-leg Back (e.g. sort step's Back on /results) can leave a
      // step-hint pointing at a specific home-leg step; jump straight there
      // instead of restarting at 'search'.
      const stepHint = safeRead(TOUR_STEP_HINT_KEY);
      safeRemove(TOUR_STEP_HINT_KEY);
      if (stepHint) {
        try { tour.show(stepHint); return; } catch { /* fall through to start */ }
      }
      tour.start();
    };

    const startResults = async (Shepherd, floatingUi) => {
      if (cancelled || tourRef.current) return;
      // Purge any shepherd DOM left over from a prior tour instance (e.g. the
      // cover-image step's popover when the visitor hit Back). The route-change
      // useEffect cleanup runs .cancel() + remove(), but Shepherd sometimes
      // holds onto step DOM across cancels — this is the belt to that suspenders.
      document
        .querySelectorAll('.shepherd-element, .shepherd-modal-overlay-container')
        .forEach((el) => el.remove());
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
      const tour = makeTour(Shepherd, floatingUi.offset);
      buildResultsSteps(tour, setDrawerOpenRef, navigateRef, floatingUi).forEach((step) => tour.addStep(step));
      tour.on('complete', finalize);
      tour.on('cancel', finalize);
      tourRef.current = tour;
      // A previous step (e.g. bookmark-folder-cover's Back button) can hint
      // which step this fresh instance should jump to, so navigation-triggered
      // remounts don't reset the visitor to step 1.
      const stepHint = safeRead(TOUR_STEP_HINT_KEY);
      safeRemove(TOUR_STEP_HINT_KEY);
      if (stepHint) {
        try { tour.show(stepHint); return; } catch { /* fall through to start */ }
      }
      tour.start();
    };

    const start = async () => {
      if (cancelled) return;
      // Lazy-load Shepherd + Floating UI helpers together so the ~50KB
      // stays out of the main bundle — the tour only runs for first-time
      // visitors; returning visitors never download either.
      const [{ default: Shepherd }, floatingUi] = await Promise.all([
        import('shepherd.js'),
        import('@floating-ui/dom'),
      ]);
      if (cancelled) return;
      if (mode === 'home') startHome(Shepherd, floatingUi);
      else await startResults(Shepherd, floatingUi);
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
  }, [pathname, forceTourParam, state, navigate]);

  return null;
}
