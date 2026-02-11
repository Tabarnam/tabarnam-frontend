const test = require("node:test");
const assert = require("node:assert/strict");

const { handler } = require("./index.js");

function makeReq({ method = "GET" } = {}) {
  return {
    method,
    url: "https://example.test/api/ping",
    headers: new Headers(),
  };
}

test("/api/ping returns ok:true", async () => {
  const res = await handler(makeReq(), {});
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.name, "ping");
  assert.ok(body.ts);
});

test("/api/ping OPTIONS returns CORS headers", async () => {
  const res = await handler(makeReq({ method: "OPTIONS" }), {});
  assert.equal(res.status, 200);
  assert.ok(res.headers["Access-Control-Allow-Origin"]);
});

test("/api/ping response is valid JSON with content type", async () => {
  const res = await handler(makeReq(), {});
  assert.equal(res.headers["Content-Type"], "application/json");
  // Should not throw
  JSON.parse(res.body);
});
