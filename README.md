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

## Azure Functions Deployment

### Flex Consumption Plan

The backend is deployed on Azure Functions Flex Consumption plan. The following deployment constraints apply:

**Publishing profiles are not supported.** Use one of these alternatives:

1. **GitHub Actions**: Deploy via CI/CD pipeline using workflow files.
2. **Function Keys**: Use function-level keys for direct deployments.
3. **Static Web Apps (SWA) Linked Backend**: Link the SWA resource to the Function App via `linkedBackend.json`.

### Verifying SWA Linked Backend Configuration

If the SWA linked backend configuration becomes stale or misconfigured, requests to `/api/*` may route to the wrong Function App.

**To verify and fix the linked backend configuration:**

1. List the current linked backend configuration:
   ```bash
   az staticwebapp linked-backend list --resource-group tabarnam-mvp-rg --name tabarnam-frontend-v2
   ```

2. Compare the output `backendResourceId` with the current Function App resource ID in your subscription:
   - Primary backend: `tabarnam-xai-dedicated`
   - External API backend: `tabarnam-xai-externalapi`

3. If the linked backend is stale, update it:
   ```bash
   az staticwebapp linked-backend link --resource-group tabarnam-mvp-rg --name tabarnam-frontend-v2 --backend-resource-id /subscriptions/{SUBSCRIPTION_ID}/resourceGroups/tabarnam-mvp-rg/providers/Microsoft.Web/sites/{FUNCTION_APP_NAME}
   ```

4. **Verify the route was linked correctly:** Open the browser console and check the **Backend Ping** diagnostic output. It shows which Function App is actually serving `/api` requests.
   - Look for: `[Backend Ping] Successfully identified backend`
   - Compare the `Backend Name` with your expected Function App name (e.g., `tabarnam-xai-dedicated` or `tabarnam-xai-externalapi`)
