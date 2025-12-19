const assert = require("node:assert/strict");

const { _test } = require("./index.js");

function makeReq({
  url = "https://example.test/api/xadmin-api-refresh-company",
  method = "POST",
  json,
  body,
  rawBody,
} = {}) {
  const req = {
    method,
    url,
    headers: new Headers(),
  };

  if (typeof json === "function") req.json = json;
  if (body !== undefined) req.body = body;
  if (rawBody !== undefined) req.rawBody = rawBody;

  return req;
}

test("/api/xadmin-api-refresh-company entrypoint returns 400 if company_id missing", async () => {
  assert.equal(typeof _test?.adminRefreshCompanyHandler, "function");

  const res = await _test.adminRefreshCompanyHandler(
    makeReq({ json: async () => ({}) }),
    { log() {} }
  );

  assert.equal(res.status, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.error, "company_id required");
});
