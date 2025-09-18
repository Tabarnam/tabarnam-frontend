// Simple admin detector for now.
// Set in your console once to test: localStorage.setItem('tab_admin', '1')
export function isAdmin(): boolean {
  try {
    // In the future, replace this with real role claims (e.g., from Azure AD/B2C).
    return localStorage.getItem('tab_admin') === '1';
  } catch {
    return false;
  }
}
