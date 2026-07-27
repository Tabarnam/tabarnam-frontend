"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { handler } = require("./index.js");
const { getAdminEmails } = require("../_adminAuth");

// The route registration wraps this in withAdminGuard; these tests hit the
// inner handler directly (guard behavior is _adminAuth's concern). What must
// hold: the payload mirrors getAdminEmails() — the backend allowlist — and
// echoes the caller. The frontend trusts this as its only admin roster.

test("roster: returns the backend allowlist, lowercased", async () => {
  const res = await handler({ method: "GET", __admin_email: "Jon@Tabarnam.com" });
  const body = JSON.parse(res.body);
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.admins, getAdminEmails().map((e) => e.toLowerCase()));
  assert.ok(body.admins.includes("jon@tabarnam.com"));
  assert.equal(body.me, "jon@tabarnam.com");
});

test("roster: me is null when the guard attached no email (internal/dev)", async () => {
  const res = await handler({ method: "GET" });
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.me, null);
});

test("roster: ADMIN_EMAILS app setting overrides the fallback list", async () => {
  const prev = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = "jon@tabarnam.com, New.Admin@Tabarnam.com";
  try {
    const res = await handler({ method: "GET" });
    const body = JSON.parse(res.body);
    assert.deepEqual(body.admins, ["jon@tabarnam.com", "new.admin@tabarnam.com"]);
  } finally {
    if (prev === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = prev;
  }
});

test("roster: rejects non-GET", async () => {
  const res = await handler({ method: "POST" });
  assert.equal(res.status, 405);
});
