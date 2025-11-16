import React from 'react';

export default function AuthKeepAlive({ intervalMs = 5 * 60 * 1000 }) {
  const timerRef = React.useRef(null);
  const [isSWAEnabled, setIsSWAEnabled] = React.useState(false);

  React.useEffect(() => {
    // Check if /.auth/me endpoint is available (Azure Static Web Apps)
    const checkSWA = async () => {
      try {
        const res = await fetch('/.auth/me', {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-store' },
        });
        setIsSWAEnabled(res.ok || res.status === 401); // 401 means auth is configured but not logged in
      } catch {
        // /.auth/me endpoint doesn't exist; not a SWA environment
        setIsSWAEnabled(false);
      }
    };

    checkSWA();
  }, []);

  const ping = React.useCallback(() => {
    if (!isSWAEnabled) return;
    // Fire-and-forget; keep session warm without blocking UI
    fetch('/.auth/me', {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-store' },
    }).catch(() => {
      // ignore network/auth errors; this is a best-effort keep-alive
    });
  }, [isSWAEnabled]);

  React.useEffect(() => {
    if (!isSWAEnabled) return;

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
  }, [intervalMs, ping, isSWAEnabled]);

  return null;
}
