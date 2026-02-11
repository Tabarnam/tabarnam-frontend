const test = require("node:test");
const assert = require("node:assert/strict");

const { handler } = require("./index.js");

function makeReq({ method = "POST", url = "https://example.test/api/xadmin-api-geocode-location", jsonBody } = {}) {
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

test("/api/admin-geocode-location handler is exported", () => {
  assert.ok(typeof handler === "function", "handler should be a function");
});

test("/api/admin-geocode-location OPTIONS returns CORS headers", async () => {
  const req = makeReq({ method: "OPTIONS" });
  const res = await handler(req, ctx());
  assert.equal(res.status, 200);
  assert.ok(res.headers);
  assert.ok(res.headers["Access-Control-Allow-Origin"]);
  assert.ok(res.headers["Access-Control-Allow-Methods"]);
});

test("/api/admin-geocode-location POST with empty body returns 400", async () => {
  const req = makeReq({
    method: "POST",
    jsonBody: { location: "" },
  });
  const res = await handler(req, ctx());
  assert.equal(res.status, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.ok(body.error, "should contain an error message");
  assert.match(body.error, /location payload required/i);
});

test("/api/admin-geocode-location POST with location object returns result", async () => {
  const req = makeReq({
    method: "POST",
    jsonBody: { location: { address: "New York, NY" } },
  });
  const res = await handler(req, ctx());
  assert.ok(typeof res.status === "number", "status should be a number");
  const body = JSON.parse(res.body);
  assert.ok(typeof body === "object" && body !== null, "body should be an object");
  assert.ok(typeof body.ok === "boolean", "body.ok should be a boolean");
  if (body.ok) {
    assert.ok(body.location, "successful response should include location");
  } else {
    assert.ok(body.error || body.detail, "error response should include error or detail");
  }
});

test("/api/admin-geocode-location POST with address string shortcut", async () => {
  const req = makeReq({
    method: "POST",
    jsonBody: { address: "Chicago, IL" },
  });
  const res = await handler(req, ctx());
  assert.ok(typeof res.status === "number", "status should be a number");
  const body = JSON.parse(res.body);
  assert.ok(typeof body === "object" && body !== null, "body should be an object");
  assert.ok(typeof body.ok === "boolean", "body.ok should be a boolean");
});

test("/api/admin-geocode-location POST with force flag strips existing lat/lng", async () => {
  const req = makeReq({
    method: "POST",
    jsonBody: { location: { address: "Test", lat: 40.7, lng: -74.0 }, force: true },
  });
  const res = await handler(req, ctx());
  assert.ok(typeof res.status === "number", "status should be a number");
  const body = JSON.parse(res.body);
  assert.ok(typeof body === "object" && body !== null, "body should be an object");
  assert.ok(typeof body.ok === "boolean", "body.ok should be a boolean");
});

test("/api/admin-geocode-location GET method returns 405", async () => {
  const req = makeReq({ method: "GET" });
  const res = await handler(req, ctx());
  assert.equal(res.status, 405);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
});

test("/api/admin-geocode-location POST with location aliases", async () => {
  const req = makeReq({
    method: "POST",
    jsonBody: { loc: { address: "Test Location" } },
  });
  const res = await handler(req, ctx());
  assert.ok(typeof res.status === "number", "status should be a number");
  const body = JSON.parse(res.body);
  assert.ok(typeof body === "object" && body !== null, "body should be an object");
  assert.ok(typeof body.ok === "boolean", "body.ok should be a boolean");
});

test("/api/admin-geocode-location POST with custom timeoutMs", async () => {
  const req = makeReq({
    method: "POST",
    jsonBody: { location: { address: "Test" }, timeoutMs: 2000 },
  });
  const res = await handler(req, ctx());
  assert.ok(typeof res.status === "number", "status should be a number");
  const body = JSON.parse(res.body);
  assert.ok(typeof body === "object" && body !== null, "body should be an object");
  assert.ok(typeof body.ok === "boolean", "body.ok should be a boolean");
});
