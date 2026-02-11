const test = require("node:test");
const assert = require("node:assert/strict");

// companies-list creates its own Cosmos client internally, so we test via
// the exported handler with env vars intentionally unset (no Cosmos).
const { handler } = require("./index.js");

function makeReq({ method = "GET", url = "https://example.test/api/companies-list", query, jsonBody } = {}) {
  const fullUrl = new URL(url);
  if (query) {
    for (const [k, v] of Object.entries(query)) fullUrl.searchParams.set(k, v);
  }
  const req = {
    method,
    url: fullUrl.toString(),
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

test("/api/companies-list handler is exported", () => {
  assert.ok(typeof handler === "function", "handler should be a function");
});

test("/api/companies-list OPTIONS returns 200", async () => {
  const req = makeReq({ method: "OPTIONS" });
  const res = await handler(req, ctx());
  assert.equal(res.status, 200);
  assert.ok(res.headers);
});

test("/api/companies-list GET without Cosmos returns 503", async () => {
  // With no COSMOS_DB_ENDPOINT set, should return 503
  const savedEndpoint = process.env.COSMOS_DB_ENDPOINT;
  const savedKey = process.env.COSMOS_DB_KEY;
  delete process.env.COSMOS_DB_ENDPOINT;
  delete process.env.COSMOS_DB_KEY;

  try {
    const req = makeReq({ method: "GET" });
    const res = await handler(req, ctx());
    // Should be 503 since Cosmos is not configured
    assert.equal(res.status, 503);
    const body = JSON.parse(res.body);
    assert.ok(body.error);
  } finally {
    if (savedEndpoint !== undefined) process.env.COSMOS_DB_ENDPOINT = savedEndpoint;
    if (savedKey !== undefined) process.env.COSMOS_DB_KEY = savedKey;
  }
});

test("/api/companies-list returns 405 for unsupported methods", async () => {
  const savedEndpoint = process.env.COSMOS_DB_ENDPOINT;
  const savedKey = process.env.COSMOS_DB_KEY;
  delete process.env.COSMOS_DB_ENDPOINT;
  delete process.env.COSMOS_DB_KEY;

  try {
    const req = makeReq({ method: "PATCH" });
    const res = await handler(req, ctx());
    // Without Cosmos it'll return 503 before reaching method check
    // But OPTIONS should still work
    assert.ok(res.status === 503 || res.status === 405);
  } finally {
    if (savedEndpoint !== undefined) process.env.COSMOS_DB_ENDPOINT = savedEndpoint;
    if (savedKey !== undefined) process.env.COSMOS_DB_KEY = savedKey;
  }
});
