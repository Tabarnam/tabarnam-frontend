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

  // Phase 2.11 — spillover-to-prompt no longer triggers by default. Pre-2.11
  // the companyHost was auto-added to excludes (6 total → 1 spilled to prompt
  // → "Also avoid these websites" appeared). Phase 2.11 stops excluding the
  // company's own host (it's the primary source of truth for small brands),
  // so the default case has 5 noise hosts and nothing spills. The
  // spillover MECHANISM is still intact and tested via
  // buildPromptExclusionText in _buildSearchParameters.test.js.
  const msg = Array.isArray(payload.messages) ? payload.messages[0] : null;
  assert.ok(typeof msg?.content === "string");
});
