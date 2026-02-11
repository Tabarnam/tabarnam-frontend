const assert = require("node:assert/strict");
const { test } = require("node:test");

// Silence chatty handler logs during tests
if (process.env.TEST_VERBOSE !== "1") {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

const { _test } = require("./index.js");

function makeReq({ url = "https://example.test/api/import/status", method = "GET", headers } = {}) {
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
  const body = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
  return body;
}

// ── 1. Export shape ─────────────────────────────────────────────────────────────
test("handler is exported correctly", () => {
  assert.ok(_test, "module should export _test");
  assert.equal(typeof _test.handler, "function", "_test.handler should be a function");
});

// ── 2. OPTIONS / CORS ───────────────────────────────────────────────────────────
test("OPTIONS returns 200 with CORS headers", async () => {
  const res = await _test.handler(makeReq({ method: "OPTIONS" }), {});
  assert.equal(res.status, 200);
  assert.ok(res.headers, "response should have headers");
  const origin = res.headers["Access-Control-Allow-Origin"];
  assert.ok(origin, "should include Access-Control-Allow-Origin header");
});

// ── 3. Missing session_id ───────────────────────────────────────────────────────
test("GET without session_id returns 400", async () => {
  const res = await _test.handler(makeReq(), {});
  assert.equal(res.status, 400, "missing session_id should return 400");
  const body = parseJson(res);
  assert.equal(body.ok, false);
  assert.ok(
    body.error && body.error.toLowerCase().includes("session_id"),
    "error message should mention session_id"
  );
});

// ── 4. Valid session_id returns JSON ────────────────────────────────────────────
test("GET with session_id returns JSON response", async () => {
  const res = await _test.handler(
    makeReq({ url: "https://example.test/api/import/status?session_id=test_123" }),
    {}
  );
  assert.ok(res, "handler should return a response");
  assert.ok(typeof res.status === "number", "status should be a number");
  // Without Cosmos the handler may return an error status, but it must still
  // produce valid JSON and not throw.
  const body = parseJson(res);
  assert.ok(body && typeof body === "object", "body should be a JSON object");
});

// ── 5. Handler metadata fields ──────────────────────────────────────────────────
test("response includes handler metadata", async () => {
  const res = await _test.handler(
    makeReq({ url: "https://example.test/api/import/status?session_id=test_123" }),
    {}
  );
  const body = parseJson(res);
  assert.ok("handler_id" in body, "body should contain handler_id");
  assert.ok("build_id" in body, "body should contain build_id");
});

// ── 6. force_resume parameter ───────────────────────────────────────────────────
test("force_resume parameter is accepted", async () => {
  const res = await _test.handler(
    makeReq({ url: "https://example.test/api/import/status?session_id=test_123&force_resume=1" }),
    {}
  );
  assert.ok(res, "handler should return a response");
  assert.ok(typeof res.status === "number", "status should be a number");
  const body = parseJson(res);
  assert.ok(body && typeof body === "object", "body should be a JSON object");
});

// ── 7. take parameter ───────────────────────────────────────────────────────────
test("take parameter is accepted", async () => {
  const res = await _test.handler(
    makeReq({ url: "https://example.test/api/import/status?session_id=test_123&take=5" }),
    {}
  );
  assert.ok(res, "handler should return a response");
  assert.ok(typeof res.status === "number", "status should be a number");
  const body = parseJson(res);
  assert.ok(body && typeof body === "object", "body should be a JSON object");
});

// ── 8. Invalid URL ──────────────────────────────────────────────────────────────
test("invalid URL returns 400", async () => {
  const res = await _test.handler(makeReq({ url: "not-a-valid-url" }), {});
  assert.equal(res.status, 400, "invalid URL should return 400");
  const body = parseJson(res);
  assert.equal(body.ok, false);
  assert.equal(body.code, "INVALID_URL");
});
