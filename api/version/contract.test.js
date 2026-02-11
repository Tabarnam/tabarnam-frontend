const test = require("node:test");
const assert = require("node:assert/strict");

const { handler } = require("./index.js");

function makeReq({ method = "GET" } = {}) {
  return {
    method,
    url: "https://example.test/api/version",
    headers: new Headers(),
  };
}

test("/api/version returns ok:true with build info", async () => {
  const res = await handler(makeReq());
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.ok(body.ts, "should have timestamp");
  assert.ok(body.source, "should have source field");
  assert.ok(body.runtime, "should have runtime info");
  assert.ok(body.config, "should have config info");
});

test("/api/version OPTIONS returns CORS headers", async () => {
  const res = await handler(makeReq({ method: "OPTIONS" }));
  assert.equal(res.status, 200);
  assert.ok(res.headers["Access-Control-Allow-Origin"]);
});

test("/api/version config reports key presence without leaking values", async () => {
  const res = await handler(makeReq());
  const body = JSON.parse(res.body);
  assert.ok("function_key_configured" in body.config);
  assert.ok("internal_job_secret_configured" in body.config);
  // Values should be booleans, not the actual keys
  assert.equal(typeof body.config.function_key_configured, "boolean");
  assert.equal(typeof body.config.internal_job_secret_configured, "boolean");
});
