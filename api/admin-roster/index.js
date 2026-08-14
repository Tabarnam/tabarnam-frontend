// GET /api/xadmin-api-roster — the admin allowlist, served to the admin UI.
//
// Single source of truth for "who is an admin": api/_adminAuth.js
// (ADMIN_EMAILS app setting, else its fallback array). The frontend fetches
// this roster instead of keeping its own hardcoded copy, so adding an admin in
// ONE place (the app setting, or _adminAuth's fallback) makes every
// admin-facing control — owner dropdowns, person filter, the admin route gate —
// pick them up with no frontend change.
//
// Contributor-guarded rather than admin-guarded: a contributor needs this to
// pass the frontend's /admin route gate and to learn its own role. The response
// carries no company data — only who works here — and is still closed to anyone
// on neither list.

const { app, hasRoute } = require("../_app");
const {
  getAdminEmails,
  getContributorEmails,
  withContributorGuard,
} = require("../_adminAuth");
const { getBuildInfo } = require("../_buildInfo");

const BUILD_INFO = getBuildInfo();

function json(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-functions-key",
    },
    body: JSON.stringify(obj),
  };
}

async function handler(req) {
  const method = String(req?.method || "GET").toUpperCase();
  if (method === "OPTIONS") return json({ ok: true });
  if (method !== "GET") return json({ ok: false, error: "Method not allowed" }, 405);

  const clean = (list) =>
    list.map((e) => String(e || "").trim().toLowerCase()).filter(Boolean);

  const admins = clean(getAdminEmails());

  // `admins` stays the owner/person dropdown source — companies are assigned to
  // staff, and a contributor must not be able to hand work to themselves.
  // `contributors` is separate so the UI can gate the /admin route on the union
  // without polluting those dropdowns.
  //
  // `role` lets the UI hide controls the caller can't use. It is a display hint
  // ONLY — every restriction is enforced server-side, so a tampered client
  // gains nothing beyond seeing buttons that return 403.
  return json({
    ok: true,
    admins,
    contributors: clean(getContributorEmails()),
    me: String(req?.__admin_email || "").trim().toLowerCase() || null,
    role: String(req?.__role || "").trim() || null,
    build_id: String(BUILD_INFO.build_id || ""),
  });
}

const ROUTE = "xadmin-api-roster";
if (!hasRoute(ROUTE)) {
  app.http("xadminApiRoster", {
    route: ROUTE,
    methods: ["GET", "OPTIONS"],
    authLevel: "anonymous",
    handler: withContributorGuard(handler),
  });
}

module.exports = { handler };
module.exports._test = { handler };
