const assert = require("node:assert/strict");
const { test } = require("node:test");

if (process.env.TEST_VERBOSE !== "1") {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

const { handler } = require("./index.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_URL = "https://example.test/api/xadmin-api-reviews";

function makeReq({ url, method = "GET", headers, body } = {}) {
  const hdrs = new Headers();
  if (headers && typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined || v === null) continue;
      hdrs.set(k, String(v));
    }
  }
  const req = { method, url: url || DEFAULT_URL, headers: hdrs };
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

const ctx = { log: () => {} };

// ---------------------------------------------------------------------------
// 1. handler is exported correctly
// ---------------------------------------------------------------------------

test("handler is exported as a function", () => {
  assert.ok(handler, "handler should be exported");
  assert.equal(typeof handler, "function", "handler should be a function");
});

// ---------------------------------------------------------------------------
// 2. OPTIONS returns 200 with CORS headers
// ---------------------------------------------------------------------------

test("OPTIONS returns 200 with CORS headers", async () => {
  const req = makeReq({ method: "OPTIONS" });
  const res = await handler(req, ctx);

  assert.equal(res.status, 200);
  assert.ok(res.headers, "should have headers");
  assert.equal(res.headers["Access-Control-Allow-Origin"], "*");
  assert.ok(
    res.headers["Access-Control-Allow-Methods"],
    "should have Allow-Methods header"
  );
});

// ---------------------------------------------------------------------------
// 3. GET without company param returns error (>= 400)
// ---------------------------------------------------------------------------

test("GET without company param returns error (>= 400)", async () => {
  const req = makeReq({ method: "GET" });
  const res = await handler(req, ctx);

  assert.ok(res.status >= 400, `expected status >= 400, got ${res.status}`);
  const data = parseJson(res);
  assert.ok(data.error, "should have an error message");
});

// ---------------------------------------------------------------------------
// 4. GET with company param returns error (no Cosmos -> 500)
// ---------------------------------------------------------------------------

test("GET with company param but no Cosmos returns 500", async () => {
  const req = makeReq({
    method: "GET",
    url: `${DEFAULT_URL}?company=test-company`,
  });
  const res = await handler(req, ctx);

  assert.equal(res.status, 500);
  const data = parseJson(res);
  assert.match(data.error, /cosmos/i);
});

// ---------------------------------------------------------------------------
// 5. POST without body returns error (no Cosmos -> 500 before body parse)
// ---------------------------------------------------------------------------

test("POST without body returns error (>= 400)", async () => {
  const req = makeReq({ method: "POST" });
  // Without Cosmos env vars the handler returns 500 before reaching body parsing
  const res = await handler(req, ctx);

  assert.ok(res.status >= 400, `expected status >= 400, got ${res.status}`);
  const data = parseJson(res);
  assert.ok(data.error, "should have an error message");
});

// ---------------------------------------------------------------------------
// 6. POST without company/source/abstract returns error (>= 400)
// ---------------------------------------------------------------------------

test("POST without company, source, abstract returns error (>= 400)", async () => {
  const req = makeReq({
    method: "POST",
    body: { title: "incomplete review" },
  });
  const res = await handler(req, ctx);

  assert.ok(res.status >= 400, `expected status >= 400, got ${res.status}`);
  const data = parseJson(res);
  assert.ok(data.error, "should have an error message");
});

// ---------------------------------------------------------------------------
// 7. DELETE without company/review_id returns error (>= 400)
// ---------------------------------------------------------------------------

test("DELETE without company and review_id returns error (>= 400)", async () => {
  const req = makeReq({
    method: "DELETE",
    body: {},
  });
  const res = await handler(req, ctx);

  assert.ok(res.status >= 400, `expected status >= 400, got ${res.status}`);
  const data = parseJson(res);
  assert.ok(data.error, "should have an error message");
});
