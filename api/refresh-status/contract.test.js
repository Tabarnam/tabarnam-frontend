// contract.test.js — refresh-status handler contract tests
const assert = require("node:assert/strict");
const { test } = require("node:test");

if (process.env.TEST_VERBOSE !== "1") {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

const { handler } = require("./index.js");

// ─── helpers ────────────────────────────────────────────────────────────────

function makeReq({ url = "https://example.test/api/refresh-status", method = "GET", headers, query } = {}) {
  const hdrs = new Headers();
  if (headers && typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined || v === null) continue;
      hdrs.set(k, String(v));
    }
  }
  const req = { method, url, headers: hdrs };
  if (query) req.query = query;
  return req;
}

function parseJson(res) {
  assert.ok(res, "response should exist");
  return typeof res.body === "string" ? JSON.parse(res.body) : res.body;
}

// ─── 1. export shape ───────────────────────────────────────────────────────

test("handler is exported correctly", () => {
  assert.equal(typeof handler, "function", "handler should be a function");
});

// ─── 2. OPTIONS returns 200 with CORS and handler headers ──────────────────

test("OPTIONS returns 200 with CORS and handler headers", async () => {
  const res = await handler(makeReq({ method: "OPTIONS" }));
  assert.equal(res.status, 200);

  const body = parseJson(res);
  assert.equal(body.ok, true);

  assert.equal(res.headers["Access-Control-Allow-Origin"], "*");
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.equal(res.headers["X-Api-Handler"], "refresh-status");
});

// ─── 3. POST returns 405 ───────────────────────────────────────────────────

test("POST returns 405 Method not allowed", async () => {
  const res = await handler(makeReq({ method: "POST" }));
  assert.equal(res.status, 405);

  const body = parseJson(res);
  assert.equal(body.ok, false);
  assert.equal(body.error, "Method not allowed");
});

// ─── 4. GET without company_id or job_id returns 400 with handler_id ────────

test("GET without company_id or job_id returns 400 with handler_id", async () => {
  const res = await handler(makeReq({ method: "GET", query: {} }));
  assert.equal(res.status, 400);

  const body = parseJson(res);
  assert.equal(body.ok, false);
  assert.equal(body.error, "company_id or job_id required");
  assert.equal(body.handler_id, "refresh-status");
});

// ─── 5. GET with job_id but no Cosmos returns 503 ──────────────────────────

test("GET with job_id but no Cosmos returns 503", async () => {
  // Ensure no Cosmos env vars are set
  const saved = { ...process.env };
  delete process.env.COSMOS_DB_ENDPOINT;
  delete process.env.COSMOS_ENDPOINT;
  delete process.env.COSMOS_DB_KEY;
  delete process.env.COSMOS_KEY;

  try {
    const res = await handler(makeReq({ method: "GET", query: { job_id: "test-job-123" } }));
    assert.equal(res.status, 503);

    const body = parseJson(res);
    assert.equal(body.ok, false);
    assert.equal(body.error, "Cosmos not configured");
  } finally {
    // Restore env
    for (const k of ["COSMOS_DB_ENDPOINT", "COSMOS_ENDPOINT", "COSMOS_DB_KEY", "COSMOS_KEY"]) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
  }
});

// ─── 5b. GET with company_id but no Cosmos returns 503 ─────────────────────

test("GET with company_id but no Cosmos returns 503", async () => {
  const saved = { ...process.env };
  delete process.env.COSMOS_DB_ENDPOINT;
  delete process.env.COSMOS_ENDPOINT;
  delete process.env.COSMOS_DB_KEY;
  delete process.env.COSMOS_KEY;

  try {
    const res = await handler(makeReq({ method: "GET", query: { company_id: "test-co-123" } }));
    assert.equal(res.status, 503);

    const body = parseJson(res);
    assert.equal(body.ok, false);
    assert.equal(body.error, "Cosmos not configured");
  } finally {
    for (const k of ["COSMOS_DB_ENDPOINT", "COSMOS_ENDPOINT", "COSMOS_DB_KEY", "COSMOS_KEY"]) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
  }
});

// ─── 6. Response includes elapsed_ms field ─────────────────────────────────

test("response includes elapsed_ms field", async () => {
  const res = await handler(makeReq({ method: "GET", query: {} }));
  const body = parseJson(res);

  assert.equal(typeof body.elapsed_ms, "number");
  assert.ok(body.elapsed_ms >= 0, "elapsed_ms should be non-negative");
});

// ─── 7. Response includes handler_id "refresh-status" ──────────────────────

test("response includes handler_id 'refresh-status'", async () => {
  const res = await handler(makeReq({ method: "POST" }));
  const body = parseJson(res);

  assert.equal(body.handler_id, "refresh-status");
});
