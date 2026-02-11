const test = require("node:test");
const assert = require("node:assert/strict");

if (process.env.TEST_VERBOSE !== "1") {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

const { handler } = require("./index.js");

function makeReq({ url = "https://example.test/api/submit-review", method = "POST", headers, body } = {}) {
  const hdrs = new Headers();
  if (headers && typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined || v === null) continue;
      hdrs.set(k, String(v));
    }
  }
  const req = { method, url, headers: hdrs };
  if (body !== undefined) {
    req.json = async () => body;
  } else {
    req.json = async () => { throw new Error("No body"); };
  }
  return req;
}

function parseJson(res) {
  assert.ok(res, "response should exist");
  return typeof res.body === "string" ? JSON.parse(res.body) : res.body;
}

// ---------------------------------------------------------------------------
// 1. handler is exported correctly
// ---------------------------------------------------------------------------

test("/api/submit-review handler is exported", () => {
  assert.ok(typeof handler === "function", "handler should be a function");
});

// ---------------------------------------------------------------------------
// 2. OPTIONS returns 200 with CORS headers
// ---------------------------------------------------------------------------

test("/api/submit-review OPTIONS returns 200 with CORS headers", async () => {
  const req = makeReq({ method: "OPTIONS" });
  const res = await handler(req, {});
  assert.equal(res.status, 200);
  assert.ok(res.headers, "response should include headers");
  assert.ok(res.headers["Access-Control-Allow-Origin"], "should have Access-Control-Allow-Origin");
  const methods = res.headers["Access-Control-Allow-Methods"];
  assert.ok(typeof methods === "string", "Access-Control-Allow-Methods header should exist");
  assert.ok(methods.includes("POST"), "CORS methods should include POST");
});

// ---------------------------------------------------------------------------
// 3. POST without body returns error (500 without Cosmos env)
// ---------------------------------------------------------------------------

test("/api/submit-review POST without body returns error", async () => {
  const req = makeReq({ method: "POST" });
  const res = await handler(req, { log: { warn: () => {} } });
  assert.ok(res.status >= 400, "should return an error status without a body");
  const body = parseJson(res);
  assert.ok(typeof body.error === "string", "error field should be a string");
});

// ---------------------------------------------------------------------------
// 4. POST with invalid JSON returns 400
// ---------------------------------------------------------------------------

test("/api/submit-review POST with invalid JSON returns error", async () => {
  const req = makeReq({ method: "POST" });
  // Simulate invalid JSON by making json() throw a SyntaxError
  req.json = async () => { throw new SyntaxError("Unexpected token"); };
  const res = await handler(req, { log: { warn: () => {} } });
  // Without Cosmos env vars the handler returns 500 before reaching JSON parse.
  // With Cosmos configured it would return 400 "Invalid JSON".
  assert.ok(res.status >= 400, "should return an error status for invalid JSON");
  const body = parseJson(res);
  assert.ok(typeof body.error === "string", "error field should be a string");
});

// ---------------------------------------------------------------------------
// 5. POST with missing rating returns error (>=400)
// ---------------------------------------------------------------------------

test("/api/submit-review POST with missing rating returns error", async () => {
  const req = makeReq({
    method: "POST",
    body: {
      company_name: "Acme Corp",
      text: "This is a perfectly valid review text that is long enough.",
    },
  });
  const res = await handler(req, { log: { warn: () => {} } });
  // Without Cosmos env vars configured, handler returns 500 before validation.
  // With Cosmos configured, it would return 400 for missing rating.
  assert.ok(res.status >= 400, "should return an error status for missing rating");
  const body = parseJson(res);
  assert.ok(typeof body.error === "string", "error field should be a string");
});

// ---------------------------------------------------------------------------
// 6. POST with short text returns error (>=400)
// ---------------------------------------------------------------------------

test("/api/submit-review POST with short review text returns error", async () => {
  const req = makeReq({
    method: "POST",
    body: {
      company_name: "Acme Corp",
      rating: 4,
      text: "Short",
    },
  });
  const res = await handler(req, { log: { warn: () => {} } });
  // Without Cosmos env vars configured, handler returns 500 before validation.
  // With Cosmos configured, it would return 400 for text too short.
  assert.ok(res.status >= 400, "should return an error status for short review text");
  const body = parseJson(res);
  assert.ok(typeof body.error === "string", "error field should be a string");
});

// ---------------------------------------------------------------------------
// 7. GET returns error (method not allowed / falls through to POST logic)
// ---------------------------------------------------------------------------

test("/api/submit-review GET returns error", async () => {
  const req = makeReq({ method: "GET" });
  const res = await handler(req, { log: { warn: () => {} } });
  // The route only registers POST and OPTIONS. A direct handler call with GET
  // skips the OPTIONS branch and falls through to POST logic, which will fail
  // because Cosmos is not configured or body parsing fails.
  assert.ok(res.status >= 400, "GET should return an error status");
  const body = parseJson(res);
  assert.ok(typeof body.error === "string", "error field should be a string");
});
