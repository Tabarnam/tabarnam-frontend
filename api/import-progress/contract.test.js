const assert = require("node:assert/strict");
const { test } = require("node:test");

if (process.env.TEST_VERBOSE !== "1") {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

const { handler } = require("./index.js");

function makeReq({ url = "https://example.test/api/import/progress", method = "GET", headers } = {}) {
  const hdrs = new Headers();
  if (headers && typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined || v === null) continue;
      hdrs.set(k, String(v));
    }
  }
  return { method, url, headers: hdrs };
}

function parseJson(res) {
  assert.ok(res, "response should exist");
  return typeof res.body === "string" ? JSON.parse(res.body) : res.body;
}

// ---------------------------------------------------------------------------
// 1. Export shape
// ---------------------------------------------------------------------------
test("handler is exported correctly", () => {
  assert.ok(handler, "handler should be exported");
  assert.equal(typeof handler, "function", "handler should be a function");
});

// ---------------------------------------------------------------------------
// 2. OPTIONS returns 200 with CORS headers
// ---------------------------------------------------------------------------
test("OPTIONS returns 200 with CORS headers", async () => {
  const req = makeReq({ method: "OPTIONS", headers: { origin: "https://app.test" } });
  const res = await handler(req, {});

  assert.equal(res.status, 200);
  assert.ok(res.headers, "response should include headers");
  assert.equal(res.headers["Access-Control-Allow-Origin"], "https://app.test");
  assert.ok(res.headers["Access-Control-Allow-Methods"], "should include Allow-Methods");
  assert.ok(res.headers["Access-Control-Allow-Headers"], "should include Allow-Headers");
});

// ---------------------------------------------------------------------------
// 3. GET without session_id returns 400
// ---------------------------------------------------------------------------
test("GET without session_id returns 400", async () => {
  const req = makeReq({ method: "GET" });
  const res = await handler(req, {});

  assert.equal(res.status, 400);

  const body = parseJson(res);
  assert.ok(body.error, "body should contain an error message");

  assert.ok(res.headers["Content-Type"], "should have Content-Type header");
  assert.ok(res.headers["Access-Control-Allow-Origin"], "should have CORS origin header");
});

// ---------------------------------------------------------------------------
// 4. GET with session_id returns JSON response
// ---------------------------------------------------------------------------
test("GET with session_id returns JSON response", async () => {
  const req = makeReq({
    method: "GET",
    url: "https://example.test/api/import/progress?session_id=test_progress_123",
  });
  const res = await handler(req, {});

  assert.ok(res.status, "response should have a status");
  assert.ok(res.headers, "response should have headers");
  assert.ok(res.headers["Content-Type"], "should have Content-Type header");
  assert.ok(res.headers["Access-Control-Allow-Origin"], "should have CORS origin header");

  const body = parseJson(res);
  assert.equal(typeof body, "object", "body should be a valid JSON object");
});

// ---------------------------------------------------------------------------
// 5. take parameter is accepted
// ---------------------------------------------------------------------------
test("take parameter is accepted", async () => {
  const req = makeReq({
    method: "GET",
    url: "https://example.test/api/import/progress?session_id=test&take=5",
  });
  const res = await handler(req, {});

  assert.ok(res.status, "response should have a status");
  assert.ok(res.headers, "response should have headers");
  assert.ok(res.headers["Content-Type"], "should have Content-Type header");
  assert.ok(res.headers["Access-Control-Allow-Origin"], "should have CORS origin header");

  const body = parseJson(res);
  assert.equal(typeof body, "object", "body should be a valid JSON object");
});
