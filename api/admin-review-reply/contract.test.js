const assert = require("node:assert/strict");
const { test } = require("node:test");

if (process.env.TEST_VERBOSE !== "1") {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

const { handler } = require("./index.js");

const URL = "https://example.test/api/xadmin-api-review-reply";
const ctx = { log: () => {} };

function makeReq({ method = "POST", body } = {}) {
  const req = { method, url: URL, headers: new Headers() };
  req.json = async () => {
    if (body === undefined) throw new Error("no body");
    return body;
  };
  return req;
}

function parse(res) {
  return typeof res.body === "string" ? JSON.parse(res.body) : res.body;
}

test("handler is exported as a function", () => {
  assert.equal(typeof handler, "function");
});

test("OPTIONS returns 200 with CORS headers", async () => {
  const res = await handler(makeReq({ method: "OPTIONS" }), ctx);
  assert.equal(res.status, 200);
  assert.equal(res.headers["Access-Control-Allow-Origin"], "*");
  assert.match(res.headers["Access-Control-Allow-Methods"], /POST/);
});

test("without Cosmos configured, returns 500", async () => {
  // No COSMOS_DB_* env in the contract-test environment → getReviewsContainer()
  // is null and the handler short-circuits before touching email.
  const res = await handler(makeReq({ body: { id: "r1" } }), ctx);
  assert.equal(res.status, 500);
  assert.match(parse(res).error, /Cosmos/);
});
