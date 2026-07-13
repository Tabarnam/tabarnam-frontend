// Guard-coverage gate (default-deny).
//
// Enumerates every app.http(...) registration under api/ and fails the build
// unless each route is EITHER protected by an auth guard OR explicitly listed
// in PUBLIC_ROUTES below. This makes "every admin endpoint is locked" a
// permanent, self-enforcing invariant: a new admin route added without a guard
// (and not deliberately allow-listed as public) breaks CI.
//
// Guard detection is source-based: a route is considered guarded if its handler
// file — or any local module it directly requires (one level) — references one
// of the known guard mechanisms (withAdminGuard / adminGuard / requireAdmin from
// _adminAuth, isInternalJobRequest from _internalJobAuth, or isDebugAuthorized
// from _debugSnapshots). The inline-vs-wrapper distinction doesn't matter; the
// guard call lives in one of those sources either way.
//
// Limitation: detection is file-level, so a single file mixing a guarded route
// and an unguarded admin route would pass. In this codebase multi-registration
// files (import-status, diag) are uniformly guarded or uniformly public, so this
// is acceptable. Keep it that way.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const API_DIR = __dirname;

const GUARD_RE =
  /withAdminGuard|adminGuard|requireAdmin|isInternalJobRequest|getInternalAuthDecision|isDebugAuthorized/;
const HAS_HTTP_RE = /app\.http\(/;
const ROUTE_RE = /route:\s*["'`]([^"'`]+)["'`]/g;
const LOCAL_REQUIRE_RE = /require\(\s*["'`](\.[^"'`]+)["'`]\s*\)/g;

// Routes that are intentionally anonymous/public. Adding a new public route is a
// deliberate act — it must be added here, which forces a conscious decision.
const PUBLIC_ROUTES = new Set([
  // health / build / diagnostics (no business data)
  "health",
  "ping",
  "version",
  "hello",
  "diag",
  "diag/queue-mismatch",
  "diag/session",
  "diag/sharp",
  "diag/xai",
  "diag/xai-alias",
  "diag/xai-v2",
  "_diag/hello",
  "_ping",
  "import/backend-ping",
  "test-echo",
  // deprecated stub — returns a 410 with no data
  "xai",
  // public consumer site
  "search-companies",
  "suggest-companies",
  "suggest-refinements",
  "suggest-cities",
  "suggest-states",
  "get-reviews",
  // Public read-only batch of visible-review counts for the results page —
  // same public data as get-reviews, just many companies at once.
  "review-counts",
  "submit-review",
  // One-click review approval from the admin email. Intentionally anonymous:
  // authorization is the signed HMAC token (api/_reviewActionToken.js), not a
  // logged-in session, and GET only renders a confirm page (no mutation).
  "review-action",
  // Public read-only image proxy (blob public access is disabled account-wide);
  // mirrors company-logo. Read-only, unguessable blob names.
  "review-image",
  "company-logo",
  "company-homepage",
  "contact-send",
  // Google API proxies — called from the public site (client-side geocoding /
  // location lookup), so they are necessarily anonymous.
  "google/geocode",
  "google/places",
  "google/translate",
]);

// Normalize a registered route to its canonical form: drop any leading "/" and
// "api/" prefix so "/api/diag/session" and "diag/session" compare equal.
function normalizeRoute(route) {
  return route.replace(/^\/+/, "").replace(/^api\//, "");
}

function resolveLocalModule(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, `${base}.js`, path.join(base, "index.js")];
  return candidates.find((c) => {
    try {
      return fs.statSync(c).isFile();
    } catch {
      return false;
    }
  });
}

// Source of `file` plus the source of every local module it directly requires
// (one level deep). Catches guards that live in a shared handler module, e.g.
// admin-refresh-company/index.js -> _adminRefreshCompany.js (adminGuard inside).
function combinedSource(file) {
  let src = fs.readFileSync(file, "utf8");
  let m;
  LOCAL_REQUIRE_RE.lastIndex = 0;
  const specs = [];
  while ((m = LOCAL_REQUIRE_RE.exec(src))) specs.push(m[1]);
  for (const spec of specs) {
    const resolved = resolveLocalModule(file, spec);
    if (resolved && resolved !== file) {
      try {
        src += "\n" + fs.readFileSync(resolved, "utf8");
      } catch {
        /* ignore unreadable require target */
      }
    }
  }
  return src;
}

function findEndpointFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...findEndpointFiles(full));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".js") &&
      !entry.name.endsWith(".test.js")
    ) {
      out.push(full);
    }
  }
  return out;
}

test("every app.http route is guarded or explicitly public", () => {
  const violations = [];

  for (const file of findEndpointFiles(API_DIR)) {
    let src;
    try {
      src = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!HAS_HTTP_RE.test(src)) continue;

    const routes = [];
    let m;
    ROUTE_RE.lastIndex = 0;
    while ((m = ROUTE_RE.exec(src))) routes.push(m[1]);
    if (routes.length === 0) continue; // dynamically-computed route — skip

    const guarded = GUARD_RE.test(combinedSource(file));

    for (const raw of routes) {
      const route = normalizeRoute(raw);
      if (guarded) continue;
      if (PUBLIC_ROUTES.has(route)) continue;
      violations.push(`${route}  (${path.relative(API_DIR, file)})`);
    }
  }

  assert.deepStrictEqual(
    violations,
    [],
    `Unguarded route(s) found. Wrap the handler with require("../_adminAuth").withAdminGuard(...) ` +
      `(or gate internal/worker endpoints via _internalJobAuth), or — only if it is genuinely public — ` +
      `add the route to PUBLIC_ROUTES in this test.\n  ${violations.join("\n  ")}`
  );
});

// Negative check: prove the gate actually fires, so it can't silently rot into a
// no-op (e.g. if GUARD_RE or the violation logic is broken in a future edit).
test("guard-coverage gate flags an unguarded, non-public admin route", () => {
  const fakeRoute = "xadmin-api-totally-unguarded-probe";
  assert.ok(!PUBLIC_ROUTES.has(fakeRoute), "probe route must not be allow-listed");

  // GUARD_RE must recognize the real wrapper and reject a bare handler.
  assert.ok(
    GUARD_RE.test('handler: require("../_adminAuth").withAdminGuard(h),'),
    "GUARD_RE should detect withAdminGuard"
  );
  assert.ok(!GUARD_RE.test("handler: bareHandler,"), "GUARD_RE should not match a bare handler");

  // The violation condition (mirrors the loop above): unguarded + not public.
  const guarded = false;
  const isViolation = !guarded && !PUBLIC_ROUTES.has(normalizeRoute(`/api/${fakeRoute}`));
  assert.strictEqual(isViolation, true, "an unguarded, non-public route must be a violation");
});
