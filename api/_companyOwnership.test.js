"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { assertCompanyAccess, assertSessionAccess, isScoped } = require("./_companyOwnership");

// Row-level authorization for the satellite endpoints — logo upload, homepage
// capture, logo retry, import status.
//
// Three properties carry the weight:
//   1. Admins short-circuit with NO Cosmos read. Staff are unscoped, and adding
//      a lookup to their path would slow every admin action to answer a
//      question whose answer is already known.
//   2. Refusals are 404, never 403. Otherwise these endpoints become an
//      existence oracle: probe ids, read the status code, learn what exists.
//   3. It fails CLOSED. "We couldn't check" must never mean "allowed".

const DANA = "dana@tabarnam.com";
const JON = "jon@tabarnam.com";

function contributorReq(email = DANA) {
  return { __role: "contributor", __actor_email: email, __admin_email: email };
}

function adminReq(email = JON) {
  return { __role: "admin", __actor_email: email, __admin_email: email };
}

function makeContainer(docs = []) {
  let queries = 0;
  return {
    get queries() {
      return queries;
    },
    items: {
      query(spec) {
        queries++;
        const id = spec.parameters?.find((p) => p.name === "@id")?.value;
        const found = docs.find((d) => d.id === id || d.company_id === id);
        return { fetchAll: async () => ({ resources: found ? [found] : [] }) };
      },
    },
  };
}

const OWNED = { id: "company_a", company_id: "company_a", owner: DANA };
const OTHERS = { id: "company_b", company_id: "company_b", owner: JON };
const ORPHAN = { id: "company_c", company_id: "company_c" };

// ── Company access ──────────────────────────────────────────────────

test("admins short-circuit without touching Cosmos", async () => {
  const container = makeContainer([OTHERS]);

  const result = await assertCompanyAccess(adminReq(), "company_b", { container });

  assert.equal(result, null, "staff proceed");
  assert.equal(container.queries, 0, "and pay no lookup for the privilege");
});

test("a contributor may act on a company they own", async () => {
  const container = makeContainer([OWNED]);
  assert.equal(await assertCompanyAccess(contributorReq(), "company_a", { container }), null);
});

test("a company owned by someone else is refused as 404", async () => {
  const container = makeContainer([OTHERS]);

  const res = await assertCompanyAccess(contributorReq(), "company_b", { container });

  assert.equal(res.status, 404, "403 would confirm the company exists");
  assert.equal(JSON.parse(res.body).error, "not_found");
});

test("an unattributed company is refused, not treated as unclaimed", async () => {
  const container = makeContainer([ORPHAN]);

  const res = await assertCompanyAccess(contributorReq(), "company_c", { container });

  assert.equal(res.status, 404, "a legacy row with no owner is nobody's to edit");
});

test("a company that does not exist is the same 404", async () => {
  const container = makeContainer([]);
  const res = await assertCompanyAccess(contributorReq(), "company_missing", { container });
  assert.equal(res.status, 404);
});

test("matching is case-insensitive on the owner", async () => {
  const container = makeContainer([{ id: "company_a", owner: "DANA@Tabarnam.com" }]);
  assert.equal(await assertCompanyAccess(contributorReq(), "company_a", { container }), null);
});

test("resolution works by company_id as well as id", async () => {
  const container = makeContainer([{ id: "x", company_id: "company_a", owner: DANA }]);
  assert.equal(await assertCompanyAccess(contributorReq(), "company_a", { container }), null);
});

// ── Failing closed ──────────────────────────────────────────────────

test("no container means refused, never allowed", async () => {
  const res = await assertCompanyAccess(contributorReq(), "company_a", {});

  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).reason, "ownership_check_unavailable");
});

test("a lookup failure means refused, never allowed", async () => {
  const container = {
    items: {
      query() {
        return {
          async fetchAll() {
            throw new Error("Cosmos unavailable");
          },
        };
      },
    },
  };

  const res = await assertCompanyAccess(contributorReq(), "company_a", { container });
  assert.equal(res.status, 403);
});

test("a contributor with no resolvable identity is refused", async () => {
  const res = await assertCompanyAccess({ __role: "contributor" }, "company_a", {
    container: makeContainer([OWNED]),
  });

  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).reason, "unresolved_contributor_identity");
});

test("a missing company id is refused", async () => {
  const res = await assertCompanyAccess(contributorReq(), "", { container: makeContainer([OWNED]) });
  assert.equal(res.status, 404);
});

// ── Import sessions ─────────────────────────────────────────────────

test("a contributor may watch an import they started", async () => {
  const container = makeContainer([{ id: "_import_session_s1", initiated_by: DANA }]);
  assert.equal(await assertSessionAccess(contributorReq(), "s1", { container }), null);
});

test("someone else's import session is refused as 404", async () => {
  const container = makeContainer([{ id: "_import_session_s2", initiated_by: JON }]);
  const res = await assertSessionAccess(contributorReq(), "s2", { container });
  assert.equal(res.status, 404);
});

test("a session predating initiated_by is refused, not shared", async () => {
  // Defaulting the other way would open every historic import to contributors.
  const container = makeContainer([{ id: "_import_session_old" }]);
  const res = await assertSessionAccess(contributorReq(), "old", { container });
  assert.equal(res.status, 404);
});

test("admins watch any session without a lookup", async () => {
  const container = makeContainer([{ id: "_import_session_s2", initiated_by: JON }]);

  assert.equal(await assertSessionAccess(adminReq(), "s2", { container }), null);
  assert.equal(container.queries, 0);
});

test("session access fails closed with no container", async () => {
  const res = await assertSessionAccess(contributorReq(), "s1", {});
  assert.equal(res.status, 403);
});

// ── Role detection ──────────────────────────────────────────────────

test("only the contributor role is scoped", () => {
  assert.equal(isScoped({ __role: "contributor" }), true);
  assert.equal(isScoped({ __role: "admin" }), false);
  assert.equal(isScoped({}), false, "internal jobs carry no role and stay unscoped");
  assert.equal(isScoped(undefined), false);
});
