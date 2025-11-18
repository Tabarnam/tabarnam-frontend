// Authentication via Azure Entra ID (Microsoft Authenticator)
// Checks /.auth/me endpoint provided by Azure Static Web Apps
// No local authentication system - all auth is delegated to Azure

const ADMIN_USERS = [
  'jon@tabarnam.com',
  'ben@tabarnam.com',
  'kels@tabarnam.com',
  'duh@tabarnam.com'
];

export interface AdminUser {
  email: string;
}

let cachedUser: AdminUser | null = null;
let cacheTime: number = 0;
const CACHE_DURATION = 60000; // 1 minute cache

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
    if (storedEmail && ADMIN_USERS.includes(storedEmail)) {
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
    const res = await fetch('/.auth/me', { credentials: 'include' });
    if (!res.ok) return null;

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
    console.error('[azureAuth] Failed to initialize user:', e);
    return null;
  }
}

export function getAuthorizedAdminEmails(): string[] {
  return ADMIN_USERS;
}
