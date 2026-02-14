let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}
const { scrapeReviewFromUrl } = require("../_reviewScrape");

function json(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "content-type,x-functions-key",
    },
    body: JSON.stringify(obj),
  };
}

async function reviewScrapeHandler(req, context) {
  const method = String(req.method || "").toUpperCase();
  if (method === "OPTIONS") {
    return {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "content-type,x-functions-key",
        "Access-Control-Max-Age": "86400",
      },
    };
  }

  const bodyObj = await req.json().catch(() => ({}));
  const url = String(bodyObj.url || "").trim();

  if (!url) {
    return json({ ok: false, error: "Missing url" }, 400);
  }

  try {
    const result = await scrapeReviewFromUrl(url);
    return json(result, result.ok ? 200 : 404);
  } catch (e) {
    return json({ ok: false, error: e?.message || String(e) }, 500);
  }
}

app.http("review-scrape", {
  route: "review-scrape",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: reviewScrapeHandler,
});

module.exports = { handler: reviewScrapeHandler };
