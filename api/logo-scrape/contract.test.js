const test = require("node:test");
const assert = require("node:assert/strict");

const { handler } = require("./index.js");

function makeReq({ method = "POST", url = "https://example.test/api/logo-scrape", jsonBody } = {}) {
  const req = {
    method,
    url,
    headers: new Headers(),
    query: {},
  };
  if (jsonBody !== undefined) {
    req.json = async () => jsonBody;
    req.text = async () => JSON.stringify(jsonBody);
  } else {
    req.json = async () => ({});
    req.text = async () => "{}";
  }
  return req;
}

function ctx() {
  return { log() {} };
}

test("/api/logo-scrape handler is exported", () => {
  assert.ok(typeof handler === "function", "handler should be a function");
});

test("/api/logo-scrape OPTIONS returns CORS headers", async () => {
  const req = makeReq({ method: "OPTIONS" });
  const res = await handler(req, ctx());
  assert.equal(res.status, 200);
  assert.ok(res.headers);
  assert.ok(res.headers["Access-Control-Allow-Origin"]);
  assert.ok(res.headers["Access-Control-Allow-Methods"]);
  assert.ok(res.headers["Access-Control-Allow-Headers"]);
});

test("/api/logo-scrape POST without domain or url returns 400", async () => {
  const req = makeReq({ method: "POST", jsonBody: {} });
  const res = await handler(req, ctx());
  assert.equal(res.status, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.ok(body.error, "should include an error message");
  assert.match(body.error, /domain/i, "error should mention missing domain");
});

test("/api/logo-scrape POST with domain returns a well-formed result", async () => {
  const req = makeReq({ method: "POST", jsonBody: { domain: "example.com" } });
  const res = await handler(req, ctx());

  // Handler does network I/O; tolerate success (200), not-found (404), or error (500)
  assert.ok([200, 404, 500].includes(res.status), `unexpected status ${res.status}`);

  const body = JSON.parse(res.body);
  assert.equal(typeof body.ok, "boolean", "body.ok should be a boolean");
  assert.ok("domain" in body, "response should contain domain field");
  assert.equal(body.domain, "example.com");
});

test("/api/logo-scrape POST with website_url returns a well-formed result", async () => {
  const req = makeReq({ method: "POST", jsonBody: { website_url: "https://example.com" } });
  const res = await handler(req, ctx());

  assert.ok([200, 404, 500].includes(res.status), `unexpected status ${res.status}`);

  const body = JSON.parse(res.body);
  assert.equal(typeof body.ok, "boolean", "body.ok should be a boolean");
  assert.ok("website_url" in body, "response should contain website_url field");
  assert.equal(body.website_url, "https://example.com");
});

test("/api/logo-scrape GET does not crash", async () => {
  const req = makeReq({ method: "GET" });
  const res = await handler(req, ctx());

  // Handler does not explicitly reject GET; it will try to process the request.
  // Just verify it returns a valid response without throwing.
  assert.ok(typeof res.status === "number", "response should have a numeric status");
});

test("/api/logo-scrape POST with both domain and website_url returns a well-formed response", async () => {
  const req = makeReq({
    method: "POST",
    jsonBody: { domain: "example.com", website_url: "https://example.com" },
  });
  const res = await handler(req, ctx());

  assert.ok([200, 404, 500].includes(res.status), `unexpected status ${res.status}`);

  const body = JSON.parse(res.body);
  assert.equal(typeof body.ok, "boolean", "body.ok should be a boolean");
  assert.ok("domain" in body, "response should contain domain field");
  assert.ok("website_url" in body, "response should contain website_url field");
  assert.equal(body.domain, "example.com");
  assert.equal(body.website_url, "https://example.com");
});
