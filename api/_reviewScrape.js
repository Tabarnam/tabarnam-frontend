/**
 * _reviewScrape.js — Extract review/article metadata from a URL using XAI/Grok.
 *
 * Uses the same shared utilities as xaiLiveSearch (resolveXaiEndpointForModel,
 * getXAIKey, etc.) but builds the request directly to control temperature.
 * temperature: 0 ensures deterministic output — same URL always yields same result.
 */

const { getXAIEndpoint, getXAIKey, resolveXaiEndpointForModel } = require("./_shared");
const { extractTextFromXaiResponse, parseJsonFromResponse } = require("./_xaiResponseFormat");

const MODEL = "grok-3-fast";

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
- title: The article/video/review title exactly as it appears. Never include the site name suffix (e.g. "- YouTube").
- excerpt: The first 1-3 sentences of the article/review as they appear on the page (max 500 chars). Do not summarize or paraphrase — copy the opening text verbatim.
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

function isAzureWebsitesUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ""));
    return /\.azurewebsites\.net$/i.test(u.hostname);
  } catch {
    return false;
  }
}

async function scrapeReviewFromUrl(url) {
  const targetUrl = String(url || "").trim();
  if (!targetUrl) {
    return emptyResult("", "Missing url");
  }

  // Resolve endpoint using the same utilities as xaiLiveSearch
  const resolvedBase = String(getXAIEndpoint() || "").trim();
  const key = String(getXAIKey() || "").trim();
  const apiUrl = resolveXaiEndpointForModel(resolvedBase, MODEL);

  if (!apiUrl || !key) {
    return emptyResult(targetUrl, "Missing XAI API configuration");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    // Build auth headers (same pattern as xaiLiveSearch)
    const headers = { "Content-Type": "application/json" };
    if (isAzureWebsitesUrl(apiUrl)) {
      headers["x-functions-key"] = key;
    } else {
      headers["Authorization"] = `Bearer ${key}`;
    }

    // Build payload with temperature: 0 for deterministic output
    const payload = {
      model: MODEL,
      temperature: 0,
      input: [{ role: "user", content: PROMPT_TEMPLATE(targetUrl) }],
      search: { mode: "auto" },
    };

    const res = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      return emptyResult(targetUrl, `XAI API error (HTTP ${res.status})`);
    }

    const rawText = await res.text();
    let json;
    try {
      json = JSON.parse(rawText);
    } catch {
      json = { raw: rawText };
    }

    const text = extractTextFromXaiResponse(json);
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
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { scrapeReviewFromUrl };
