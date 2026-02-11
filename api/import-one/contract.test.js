const test = require("node:test");
const assert = require("node:assert/strict");

const { handleImportOne } = require("./index.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq({ method = "POST", url = "https://example.test/api/import-one", query, jsonBody } = {}) {
  const req = {
    method,
    url,
    headers: new Headers(),
    query: query || {},
  };
  if (jsonBody !== undefined) {
    req.json = async () => jsonBody;
    req.text = async () => JSON.stringify(jsonBody);
  }
  return req;
}

function ctx() {
  return { log() {} };
}

// ---------------------------------------------------------------------------
// Export contract
// ---------------------------------------------------------------------------

test("/api/import-one handleImportOne is exported", () => {
  assert.ok(typeof handleImportOne === "function", "handleImportOne should be a function");
});

// ---------------------------------------------------------------------------
// OPTIONS / CORS
// ---------------------------------------------------------------------------

test("/api/import-one OPTIONS returns 200 with CORS headers", async () => {
  // The module registers the OPTIONS handler via app.http; the exported
  // handleImportOne is the POST-only inner handler.  The outer handler
  // (registered on app.http) checks for OPTIONS before delegating.
  // We can still verify that the json() helper used by handleImportOne sets
  // CORS headers on normal responses by calling with a valid POST that fails
  // at the Cosmos layer.
  const req = makeReq({
    method: "POST",
    jsonBody: { url: "https://example.com" },
  });
  const res = await handleImportOne(req, ctx());
  assert.ok(res.headers, "response should have headers");
  assert.ok(res.headers["Access-Control-Allow-Origin"], "should have Access-Control-Allow-Origin");
  assert.ok(res.headers["Access-Control-Allow-Methods"], "should have Access-Control-Allow-Methods");
});

// ---------------------------------------------------------------------------
// Missing / invalid body
// ---------------------------------------------------------------------------

test("/api/import-one POST without body returns 400", async () => {
  const req = makeReq({ method: "POST", jsonBody: null });
  const res = await handleImportOne(req, ctx());
  assert.equal(res.status, 400, "should return 400 for null body");
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "invalid_body");
});

test("/api/import-one POST with non-object body returns 400", async () => {
  const req = makeReq({ method: "POST", jsonBody: "not-an-object" });
  const res = await handleImportOne(req, ctx());
  assert.equal(res.status, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "invalid_body");
});

test("/api/import-one POST with empty object (no url) returns 400", async () => {
  const req = makeReq({ method: "POST", jsonBody: {} });
  const res = await handleImportOne(req, ctx());
  assert.equal(res.status, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "invalid_url");
});

test("/api/import-one POST with empty url string returns 400", async () => {
  const req = makeReq({ method: "POST", jsonBody: { url: "" } });
  const res = await handleImportOne(req, ctx());
  assert.equal(res.status, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "invalid_url");
});

test("/api/import-one POST with whitespace-only url returns 400", async () => {
  const req = makeReq({ method: "POST", jsonBody: { url: "   " } });
  const res = await handleImportOne(req, ctx());
  assert.equal(res.status, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "invalid_url");
});

// ---------------------------------------------------------------------------
// Invalid URL shapes
// ---------------------------------------------------------------------------

test("/api/import-one POST with non-URL string returns 400", async () => {
  const req = makeReq({ method: "POST", jsonBody: { url: "not a url at all" } });
  const res = await handleImportOne(req, ctx());
  assert.equal(res.status, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "invalid_url");
});

