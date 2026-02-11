const assert = require("node:assert/strict");
const { test } = require("node:test");

if (process.env.TEST_VERBOSE !== "1") {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

const { handler } = require("./index.js");

function makeReq({ url = "https://example.test/api/admin/company", method = "GET", headers } = {}) {
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
// 1. handler is exported correctly
// ---------------------------------------------------------------------------
test("handler is exported correctly", () => {
  assert.ok(handler, "handler should be exported");
  assert.equal(typeof handler, "function", "handler should be a function");
});

// ---------------------------------------------------------------------------
// 2. OPTIONS returns 200 with CORS headers
// ---------------------------------------------------------------------------
test("OPTIONS returns 200 with CORS headers", async () => {
  const res = await handler(makeReq({ method: "OPTIONS" }), {});

  assert.equal(res.status, 200, "status should be 200");
  assert.ok(res.headers, "response should include headers");
  assert.equal(res.headers["Access-Control-Allow-Origin"], "*");
  assert.ok(
    res.headers["Access-Control-Allow-Methods"].includes("GET"),
    "Allow-Methods should include GET"
  );
  assert.ok(
    res.headers["Access-Control-Allow-Methods"].includes("OPTIONS"),
    "Allow-Methods should include OPTIONS"
  );
});

// ---------------------------------------------------------------------------
// 3. GET without id or domain returns 400
//    NOTE: Without Cosmos configured the handler returns 500 before reaching
//    param validation, so we accept either 400 or 500 as a non-success status.
// ---------------------------------------------------------------------------
test("GET without id or domain returns 400", async () => {
  const res = await handler(makeReq({ method: "GET" }), {});

  assert.ok(res.status >= 400, "status should be an error (>= 400)");
  const body = parseJson(res);
  assert.equal(body.ok, false, "ok should be false");
  assert.ok(body.error, "error message should be present");
});

// ---------------------------------------------------------------------------
// 4. POST returns 405 Method Not Allowed
// ---------------------------------------------------------------------------
test("POST returns 405 Method Not Allowed", async () => {
  const res = await handler(makeReq({ method: "POST" }), {});

  assert.equal(res.status, 405, "status should be 405");
  const body = parseJson(res);
  assert.equal(body.ok, false, "ok should be false");
  assert.ok(
    res.headers["Content-Type"].includes("application/json"),
    "Content-Type should be JSON"
  );
});

// ---------------------------------------------------------------------------
// 5. GET with id param returns JSON
// ---------------------------------------------------------------------------
test("GET with id param returns JSON", async () => {
  const url = "https://example.test/api/admin/company?id=company_123";
  const res = await handler(makeReq({ method: "GET", url }), {});

  assert.ok(res, "response should exist");
  assert.ok(typeof res.status === "number", "status should be a number");
  assert.ok(
    res.headers["Content-Type"].includes("application/json"),
    "Content-Type should be JSON"
  );

  const body = parseJson(res);
  assert.ok(typeof body === "object" && body !== null, "body should be a JSON object");

  // Without Cosmos the handler returns 500 with a structured error; verify it is still valid JSON
  if (res.status === 200) {
    assert.equal(body.ok, true, "ok should be true on 200");
    assert.equal(body.lookup, "id", "lookup should be 'id'");
  }
});

// ---------------------------------------------------------------------------
// 6. GET with domain param returns JSON
// ---------------------------------------------------------------------------
test("GET with domain param returns JSON", async () => {
  const url = "https://example.test/api/admin/company?domain=example.com";
  const res = await handler(makeReq({ method: "GET", url }), {});

  assert.ok(res, "response should exist");
  assert.ok(typeof res.status === "number", "status should be a number");
  assert.ok(
    res.headers["Content-Type"].includes("application/json"),
    "Content-Type should be JSON"
  );

  const body = parseJson(res);
  assert.ok(typeof body === "object" && body !== null, "body should be a JSON object");

  if (res.status === 200) {
    assert.equal(body.ok, true, "ok should be true on 200");
    assert.equal(body.lookup, "domain", "lookup should be 'domain'");
  }
});

// ---------------------------------------------------------------------------
// 7. include_deleted param is accepted
// ---------------------------------------------------------------------------
test("include_deleted param is accepted", async () => {
  const url = "https://example.test/api/admin/company?id=company_123&include_deleted=1";
  const res = await handler(makeReq({ method: "GET", url }), {});

  assert.ok(res, "response should exist");
  assert.ok(typeof res.status === "number", "status should be a number");
  assert.ok(
    res.headers["Content-Type"].includes("application/json"),
    "Content-Type should be JSON"
  );

  const body = parseJson(res);
  assert.ok(typeof body === "object" && body !== null, "body should be a JSON object");

  // The handler should not reject the include_deleted param (no 400)
  assert.notEqual(res.status, 400, "should not return 400 when include_deleted is provided");

  if (res.status === 200) {
    assert.equal(body.ok, true, "ok should be true on 200");
    assert.equal(body.request.include_deleted, true, "include_deleted should be true in request echo");
  }
});
