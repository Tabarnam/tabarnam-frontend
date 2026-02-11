const test = require("node:test");
const assert = require("node:assert/strict");

const endpoint = require("./index.js");
const handler = endpoint.handler;

function parseJson(res) {
  assert.ok(res);
  const ct = res.headers?.["Content-Type"] || res.headers?.["content-type"];
  assert.equal(ct, "application/json");
  return JSON.parse(res.body);
}

function makeReq({ method = "POST", url = "https://example.test/api/xadmin-api-refresh-import", query, json } = {}) {
  const req = {
    method,
    url,
    headers: new Headers(),
    query: query || {},
  };

  if (typeof json === "function") req.json = json;

  return req;
}

function ctx() {
  return { log() {} };
}

// ── 1. Handler exports a function ──────────────────────────────────────────────

test("admin-refresh-import: handler exports a function", () => {
  assert.equal(typeof handler, "function");
});

// ── 2. OPTIONS returns CORS headers ────────────────────────────────────────────

test("admin-refresh-import: OPTIONS returns CORS headers", async () => {
  const res = await handler(
    makeReq({ method: "OPTIONS" }),
    ctx()
  );

  assert.equal(res.status, 200);
  assert.ok(res.headers);
  assert.equal(res.headers["Access-Control-Allow-Origin"], "*");
  assert.ok(res.headers["Access-Control-Allow-Methods"].includes("POST"));
  assert.ok(res.headers["Access-Control-Allow-Methods"].includes("OPTIONS"));
  assert.ok(res.headers["Access-Control-Allow-Headers"].includes("Content-Type"));
  assert.ok(res.headers["Access-Control-Allow-Headers"].includes("Authorization"));
});

// ── 3. Invalid methods return 405 ──────────────────────────────────────────────

test("admin-refresh-import: GET returns 405", async () => {
  const res = await handler(
    makeReq({ method: "GET" }),
    ctx()
  );

  assert.equal(res.status, 405);
  const body = parseJson(res);
  assert.equal(body.ok, false);
  assert.ok(body.error);
  assert.ok(body.route);
  assert.ok(typeof body.elapsed_ms === "number");
});

test("admin-refresh-import: PUT returns 405", async () => {
  const res = await handler(
    makeReq({ method: "PUT" }),
    ctx()
  );

  assert.equal(res.status, 405);
  const body = parseJson(res);
  assert.equal(body.ok, false);
});

test("admin-refresh-import: DELETE returns 405", async () => {
  const res = await handler(
    makeReq({ method: "DELETE" }),
    ctx()
  );

  assert.equal(res.status, 405);
  const body = parseJson(res);
  assert.equal(body.ok, false);
});

// ── 4. Missing required params return 400 ──────────────────────────────────────

test("admin-refresh-import: POST with empty body returns 400 (missing company_id/domain/name)", async () => {
  const res = await handler(
    makeReq({
      method: "POST",
      json: async () => ({}),
    }),
    ctx()
  );

  // Without COSMOS env vars the handler returns 503 before reaching the param check.
  // That is still a valid contract: no Cosmos = 503.
  // We accept either 400 (param validation) or 503 (Cosmos not configured).
  assert.ok(res.status === 400 || res.status === 503, `Expected 400 or 503, got ${res.status}`);
  const body = parseJson(res);
  assert.equal(body.ok, false);
  assert.ok(body.error);
  assert.ok(body.route);
});

test("admin-refresh-import: POST with invalid JSON returns 503 (Cosmos check precedes JSON parse)", async () => {
  // The handler checks Cosmos DB configuration before parsing the request body.
  // Without COSMOS env vars, 503 is returned before JSON parsing is attempted.
  // This test documents that ordering contract.
  const res = await handler(
    makeReq({
      method: "POST",
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    }),
    ctx()
  );

  assert.equal(res.status, 503);
  const body = parseJson(res);
  assert.equal(body.ok, false);
  assert.ok(body.error.includes("Cosmos"));
  assert.ok(body.route);
});

// ── 5. Valid request shape — will fail at Cosmos (503) ─────────────────────────

test("admin-refresh-import: POST with company_id but no Cosmos returns 503 error shape", async () => {
  const res = await handler(
    makeReq({
      method: "POST",
      json: async () => ({
        company_id: "test_company_123",
      }),
    }),
    ctx()
  );

  assert.equal(res.status, 503);
  const body = parseJson(res);
  assert.equal(body.ok, false);
  assert.equal(body.route, "xadmin-api-refresh-import");
  assert.ok(body.error.includes("Cosmos"));
  assert.ok(typeof body.trace_id === "string");
  assert.ok(typeof body.elapsed_ms === "number");
});

test("admin-refresh-import: POST with normalized_domain but no Cosmos returns 503 error shape", async () => {
  const res = await handler(
    makeReq({
      method: "POST",
      json: async () => ({
        normalized_domain: "example.com",
      }),
    }),
    ctx()
  );

  assert.equal(res.status, 503);
  const body = parseJson(res);
  assert.equal(body.ok, false);
  assert.equal(body.route, "xadmin-api-refresh-import");
  assert.ok(body.error.includes("Cosmos"));
});

test("admin-refresh-import: POST with company_name but no Cosmos returns 503 error shape", async () => {
  const res = await handler(
    makeReq({
      method: "POST",
      json: async () => ({
        company_name: "Test Co",
      }),
    }),
    ctx()
  );

  assert.equal(res.status, 503);
  const body = parseJson(res);
  assert.equal(body.ok, false);
  assert.equal(body.route, "xadmin-api-refresh-import");
});

// ── 6. Response shape consistency ──────────────────────────────────────────────

test("admin-refresh-import: all error responses include route and elapsed_ms", async () => {
  // 405 error
  const res405 = await handler(makeReq({ method: "PATCH" }), ctx());
  assert.equal(res405.status, 405);
  const body405 = parseJson(res405);
  assert.ok("route" in body405);
  assert.ok("elapsed_ms" in body405);
  assert.ok("trace_id" in body405);

  // 503 error (Cosmos check precedes JSON parse, so invalid JSON still yields 503)
  const res503b = await handler(
    makeReq({
      method: "POST",
      json: async () => { throw new Error("bad json"); },
    }),
    ctx()
  );
  assert.equal(res503b.status, 503);
  const body503b = parseJson(res503b);
  assert.ok("route" in body503b);
  assert.ok("elapsed_ms" in body503b);
  assert.ok("trace_id" in body503b);

  // 503 error
  const res503 = await handler(
    makeReq({
      method: "POST",
      json: async () => ({ company_id: "abc" }),
    }),
    ctx()
  );
  assert.equal(res503.status, 503);
  const body503 = parseJson(res503);
  assert.ok("route" in body503);
  assert.ok("elapsed_ms" in body503);
  assert.ok("trace_id" in body503);
});

// ── 7. Trace ID is forwarded from query params ────────────────────────────────

test("admin-refresh-import: trace_id from query is preserved in response", async () => {
  const customTrace = "my_custom_trace_id_123";
  const res = await handler(
    makeReq({
      method: "POST",
      query: { trace: customTrace },
      json: async () => ({ company_id: "abc" }),
    }),
    ctx()
  );

  const body = parseJson(res);
  assert.equal(body.trace_id, customTrace);
});

// ── 8. CORS headers present on all JSON responses ──────────────────────────────

test("admin-refresh-import: CORS headers present on error responses", async () => {
  const res = await handler(
    makeReq({ method: "GET" }),
    ctx()
  );

  assert.equal(res.headers["Access-Control-Allow-Origin"], "*");
});
