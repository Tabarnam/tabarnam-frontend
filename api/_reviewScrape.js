/**
 * _reviewScrape.js — Extract review/article metadata from a URL using XAI/Grok.
 *
 * Instead of fetching HTML and parsing meta tags (which fails on many sites
 * due to bot detection, JS rendering, and Azure Functions compression issues),
 * we send the URL to Grok which browses the page natively and extracts
 * structured metadata.
 *
 * Uses xaiLiveSearch (the proven production module with proper URL resolution,
 * auth handling, and timeout safety) rather than the lower-level xaiResponses.
 */

const { xaiLiveSearch, extractTextFromXaiResponse } = require("./_xaiLiveSearch");
const { parseJsonFromResponse } = require("./_xaiResponseFormat");

const PROMPT_TEMPLATE = (url) => `You are a metadata extraction assistant. Browse the following URL and extract review/article metadata.

URL: ${url}

Return valid JSON only. No markdown, no prose, no backticks.

Return EXACTLY this JSON structure:
{
  "title": "...",
  "excerpt": "...",
  "author": "...",
  "date": "YYYY-MM-DD",
  "source_name": "...",
  "rating": null
}

Rules:
- title: The article/video/review title. Never include the site name suffix (e.g. "- YouTube").
- excerpt: A 1-3 sentence summary or key quote from the content (max 500 chars).
- author: The author or channel name. Empty string if unknown.
- date: Publication date in YYYY-MM-DD format. Empty string if unknown.
- source_name: The publication/site/channel name (e.g. "YouTube", "Forbes", "TechCrunch").
- rating: Numeric rating if the review includes one (e.g. 4.5), otherwise null.
- If a field cannot be determined, use empty string (or null for rating).`;

function emptyResult(url, error) {
  return {
    ok: false,
    error: error || "",
    title: "",
    excerpt: "",
    author: "",
    date: "",
    source_name: "",
    source_url: String(url || ""),
    rating: null,
    strategy: "",
  };
}

async function scrapeReviewFromUrl(url) {
  const targetUrl = String(url || "").trim();
  if (!targetUrl) {
    return emptyResult("", "Missing url");
  }

  try {
    const result = await xaiLiveSearch({
      prompt: PROMPT_TEMPLATE(targetUrl),
      model: "grok-3-fast",
      timeoutMs: 30000,
      maxTokens: 900,
    });

    if (!result.ok) {
      const errMsg = result.error || "XAI request failed";
      return emptyResult(targetUrl, errMsg);
    }

    const text = extractTextFromXaiResponse(result.resp);
    const parsed = parseJsonFromResponse(text);

    if (!parsed || typeof parsed !== "object") {
      return emptyResult(targetUrl, "Failed to parse extraction response");
    }

    const title = String(parsed.title || "").trim();
    const excerpt = String(parsed.excerpt || "").trim().slice(0, 500);
    const author = String(parsed.author || "").trim();
    const date = String(parsed.date || "").trim();
    const source_name = String(parsed.source_name || "").trim();
    const rawRating = parsed.rating;
    const rating = typeof rawRating === "number" && Number.isFinite(rawRating) ? rawRating : null;

    const hasContent = Boolean(title || excerpt);

    return {
      ok: hasContent,
      title,
      excerpt,
      author,
      date,
      source_name,
      source_url: targetUrl,
      rating,
      strategy: "xai",
      error: hasContent ? "" : "Could not extract meaningful content",
    };
  } catch (e) {
    return emptyResult(targetUrl, e?.message || String(e));
  }
}

module.exports = { scrapeReviewFromUrl };
