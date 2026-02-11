const test = require("node:test");
const assert = require("node:assert/strict");

const { handler } = require("./index.js");

function makeReq({
  method = "PUT",
  url = "https://example.test/api/xadmin-api-logos/test-company-id",
  params = { companyId: "test-company-id" },
  jsonBody,
} = {}) {
  const req = {
    method,
    url,
    headers: new Headers(),
    params: params || {},
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
  return { log() {}, error() {} };
}

test("/api/xadmin-api-logos handler is exported", () => {
  assert.ok(typeof handler === "function", "handler should be a function");
});

test("/api/xadmin-api-logos OPTIONS returns CORS headers", async () => {
  const req = makeReq({ method: "OPTIONS" });
  const res = await handler(req, ctx());
  assert.equal(res.status, 200);
  assert.ok(res.headers);
  assert.ok(res.headers["Access-Control-Allow-Origin"]);
  assert.ok(res.headers["Access-Control-Allow-Methods"]);
  assert.ok(res.headers["Access-Control-Allow-Headers"]);
});

test("/api/xadmin-api-logos PUT without companyId returns 400", async () => {
  const req = makeReq({
    method: "PUT",
    params: {},
    jsonBody: { logo_url: "https://example.com/logo.png" },
  });
  const res = await handler(req, ctx());
  assert.equal(res.status, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.ok(body.error, "should contain an error message");
  assert.match(body.error, /companyId/i, "error should mention missing companyId");
});

test("/api/xadmin-api-logos PUT without logo_url returns 400", async () => {
  const req = makeReq({
    method: "PUT",
    jsonBody: {},
  });
  const res = await handler(req, ctx());
  assert.equal(res.status, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.ok(body.error, "should contain an error message");
  assert.match(body.error, /logo_url/i, "error should mention missing logo_url");
});

test("/api/xadmin-api-logos PUT with non-string logo_url returns 400", async () => {
  const req = makeReq({
    method: "PUT",
    jsonBody: { logo_url: 12345 },
  });
  const res = await handler(req, ctx());
  assert.equal(res.status, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.match(body.error, /logo_url/i, "error should mention invalid logo_url");
});

test("/api/xadmin-api-logos PUT with valid params returns well-formed error (no Cosmos config)", async () => {
  // Without COSMOS_DB_ENDPOINT / COSMOS_DB_KEY env vars the handler returns 500
  const req = makeReq({
    method: "PUT",
    jsonBody: { logo_url: "https://example.com/logo.png" },
  });
  const res = await handler(req, ctx());
  assert.equal(res.status, 500);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.ok(body.error, "should contain an error message");
  assert.match(body.error, /cosmos/i, "error should mention Cosmos DB");
});

test("/api/xadmin-api-logos invalid method falls through gracefully", async () => {
  // Handler only explicitly handles OPTIONS; other methods fall into the try block.
  // A GET with valid params but no Cosmos config should still return a well-formed JSON response.
  const req = makeReq({
    method: "GET",
    jsonBody: { logo_url: "https://example.com/logo.png" },
  });
  const res = await handler(req, ctx());
  assert.ok(typeof res.status === "number", "response should have a numeric status");
  const body = JSON.parse(res.body);
  assert.ok(typeof body === "object" && body !== null, "body should be an object");
  assert.equal(typeof body.ok, "boolean", "body.ok should be a boolean");
});

test("/api/xadmin-api-logos CORS headers present on JSON error responses", async () => {
  const req = makeReq({
    method: "PUT",
    params: {},
    jsonBody: { logo_url: "https://example.com/logo.png" },
  });
  const res = await handler(req, ctx());
  assert.equal(res.status, 400);
  assert.ok(res.headers["Access-Control-Allow-Origin"], "error responses should include CORS origin header");
  assert.ok(res.headers["Content-Type"], "error responses should include Content-Type header");
});
