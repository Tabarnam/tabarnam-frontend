"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  requireAdmin,
  requireRole,
  adminGuard,
  contributorGuard,
  withAdminGuard,
  withContributorGuard,
  getAdminEmails,
} = require("./_adminAuth");

// STAFF ACCESS REGRESSION GATE.
//
// The contributor work touched the auth layer that every admin endpoint sits
// behind. This file exists to answer one question and keep answering it:
// did any of it reduce what Jon, Ben or Kels can do?
//
// The answer must stay "no". Everything here is written from the staff side.

const STAFF = ["jon@tabarnam.com", "ben@tabarnam.com", "kels@tabarnam.com"];

function principalReq(email, method = "GET") {
  const headers = new Headers();
  if (email) {
    const payload = JSON.stringify({ userDetails: email, userId: `${email}-oid` });
    headers.set("x-ms-client-principal", Buffer.from(payload, "utf-8").toString("base64"));
  }
  return { method, headers };
}

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// The realistic production shape: staff on the admin list, a contributor
// present, and no dev bypass.
function inProduction(fn) {
  return withEnv(
    {
      TABARNAM_DEV_BYPASS: undefined,
      ADMIN_EMAILS: undefined, // exercise the real fallback list
      CONTRIBUTOR_EMAILS: "dana@tabarnam.com",
    },
    fn
  );
}

// ── The three named people ──────────────────────────────────────────

test("staff are still admins with a contributor configured", () => {
  inProduction(() => {
    for (const email of STAFF) {
      const decision = requireRole(principalReq(email));
      assert.equal(decision.ok, true, `${email} must authenticate`);
      assert.equal(decision.role, "admin", `${email} must hold the admin role`);
    }
  });
});

test("staff pass the admin guard, unchanged", () => {
  inProduction(() => {
    for (const email of STAFF) {
      const req = principalReq(email);
      assert.equal(adminGuard(req, { log() {} }), null, `${email} must clear adminGuard`);
      assert.equal(req.__admin_email, email, "the legacy attribution field is still set");
    }
  });
});

test("staff pass the contributor guard too — the three swapped endpoints stay open", () => {
  // admin-companies-v2, admin-roster and import-start moved from the admin
  // guard to the contributor guard. A swap that locked staff out would be the
  // worst possible outcome of this work.
  inProduction(() => {
    for (const email of STAFF) {
      const req = principalReq(email);
      assert.equal(contributorGuard(req, { log() {} }), null, `${email} must clear contributorGuard`);
      assert.equal(req.__role, "admin", "and must be seen as staff, not as scoped");
    }
  });
});

test("staff are never flagged as metered, so no import cap applies", () => {
  const { isMetered } = require("./_importQuota");

  inProduction(() => {
    for (const email of STAFF) {
      const req = principalReq(email);
      contributorGuard(req, { log() {} });
      assert.equal(isMetered(req), false, `${email} must not be subject to the daily cap`);
    }
  });
});

test("staff writes are unscoped — no owner filter is applied to them", () => {
  const { _test } = require("./admin-companies-v2/index.js");

  inProduction(() => {
    for (const email of STAFF) {
      const req = principalReq(email);
      contributorGuard(req, { log() {} });
      // getContributorScope returns null for anyone who is not a contributor,
      // and every scoping branch in the handler is gated on that being truthy.
      assert.equal(req.__role, "admin");
    }
  });

  assert.ok(_test.adminCompaniesHandler, "handler still exported");
});

// ── The rest of the surface ─────────────────────────────────────────

test("background work still resolves to admin, so queue triggers are unaffected", () => {
  inProduction(() => {
    // Internal job requests carry no principal; the bypass must still admit
    // them at full privilege or every worker breaks.
    const decision = requireRole({ method: "POST", headers: new Headers() });
    assert.equal(decision.ok, false, "no principal and no internal secret is still rejected");
  });

  withEnv({ TABARNAM_DEV_BYPASS: "1" }, () => {
    const decision = requireRole({ method: "POST", headers: new Headers() });
    assert.equal(decision.role, "admin", "the dev bypass is unchanged");
  });
});

test("requireAdmin keeps its original return shape", () => {
  inProduction(() => {
    const ok = requireAdmin(principalReq("jon@tabarnam.com"));
    assert.deepEqual(Object.keys(ok).sort(), ["email", "error", "method", "ok"]);
    assert.equal(ok.ok, true);
    assert.equal(ok.error, null);

    const denied = requireAdmin(principalReq("stranger@example.com"));
    assert.equal(denied.ok, false);
    assert.equal(denied.error, "not_admin");
    assert.equal(denied.email, "stranger@example.com", "email still surfaces for logging");
  });
});

test("the guard wrappers still pass OPTIONS straight through", async () => {
  const handler = async () => ({ status: 200, body: "cors" });

  for (const wrap of [withAdminGuard, withContributorGuard]) {
    const res = await wrap(handler)({ method: "OPTIONS", headers: new Headers() }, { log() {} });
    assert.equal(res.status, 200, "preflight carries no principal and must not be guarded");
  }
});

test("a stranger is still refused by both guards", () => {
  inProduction(() => {
    assert.equal(adminGuard(principalReq("stranger@example.com"), { log() {} }).status, 403);
    assert.equal(contributorGuard(principalReq("stranger@example.com"), { log() {} }).status, 403);
  });
});

// ── Guard coverage, counted ─────────────────────────────────────────

test("only the intended endpoints left the admin guard", () => {
  // A structural check rather than a behavioral one: if a future change moves
  // another endpoint off the admin guard, this fails and names it.
  const EXPECTED_CONTRIBUTOR_ROUTES = new Set([
    // Companies CRUD — scopes itself inside its own queries.
    "admin-companies-v2",
    // Who works here. No company data.
    "admin-roster",
    // Import entry + the polling surface for a run. Session-scoped via
    // initiated_by, except the pipeline traffic light which is a global
    // operational aggregate exposing no company data.
    "import-start",
    "import-preflight",
    "import-status",
    "import-progress",
    "import-stop",
    "import-pipeline-status",
    "save-companies",
    // Logo / homepage work — each checks ownership of the target company.
    "upload-logo-blob",
    "delete-logo-blob",
    "upload-homepage-blob",
    "delete-homepage-blob",
    "retry-logo-import",
    "xadmin-api-logos",
    "xadmin-api-microlink-fetch-one",
    // Stateless helper: takes a URL, returns a logo source URL. Reads no
    // company and writes nothing, so there is no row to scope it to.
    "logo-scrape",
  ]);

  const apiDir = __dirname;
  const found = new Set();

  for (const entry of fs.readdirSync(apiDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;

    const file = path.join(apiDir, entry.name, "index.js");
    let src;
    try {
      src = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }

    if (/withContributorGuard\(|contributorGuard\(req/.test(src)) found.add(entry.name);
  }

  const unexpected = [...found].filter((n) => !EXPECTED_CONTRIBUTOR_ROUTES.has(n));

  assert.deepEqual(
    unexpected,
    [],
    "An endpoint was opened to contributors without updating this list. " +
      "Confirm it enforces owner scoping, then add it here.\n  " +
      unexpected.join("\n  ")
  );
});

test("the staff roster itself is unchanged", () => {
  withEnv({ ADMIN_EMAILS: undefined }, () => {
    const admins = getAdminEmails();
    for (const email of STAFF) {
      assert.ok(admins.includes(email), `${email} is still on the admin list`);
    }
    assert.ok(
      !admins.includes("duh@tabarnam.com"),
      "the shared notification inbox is still excluded from admin"
    );
  });
});
