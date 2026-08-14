"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { handler } = require("./index.js");

// CORS preflight for import-preflight.
//
// This endpoint answered OPTIONS with `json({}, 204)` — a 204 carrying a body.
// 204 means No Content, so that response is invalid and the Functions host
// turned it into a 500. Live behaviour was OPTIONS => 500 while POST => 401.
//
// It went unnoticed because the admin UI is same-origin and same-origin
// requests never issue a preflight. It would have surfaced the moment anything
// called this endpoint cross-origin.

function optionsReq() {
  return { method: "OPTIONS", headers: new Headers() };
}

test("OPTIONS returns 204 with NO body", async () => {
  const res = await handler(optionsReq(), { log() {} });

  assert.equal(res.status, 204);
  assert.equal(res.body, undefined, "a 204 carrying a body is invalid and becomes a 500");
});

test("OPTIONS still carries the CORS headers a preflight needs", async () => {
  const res = await handler(optionsReq(), { log() {} });

  assert.equal(res.headers["Access-Control-Allow-Origin"], "*");
  assert.match(res.headers["Access-Control-Allow-Methods"], /OPTIONS/);
  assert.match(res.headers["Access-Control-Allow-Methods"], /POST/);
  assert.match(res.headers["Access-Control-Allow-Headers"], /Content-Type/);
});

test("OPTIONS is answered before the auth guard", async () => {
  // Preflight requests carry no credentials, so guarding them breaks CORS.
  const res = await handler(optionsReq(), { log() {} });

  assert.notEqual(res.status, 401);
  assert.notEqual(res.status, 403);
});

test("a non-OPTIONS request still reaches the guard", async () => {
  // Proves the early return above is scoped to preflight and did not become a
  // hole in the guard.
  const prev = process.env.TABARNAM_DEV_BYPASS;
  delete process.env.TABARNAM_DEV_BYPASS;

  try {
    const res = await handler({ method: "POST", headers: new Headers() }, { log() {} });
    assert.equal(res.status, 401, "an unauthenticated POST is still rejected");
  } finally {
    if (prev === undefined) delete process.env.TABARNAM_DEV_BYPASS;
    else process.env.TABARNAM_DEV_BYPASS = prev;
  }
});
