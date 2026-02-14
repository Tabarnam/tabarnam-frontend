const test = require("node:test");
const assert = require("node:assert/strict");

const { handler } = require("./index.js");

function makeReq({ method = "POST", url = "https://example.test/api/review-scrape", jsonBody } = {}) {
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

test("/api/review-scrape handler is exported", () => {
  assert.ok(typeof handler === "function", "handler should be a function");
});

test("/api/review-scrape OPTIONS returns CORS headers", async () => {
  const req = makeReq({ method: "OPTIONS" });
  const res = await handler(req, ctx());
  assert.equal(res.status, 200);
  assert.ok(res.headers);
  assert.ok(res.headers["Access-Control-Allow-Origin"]);
  assert.ok(res.headers["Access-Control-Allow-Methods"]);
  assert.ok(res.headers["Access-Control-Allow-Headers"]);
});

test("/api/review-scrape POST without url returns 400", async () => {
  const req = makeReq({ method: "POST", jsonBody: {} });
  const res = await handler(req, ctx());
  assert.equal(res.status, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.ok(body.error, "should include an error message");
  assert.match(body.error, /url/i, "error should mention missing url");
});

test("/api/review-scrape POST with url returns a well-formed result", async () => {
  const req = makeReq({ method: "POST", jsonBody: { url: "https://example.com" } });
  const res = await handler(req, ctx());

  // Handler does network I/O; tolerate success (200), not-found (404), or error (500)
  assert.ok([200, 404, 500].includes(res.status), `unexpected status ${res.status}`);

  const body = JSON.parse(res.body);
  assert.equal(typeof body.ok, "boolean", "body.ok should be a boolean");
  assert.ok("source_url" in body, "response should contain source_url field");
  assert.ok("title" in body, "response should contain title field");
  assert.ok("excerpt" in body, "response should contain excerpt field");
  assert.ok("author" in body, "response should contain author field");
  assert.ok("date" in body, "response should contain date field");
  assert.ok("source_name" in body, "response should contain source_name field");
  assert.ok("strategy" in body, "response should contain strategy field");
});

test("/api/review-scrape GET does not crash", async () => {
  const req = makeReq({ method: "GET" });
  const res = await handler(req, ctx());

  // Handler does not explicitly reject GET; just verify it returns a valid response without throwing.
  assert.ok(typeof res.status === "number", "response should have a numeric status");
});
