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

let cachedUser: AdminUser | null = null;
let cacheTime: number = 0;
const CACHE_DURATION = 60000; // 1 minute cache

// ── Admin roster (fetched from the backend allowlist) ────────────────
const ROSTER_STORAGE_KEY = 'admin_roster_v1';
const ROSTER_TTL_MS = 5 * 60 * 1000;

let rosterCache: string[] | null = null;

function readStoredRoster(): string[] | null {
  try {
    const raw = sessionStorage.getItem(ROSTER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.admins) || typeof parsed.ts !== 'number') return null;
    if (Date.now() - parsed.ts > ROSTER_TTL_MS) return null;
    const admins = parsed.admins.filter((e: unknown) => typeof e === 'string' && (e as string).trim());
    return admins.length > 0 ? admins : null;
  } catch {
    return null;
  }
}

function storeRoster(admins: string[]): void {
  rosterCache = admins;
  try {
    sessionStorage.setItem(ROSTER_STORAGE_KEY, JSON.stringify({ admins, ts: Date.now() }));
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
    // no-store: an auth verdict must never be served from cache.
    const res = await fetch('/api/xadmin-api-roster', { credentials: 'include', cache: 'no-store' });
    if (res.status === 401) return { status: 'unauthenticated' };
    if (res.status === 403) return { status: 'forbidden' };
    if (!res.ok) return { status: 'error' };

    const data = await res.json().catch(() => null);
    const admins: string[] = Array.isArray(data?.admins)
      ? data.admins
          .filter((e: unknown) => typeof e === 'string' && (e as string).trim())
          .map((e: string) => e.trim().toLowerCase())
      : [];
    if (!data?.ok || admins.length === 0) return { status: 'error' };

    storeRoster(admins);
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
    rosterCache = stored;
    return stored;
  }
  return FALLBACK_ADMIN_USERS;
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
    if (storedEmail && getAuthorizedAdminEmails().includes(storedEmail.toLowerCase())) {
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
    // no-store: see AdminRoute — a cached null principal makes a valid session
    // look signed-out.
    const res = await fetch('/.auth/me', { credentials: 'include', cache: 'no-store' });
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
}
