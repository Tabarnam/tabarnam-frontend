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

test("xadmin refresh reviews upstream payload caps excluded websites to 5 and spills to prompt", () => {
  assert.equal(typeof _test?._internals?.buildReviewsUpstreamPayload, "function");

  const company = {
    company_name: "AudioControl",
    website_url: "https://audiocontrol.com",
  };

  const built = _test._internals.buildReviewsUpstreamPayload({
    company,
    offset: 0,
    limit: 3,
    model: "grok-4-latest",
  });

  assert.ok(built && typeof built === "object");
  assert.ok(built.payload && typeof built.payload === "object");

  const payload = built.payload;

  assert.equal(payload?.search_parameters?.mode, "on");
  assert.ok(Array.isArray(payload?.search_parameters?.sources));

  const web = payload.search_parameters.sources.find((s) => s?.type === "web");
  const news = payload.search_parameters.sources.find((s) => s?.type === "news");

  assert.ok(Array.isArray(web?.excluded_websites));
  assert.ok(Array.isArray(news?.excluded_websites));
  assert.ok(web.excluded_websites.length <= 5);
  assert.ok(news.excluded_websites.length <= 5);

  const user = Array.isArray(payload.messages) ? payload.messages.find((m) => m?.role === "user") : null;
  assert.ok(typeof user?.content === "string");
  assert.ok(user.content.includes("Also avoid these websites"));
});
