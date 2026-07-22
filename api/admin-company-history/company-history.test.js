const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("./index.js");

// With Cosmos unconfigured the handler returns 503 ("Cosmos DB not configured").
// So "not 400" proves company_id WAS parsed; 400 means it came back empty.
// Regression: req.query is a URLSearchParams in the Functions v4 model, but the
// helper read it as a plain object, so every query-param request 400'd with
// "company_id required".
const CID = "company_1784650396265_9z7aesia4s";
const ctx = { log() {} };

async function run(req) {
  const res = await _test.handler(req, ctx);
  return { status: res.status, body: JSON.parse(res.body) };
}

test("company-history: reads company_id from a v4 URLSearchParams query", async () => {
  const req = {
    method: "GET",
    url: `https://x.test/api/xadmin-api-company-history?company_id=${CID}&limit=25`,
    query: new URLSearchParams({ company_id: CID, limit: "25" }),
  };
  const { status, body } = await run(req);
  assert.notEqual(status, 400, `should not 400; got ${status} ${JSON.stringify(body)}`);
  assert.notEqual(body.error, "company_id required");
});

test("company-history: still reads a v3 plain-object query", async () => {
  const req = {
    method: "GET",
    url: `https://x.test/api/xadmin-api-company-history?company_id=${CID}`,
    query: { company_id: CID, limit: "25" },
  };
  const { status, body } = await run(req);
  assert.notEqual(status, 400, `should not 400; got ${status} ${JSON.stringify(body)}`);
  assert.notEqual(body.error, "company_id required");
});

test("company-history: falls back to parsing the raw url", async () => {
  const req = {
    method: "GET",
    url: `https://x.test/api/xadmin-api-company-history?company_id=${CID}&limit=25`,
    // no usable query object at all
  };
  const { status, body } = await run(req);
  assert.notEqual(status, 400, `should not 400; got ${status} ${JSON.stringify(body)}`);
  assert.notEqual(body.error, "company_id required");
});

test("company-history: still 400s when company_id is genuinely absent", async () => {
  const req = {
    method: "GET",
    url: "https://x.test/api/xadmin-api-company-history?limit=25",
    query: new URLSearchParams({ limit: "25" }),
  };
  const { status, body } = await run(req);
  assert.equal(status, 400);
  assert.equal(body.error, "company_id required");
});

test("company-history: route-param (bindingData) path still works", async () => {
  const req = { method: "GET", url: "https://x.test/api/admin/companies/x/history", query: new URLSearchParams() };
  const { status, body } = await run(req, { ...ctx });
  // bindingData carries the id in the route-based registration
  const res2 = await _test.handler(req, { log() {}, bindingData: { company_id: CID } });
  const body2 = JSON.parse(res2.body);
  assert.notEqual(res2.status, 400, `route param should not 400; got ${res2.status}`);
  assert.notEqual(body2.error, "company_id required");
  // sanity: without any id it does 400
  assert.equal(status, 400, `expected 400 without id, got ${status} ${JSON.stringify(body)}`);
});
