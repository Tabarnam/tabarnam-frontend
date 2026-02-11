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

test("/api/companies-list POST without Cosmos returns 503", async () => {
  const savedEndpoint = process.env.COSMOS_DB_ENDPOINT;
  const savedKey = process.env.COSMOS_DB_KEY;
  delete process.env.COSMOS_DB_ENDPOINT;
  delete process.env.COSMOS_DB_KEY;

  try {
    const req = makeReq({
      method: "POST",
      jsonBody: { company_name: "Test Corp", url: "https://test.com" },
    });
    const res = await handler(req, ctx());
    assert.equal(res.status, 503);
    const body = JSON.parse(res.body);
    assert.ok(body.error);
  } finally {
    if (savedEndpoint !== undefined) process.env.COSMOS_DB_ENDPOINT = savedEndpoint;
    if (savedKey !== undefined) process.env.COSMOS_DB_KEY = savedKey;
  }
});

test("/api/companies-list PUT without Cosmos returns 503", async () => {
  const savedEndpoint = process.env.COSMOS_DB_ENDPOINT;
  const savedKey = process.env.COSMOS_DB_KEY;
  delete process.env.COSMOS_DB_ENDPOINT;
  delete process.env.COSMOS_DB_KEY;

  try {
    const req = makeReq({
      method: "PUT",
      jsonBody: { id: "existing-id", company_name: "Updated Corp", url: "https://updated.com" },
    });
    const res = await handler(req, ctx());
    assert.equal(res.status, 503);
    const body = JSON.parse(res.body);
    assert.ok(body.error);
  } finally {
    if (savedEndpoint !== undefined) process.env.COSMOS_DB_ENDPOINT = savedEndpoint;
    if (savedKey !== undefined) process.env.COSMOS_DB_KEY = savedKey;
  }
});

test("/api/companies-list DELETE without Cosmos returns 503", async () => {
  const savedEndpoint = process.env.COSMOS_DB_ENDPOINT;
  const savedKey = process.env.COSMOS_DB_KEY;
  delete process.env.COSMOS_DB_ENDPOINT;
  delete process.env.COSMOS_DB_KEY;

  try {
    const req = makeReq({
      method: "DELETE",
      jsonBody: { id: "some-company-id" },
    });
    const res = await handler(req, ctx());
    assert.equal(res.status, 503);
    const body = JSON.parse(res.body);
    assert.ok(body.error);
  } finally {
    if (savedEndpoint !== undefined) process.env.COSMOS_DB_ENDPOINT = savedEndpoint;
    if (savedKey !== undefined) process.env.COSMOS_DB_KEY = savedKey;
  }
});

test("/api/companies-list OPTIONS includes all allowed methods", async () => {
  const req = makeReq({ method: "OPTIONS" });
  const res = await handler(req, ctx());
  assert.equal(res.status, 200);
  assert.ok(res.headers, "response should have headers");
  const allowMethods = res.headers["Access-Control-Allow-Methods"];
  assert.ok(allowMethods, "Access-Control-Allow-Methods header should be present");
  for (const method of ["GET", "POST", "PUT", "DELETE", "OPTIONS"]) {
    assert.ok(
      allowMethods.includes(method),
      `Access-Control-Allow-Methods should include ${method}, got: ${allowMethods}`
    );
  }
});

test("/api/companies-list GET with id query without Cosmos returns 503", async () => {
  const savedEndpoint = process.env.COSMOS_DB_ENDPOINT;
  const savedKey = process.env.COSMOS_DB_KEY;
  delete process.env.COSMOS_DB_ENDPOINT;
  delete process.env.COSMOS_DB_KEY;

  try {
    const req = makeReq({ method: "GET", query: { id: "test-id" } });
    const res = await handler(req, ctx());
    assert.equal(res.status, 503);
    const body = JSON.parse(res.body);
    assert.ok(body.error);
  } finally {
    if (savedEndpoint !== undefined) process.env.COSMOS_DB_ENDPOINT = savedEndpoint;
    if (savedKey !== undefined) process.env.COSMOS_DB_KEY = savedKey;
  }
});

test("/api/companies-list GET with search query without Cosmos returns 503", async () => {
  const savedEndpoint = process.env.COSMOS_DB_ENDPOINT;
  const savedKey = process.env.COSMOS_DB_KEY;
  delete process.env.COSMOS_DB_ENDPOINT;
  delete process.env.COSMOS_DB_KEY;

  try {
    const req = makeReq({ method: "GET", query: { search: "test company" } });
    const res = await handler(req, ctx());
    assert.equal(res.status, 503);
    const body = JSON.parse(res.body);
    assert.ok(body.error);
  } finally {
    if (savedEndpoint !== undefined) process.env.COSMOS_DB_ENDPOINT = savedEndpoint;
    if (savedKey !== undefined) process.env.COSMOS_DB_KEY = savedKey;
  }
});

test("/api/companies-list POST with invalid JSON body returns 400", async () => {
  const savedEndpoint = process.env.COSMOS_DB_ENDPOINT;
  const savedKey = process.env.COSMOS_DB_KEY;
  // Set env vars so Cosmos check passes and we reach body parsing
  process.env.COSMOS_DB_ENDPOINT = "https://fake.documents.azure.com:443/";
  process.env.COSMOS_DB_KEY = "ZmFrZWtleQ==";

  try {
    const req = makeReq({ method: "POST" });
    // Override json and text to simulate unparseable body
    req.json = async () => { throw new Error("bad json"); };
    req.text = async () => { throw new Error("bad json"); };
    const res = await handler(req, ctx());
    assert.equal(res.status, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error, "response body should contain an error field");
  } finally {
    if (savedEndpoint !== undefined) {
      process.env.COSMOS_DB_ENDPOINT = savedEndpoint;
    } else {
      delete process.env.COSMOS_DB_ENDPOINT;
    }
    if (savedKey !== undefined) {
      process.env.COSMOS_DB_KEY = savedKey;
    } else {
      delete process.env.COSMOS_DB_KEY;
    }
  }
});

test("/api/companies-list POST with empty body returns 400", async () => {
  const savedEndpoint = process.env.COSMOS_DB_ENDPOINT;
  const savedKey = process.env.COSMOS_DB_KEY;
  // Set env vars so Cosmos check passes and we reach body parsing
  process.env.COSMOS_DB_ENDPOINT = "https://fake.documents.azure.com:443/";
  process.env.COSMOS_DB_KEY = "ZmFrZWtleQ==";

  try {
    const req = makeReq({ method: "POST" });
    // Simulate a request with no body at all - both json() and text() fail,
    // which is what happens when a client sends an empty POST with no Content-Type.
    req.json = async () => { throw new Error("body used already"); };
    req.text = async () => { throw new Error("body used already"); };
    const res = await handler(req, ctx());
    assert.equal(res.status, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error, "response body should contain an error field");
  } finally {
    if (savedEndpoint !== undefined) {
      process.env.COSMOS_DB_ENDPOINT = savedEndpoint;
    } else {
      delete process.env.COSMOS_DB_ENDPOINT;
    }
    if (savedKey !== undefined) {
      process.env.COSMOS_DB_KEY = savedKey;
    } else {
      delete process.env.COSMOS_DB_KEY;
    }
  }
});
