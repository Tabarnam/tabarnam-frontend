/**
 * _reviewScrape.js — Extract review/article metadata from a URL using XAI/Grok.
 *
 * Uses xaiLiveSearch (the proven production module) with grok-4-latest
 * and search enabled. Grok browses the page via its built-in web_search
 * tool and extracts structured metadata as JSON.
 */

const { xaiLiveSearch, extractTextFromXaiResponse } = require("./_xaiLiveSearch");
const { parseJsonFromResponse } = require("./_xaiResponseFormat");

const PROMPT_TEMPLATE = (url) =>
  `What is the title, author, publication date, source/publication name, and opening text of this page: ${url}

Return valid JSON only, no other text:
{"title":"...","excerpt":"...","author":"...","date":"YYYY-MM-DD","source_name":"...","rating":null}

Rules:
- title: exact page title without site suffix (e.g. no "- YouTube")
- excerpt: first 1-3 sentences from the page verbatim (max 500 chars)
- author: author or channel name, empty string if unknown
- date: publication date as YYYY-MM-DD, empty string if unknown
- source_name: site or publication name (e.g. "YouTube", "Forbes")
- rating: numeric rating if present, otherwise null`;

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
      model: "grok-4-latest",
      timeoutMs: 30000,
      maxTokens: 900,
      search_parameters: { mode: "on" },
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
