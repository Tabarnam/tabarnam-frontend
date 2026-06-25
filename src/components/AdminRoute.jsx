import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { getAuthorizedAdminEmails } from '@/lib/azureAuth';

// Pull the caller's email out of the SWA clientPrincipal (userDetails, or an
// email-bearing claim). Mirrors api/_adminAuth.js::extractEmail so the UI gate
// and the backend gate agree on identity.
function extractPrincipalEmail(principal) {
  if (!principal) return '';
  if (principal.userDetails) return String(principal.userDetails).trim().toLowerCase();
  const claims = Array.isArray(principal.claims) ? principal.claims : [];
  const match = claims.find(
    (c) =>
      c?.typ === 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress' ||
      c?.typ === 'preferred_username' ||
      c?.typ === 'email'
  );
  return match?.val ? String(match.val).trim().toLowerCase() : '';
}

export default function AdminRoute({ children }) {
  const { pathname, search } = useLocation();
  // checking | allowed | denied (not signed in) | forbidden (signed in, not admin) | dev
  const [status, setStatus] = React.useState('checking');

  React.useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch('/.auth/me', { credentials: 'include' });
        if (!res.ok) throw new Error('auth unavailable');
        // /.auth/me only exists on SWA; locally it 404s or returns HTML.
        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) throw new Error('auth unavailable');

        const data = await res.json();
        const principal = data && data.clientPrincipal;
        if (!principal) {
          if (!cancelled) setStatus('denied');
          return;
        }

        // Defense-in-depth: the UI must not render the admin shell for just any
        // signed-in Microsoft account — validate the email against the allowlist
        // (the backend guard remains the authoritative enforcement).
        const email = extractPrincipalEmail(principal);
        const admins = getAuthorizedAdminEmails().map((e) => e.toLowerCase());
        if (!cancelled) setStatus(email && admins.includes(email) ? 'allowed' : 'forbidden');
      } catch {
        // In non-SWA environments (local/dev), allow access so the page remains
        // usable. The backend guard is the real gate.
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

  if (status === 'forbidden') {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center px-4">
        <div className="bg-slate-800 p-6 rounded-lg shadow-lg w-full max-w-sm text-center space-y-4">
          <h2 className="text-white text-xl font-semibold">Access denied</h2>
          <p className="text-gray-400 text-sm">
            Your Microsoft account is not authorized for the Tabarnam admin. If you believe this is a
            mistake, contact an administrator.
          </p>
          <a href="/.auth/logout" className="inline-block text-sm text-purple-300 underline">
            Sign out and try another account
          </a>
        </div>
      </div>
    );
  }

  return children;
}
