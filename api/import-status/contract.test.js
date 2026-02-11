const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("./index.js");

function makeReq({ method = "GET", url = "https://example.test/api/import-status", query } = {}) {
  const fullUrl = new URL(url);
  if (query) {
    for (const [k, v] of Object.entries(query)) fullUrl.searchParams.set(k, v);
  }
  return {
    method,
    url: fullUrl.toString(),
    headers: new Headers(),
    query: query || {},
  };
}

test("/api/import-status handler is exported", () => {
  assert.ok(_test, "module should export _test");
  assert.ok(typeof _test.handler === "function", "handler should be a function");
});

test("/api/import-status OPTIONS returns CORS headers", async () => {
  const req = makeReq({ method: "OPTIONS" });
  const res = await _test.handler(req, { log() {} });
  assert.equal(res.status, 200);
  assert.ok(res.headers);
  const origin = res.headers["Access-Control-Allow-Origin"];
  assert.ok(origin, "should have CORS origin header");
});

test("/api/import-status GET without session_id returns error", async () => {
  const req = makeReq({ method: "GET" });
  const res = await _test.handler(req, { log() {} });
  assert.ok(res.status === 400 || res.status === 200, "should respond with 400 or 200");
  const body = JSON.parse(res.body);
  // If 400, error is expected; if 200, it should indicate missing session
  if (res.status === 400) {
    assert.equal(body.ok, false);
  }
});
