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

function makeReq({ url, method = "GET", headers, body } = {}) {
  const hdrs = new Headers();
  if (headers && typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined || v === null) continue;
      hdrs.set(k, String(v));
    }
  }
  const req = { method, url: url || "https://example.test/api/xadmin-api-login", headers: hdrs };
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
  const res = await handler(req, { log: () => {} });

  assert.equal(res.status, 200);
  assert.ok(res.headers, "should have headers");
  assert.equal(res.headers["Access-Control-Allow-Origin"], "https://my-app.test");
});

// ---------------------------------------------------------------------------
// 3. POST without credentials returns 400
// ---------------------------------------------------------------------------

test("POST without email/password returns 400", async () => {
  const req = makeReq({ method: "POST", body: {} });
  const res = await handler(req, { log: () => {} });

  assert.equal(res.status, 400);
  const data = parseJson(res);
  assert.equal(data.success, false);
  assert.match(data.error, /email and password/i);
});

// ---------------------------------------------------------------------------
// 4. POST with credentials but no ADMIN_CREDENTIALS configured returns 500
// ---------------------------------------------------------------------------

test("POST with credentials but no ADMIN_CREDENTIALS env returns 500", async () => {
  const savedCreds = process.env.ADMIN_CREDENTIALS;
  const savedPlain = process.env.ADMIN_PLAIN_CREDENTIALS;
  delete process.env.ADMIN_CREDENTIALS;
  delete process.env.ADMIN_PLAIN_CREDENTIALS;

  try {
    const req = makeReq({
      method: "POST",
      body: { email: "nobody@test.com", password: "whatever" },
    });
    const res = await handler(req, { log: () => {} });

    assert.equal(res.status, 500);
    const data = parseJson(res);
    assert.equal(data.success, false);
    assert.match(data.error, /not configured/i);
  } finally {
    if (savedCreds !== undefined) process.env.ADMIN_CREDENTIALS = savedCreds;
    else delete process.env.ADMIN_CREDENTIALS;
    if (savedPlain !== undefined) process.env.ADMIN_PLAIN_CREDENTIALS = savedPlain;
    else delete process.env.ADMIN_PLAIN_CREDENTIALS;
  }
});

// ---------------------------------------------------------------------------
// 5. POST with valid credentials returns 200 with token
// ---------------------------------------------------------------------------

test("POST with valid plain credentials returns 200 with token", async () => {
  const savedCreds = process.env.ADMIN_CREDENTIALS;
  const savedPlain = process.env.ADMIN_PLAIN_CREDENTIALS;
  delete process.env.ADMIN_CREDENTIALS;
  process.env.ADMIN_PLAIN_CREDENTIALS = "test@admin.com:secretpass";

  try {
    const req = makeReq({
      method: "POST",
      body: { email: "test@admin.com", password: "secretpass" },
    });
    const res = await handler(req, { log: () => {} });

    assert.equal(res.status, 200);
    const data = parseJson(res);
    assert.equal(data.success, true);
    assert.ok(data.token, "response should contain a token");
    assert.equal(typeof data.token, "string");
    // JWT has 3 dot-separated segments
    assert.equal(data.token.split(".").length, 3, "token should be a JWT");
  } finally {
    if (savedCreds !== undefined) process.env.ADMIN_CREDENTIALS = savedCreds;
    else delete process.env.ADMIN_CREDENTIALS;
    if (savedPlain !== undefined) process.env.ADMIN_PLAIN_CREDENTIALS = savedPlain;
    else delete process.env.ADMIN_PLAIN_CREDENTIALS;
  }
});

// ---------------------------------------------------------------------------
// 6. POST with wrong password returns 401
// ---------------------------------------------------------------------------

test("POST with wrong password returns 401", async () => {
  const savedCreds = process.env.ADMIN_CREDENTIALS;
  const savedPlain = process.env.ADMIN_PLAIN_CREDENTIALS;
  delete process.env.ADMIN_CREDENTIALS;
  process.env.ADMIN_PLAIN_CREDENTIALS = "test@admin.com:secretpass";

  try {
    const req = makeReq({
      method: "POST",
      body: { email: "test@admin.com", password: "wrongpass" },
    });
    const res = await handler(req, { log: () => {} });

    assert.equal(res.status, 401);
    const data = parseJson(res);
    assert.equal(data.success, false);
    assert.match(data.error, /invalid password/i);
  } finally {
    if (savedCreds !== undefined) process.env.ADMIN_CREDENTIALS = savedCreds;
    else delete process.env.ADMIN_CREDENTIALS;
    if (savedPlain !== undefined) process.env.ADMIN_PLAIN_CREDENTIALS = savedPlain;
    else delete process.env.ADMIN_PLAIN_CREDENTIALS;
  }
});
