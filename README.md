# tabarnam-frontend

## Microsoft Entra ID (Azure AD) SSO

This app uses Azure Static Web Apps built-in auth with Microsoft Entra ID for the admin area.

### Login flow
- Users visit /admin (or any protected page).
- If unauthenticated, AdminRoute redirects to `/.auth/login/aad` with `post_login_redirect_uri` set to the originally requested path (including query parameters).
- After successful sign-in, SWA redirects back to that path.
- A lightweight keep-alive runs sitewide and pings `/.auth/me` every 5 minutes (and on focus/online) to reduce idle sign-outs.

### Error handling
- If Microsoft returns `?error=` or `?error_description=` to /login, the page shows a concise error and a retry button.

### Route protection and roles
- `public/staticwebapp.config.json` protects:
  - `/admin` and `/admin/*` with `allowedRoles: ["authenticated", "admin"]`
  - `/bulk-import` with `allowedRoles: ["admin"]`
- To use the `admin` role based on an Entra group:
  1. Create an Entra security group (e.g., "Tabarnam Admins"). Add the appropriate users.
  2. In Azure Portal → Static Web Apps → Your app → Authentication → Roles: add a role named `admin` and assign the Entra group (by object ID).
  3. Save. Users in that group will receive the `admin` role claim.
  4. Optionally tighten `/bulk-import` to also require `admin` by mirroring the `/admin/*` rule if desired.

### Local and preview environments
- In non-SWA environments, AdminRoute allows access to keep pages usable for local development.
- Ensure the following callback/logout URLs are permitted (SWA handles callbacks internally):
  - `/.auth/login/aad` (auto-managed)
  - `/.auth/logout`

### Testing checklist
1. Sign-in
   - Navigate to `/login?next=/admin/xai-bulk-import?foo=bar`.
   - Click "Sign in with Microsoft".
   - Verify redirect lands on `/admin/xai-bulk-import?foo=bar`.
2. Role gating
   - User in `admin` group: confirm access to `/admin/*`.
   - User not in `admin` group: confirm access still allowed via `authenticated` (or tighten config as needed).
3. Keep-alive
   - Stay on a page >10 minutes; verify you remain signed in (opening DevTools Network: periodic `/.auth/me` requests are visible).
4. Error path
   - Manually visit `/login?error=access_denied&error_description=Denied` and see error banner.
5. API sanity
   - Call `/api/ping` and verify JSON: `{ ok: true, name: "ping", ts: "..." }`.
6. MIME check
   - Build produces `public/staticwebapp.config.json` with required mimeTypes. No JS MIME errors should appear in the browser console.

### Notes
- Post-login redirect on /login honors `?next=` or `?returnTo=` (defaults to `/admin`).
- Logout uses `/.auth/logout?post_logout_redirect_uri=/login`.
