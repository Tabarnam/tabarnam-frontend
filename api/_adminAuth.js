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

function getAdminEmails() {
  const envList = (process.env.ADMIN_EMAILS || "").trim();
  if (envList) {
    return envList
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
  }
  return FALLBACK_ADMIN_EMAILS;
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
 * Returns { ok, email, method, error }.
 * Does NOT send HTTP responses — callers decide how to respond.
 */
function requireAdmin(req) {
  // 1. Internal job bypass (resume-worker, queue triggers)
  if (isInternalJobRequest(req)) {
    return { ok: true, email: null, method: "internal_job", error: null };
  }

  // 2. Local dev bypass
  if (isLocalDev()) {
    return { ok: true, email: "dev@localhost", method: "local_dev", error: null };
  }

  // 3. Decode x-ms-client-principal
  const principal = decodeClientPrincipal(req);
  if (!principal) {
    return { ok: false, email: null, method: null, error: "missing_auth" };
  }

  // 4. Extract email
  const email = extractEmail(principal);
  if (!email) {
    return {
      ok: false,
      email: null,
      method: "swa_principal",
      error: "no_email_in_principal",
    };
  }

  // 5. Check admin list
  const adminEmails = getAdminEmails();
  if (!adminEmails.includes(email.toLowerCase())) {
    return { ok: false, email, method: "swa_principal", error: "not_admin" };
  }

  return { ok: true, email, method: "swa_principal", error: null };
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
 * Call at the top of a handler (after OPTIONS check).
 * Returns null on success (proceed), or a ready-to-use HTTP response on failure.
 */
function adminGuard(req, context) {
  const auth = requireAdmin(req);

  if (auth.ok) {
    // Attach email for downstream logging
    try {
      if (req && auth.email) req.__admin_email = auth.email;
    } catch {}
    return null; // No error — proceed
  }

  const status = auth.error === "not_admin" ? 403 : 401;
  const message =
    auth.error === "not_admin"
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
        error: auth.error,
        method: auth.method,
      }),
    );
  } catch {}

  return {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    body: JSON.stringify({ error: message, auth_error: auth.error }),
  };
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

module.exports = {
  requireAdmin,
  adminGuard,
  withAdminGuard,
  decodeClientPrincipal,
  getAdminEmails,
  isLocalDev,
};
