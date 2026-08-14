// Authentication via Azure Entra ID (Microsoft Authenticator)
// Checks /.auth/me endpoint provided by Azure Static Web Apps
// No local authentication system - all auth is delegated to Azure
//
// WHO IS AN ADMIN lives in ONE place: the backend allowlist in
// api/_adminAuth.js (ADMIN_EMAILS app setting, else its fallback array).
// The frontend fetches that roster from /api/xadmin-api-roster and caches it;
// FALLBACK_ADMIN_USERS below exists only so the UI still works before the
// first fetch resolves (or when the API is unreachable). Add a new admin on
// the backend and every dropdown/gate here follows automatically — do NOT
// add emails to this file.

// duh@tabarnam.com is a shared notification inbox (not a person) — excluded from admin.
const FALLBACK_ADMIN_USERS = [
  'jon@tabarnam.com',
  'ben@tabarnam.com',
  'kels@tabarnam.com'
];

export interface AdminUser {
  email: string;
}

/**
 * The ONLY way this app should read auth state (/.auth/me, the admin roster, or
 * anything else whose answer is "are you signed in / are you an admin").
 *
 * Always sends credentials and always bypasses the HTTP cache. A cached auth
 * answer is a correctness bug, not an optimisation: a stored
 * "clientPrincipal: null" made valid sessions look permanently signed-out and
 * produced an unfixable-by-re-login sign-in loop.
 *
 * NOTE: the service worker must also skip these paths (see
 * public/service-worker.js) — a SW intercepts before the HTTP cache, so
 * `cache: 'no-store'` alone is not sufficient.
 *
 * Do not call fetch() directly for auth state; use this.
 */
export function fetchAuthState(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...(init || {}), credentials: 'include', cache: 'no-store' });
}

let cachedUser: AdminUser | null = null;
let cacheTime: number = 0;
const CACHE_DURATION = 60000; // 1 minute cache

// ── Admin roster (fetched from the backend allowlist) ────────────────
const ROSTER_STORAGE_KEY = 'admin_roster_v2';
const ROSTER_TTL_MS = 5 * 60 * 1000;

/**
 * Two lists, deliberately separate.
 *
 *  admins       — staff. Read this only where "staff" is genuinely what you
 *                 mean; it is NOT the source for owner dropdowns.
 *  contributors — scoped outside help. May enter /admin, but sees only the
 *                 companies they own.
 *
 * Use getAssignableOwnerEmails() (the union) for anything that names a person
 * work can belong to. Assigning companies to a contributor is the point of the
 * role, and an earlier version of this file excluded them from those dropdowns
 * on the theory that it stopped them handing work to themselves. It did not —
 * it stopped ADMINS from assigning anything. What actually prevents a
 * contributor reassigning ownership is the server-side deny list on `owner`
 * (CONTRIBUTOR_DENIED_FIELDS in api/admin-companies-v2).
 *
 * `role` is the CALLER's own role. It exists so the UI can hide controls that
 * would only return 403 — it is a display hint, never an enforcement boundary.
 * Every restriction is enforced server-side.
 */
export type AdminRole = 'admin' | 'contributor';

let rosterCache: string[] | null = null;
let contributorCache: string[] | null = null;
let roleCache: AdminRole | null = null;

interface StoredRoster {
  admins: string[];
  contributors: string[];
  role: AdminRole | null;
  ts: number;
}

function readStoredRoster(): StoredRoster | null {
  try {
    const raw = sessionStorage.getItem(ROSTER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.admins) || typeof parsed.ts !== 'number') return null;
    if (Date.now() - parsed.ts > ROSTER_TTL_MS) return null;

    const clean = (list: unknown): string[] =>
      Array.isArray(list)
        ? list.filter((e: unknown) => typeof e === 'string' && (e as string).trim())
        : [];

    const admins = clean(parsed.admins);
    if (admins.length === 0) return null;

    return {
      admins,
      contributors: clean(parsed.contributors),
      role: parsed.role === 'admin' || parsed.role === 'contributor' ? parsed.role : null,
      ts: parsed.ts,
    };
  } catch {
    return null;
  }
}

function storeRoster(admins: string[], contributors: string[], role: AdminRole | null): void {
  rosterCache = admins;
  contributorCache = contributors;
  roleCache = role;
  try {
    sessionStorage.setItem(
      ROSTER_STORAGE_KEY,
      JSON.stringify({ admins, contributors, role, ts: Date.now() })
    );
  } catch {
    // sessionStorage unavailable — module cache still works for this page
  }
}

export type RosterFetchResult =
  | { status: 'ok'; admins: string[] }
  | { status: 'unauthenticated' }
  | { status: 'forbidden' }
  | { status: 'error' };

/**
 * Fetch the admin allowlist from the backend (the single source of truth).
 *
 * The backend distinguishes these deliberately (api/_adminAuth.js): 403 =
 * `not_admin` (authenticated, but not on the allowlist) and 401 = `missing_auth`
 * (no/invalid credentials on THIS request). They must NOT be conflated:
 *   'forbidden'       — 403 only. A real authorization failure; tell the user.
 *   'unauthenticated' — 401. The session expired / wasn't attached / is mid-refresh.
 *                       Recoverable: re-authenticate, never accuse a valid admin of
 *                       "not authorized" (that was the old intermittent bug).
 *   'error'           — endpoint unreachable; callers fall back to the last known /
 *                       hardcoded list rather than locking anyone out.
 */
