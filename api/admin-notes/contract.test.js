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

const DEFAULT_URL = "https://example.test/api/xadmin-api-notes";

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
// 2. OPTIONS returns 200 with CORS
// ---------------------------------------------------------------------------

test("OPTIONS returns 200 with CORS headers", async () => {
  const req = makeReq({
    method: "OPTIONS",
    headers: { origin: "https://my-app.test" },
  });
  const res = await handler(req, ctx);

  assert.equal(res.status, 200);
  assert.ok(res.headers, "should have headers");
  assert.equal(res.headers["Access-Control-Allow-Origin"], "https://my-app.test");
});

// ---------------------------------------------------------------------------
// 3. GET without company_id returns 400 or 500 (no Cosmos)
// ---------------------------------------------------------------------------

test("GET without company_id returns error (>= 400)", async () => {
  const req = makeReq({ method: "GET" });
  const res = await handler(req, ctx);

  assert.ok(res.status >= 400, `expected status >= 400, got ${res.status}`);
  const data = parseJson(res);
  assert.ok(data.error, "should have an error message");
});

// ---------------------------------------------------------------------------
// 4. GET with company_id but no Cosmos returns 500
// ---------------------------------------------------------------------------

test("GET with company_id but no Cosmos env returns 500", async () => {
  const req = makeReq({
    method: "GET",
    url: `${DEFAULT_URL}?company_id=test-co`,
  });
  const res = await handler(req, ctx);

  assert.equal(res.status, 500);
  const data = parseJson(res);
  assert.match(data.error, /cosmos/i);
});

// ---------------------------------------------------------------------------
// 5. POST without note.company_id returns error (>= 400)
// ---------------------------------------------------------------------------

test("POST without note.company_id returns error (>= 400)", async () => {
  const req = makeReq({
    method: "POST",
    body: { text: "some note but no company_id" },
  });
  const res = await handler(req, ctx);

  assert.ok(res.status >= 400, `expected status >= 400, got ${res.status}`);
  const data = parseJson(res);
  assert.ok(data.error, "should have an error message");
});

// ---------------------------------------------------------------------------
// 6. DELETE without id/company_id returns error (>= 400)
// ---------------------------------------------------------------------------

test("DELETE without id and company_id returns error (>= 400)", async () => {
  const req = makeReq({
    method: "DELETE",
    body: {},
  });
  const res = await handler(req, ctx);

  assert.ok(res.status >= 400, `expected status >= 400, got ${res.status}`);
  const data = parseJson(res);
  assert.ok(data.error, "should have an error message");
});