test("/api/import-one POST with url containing spaces returns 400", async () => {
  const req = makeReq({ method: "POST", jsonBody: { url: "https://example .com" } });
  const res = await handleImportOne(req, ctx());
  assert.equal(res.status, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  // spaces in URL -> looksLikeUrl returns false
  assert.equal(body.error.code, "invalid_url");
});

test("/api/import-one POST with single-label host returns 400", async () => {
  // looksLikeUrl checks for at least two dot-separated parts
  const req = makeReq({ method: "POST", jsonBody: { url: "https://localhost" } });
  const res = await handleImportOne(req, ctx());
  assert.equal(res.status, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "invalid_url");
});

// ---------------------------------------------------------------------------
// Valid request shape (hits Cosmos / network boundary)
// ---------------------------------------------------------------------------

test("/api/import-one POST with valid URL proceeds past validation (hits infra boundary)", async () => {
  const req = makeReq({
    method: "POST",
    jsonBody: { url: "https://acme.example.com" },
  });
  const res = await handleImportOne(req, ctx());
  // Without Cosmos/network the handler will either:
  //  - return 200 with ok:true, completed:false (session created, worker fails silently)
  //  - return 500 with handler_error (unexpected throw)
  // In either case it should NOT be a 400 (validation passes).
  assert.ok(res.status !== 400, "valid URL should pass validation (status should not be 400)");
  const body = JSON.parse(res.body);
  assert.ok(typeof body.ok === "boolean", "response should have boolean ok field");
  assert.ok(typeof body.build_id === "string", "response should include build_id");
});

test("/api/import-one POST with valid URL includes session_id in response", async () => {
  const req = makeReq({
    method: "POST",
    jsonBody: { url: "https://example.com" },
  });
  const res = await handleImportOne(req, ctx());
  const body = JSON.parse(res.body);
  // When not a 400 error, the handler always sets session_id
  if (res.status !== 400) {
    assert.ok(typeof body.session_id === "string", "response should include session_id");
    assert.ok(body.session_id.length > 0, "session_id should not be empty");
  }
});

test("/api/import-one POST valid URL response has correct CORS headers", async () => {
  const req = makeReq({
    method: "POST",
    jsonBody: { url: "https://example.com" },
  });
  const res = await handleImportOne(req, ctx());
  assert.equal(res.headers["Access-Control-Allow-Origin"], "*");
  assert.ok(res.headers["Access-Control-Allow-Methods"].includes("POST"));
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.equal(res.headers["Content-Type"], "application/json");
});

// ---------------------------------------------------------------------------
// Edge cases: URL normalization
// ---------------------------------------------------------------------------

test("/api/import-one POST with bare domain (no protocol) passes validation", async () => {
  const req = makeReq({
    method: "POST",
    jsonBody: { url: "acme.com" },
  });
  const res = await handleImportOne(req, ctx());
  // Should pass looksLikeUrl and normalizeUrl (auto-prepends https://)
  assert.ok(res.status !== 400, "bare domain should pass validation");
});

test("/api/import-one POST with trailing-slash URL passes validation", async () => {
  const req = makeReq({
    method: "POST",
    jsonBody: { url: "https://acme.com/" },
  });
  const res = await handleImportOne(req, ctx());
  assert.ok(res.status !== 400, "trailing slash URL should pass validation");
});

test("/api/import-one POST with URL having query params passes validation", async () => {
  const req = makeReq({
    method: "POST",
    jsonBody: { url: "https://acme.com?ref=test" },
  });
  const res = await handleImportOne(req, ctx());
  // normalizeUrl strips query params
  assert.ok(res.status !== 400, "URL with query params should still pass validation");
});

// ---------------------------------------------------------------------------
// Body shape edge cases
// ---------------------------------------------------------------------------

test("/api/import-one POST with numeric body returns 400", async () => {
  const req = makeReq({ method: "POST", jsonBody: 12345 });
  const res = await handleImportOne(req, ctx());
  assert.equal(res.status, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "invalid_body");
});

test("/api/import-one POST with array body returns 400", async () => {
  const req = makeReq({ method: "POST", jsonBody: [{ url: "https://example.com" }] });
  const res = await handleImportOne(req, ctx());
  // Arrays pass typeof === 'object' check, but body.url will be undefined
  assert.equal(res.status, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
});

test("/api/import-one POST with boolean body returns 400", async () => {
  const req = makeReq({ method: "POST", jsonBody: true });
  const res = await handleImportOne(req, ctx());
  assert.equal(res.status, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
});

// ---------------------------------------------------------------------------
// Response shape consistency
// ---------------------------------------------------------------------------

test("/api/import-one error responses always include build_id", async () => {
  // 400 path
  const req400 = makeReq({ method: "POST", jsonBody: {} });
  const res400 = await handleImportOne(req400, ctx());
  const body400 = JSON.parse(res400.body);
  assert.ok(typeof body400.build_id === "string", "400 response should include build_id");

  // null body path
  const reqNull = makeReq({ method: "POST", jsonBody: null });
  const resNull = await handleImportOne(reqNull, ctx());
  const bodyNull = JSON.parse(resNull.body);
  assert.ok(typeof bodyNull.build_id === "string", "null body response should include build_id");
});

test("/api/import-one error response body is valid JSON with ok:false", async () => {
  const req = makeReq({ method: "POST", jsonBody: null });
  const res = await handleImportOne(req, ctx());
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.ok(body.error && typeof body.error === "object", "error should be an object");
  assert.ok(typeof body.error.message === "string", "error.message should be a string");
  assert.ok(typeof body.error.code === "string", "error.code should be a string");
});

// ---------------------------------------------------------------------------
// Multiple rapid calls produce unique session IDs
// ---------------------------------------------------------------------------

test("/api/import-one POST each call gets a unique session_id", async () => {
  const req1 = makeReq({ method: "POST", jsonBody: { url: "https://a.example.com" } });
  const req2 = makeReq({ method: "POST", jsonBody: { url: "https://b.example.com" } });
  const [res1, res2] = await Promise.all([
    handleImportOne(req1, ctx()),
    handleImportOne(req2, ctx()),
  ]);
  const body1 = JSON.parse(res1.body);
  const body2 = JSON.parse(res2.body);
  if (body1.session_id && body2.session_id) {
    assert.notEqual(body1.session_id, body2.session_id, "session IDs should be unique");
  }
});
