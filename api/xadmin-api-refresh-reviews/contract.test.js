const assert = require("node:assert/strict");
const { test } = require("node:test");

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

test("/api/xadmin-api-refresh-reviews entrypoint returns 400 if company_id missing", async () => {
  assert.equal(typeof _test?.adminRefreshReviewsHandler, "function");

  const res = await _test.adminRefreshReviewsHandler(makeReq({ json: async () => ({ take: 5 }) }), { log() {} });

  assert.equal(res.status, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.error, "company_id required");
});
