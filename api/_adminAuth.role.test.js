"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  requireRole,
  requireAdmin,
  adminGuard,
  contributorGuard,
  getContributorEmails,
} = require("./_adminAuth");

// The contributor tier.
//
// The load-bearing property: adding CONTRIBUTOR_EMAILS must NOT widen any
// existing endpoint. withAdminGuard still means admin, so the ~79 endpoints
// already wrapped in it stay closed to the new role. Only endpoints explicitly
// wrapped in withContributorGuard admit a contributor — and clearing that guard
// proves identity, never row access.

function principalReq(email) {
  const headers = new Headers();
  if (email) {
    const payload = JSON.stringify({ userDetails: email, userId: `${email}-oid` });
    headers.set("x-ms-client-principal", Buffer.from(payload, "utf-8").toString("base64"));
  }
  return { method: "GET", headers };
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

// Every test pins both lists and clears the dev bypass so nothing leaks in from
// the ambient environment.
function scenario(vars, fn) {
  return withEnv(
    {
      TABARNAM_DEV_BYPASS: undefined,
      ADMIN_EMAILS: "jon@tabarnam.com,ben@tabarnam.com",
      CONTRIBUTOR_EMAILS: undefined,
      ...vars,
    },
    fn
  );
}

test("dormant by default: no CONTRIBUTOR_EMAILS means no contributors", () => {
  scenario({}, () => {
    assert.deepEqual(getContributorEmails(), []);

    const decision = requireRole(principalReq("someone@example.com"));
    assert.equal(decision.ok, false);
    assert.equal(decision.role, null);
    assert.equal(decision.error, "not_admin");
  });
});

test("an empty CONTRIBUTOR_EMAILS setting admits nobody", () => {
  scenario({ CONTRIBUTOR_EMAILS: "   ,  , " }, () => {
    assert.deepEqual(getContributorEmails(), []);
    assert.equal(requireRole(principalReq("dana@tabarnam.com")).ok, false);
  });
});

test("a contributor resolves to the contributor role", () => {
  scenario({ CONTRIBUTOR_EMAILS: "dana@tabarnam.com" }, () => {
    const decision = requireRole(principalReq("dana@tabarnam.com"));
    assert.equal(decision.ok, true);
    assert.equal(decision.role, "contributor");
    assert.equal(decision.email, "dana@tabarnam.com");
  });
});

test("the list is case- and whitespace-insensitive", () => {
  scenario({ CONTRIBUTOR_EMAILS: "  Dana@Tabarnam.com , other@x.com " }, () => {
    assert.equal(requireRole(principalReq("DANA@TABARNAM.COM")).role, "contributor");
  });
});

test("an address on BOTH lists keeps admin — never silently downgraded", () => {
  scenario({ CONTRIBUTOR_EMAILS: "jon@tabarnam.com" }, () => {
    assert.equal(requireRole(principalReq("jon@tabarnam.com")).role, "admin");
    assert.equal(requireAdmin(principalReq("jon@tabarnam.com")).ok, true);
  });
});

test("REGRESSION GATE: a contributor is not an admin", () => {
  scenario({ CONTRIBUTOR_EMAILS: "dana@tabarnam.com" }, () => {
    const auth = requireAdmin(principalReq("dana@tabarnam.com"));
    assert.equal(auth.ok, false, "contributors must fail the admin decision");
    assert.equal(auth.error, "not_admin");
    assert.equal(auth.email, "dana@tabarnam.com", "the email still surfaces for logging");
  });
});

test("REGRESSION GATE: adminGuard rejects a contributor with 403", () => {
  scenario({ CONTRIBUTOR_EMAILS: "dana@tabarnam.com" }, () => {
    const res = adminGuard(principalReq("dana@tabarnam.com"), { log() {} });
    assert.ok(res, "the guard must produce a rejection response");
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.body).auth_error, "not_admin");
  });
});

test("adminGuard still admits an admin and attaches identity", () => {
  scenario({}, () => {
    const req = principalReq("ben@tabarnam.com");
    assert.equal(adminGuard(req, { log() {} }), null);
    assert.equal(req.__admin_email, "ben@tabarnam.com");
    assert.equal(req.__actor_email, "ben@tabarnam.com");
    assert.equal(req.__role, "admin");
  });
});

test("contributorGuard admits a contributor and attaches identity + role", () => {
  scenario({ CONTRIBUTOR_EMAILS: "dana@tabarnam.com" }, () => {
    const req = principalReq("dana@tabarnam.com");
    assert.equal(contributorGuard(req, { log() {} }), null);
    assert.equal(req.__role, "contributor", "downstream scoping keys off this");
    assert.equal(req.__actor_email, "dana@tabarnam.com");
    assert.equal(
      req.__admin_email,
      "dana@tabarnam.com",
      "the legacy attribution field is populated so edits are not left unattributed"
    );
  });
});

test("contributorGuard admits an admin too", () => {
  scenario({ CONTRIBUTOR_EMAILS: "dana@tabarnam.com" }, () => {
    const req = principalReq("jon@tabarnam.com");
    assert.equal(contributorGuard(req, { log() {} }), null);
    assert.equal(req.__role, "admin");
  });
});

test("contributorGuard rejects someone on neither list with 403", () => {
  scenario({ CONTRIBUTOR_EMAILS: "dana@tabarnam.com" }, () => {
    const res = contributorGuard(principalReq("stranger@example.com"), { log() {} });
    assert.equal(res.status, 403);
  });
});

test("no principal is 401, not 403 — an expired session is recoverable", () => {
  scenario({ CONTRIBUTOR_EMAILS: "dana@tabarnam.com" }, () => {
    assert.equal(adminGuard(principalReq(null), { log() {} }).status, 401);
    assert.equal(contributorGuard(principalReq(null), { log() {} }).status, 401);
  });
});

test("internal jobs and local dev resolve to admin, not to a scoped role", () => {
  scenario({ TABARNAM_DEV_BYPASS: "1" }, () => {
    const decision = requireRole(principalReq(null));
    assert.equal(decision.ok, true);
    assert.equal(decision.role, "admin", "background work must not be owner-scoped");
  });
});
