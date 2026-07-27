// GET /api/xadmin-api-roster — the admin allowlist, served to the admin UI.
//
// Single source of truth for "who is an admin": api/_adminAuth.js
// (ADMIN_EMAILS app setting, else its fallback array). The frontend fetches
// this roster instead of keeping its own hardcoded copy, so adding an admin in
// ONE place (the app setting, or _adminAuth's fallback) makes every
// admin-facing control — owner dropdowns, person filter, the admin route gate —
// pick them up with no frontend change.
//
// Admin-guarded: the roster is only visible to someone already on it.

const { app, hasRoute } = require("../_app");
const { getAdminEmails, withAdminGuard } = require("../_adminAuth");
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

  const admins = getAdminEmails()
    .map((e) => String(e || "").trim().toLowerCase())
    .filter(Boolean);

  return json({
    ok: true,
    admins,
    me: String(req?.__admin_email || "").trim().toLowerCase() || null,
    build_id: String(BUILD_INFO.build_id || ""),
  });
}

const ROUTE = "xadmin-api-roster";
if (!hasRoute(ROUTE)) {
  app.http("xadminApiRoster", {
    route: ROUTE,
    methods: ["GET", "OPTIONS"],
    authLevel: "anonymous",
    handler: withAdminGuard(handler),
  });
}

module.exports = { handler };
module.exports._test = { handler };
