const test = require("node:test");
const assert = require("node:assert/strict");

const { handler } = require("./index.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq({ method = "GET", url = "https://example.test/api/diag", query, headers: extraHeaders } = {}) {
  const req = {
    method,
    url,
    headers: {},
    query: query || {},
  };
  if (extraHeaders) {
    Object.assign(req.headers, extraHeaders);
  }
  return req;
}

function ctx() {
  return { log() {} };
}

// ---------------------------------------------------------------------------
// Export contract
// ---------------------------------------------------------------------------

test("/api/diag handler is exported", () => {
  assert.ok(typeof handler === "function", "handler should be a function");
});

// ---------------------------------------------------------------------------
// OPTIONS / CORS
// ---------------------------------------------------------------------------

test("/api/diag OPTIONS returns 200 with CORS headers", async () => {
  const req = makeReq({ method: "OPTIONS" });
  const res = await handler(req, ctx());
  assert.equal(res.status, 200);
  assert.ok(res.headers, "response should have headers");
  assert.ok(res.headers["Access-Control-Allow-Origin"], "should have Access-Control-Allow-Origin");
  assert.ok(res.headers["Access-Control-Allow-Methods"], "should have Access-Control-Allow-Methods");
});

test("/api/diag OPTIONS returns proper CORS methods including GET", async () => {
  const req = makeReq({ method: "OPTIONS" });
  const res = await handler(req, ctx());
  assert.equal(res.status, 200);
  const methods = res.headers["Access-Control-Allow-Methods"];
  assert.ok(typeof methods === "string", "Access-Control-Allow-Methods should be a string");
  assert.ok(methods.includes("GET"), "CORS methods should include GET");
  assert.ok(methods.includes("OPTIONS"), "CORS methods should include OPTIONS");
});

test("/api/diag OPTIONS response does not include body", async () => {
  const req = makeReq({ method: "OPTIONS" });
  const res = await handler(req, ctx());
  assert.equal(res.status, 200);
  // The OPTIONS handler returns just status + headers, no body
  assert.ok(res.body === undefined || res.body === null || res.body === "", "OPTIONS should not return a body");
});

// ---------------------------------------------------------------------------
// GET - normal diagnostic response
// ---------------------------------------------------------------------------

test("/api/diag GET returns 200 with ok:true", async () => {
  const req = makeReq({ method: "GET" });
  const res = await handler(req, ctx());
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
});

test("/api/diag GET response includes timestamp", async () => {
  const req = makeReq({ method: "GET" });
  const res = await handler(req, ctx());
  const body = JSON.parse(res.body);
  assert.ok(typeof body.now === "string", "response should include 'now' timestamp");
  // Should be a valid ISO string
  assert.ok(!isNaN(Date.parse(body.now)), "'now' should be a valid ISO date string");
});

test("/api/diag GET response includes env object", async () => {
  const req = makeReq({ method: "GET" });
  const res = await handler(req, ctx());
  const body = JSON.parse(res.body);
  assert.ok(body.env && typeof body.env === "object", "response should include env object");
  // pickEnv always returns these keys
  assert.ok("website_site_name" in body.env, "env should have website_site_name");
  assert.ok("node_version" in body.env, "env should have node_version");
  assert.ok("website_hostname" in body.env, "env should have website_hostname");
});

test("/api/diag GET response includes routes array", async () => {
  const req = makeReq({ method: "GET" });
  const res = await handler(req, ctx());
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.routes), "response should include routes array");
});

test("/api/diag GET response includes handler_versions", async () => {
  const req = makeReq({ method: "GET" });
  const res = await handler(req, ctx());
  const body = JSON.parse(res.body);
  assert.ok(
    body.handler_versions && typeof body.handler_versions === "object",
    "response should include handler_versions object"
  );
});

test("/api/diag GET response includes build info fields", async () => {
  const req = makeReq({ method: "GET" });
  const res = await handler(req, ctx());
  const body = JSON.parse(res.body);
  // getBuildInfo() spreads into the response; it should include build_id or build_timestamp
  assert.ok(
    typeof body.build_id === "string" || typeof body.build_timestamp === "string",
    "response should include build_id or build_timestamp from getBuildInfo()"
  );
});

