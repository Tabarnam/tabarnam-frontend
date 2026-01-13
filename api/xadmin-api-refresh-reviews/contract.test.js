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

function makeCompaniesContainer(docById) {
  return {
    items: {
      query: (spec) => ({
        fetchAll: async () => {
          const id = spec?.parameters?.find((p) => p?.name === "@id")?.value;
          const doc = id ? docById[String(id)] : null;
          return { resources: doc ? [doc] : [] };
        },
      }),
    },
    item: () => ({
      patch: async () => ({ ok: true }),
    }),
  };
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

test("/api/xadmin-api-refresh-reviews returns 200 ok:false on upstream 500 html/text", async () => {
  assert.equal(typeof _test?.handler, "function");

  const companiesContainer = makeCompaniesContainer({
    company_1: {
      id: "company_1",
      company_name: "Acme Audio",
      website_url: "https://acme.example",
      normalized_domain: "acme.example",
      curated_reviews: [],
      review_cursor: {
        source: "xai_reviews",
        last_offset: 0,
        total_fetched: 0,
        exhausted: false,
      },
    },
  });

  const axiosPost = async () => {
    return {
      status: 500,
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
      data: "<html><body>Backend call failure</body></html>",
    };
  };

  const res = await _test.handler(
    makeReq({
      json: async () => ({
        company_id: "company_1",
        take: 2,
        timeout_ms: 5000,
      }),
    }),
    { log() {} },
    {
      companiesContainer,
      axiosPost,
      xaiUrl: "https://xai.test/api",
      xaiKey: "xai_test_key",
    }
  );

  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.stage, "reviews_refresh");
  assert.equal(body.root_cause, "bad_response_not_json");
  assert.equal(body.upstream_status, 500);

  assert.ok(Array.isArray(body.attempts));
  assert.ok(body.attempts.length >= 1);
  assert.equal(body.attempts[0].ok, false);
  assert.equal(body.attempts[0].root_cause, "bad_response_not_json");
  assert.equal(body.attempts[0].upstream_status, 500);

  assert.ok(body.upstream_body_diagnostics && typeof body.upstream_body_diagnostics === "object");
  assert.equal(body.upstream_body_diagnostics.raw_body_kind, "html");
  assert.ok(typeof body.upstream_body_diagnostics.raw_body_preview === "string");
});
