const assert = require("node:assert/strict");
const test = require("node:test");

const { _test } = require("../_adminRefreshReviews");

test("admin-refresh-reviews upstream payload caps excluded websites to 5 and spills to prompt", () => {
  assert.equal(typeof _test?.buildReviewsUpstreamPayload, "function");

  const prompt = "Find independent reviews about this company.";

  const built = _test.buildReviewsUpstreamPayload({
    prompt,
    companyWebsiteHost: "audiocontrol.com",
    model: "grok-4-latest",
  });

  assert.ok(built && typeof built === "object");
  assert.ok(built.payload && typeof built.payload === "object");

  const payload = built.payload;
  assert.equal(payload?.search_parameters?.mode, "on");

  const sources = payload?.search_parameters?.sources;
  assert.ok(Array.isArray(sources));

  const web = sources.find((s) => s?.type === "web");
  const news = sources.find((s) => s?.type === "news");

  assert.ok(Array.isArray(web?.excluded_websites));
  assert.ok(Array.isArray(news?.excluded_websites));

  assert.ok(web.excluded_websites.length <= 5);
  assert.ok(news.excluded_websites.length <= 5);

  const msg = Array.isArray(payload.messages) ? payload.messages[0] : null;
  assert.ok(typeof msg?.content === "string");
  assert.ok(msg.content.includes("Also avoid these websites"));
});
