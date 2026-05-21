import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Resets scroll position on SPA navigation. React Router preserves the
 * previous scroll position across route changes by default; this restores
 * normal browser behavior:
 *   - URL with a hash  -> smooth-scroll to that element (deep links / TOC)
 *   - URL without hash -> jump to the top of the page
 *
 * Mounted once inside <Router> in App.jsx, so every route gets the behavior
 * (previously this logic was duplicated per-page in Help/About/Privacy).
 */
export default function ScrollToHashOrTop() {
  const { pathname, hash } = useLocation();

  useEffect(() => {
    if (hash) {
      const id = hash.slice(1);
      // Defer one tick so the target element has rendered.
      const t = setTimeout(() => {
        try {
          document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch {}
      }, 50);
      return () => clearTimeout(t);
    }
    try {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    } catch {
      window.scrollTo(0, 0);
    }
  }, [pathname, hash]);

  return null;
}
