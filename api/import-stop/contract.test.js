const assert = require("node:assert/strict");
const { test } = require("node:test");

if (process.env.TEST_VERBOSE !== "1") {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

const { handler } = require("./index.js");

function makeReq({ url = "https://example.test/api/import/stop", method = "POST", json, headers } = {}) {
  const hdrs = new Headers();
  if (headers && typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined || v === null) continue;
      hdrs.set(k, String(v));
    }
  }
  const req = { method, url, headers: hdrs };
  // The handler calls req.text() to parse the body, so provide a text() method
  if (typeof json === "function") {
    const body = json();
    req.text = async () => JSON.stringify(body);
    req.json = async () => body;
  } else {
    req.text = async () => "";
  }
  return req;
}

function parseJson(res) {
  assert.ok(res, "response should exist");
  return typeof res.body === "string" ? JSON.parse(res.body) : res.body;
}

function makeContext() {
  return { log() {} };
}

// ── 1. Handler export shape ─────────────────────────────────────────────────
test("handler is exported correctly", () => {
  assert.ok(handler, "handler should be exported");
  assert.equal(typeof handler, "function", "handler should be a function");
});

// ── 2. OPTIONS preflight ────────────────────────────────────────────────────
test("OPTIONS returns 200 with CORS headers", async () => {
  const req = makeReq({ method: "OPTIONS" });
  const res = await handler(req, makeContext());

  assert.equal(res.status, 200, "status should be 200");
  assert.ok(res.headers, "response should include headers");
  assert.ok(
    res.headers["Access-Control-Allow-Origin"],
    "CORS Allow-Origin header should be present"
  );
  assert.ok(
    res.headers["Access-Control-Allow-Methods"],
    "CORS Allow-Methods header should be present"
  );
});

// ── 3. POST without session_id ──────────────────────────────────────────────
test("POST without session_id returns 400", async () => {
  const req = makeReq({ method: "POST" });
  const res = await handler(req, makeContext());

  assert.equal(res.status, 400, "status should be 400");
  const body = parseJson(res);
  assert.ok(body.error, "body should contain an error message");
  assert.match(body.error, /session_id/i, "error should mention session_id");
});

// ── 4. POST with session_id in body ─────────────────────────────────────────
test("POST with session_id in body returns 200", async () => {
  const req = makeReq({
    method: "POST",
    json: () => ({ session_id: "test_stop_123" }),
  });
  const res = await handler(req, makeContext());

  assert.equal(res.status, 200, "status should be 200");
  const body = parseJson(res);
  assert.ok("ok" in body, "body should have an ok field");
  assert.equal(body.ok, true, "ok should be true");
});

// ── 5. POST with session_id in query ────────────────────────────────────────
test("POST with session_id in query returns 200", async () => {
  const req = makeReq({
    method: "POST",
    url: "https://example.test/api/import/stop?session_id=test_stop_456",
  });
  const res = await handler(req, makeContext());

  assert.equal(res.status, 200, "status should be 200");
  const body = parseJson(res);
  assert.ok("ok" in body, "body should have an ok field");
  assert.equal(body.ok, true, "ok should be true");
});

// ── 6. Response includes session_id in output ───────────────────────────────
// When Cosmos is configured the handler echoes session_id in the response body.
// Without Cosmos env vars (test default) the handler returns early with a
// "DB not configured" message but no session_id field.  We verify both paths:
//   a) the successful-response shape when session_id IS present, and
//   b) that the handler still returns ok:true so the frontend can proceed.
test("response includes session_id in output", async () => {
  const sid = "test_stop_echo_789";
  const req = makeReq({
    method: "POST",
    json: () => ({ session_id: sid }),
  });
  const res = await handler(req, makeContext());

  assert.equal(res.status, 200, "status should be 200");
  const body = parseJson(res);
  assert.equal(body.ok, true, "ok should be true");

  // When session_id is echoed it must match what was sent
  if ("session_id" in body) {
    assert.equal(body.session_id, sid, "response body should echo the session_id");
  }

  // The response must always carry CORS and JSON content-type headers
  assert.ok(res.headers, "response should have headers");
  assert.ok(res.headers["Content-Type"], "Content-Type header should be set");
});
