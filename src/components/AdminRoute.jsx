import React from 'react';
import { useLocation } from 'react-router-dom';
import { fetchAdminRoster, getAuthorizedAdminEmails } from '@/lib/azureAuth';

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

// One-shot re-login guard. A sign-in that doesn't establish a session must not
// be retried forever — that produced an endless /.auth/complete <-> /login
// flash. We attempt the redirect at most once per browser session; if we come
// back still unauthenticated, we stop and explain instead of looping.
const RELOGIN_FLAG = 'admin_relogin_attempted';

function hasAttemptedRelogin() {
  try {
    return sessionStorage.getItem(RELOGIN_FLAG) === '1';
  } catch {
    return false; // sessionStorage unavailable — fail open to a single attempt
  }
}
function markReloginAttempted() {
  try {
    sessionStorage.setItem(RELOGIN_FLAG, '1');
  } catch { /* non-fatal */ }
}
function clearReloginAttempted() {
  try {
    sessionStorage.removeItem(RELOGIN_FLAG);
  } catch { /* non-fatal */ }
}

export default function AdminRoute({ children }) {
  const { pathname, search } = useLocation();
  // checking  — still resolving
  // allowed   — admin, render the shell
  // forbidden — signed in but NOT on the allowlist (a real 403)
  // stuck     — sign-in didn't establish a session, and we already retried once
  const [status, setStatus] = React.useState('checking');
  const [diag, setDiag] = React.useState({ email: '', reason: '' });

  React.useEffect(() => {
    let cancelled = false;

    // Send the user to Microsoft to sign in, returning them to the page they
    // asked for. IMPORTANT: perform exactly ONE navigation. Previously this
    // also returned <Navigate to="/login">, and the two raced — which both
    // caused the observed redirect loop and threw away the intended path.
    const goToLogin = () => {
      markReloginAttempted();
      const target = pathname + (search || '');
      window.location.replace(
        `/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(target)}`
      );
    };

    const check = async () => {
      let principal = null;
      try {
        const res = await fetch('/.auth/me', { credentials: 'include' });
        if (!res.ok) throw new Error('auth unavailable');
        // /.auth/me only exists on SWA; locally it 404s or returns HTML.
        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) throw new Error('auth unavailable');
        const data = await res.json();
        principal = data && data.clientPrincipal;
      } catch {
        // Non-SWA environment (local/dev): render the app. The backend guard is
        // the real gate, so this cannot grant access to protected data.
        if (!cancelled) setStatus('allowed');
        return;
      }

      // Not signed in at all — go authenticate (once).
      if (!principal) {
        if (cancelled) return;
        if (hasAttemptedRelogin()) {
          setDiag({ email: '', reason: 'no_session_after_signin' });
          setStatus('stuck');
          return;
        }
        goToLogin();
        return;
      }

      const email = extractPrincipalEmail(principal);

      // The BACKEND allowlist is the single source of truth — ask it directly
      // (the roster endpoint is itself admin-guarded, so a 200 IS the verdict).
      // This also warms the roster cache every owner/person dropdown reads.
      let verdict = await fetchAdminRoster();

      // A 401 means "credentials weren't accepted on THIS request" (expired /
      // not-yet-attached / mid-refresh) — NOT "you aren't an admin". Retry once
      // to absorb the token-refresh race before doing anything drastic.
      if (verdict.status === 'unauthenticated') {
        await new Promise((r) => setTimeout(r, 600));
        if (cancelled) return;
        verdict = await fetchAdminRoster();
      }
      if (cancelled) return;

      if (verdict.status === 'ok') {
        clearReloginAttempted(); // healthy session — reset the guard
        setStatus('allowed');
        return;
      }

      if (verdict.status === 'forbidden') {
        // Genuine 403: authenticated, but not on the allowlist.
        setDiag({ email, reason: 'not_admin' });
        setStatus('forbidden');
        return;
      }

      if (verdict.status === 'unauthenticated') {
        // Still 401 after a retry: the session truly isn't valid. Re-login once;
        // if we've already tried, stop and explain rather than loop.
        if (hasAttemptedRelogin()) {
          setDiag({ email, reason: 'session_not_accepted' });
          setStatus('stuck');
          return;
        }
        goToLogin();
        return;
      }

      // verdict.status === 'error' — endpoint unreachable. Fall back to the last
      // known/hardcoded list so an API blip can't lock out existing admins.
      const admins = getAuthorizedAdminEmails().map((e) => e.toLowerCase());
      if (email && admins.includes(email)) {
        setStatus('allowed');
      } else {
        setDiag({ email, reason: 'roster_unavailable' });
        setStatus('forbidden');
      }
    };

    check();
    return () => {
      cancelled = true;
    };
  }, [pathname, search]);

  if (status === 'checking') return null;

  // Sign-in completed but no usable session came back, and we already retried.
  // Distinct from "not authorized" — this is a session problem, not a
  // permissions problem, so say so and offer the manual path.
  if (status === 'stuck') {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center px-4">
        <div className="bg-slate-800 p-6 rounded-lg shadow-lg w-full max-w-md text-center space-y-4">
          <h2 className="text-white text-xl font-semibold">Sign-in didn&apos;t stick</h2>
          <p className="text-gray-400 text-sm">
            You signed in, but the browser didn&apos;t keep a valid session, so we stopped
            instead of retrying in a loop. This is usually a cookie/session issue — not a
            permissions problem.
          </p>
          <p className="text-gray-500 text-xs">
            Try: sign out fully, then sign in again. If it persists, clear cookies and site
            data for this site, or try another browser.
          </p>
          <div className="flex flex-col gap-2">
            <a href="/.auth/logout" className="text-sm text-purple-300 underline">
              Sign out and start over
            </a>
            <a href="/.auth/login/aad" className="text-sm text-purple-300 underline">
              Try signing in again
            </a>
          </div>
          <p className="text-gray-600 text-[11px]">
            diagnostic: {diag.reason || 'unknown'}
            {diag.email ? ` · ${diag.email}` : ''}
          </p>
        </div>
      </div>
    );
  }

  if (status === 'forbidden') {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center px-4">
        <div className="bg-slate-800 p-6 rounded-lg shadow-lg w-full max-w-md text-center space-y-4">
          <h2 className="text-white text-xl font-semibold">Access denied</h2>
          <p className="text-gray-400 text-sm">
            {diag.reason === 'roster_unavailable'
              ? 'We could not confirm your admin access (the roster service is unreachable) and your account is not in the local list.'
              : 'Your Microsoft account is not authorized for the Tabarnam admin. If you believe this is a mistake, contact an administrator.'}
          </p>
          <a href="/.auth/logout" className="inline-block text-sm text-purple-300 underline">
            Sign out and try another account
          </a>
          {/* Self-diagnosing: shows WHICH account was presented, so a wrong /
              aliased Microsoft account is obvious without opening DevTools. */}
          <p className="text-gray-600 text-[11px]">
            signed in as: {diag.email || '(no email in token)'} · {diag.reason || 'unknown'}
          </p>
        </div>
      </div>
    );
  }

  return children;
}
