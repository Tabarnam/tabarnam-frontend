const { test } = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("./index.js");

function makeReq({
  url = "https://example.test/api/xadmin-api-refresh-reviews",
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
    query: query || {},
  };

  if (typeof json === "function") req.json = json;
  if (body !== undefined) req.body = body;
  if (rawBody !== undefined) req.rawBody = rawBody;

  return req;
}

test("/api/xadmin-api-refresh-reviews returns 200 JSON ok:false if company_id missing", async () => {
  assert.equal(typeof _test?.handler, "function");

  const res = await _test.handler(makeReq({ json: async () => ({ take: 5 }) }), { log() {} });

  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.stage, "reviews_refresh");
  assert.equal(body.root_cause, "client_bad_request");
});
