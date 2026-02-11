const test = require("node:test");
const assert = require("node:assert/strict");

const { handler } = require("./index.js");

function makeReq({ method = "GET" } = {}) {
  return {
    method,
    url: "https://example.test/api/health",
    headers: new Headers(),
  };
}

test("/api/health returns ok:true with timestamp", async () => {
  const res = await handler(makeReq(), {});
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.name, "health");
  assert.ok(body.ts, "should have timestamp");
  // Validate ISO format
  assert.ok(!isNaN(Date.parse(body.ts)), "ts should be valid ISO date");
});

test("/api/health OPTIONS returns CORS headers", async () => {
  const res = await handler(makeReq({ method: "OPTIONS" }), {});
  assert.equal(res.status, 200);
  assert.ok(res.headers["Access-Control-Allow-Origin"]);
  assert.ok(res.headers["Access-Control-Allow-Methods"]);
});

test("/api/health response has JSON content type", async () => {
  const res = await handler(makeReq(), {});
  assert.equal(res.headers["Content-Type"], "application/json");
});

test("/api/health?deep=true includes dependency checks", async () => {
  const res = await handler({
    method: "GET",
    url: "https://example.test/api/health?deep=true",
    headers: new Headers(),
  }, {});
  const body = JSON.parse(res.body);
  assert.ok(body.dependencies, "deep mode should include dependencies");
  assert.ok("cosmos" in body.dependencies, "should check cosmos");
  assert.ok("xai" in body.dependencies, "should check xai");
});

test("/api/health shallow mode does not include dependencies", async () => {
  const res = await handler(makeReq(), {});
  const body = JSON.parse(res.body);
  assert.equal(body.dependencies, undefined, "shallow mode should not include dependencies");
});
