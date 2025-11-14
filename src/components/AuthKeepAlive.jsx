import React from 'react';

export default function AuthKeepAlive({ intervalMs = 5 * 60 * 1000 }) {
  const timerRef = React.useRef(null);

  const ping = React.useCallback(() => {
    // Fire-and-forget; keep session warm without blocking UI
    fetch('/.auth/me', {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-store' },
    }).catch(() => {
      // ignore network/auth errors; this is a best-effort keep-alive
    });
  }, []);

  React.useEffect(() => {
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
  }, [intervalMs, ping]);

  return null;
}
