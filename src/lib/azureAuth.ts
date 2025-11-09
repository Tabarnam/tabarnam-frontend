// Simple admin authentication for local development
// Uses localStorage to persist admin state
// In production, replace with Azure AD B2C or Microsoft Authentication Library (MSAL)

const ADMIN_USERS = [
  'duh@tabarnam.com',
  'admin@tabarnam.com'
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

export function loginAdmin(email: string, password: string): { success: boolean; error?: string } {
  // Simple validation - in production use Azure AD
  if (!email || !password) {
    return { success: false, error: 'Email and password are required' };
  }

  if (!ADMIN_USERS.includes(email)) {
    return { success: false, error: 'Email not authorized as admin' };
  }

  // For now, accept any password (replace with real auth)
  // In production, use Azure AD B2C or MSAL
  if (password.length < 4) {
    return { success: false, error: 'Password must be at least 4 characters' };
  }

  try {
    const token = `admin_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    localStorage.setItem(ADMIN_TOKEN_KEY, token);
    localStorage.setItem(ADMIN_EMAIL_KEY, email);
    return { success: true };
  } catch {
    return { success: false, error: 'Failed to save login state' };
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
