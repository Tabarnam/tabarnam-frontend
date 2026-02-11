const test = require("node:test");
const assert = require("node:assert/strict");

const { handler } = require("./index.js");

function makeReq({ method = "POST", url = "https://example.test/api/save-companies", query, jsonBody } = {}) {
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

test("/api/save-companies handler is exported", () => {
  assert.ok(typeof handler === "function", "handler should be a function");
});

test("/api/save-companies OPTIONS returns 200 with CORS", async () => {
  const req = makeReq({ method: "OPTIONS" });
  const res = await handler(req, ctx());
  assert.equal(res.status, 200);
  assert.ok(res.headers);
  assert.ok(res.headers["Access-Control-Allow-Origin"]);
});

test("/api/save-companies POST without body returns error", async () => {
  const req = makeReq({
    method: "POST",
    jsonBody: null,
  });
  const res = await handler(req, ctx());
  const body = JSON.parse(res.body);
  // Should fail gracefully when no companies provided
  assert.ok(res.status >= 400 || body.ok === false, "should reject empty body");
});

test("/api/save-companies POST with empty companies array returns error", async () => {
  const req = makeReq({
    method: "POST",
    jsonBody: { companies: [] },
  });
  const res = await handler(req, ctx());
  const body = JSON.parse(res.body);
  assert.ok(res.status >= 400 || body.ok === false, "should reject empty companies array");
});

test("/api/save-companies GET is not allowed", async () => {
  const req = makeReq({ method: "GET" });
  const res = await handler(req, ctx());
  // save-companies only accepts POST and OPTIONS
  assert.ok(res.status === 405 || res.status === 400 || res.status >= 400);
});
