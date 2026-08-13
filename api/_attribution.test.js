"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveAttribution } = require("./_attribution");

// One rule, two create paths (save-companies for imports, admin-companies-v2
// for the editor). The asymmetry between roles is the whole point:
//
//   admin       — carried value wins (re-saves must not reassign)
//   contributor — authenticated identity wins (owner is the security boundary)

const ADMIN = { role: "admin", actorEmail: "jon@tabarnam.com" };
const CONTRIB = { role: "contributor", actorEmail: "dana@tabarnam.com" };

test("admin: falls back to the authenticated identity when nothing is carried", () => {
  assert.deepEqual(resolveAttribution(ADMIN), {
    imported_by: "jon@tabarnam.com",
    owner: "jon@tabarnam.com",
  });
});

test("admin: a carried importer wins, so a re-save does not reassign", () => {
  assert.deepEqual(
    resolveAttribution({ ...ADMIN, carriedImportedBy: "ben@tabarnam.com" }),
    { imported_by: "ben@tabarnam.com", owner: "ben@tabarnam.com" }
  );
});

test("admin: can import on someone else's behalf — owner and importer differ", () => {
  assert.deepEqual(
    resolveAttribution({ ...ADMIN, carriedOwner: "dana@tabarnam.com" }),
    { imported_by: "jon@tabarnam.com", owner: "dana@tabarnam.com" }
  );
});

test("contributor: the authenticated identity wins over a carried owner", () => {
  const result = resolveAttribution({ ...CONTRIB, carriedOwner: "jon@tabarnam.com" });

  assert.equal(result.owner, "dana@tabarnam.com", "a contributor cannot choose its own owner");
  assert.equal(result.imported_by, "dana@tabarnam.com");
});

test("contributor: cannot attribute an import to someone else", () => {
  const result = resolveAttribution({
    ...CONTRIB,
    carriedImportedBy: "jon@tabarnam.com",
    carriedOwner: "jon@tabarnam.com",
  });

  assert.deepEqual(result, {
    imported_by: "dana@tabarnam.com",
    owner: "dana@tabarnam.com",
  });
});

test("contributor: cannot orphan a row by carrying empty attribution", () => {
  const result = resolveAttribution({ ...CONTRIB, carriedOwner: "   ", carriedImportedBy: "" });

  assert.equal(result.owner, "dana@tabarnam.com");
  assert.equal(result.imported_by, "dana@tabarnam.com");
});

test("emails are normalized to lowercase on both paths", () => {
  assert.equal(
    resolveAttribution({ role: "admin", actorEmail: "  Jon@Tabarnam.com  " }).owner,
    "jon@tabarnam.com"
  );
  assert.equal(
    resolveAttribution({ role: "admin", carriedOwner: "KELS@TABARNAM.COM" }).owner,
    "kels@tabarnam.com"
  );
});

test("no identity anywhere yields null, not undefined or empty string", () => {
  assert.deepEqual(resolveAttribution({}), { imported_by: null, owner: null });
  assert.deepEqual(resolveAttribution(), { imported_by: null, owner: null });
});

test("an unknown role is treated as admin, never as a contributor", () => {
  // Defensive: a missing req.__role must not accidentally pin attribution.
  assert.deepEqual(
    resolveAttribution({ actorEmail: "jon@tabarnam.com", carriedOwner: "ben@tabarnam.com" }),
    { imported_by: "jon@tabarnam.com", owner: "ben@tabarnam.com" }
  );
});

test("non-string carried values are ignored rather than coerced", () => {
  const result = resolveAttribution({
    ...ADMIN,
    carriedOwner: { email: "sneaky@example.com" },
    carriedImportedBy: 12345,
  });

  assert.deepEqual(result, {
    imported_by: "jon@tabarnam.com",
    owner: "jon@tabarnam.com",
  });
});
