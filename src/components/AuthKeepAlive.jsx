import React from 'react';

export default function AuthKeepAlive({ intervalMs = 5 * 60 * 1000 }) {
  const timerRef = React.useRef(null);

  // Only run keep-alive on Azure Static Web Apps hosts where `/.auth/*` exists.
  // Builder preview / local dev environments do not provide the SWA auth endpoints.
  const isSWAEnvironment = (() => {
    try {
      const host = String(window?.location?.hostname || "").toLowerCase();
      if (!host) return false;
      if (host.includes("localhost") || host.includes("127.0.0.1")) return false;
      if (host === "tabarnam.com" || host === "www.tabarnam.com") return true;
      return host.endsWith(".azurestaticapps.net") || host.includes("azurestaticapps");
    } catch {
      return false;
    }
  })();

  const ping = React.useCallback(() => {
    if (!isSWAEnvironment) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;

    // Fire-and-forget; keep session warm without blocking UI.
    // Some environments monkeypatch `window.fetch` and may throw synchronously, so we guard both sync + async failures.
    try {
      const res = fetch("/.auth/me", {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers: { "Cache-Control": "no-store" },
      });

      if (res && typeof res.catch === "function") {
        res.catch(() => {
          // ignore network/auth errors; this is a best-effort keep-alive
        });
      }
    } catch {
      // ignore
    }
  }, [isSWAEnvironment]);

  React.useEffect(() => {
    if (!isSWAEnvironment) return;

    // initial ping shortly after mount
    const id = setTimeout(ping, 1000);

    const start = () => {
      if (timerRef.current) return;
      timerRef.current = setInterval(ping, intervalMs);
    };
    const stop = () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };

    // run when page is visible and online
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        ping();
        start();
      } else {
        stop();
      }
    };
    const onOnline = () => {
      ping();
      start();
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);

    // start immediately if visible
    if (document.visibilityState === 'visible') start();

    return () => {
      clearTimeout(id);
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
    };
  }, [intervalMs, ping, isSWAEnvironment]);

  return null;
}
