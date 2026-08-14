// Post-login destination that survives the SWA auth round-trip.
//
// Azure Static Web Apps stashes the requested `post_login_redirect_uri` in an
// encrypted `StaticWebAppsAuthContextCookie` (SameSite=None). That cookie has to
// survive a cross-site `form_post` from login.microsoftonline.com back to
// /.auth/login/aad/callback. Browsers with strict third-party-cookie blocking —
// Brave Shields especially — drop it on the return leg, so SWA loses the target
// and lands the admin on "/" instead of the page they asked for. This is the
// long-standing "admin login goes to the homepage" bug.
//
// localStorage is first-party to tabarnam.com and survives the round-trip
// untouched, so we stash the intended admin path here right before redirecting
// to login and honor it on the next app load (see consumePostLoginDest, called
// from App on mount). It is a belt to SWA's cookie suspenders: when the cookie
// works we no-op harmlessly; when it's dropped we still land on /admin.

const KEY = "tabarnam_post_login_dest";
const MAX_AGE_MS = 5 * 60 * 1000; // ignore stale intents (abandoned logins)

/** Remember where to land after login. Only admin paths are ever stored. */
export function savePostLoginDest(path: string): void {
  try {
    if (typeof window === "undefined") return;
    const p = String(path || "");
    // Never store "/" or a public route — that would hijack ordinary navigation
    // on the next load. Only ever send the user back into the admin app.
    if (!p.startsWith("/admin")) return;
    window.localStorage.setItem(KEY, JSON.stringify({ path: p, ts: Date.now() }));
  } catch {
    /* storage unavailable — SWA's cookie remains the fallback */
  }
}

/**
 * Read and clear a stashed admin destination (one-shot). Returns the path only
 * when it's a fresh, admin-scoped intent; otherwise null.
 */
export function consumePostLoginDest(): string | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    window.localStorage.removeItem(KEY); // one-shot: never redirect twice
    const parsed = JSON.parse(raw) as { path?: unknown; ts?: unknown };
    const path = typeof parsed?.path === "string" ? parsed.path : "";
    const ts = typeof parsed?.ts === "number" ? parsed.ts : 0;
    if (!path.startsWith("/admin")) return null;
    if (!ts || Date.now() - ts > MAX_AGE_MS) return null; // stale → ignore
    return path;
  } catch {
    return null;
  }
}
