import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';

export default function AdminRoute({ children }) {
  const { pathname, search } = useLocation();
  const [status, setStatus] = React.useState('checking'); // checking | allowed | denied | dev

  React.useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch('/.auth/me', { credentials: 'include' });
        if (!res.ok) throw new Error('auth unavailable');
        const data = await res.json();
        const principal = data && data.clientPrincipal;
        if (!cancelled) setStatus(principal ? 'allowed' : 'denied');
      } catch {
        // In non-SWA environments (local/dev), allow access so the page remains usable
        if (!cancelled) setStatus('dev');
      }
    };
    check();
    return () => {
      cancelled = true;
    };
  }, [pathname, search]);

  if (status === 'checking') return null;

  if (status === 'denied') {
    const postLogin = encodeURIComponent(pathname + (search || ''));
    window.location.href = `/.auth/login/aad?post_login_redirect_uri=${postLogin}`;
    return <Navigate to="/login" replace />;
  }

  return children;
}
