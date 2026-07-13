const assert = require("node:assert/strict");
const { test } = require("node:test");

if (process.env.TEST_VERBOSE !== "1") {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

const { handler } = require("./index.js");

const URL = "https://example.test/api/review-counts";
const ctx = { log: () => {} };

function makeReq({ method = "POST", body } = {}) {
  const req = { method, url: URL, headers: new Headers() };
  req.json = async () => {
    if (body === undefined) throw new Error("no body");
    return body;
  };
  return req;
}
const parse = (res) => (typeof res.body === "string" ? JSON.parse(res.body) : res.body);

test("handler is exported as a function", () => {
  assert.equal(typeof handler, "function");
});

test("OPTIONS returns 200 with CORS", async () => {
  const res = await handler(makeReq({ method: "OPTIONS" }), ctx);
  assert.equal(res.status, 200);
  assert.equal(res.headers["Access-Control-Allow-Origin"], "*");
});

test("non-POST is rejected", async () => {
  const res = await handler(makeReq({ method: "GET" }), ctx);
  assert.equal(res.status, 405);
});

test("invalid JSON returns 400", async () => {
  const res = await handler(makeReq({}), ctx);
  assert.equal(res.status, 400);
});

test("empty ids returns empty counts", async () => {
  const res = await handler(makeReq({ body: { ids: [] } }), ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(parse(res).counts, {});
});

test("returns an object of counts for provided ids (0 without Cosmos)", async () => {
  // No Cosmos in the contract-test env → get-reviews finds nothing → count 0.
  const res = await handler(makeReq({ body: { ids: ["c1", "c2", "c1", "", "  "] } }), ctx);
  assert.equal(res.status, 200);
  const body = parse(res);
  assert.equal(body.ok, true);
  assert.equal(typeof body.counts, "object");
  // Duplicates and blanks collapse to the two distinct ids.
  assert.deepEqual(Object.keys(body.counts).sort(), ["c1", "c2"]);
  assert.equal(body.counts.c1, 0);
});
