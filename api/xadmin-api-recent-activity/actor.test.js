"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("./index.js");

// Who signs an audit entry.
//
// The batch-summary write used to let a body-supplied actor_email override the
// authenticated SWA principal, which meant a caller could sign an entry as
// someone else. The body value is now a FALLBACK only — it still exists because
// the bulk-import frontend passes the user's email explicitly for callers that
// arrive without a client principal.

function principalHeader(userDetails, userId) {
  const payload = JSON.stringify({ userDetails, userId });
  return Buffer.from(payload, "utf-8").toString("base64");
}

function makeReq({ userDetails, userId } = {}) {
  const headers = new Headers();
  if (userDetails || userId) {
    headers.set("x-ms-client-principal", principalHeader(userDetails, userId));
  }
  return { method: "POST", headers };
}

test("actor: the authenticated principal wins over a body-supplied actor", () => {
  const actor = _test.resolveActor(
    makeReq({ userDetails: "kels@tabarnam.com", userId: "kels-oid" }),
    { actor_email: "jon@tabarnam.com", actor_user_id: "jon-oid" }
  );

  assert.equal(actor.actor_email, "kels@tabarnam.com");
  assert.equal(actor.actor_user_id, "kels-oid");
});

test("actor: falls back to the body when there is no client principal", () => {
  const actor = _test.resolveActor(makeReq(), {
    actor_email: "jon@tabarnam.com",
    actor_user_id: "jon-oid",
  });

  assert.equal(actor.actor_email, "jon@tabarnam.com");
  assert.equal(actor.actor_user_id, "jon-oid");
});

test("actor: accepts the camelCase body fallback the frontend sends", () => {
  const actor = _test.resolveActor(makeReq(), {
    actorEmail: "ben@tabarnam.com",
    actorUserId: "ben-oid",
  });

  assert.equal(actor.actor_email, "ben@tabarnam.com");
  assert.equal(actor.actor_user_id, "ben-oid");
});

test("actor: undefined when neither source supplies an identity", () => {
  const actor = _test.resolveActor(makeReq(), {});

  assert.equal(actor.actor_email, undefined);
  assert.equal(actor.actor_user_id, undefined);
});

test("actor: a missing body does not throw", () => {
  const actor = _test.resolveActor(makeReq({ userDetails: "jon@tabarnam.com" }), undefined);

  assert.equal(actor.actor_email, "jon@tabarnam.com");
});

test("actor: principal without userId falls back to userDetails for actor_user_id", () => {
  const actor = _test.resolveActor(makeReq({ userDetails: "jon@tabarnam.com" }), {
    actor_user_id: "spoofed-oid",
  });

  assert.equal(actor.actor_email, "jon@tabarnam.com");
  assert.equal(actor.actor_user_id, "jon@tabarnam.com");
});