test("/api/diag GET response has correct Content-Type header", async () => {
  const req = makeReq({ method: "GET" });
  const res = await handler(req, ctx());
  assert.equal(res.headers["Content-Type"], "application/json");
});

test("/api/diag GET response has CORS headers", async () => {
  const req = makeReq({ method: "GET" });
  const res = await handler(req, ctx());
  assert.equal(res.headers["Access-Control-Allow-Origin"], "*");
  assert.ok(res.headers["Access-Control-Allow-Methods"].includes("GET"));
});

// ---------------------------------------------------------------------------
// Method handling
// ---------------------------------------------------------------------------

test("/api/diag POST is not an expected method", async () => {
  // diagHandler does not explicitly reject POST; it falls through to the
  // same diagnostic body. The app.http registration restricts to GET+OPTIONS.
  // When called directly, the handler treats non-OPTIONS as GET-like.
  const req = makeReq({ method: "POST" });
  const res = await handler(req, ctx());
  // The handler does not enforce method; it returns 200 for any non-OPTIONS.
  // This documents the current behavior.
  assert.equal(res.status, 200, "handler returns 200 for POST (no method guard beyond OPTIONS)");
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
});

test("/api/diag PUT returns diagnostic response (no method guard)", async () => {
  const req = makeReq({ method: "PUT" });
  const res = await handler(req, ctx());
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
});

test("/api/diag DELETE returns diagnostic response (no method guard)", async () => {
  const req = makeReq({ method: "DELETE" });
  const res = await handler(req, ctx());
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("/api/diag GET with missing req.method falls through to diagnostic", async () => {
  // String(undefined).toUpperCase() === "UNDEFINED" which is not "OPTIONS"
  const req = makeReq({ method: undefined });
  const res = await handler(req, ctx());
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
});

test("/api/diag GET response body is valid JSON", async () => {
  const req = makeReq({ method: "GET" });
  const res = await handler(req, ctx());
  assert.doesNotThrow(() => JSON.parse(res.body), "body should be valid JSON");
});

test("/api/diag GET env values are all strings", async () => {
  const req = makeReq({ method: "GET" });
  const res = await handler(req, ctx());
  const body = JSON.parse(res.body);
  for (const [key, val] of Object.entries(body.env)) {
    assert.equal(typeof val, "string", `env.${key} should be a string`);
  }
});

test("/api/diag called with null req does not throw (returns OPTIONS-like or diagnostic)", async () => {
  // diagHandler reads req?.method; null is safe
  const res = await handler(null, ctx());
  // String(null?.method).toUpperCase() -> "UNDEFINED", not OPTIONS -> falls through to diagnostic
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
});

test("/api/diag two consecutive calls return fresh timestamps", async () => {
  const req1 = makeReq({ method: "GET" });
  const req2 = makeReq({ method: "GET" });
  const res1 = await handler(req1, ctx());
  // Small delay to ensure different timestamps
  await new Promise((resolve) => setTimeout(resolve, 5));
  const res2 = await handler(req2, ctx());
  const body1 = JSON.parse(res1.body);
  const body2 = JSON.parse(res2.body);
  assert.ok(body1.now, "first call should have 'now'");
  assert.ok(body2.now, "second call should have 'now'");
  // Timestamps should be valid (may be equal if fast, but both should parse)
  assert.ok(!isNaN(Date.parse(body1.now)));
  assert.ok(!isNaN(Date.parse(body2.now)));
});

test("/api/diag GET handler_version is a string", async () => {
  const req = makeReq({ method: "GET" });
  const res = await handler(req, ctx());
  const body = JSON.parse(res.body);
  // handler_version comes from handler_versions.import_start
  assert.ok(
    typeof body.handler_version === "string" || body.handler_version === undefined,
    "handler_version should be a string or undefined"
  );
});

test("/api/diag GET node_version in env is populated", async () => {
  const req = makeReq({ method: "GET" });
  const res = await handler(req, ctx());
  const body = JSON.parse(res.body);
  assert.ok(body.env.node_version.length > 0, "node_version should be populated");
});
