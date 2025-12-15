const assert = require("node:assert/strict");

const { _test } = require("./index.js");

function makeReq({
  url = "https://example.test/api/import/start",
  method = "POST",
  json,
  body,
  rawBody,
  query,
} = {}) {
  const req = {
    method,
    url,
    headers: new Headers(),
  };

  if (typeof json === "function") req.json = json;
  if (body !== undefined) req.body = body;
  if (rawBody !== undefined) req.rawBody = rawBody;
  if (query !== undefined) req.query = query;

  return req;
}

async function withTempEnv(overrides, fn) {
  const original = {};
  for (const [k, v] of Object.entries(overrides)) {
    original[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }

  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function parseJsonResponse(res) {
  assert.ok(res);
  assert.equal(res.headers?.["Content-Type"] || res.headers?.["content-type"], "application/json");
  return JSON.parse(res.body);
}

const NO_NETWORK_ENV = {
  XAI_EXTERNAL_BASE: "",
  XAI_EXTERNAL_KEY: "",
  FUNCTION_URL: "",
  FUNCTION_KEY: "",
  COSMOS_DB_ENDPOINT: "",
  COSMOS_DB_KEY: "",
  COSMOS_DB_DB_ENDPOINT: "",
  COSMOS_DB_DB_KEY: "",
};

test("/api/import/start parses body with proxy=false boolean", async () => {
  await withTempEnv(NO_NETWORK_ENV, async () => {
    const req = makeReq({
      json: async () => ({
        proxy: false,
        debug: true,
        dry_run: true,
        company_name: "Test",
        website_url: "https://example.com",
      }),
    });

    const res = await _test.importStartHandler(req, { log() {} });
    const body = parseJsonResponse(res);

    assert.equal(body.company_name, "Test");
    assert.equal(body.website_url, "https://example.com");
    assert.notEqual(body.stage, "proxy_config");
  });
});

test("/api/import/start parses body with proxy='false' string", async () => {
  await withTempEnv(NO_NETWORK_ENV, async () => {
    const req = makeReq({
      body: JSON.stringify({
        proxy: "false",
        debug: true,
        dry_run: true,
        company_name: "Test",
        website_url: "https://example.com",
      }),
    });

    const res = await _test.importStartHandler(req, { log() {} });
    const body = parseJsonResponse(res);

    assert.equal(body.company_name, "Test");
    assert.equal(body.website_url, "https://example.com");
    assert.notEqual(body.stage, "proxy_config");
  });
});

test("/api/import/start respects query proxy=false when body has no proxy", async () => {
  await withTempEnv(NO_NETWORK_ENV, async () => {
    const rawBody = Buffer.from(
      JSON.stringify({
        debug: true,
        dry_run: true,
        company_name: "Test",
        website_url: "https://example.com",
      }),
      "utf8"
    );

    const req = makeReq({
      url: "https://example.test/api/import/start?proxy=false",
      rawBody,
      query: { proxy: "false" },
    });

    const res = await _test.importStartHandler(req, { log() {} });
    const body = parseJsonResponse(res);

    assert.equal(body.company_name, "Test");
    assert.equal(body.website_url, "https://example.com");
    assert.notEqual(body.stage, "proxy_config");
  });
});