export async function fetchAdminRoster(): Promise<RosterFetchResult> {
  try {
    const res = await fetchAuthState('/api/xadmin-api-roster');
    if (res.status === 401) return { status: 'unauthenticated' };
    if (res.status === 403) return { status: 'forbidden' };
    if (!res.ok) return { status: 'error' };

    const data = await res.json().catch(() => null);

    const clean = (list: unknown): string[] =>
      Array.isArray(list)
        ? list
            .filter((e: unknown) => typeof e === 'string' && (e as string).trim())
            .map((e: string) => e.trim().toLowerCase())
        : [];

    const admins = clean(data?.admins);
    if (!data?.ok || admins.length === 0) return { status: 'error' };

    const contributors = clean(data?.contributors);
    const role: AdminRole | null =
      data?.role === 'admin' || data?.role === 'contributor' ? data.role : null;

    storeRoster(admins, contributors, role);
    return { status: 'ok', admins };
  } catch {
    return { status: 'error' };
  }
}

/**
 * Current admin allowlist, synchronously: fetched roster when available
 * (module cache, then sessionStorage), else the hardcoded fallback. All
 * owner/person dropdowns and UI gates read this.
 */
export function getAuthorizedAdminEmails(): string[] {
  if (rosterCache && rosterCache.length > 0) return rosterCache;
  const stored = readStoredRoster();
  if (stored) {
    rosterCache = stored.admins;
    contributorCache = stored.contributors;
    roleCache = stored.role;
    return stored.admins;
  }
  return FALLBACK_ADMIN_USERS;
}

/** Contributors only. For assignment targets use getAssignableOwnerEmails(). */
export function getContributorEmails(): string[] {
  if (contributorCache) return contributorCache;
  const stored = readStoredRoster();
  if (stored) {
    rosterCache = stored.admins;
    contributorCache = stored.contributors;
    roleCache = stored.role;
    return stored.contributors;
  }
  return [];
}

/**
 * Everyone who may enter /admin at all. Used by the route gate ONLY — what a
 * person can then do is decided per request by the server.
 */
export function getAdminPortalEmails(): string[] {
  return [...new Set([...getAuthorizedAdminEmails(), ...getContributorEmails()])];
}

/**
 * Everyone work can be attributed to: owner dropdowns, bulk assign, batch
 * owner on import, and the person filters.
 *
 * This MUST include contributors. Assigning companies to a contributor is the
 * entire point of the role — leaving them out of these lists doesn't restrict
 * the contributor, it stops an admin from giving them anything to do.
 *
 * What prevents a contributor reassigning ownership is the server-side deny
 * list on `owner` (api/admin-companies-v2, CONTRIBUTOR_DENIED_FIELDS), not the
 * contents of a <select>. A dropdown is not an access control.
 */
export function getAssignableOwnerEmails(): string[] {
  return getAdminPortalEmails();
}

/**
 * The signed-in user's own role, once the roster has been fetched. Returns null
 * before that resolves.
 *
 * Use this to hide controls that would only 403, never to decide whether an
 * action is permitted — the server decides that, every time.
 */
export function getCurrentRole(): AdminRole | null {
  if (roleCache) return roleCache;
  const stored = readStoredRoster();
  if (stored) {
    rosterCache = stored.admins;
    contributorCache = stored.contributors;
    roleCache = stored.role;
    return stored.role;
  }
  return null;
}

/** True only when we positively know the caller is scoped. */
export function isContributor(): boolean {
  return getCurrentRole() === 'contributor';
}

/**
 * Get current admin user from Azure Entra ID
 * Reads from /.auth/me which is provided by Azure Static Web Apps
 */
export function getAdminUser(): AdminUser | null {
  // Return cached user if still fresh
  const now = Date.now();
  if (cachedUser && now - cacheTime < CACHE_DURATION) {
    return cachedUser;
  }

  // Fetch from Azure endpoint synchronously (blocking for initial load)
  try {
    // Note: In production, consider making this async
    // For now, we use localStorage as a fallback during initial page load
    const storedEmail = sessionStorage.getItem('azure_user_email');
    if (storedEmail && getAdminPortalEmails().includes(storedEmail.toLowerCase())) {
      cachedUser = { email: storedEmail };
      cacheTime = now;
      return cachedUser;
    }
  } catch {}

  return null;
}

/**
 * Fetch and cache the current user from Azure Entra ID
 * Should be called on page load to populate the user cache
 */
export async function initializeAzureUser(): Promise<AdminUser | null> {
  try {
    const res = await fetchAuthState('/.auth/me');
    if (!res.ok) return null;

    // Check content type to ensure we're getting JSON (not HTML error pages)
    const contentType = res.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      console.debug('[azureAuth] Non-JSON response from /.auth/me (development environment?)');
      return null;
    }

    const data = await res.json();
    const principal = data?.clientPrincipal;

    if (!principal) return null;

    const email = principal.userDetails || principal.claims?.find((c: any) => c.typ === 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress')?.val;

    if (!email) return null;

    // Cache the user in sessionStorage (cleared on browser close)
    sessionStorage.setItem('azure_user_email', email);

    cachedUser = { email };
    cacheTime = Date.now();

    return cachedUser;
  } catch (e) {
    // Silently handle errors in development (/.auth/me doesn't exist locally)
    console.debug('[azureAuth] Failed to initialize user:', e);
    return null;
  }
}

// Test hook: reset module caches between vitest cases.
export function __resetAuthCachesForTest(): void {
  cachedUser = null;
  cacheTime = 0;
  rosterCache = null;
  contributorCache = null;
  roleCache = null;
}
