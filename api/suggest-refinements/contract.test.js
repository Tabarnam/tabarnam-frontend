const assert = require("node:assert/strict");
const { test } = require("node:test");

if (process.env.TEST_VERBOSE !== "1") {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

const { handler: suggestRefinementsHandler } = require("./index.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq({
  url = "https://example.test/api/suggest-refinements",
  method = "GET",
  headers,
} = {}) {
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

const ctx = { log: () => {} };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("suggestRefinementsHandler is exported correctly", () => {
  assert.equal(typeof suggestRefinementsHandler, "function");
});

// ---------------------------------------------------------------------------

test("OPTIONS returns 200 with CORS headers", async () => {
  const req = makeReq({ method: "OPTIONS" });
  const res = await suggestRefinementsHandler(req, ctx);

  assert.equal(res.status, 200);
  assert.equal(res.headers["Access-Control-Allow-Origin"], "*");
  assert.ok(
    res.headers["Access-Control-Allow-Methods"]?.includes("GET"),
    "Allow-Methods should include GET",
  );
});

// ---------------------------------------------------------------------------

test("GET without q param returns empty suggestions", async () => {
  const req = makeReq({ url: "https://example.test/api/suggest-refinements" });
  const res = await suggestRefinementsHandler(req, ctx);
  const body = parseJson(res);

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.success, true);
  assert.ok(Array.isArray(body.suggestions), "suggestions should be an array");
  assert.equal(body.suggestions.length, 0);
});

// ---------------------------------------------------------------------------

test("GET with q shorter than 2 chars returns empty suggestions", async () => {
  const req = makeReq({
    url: "https://example.test/api/suggest-refinements?q=a",
  });
  const res = await suggestRefinementsHandler(req, ctx);
  const body = parseJson(res);

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.success, true);
  assert.ok(Array.isArray(body.suggestions), "suggestions should be an array");
  assert.equal(body.suggestions.length, 0);
});

// ---------------------------------------------------------------------------

test("GET with q (>=2 chars) returns valid response shape (graceful without Cosmos)", async () => {
  const req = makeReq({
    url: "https://example.test/api/suggest-refinements?q=test&country=CA&state=QC&city=Montreal",
  });
  const res = await suggestRefinementsHandler(req, ctx);
  const body = parseJson(res);

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.success, true);
  assert.ok(Array.isArray(body.suggestions), "suggestions should be an array");
});

// ---------------------------------------------------------------------------

test("POST returns 405 Method Not Allowed", async () => {
  const req = makeReq({ method: "POST" });
  const res = await suggestRefinementsHandler(req, ctx);
  const body = parseJson(res);

  assert.equal(res.status, 405);
  assert.equal(body.ok, false);
  assert.equal(body.success, false);
  assert.equal(body.error, "Method Not Allowed");
});
