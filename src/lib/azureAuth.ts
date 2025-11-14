// Simple admin authentication for local development
// Uses localStorage to persist admin state
// In production, replace with Azure AD B2C or Microsoft Authentication Library (MSAL)

const ADMIN_USERS = [
  'jon@tabarnam.com',
  'ben@tabarnam.com',
  'kels@tabarnam.com'
];

const ADMIN_TOKEN_KEY = 'tabarnam_admin_token';
const ADMIN_EMAIL_KEY = 'tabarnam_admin_email';

export interface AdminUser {
  email: string;
  token: string;
}

export function isAdminLoggedIn(): boolean {
  try {
    const token = localStorage.getItem(ADMIN_TOKEN_KEY);
    const email = localStorage.getItem(ADMIN_EMAIL_KEY);
    return !!(token && email && ADMIN_USERS.includes(email));
  } catch {
    return false;
  }
}

export function getAdminUser(): AdminUser | null {
  try {
    const token = localStorage.getItem(ADMIN_TOKEN_KEY);
    const email = localStorage.getItem(ADMIN_EMAIL_KEY);
    if (token && email && ADMIN_USERS.includes(email)) {
      return { email, token };
    }
  } catch {}
  return null;
}

export async function loginAdmin(email: string, password: string): Promise<{ success: boolean; error?: string }> {
  if (!email || !password) {
    return { success: false, error: 'Email and password are required' };
  }
  if (!ADMIN_USERS.includes(email)) {
    return { success: false, error: 'Email not authorized as admin' };
  }
  try {
    const res = await fetch('/api/admin-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({} as any));
    if (!res.ok || !data?.success) {
      return { success: false, error: data?.error || 'Login failed' };
    }
    const token = String(data.token || '');
    if (!token) return { success: false, error: 'Missing token from server' };
    localStorage.setItem(ADMIN_TOKEN_KEY, token);
    localStorage.setItem(ADMIN_EMAIL_KEY, email);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e?.message || 'Network error' };
  }
}

export function logoutAdmin(): void {
  try {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    localStorage.removeItem(ADMIN_EMAIL_KEY);
  } catch {}
}

export function getAuthorizedAdminEmails(): string[] {
  return ADMIN_USERS;
}
