/**
 * Admin authentication guard for API endpoints.
 *
 * Uses Azure Static Web Apps' x-ms-client-principal header to identify
 * the caller, then checks the email against a list of admin users.
 *
 * Bypasses:
 *  - Internal job requests (resume-worker, queue-triggered) via _internalJobAuth
 *  - Local dev when TABARNAM_DEV_BYPASS=1
 */

const { isInternalJobRequest } = require("./_internalJobAuth");

// ── Admin email list ────────────────────────────────────────────────
// Env var takes precedence so the list can be updated without redeploying.
// Fallback matches src/lib/azureAuth.ts.
// NOTE: duh@tabarnam.com is a shared notification inbox (contact-send /
// review-queue recipient), NOT a person — intentionally excluded from admin.
const FALLBACK_ADMIN_EMAILS = [
  "jon@tabarnam.com",
  "ben@tabarnam.com",
  "kels@tabarnam.com",
];

function parseEmailList(raw) {
  return String(raw || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function getAdminEmails() {
  const envList = (process.env.ADMIN_EMAILS || "").trim();
  if (envList) return parseEmailList(envList);
  return FALLBACK_ADMIN_EMAILS;
}

// ── Contributor email list ──────────────────────────────────────────
// A scoped, lower-privilege role for outside help: may work only on the
// companies they own, and only through the endpoints explicitly wrapped in
// withContributorGuard. Everything else — the whole existing surface — stays
// admin-only, because withAdminGuard rejects this role.
//
// There is deliberately NO fallback list. Contributors exist only when the
// CONTRIBUTOR_EMAILS app setting names them, so with the setting unset the tier
// is dormant and behavior is identical to before it existed. Removing an email
// from the setting is the immediate kill switch (disabling the Entra account
// does not invalidate a live SWA session).
function getContributorEmails() {
  return parseEmailList(process.env.CONTRIBUTOR_EMAILS);
}

// ── Local dev bypass ────────────────────────────────────────────────
function isLocalDev() {
  return process.env.TABARNAM_DEV_BYPASS === "1";
}

// ── Decode Azure SWA x-ms-client-principal ──────────────────────────
function decodeClientPrincipal(req) {
  let headerValue = "";
  try {
    headerValue = req?.headers?.get
      ? String(req.headers.get("x-ms-client-principal") || "").trim()
      : "";
  } catch {
    return null;
  }
  if (!headerValue) return null;

  try {
    const decoded = Buffer.from(headerValue, "base64").toString("utf-8");
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function extractEmail(principal) {
  // Primary: userDetails (this is what the frontend reads in azureAuth.ts)
  if (principal.userDetails) {
    return String(principal.userDetails).trim().toLowerCase();
  }

  // Fallback: search claims array for email claim types
  if (Array.isArray(principal.claims)) {
    const emailClaim = principal.claims.find(
      (c) =>
        c.typ ===
          "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress" ||
        c.typ === "preferred_username" ||
        c.typ === "email",
    );
    if (emailClaim?.val) return String(emailClaim.val).trim().toLowerCase();
  }

  return null;
}

// ── Core auth decision ──────────────────────────────────────────────
/**
 * Identify the caller and their role.
 *
 * Returns { ok, email, role, method, error } where role is "admin" |
 * "contributor" | null. Does NOT send HTTP responses — callers decide how to
 * respond.
 *
 * Internal-job and local-dev callers resolve to "admin": workers and queue
 * triggers act on the whole catalog by design, and gating them behind an
 * owner-scoped role would break every background job.
 */
function requireRole(req) {
  // 1. Internal job bypass (resume-worker, queue triggers)
  if (isInternalJobRequest(req)) {
    return { ok: true, email: null, role: "admin", method: "internal_job", error: null };
  }

  // 2. Local dev bypass
  if (isLocalDev()) {
    return { ok: true, email: "dev@localhost", role: "admin", method: "local_dev", error: null };
  }

  // 3. Decode x-ms-client-principal
  const principal = decodeClientPrincipal(req);
  if (!principal) {
    return { ok: false, email: null, role: null, method: null, error: "missing_auth" };
  }

  // 4. Extract email
  const email = extractEmail(principal);
  if (!email) {
    return {
      ok: false,
      email: null,
      role: null,
      method: "swa_principal",
      error: "no_email_in_principal",
    };
  }

  // 5. Resolve role. Admin is checked FIRST so an address that appears on both
  //    lists keeps full privileges rather than being silently downgraded.
  const lower = email.toLowerCase();

  if (getAdminEmails().includes(lower)) {
    return { ok: true, email: lower, role: "admin", method: "swa_principal", error: null };
  }

  if (getContributorEmails().includes(lower)) {
    return { ok: true, email: lower, role: "contributor", method: "swa_principal", error: null };
  }

  return { ok: false, email: lower, role: null, method: "swa_principal", error: "not_admin" };
}

/**
 * Returns { ok, email, method, error }.
 *
 * Admin-only decision, kept at its original call signature and return shape —
 * every existing endpoint depends on it. A contributor is NOT an admin here and
 * is rejected with "not_admin", which is what keeps the entire pre-existing
 * surface closed to the new role by default.
 */
function requireAdmin(req) {
  const decision = requireRole(req);

  if (decision.ok && decision.role === "admin") {
    return { ok: true, email: decision.email, method: decision.method, error: null };
  }

  return {
    ok: false,
    email: decision.email,
    method: decision.method,
    error: decision.ok ? "not_admin" : decision.error,
  };
}

// ── Convenience guard ───────────────────────────────────────────────
// Standard CORS headers matching existing endpoint patterns.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, x-functions-key, x-request-id, x-correlation-id, x-session-id",
};

/**
 * Shared guard body. Returns null when the caller holds one of `allowedRoles`
 * (proceed), or a ready-to-use HTTP response when they don't.
 */
function roleGuard(req, context, allowedRoles) {
  const decision = requireRole(req);
  const passed = decision.ok && allowedRoles.includes(decision.role);

  if (passed) {
    try {
      if (req) {
        req.__role = decision.role;
        if (decision.email) {
          // __admin_email is the long-standing name endpoints read for audit
          // attribution — keep it populated for whoever cleared the guard, so
          // a contributor's edits are attributed rather than landing blank.
          req.__admin_email = decision.email;
          req.__actor_email = decision.email;
        }
      }
    } catch {}
    return null; // No error — proceed
  }

  // Authenticated but holding the wrong role is a 403, same as being on no
  // list at all. Only a missing/undecodable principal is a 401.
  const error = decision.ok ? "not_admin" : decision.error;
  const status = error === "not_admin" ? 403 : 401;
  const message =
    error === "not_admin"
      ? "Forbidden: not an authorized admin"
      : "Unauthorized: admin authentication required";

  // Log the rejection
  try {
    const logFn =
      typeof context?.log === "function" ? context.log : console.log;
    logFn(
      JSON.stringify({
        stage: "admin_auth",
        kind: "rejected",
        status,
        error,
        method: decision.method,
        role: decision.role || null,
        allowed: allowedRoles,
      }),
    );
  } catch {}

  return {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    body: JSON.stringify({ error: message, auth_error: error }),
  };
}

/**
 * Call at the top of a handler (after OPTIONS check).
 * Returns null on success (proceed), or a ready-to-use HTTP response on failure.
 */
function adminGuard(req, context) {
  return roleGuard(req, context, ["admin"]);
}

/**
 * Admin-or-contributor variant. Clearing this guard means only that the caller
 * is a known person — it says NOTHING about which rows they may touch. Every
 * endpoint wrapped in it must additionally scope its reads and writes to
 * `req.__actor_email` when `req.__role === "contributor"`.
 */
function contributorGuard(req, context) {
  return roleGuard(req, context, ["admin", "contributor"]);
}

/**
 * Wrap an Azure Functions v4 handler so every non-OPTIONS request must pass
 * adminGuard() before the handler runs. OPTIONS (CORS preflight) is passed
 * straight through to the handler's own CORS response — preflight carries no
 * principal, so guarding it would break CORS.
 *
 * Usage in app.http registration:
 *   handler: require("../_adminAuth").withAdminGuard(myHandler)
 *
 * adminGuard's triple bypass (internal-job secret / TABARNAM_DEV_BYPASS /
 * admin x-ms-client-principal) means workers, local dev, and the logged-in
 * admin UI all continue to work unchanged.
 */
function withAdminGuard(handler) {
  return async function guardedHandler(req, context) {
    let method = "";
    try {
      method = String(req?.method || "").toUpperCase();
    } catch {}
    if (method !== "OPTIONS") {
      const authError = adminGuard(req, context);
      if (authError) return authError;
    }
    return handler(req, context);
  };
}

/**
 * Wrap a handler so every non-OPTIONS request must be an admin OR a
 * contributor. Same OPTIONS pass-through as withAdminGuard.
 *
 * Use this ONLY on endpoints that enforce owner scoping themselves. Wrapping an
 * endpoint that operates on the whole catalog (the backfill workers, the
 * rebuild jobs, the cleanup endpoints) would hand a contributor the catalog,
 * because there is no row to scope those to.
 */
function withContributorGuard(handler) {
  return async function guardedHandler(req, context) {
    let method = "";
    try {
      method = String(req?.method || "").toUpperCase();
    } catch {}
    if (method !== "OPTIONS") {
      const authError = contributorGuard(req, context);
      if (authError) return authError;
    }
    return handler(req, context);
  };
}

module.exports = {
  requireAdmin,
  requireRole,
  adminGuard,
  contributorGuard,
  withAdminGuard,
  withContributorGuard,
  decodeClientPrincipal,
  getAdminEmails,
  getContributorEmails,
  isLocalDev,
};
