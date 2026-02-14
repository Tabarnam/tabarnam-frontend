/**
 * _reviewScrape.js — Extract review/article metadata from a URL using XAI/Grok.
 *
 * Uses the xAI /v1/responses API with tools: [{ type: "web_search" }]
 * and a browse_page prompt to have Grok visit the specific URL and
 * extract metadata directly from the page content.
 */

const { getXAIEndpoint, getXAIKey, resolveXaiEndpointForModel } = require("./_shared");
const { extractTextFromXaiResponse } = require("./_xaiResponseFormat");

const MODEL = "grok-4-latest";
const TIMEOUT_MS = 60000;

const PROMPT_TEMPLATE = (url) =>
  `Use the browse_page tool on ${url} with instructions: Fetch the page content and confirm it loads publicly without errors or paywalls. If valid and containing review content, extract these fields if they exist:
- Source: Name of the publication, channel, or website (e.g., 'YouTube' or 'Healthline').
- Author: Author or channel name (from byline or uploader).
- URL: Return the provided URL as-is.
- Title: Exact title as published (article headline or video title).
- Date: Publication or upload date in any format (from metadata or text).
- Text: A 1-3 sentence excerpt or summary of the review content (directly from body/description; focus on key opinions; no additions).
If invalid, irrelevant, or not a review, return 'Invalid URL'. Output only the extracted fields in plain text, one per line, no markdown.`;

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
    return /\.azurewebsites\.net$/i.test(new URL(String(rawUrl || "")).hostname);
  } catch {
    return false;
  }
}

/**
 * Parse Grok's plain-text response into structured fields.
 * Expected format:
 *   Source: YouTube
 *   Author: Channel Name
 *   URL: https://...
 *   Title: Video Title
 *   Date: 2024-01-15
 *   Text: First sentence of the review...
 */
function parseFieldsFromText(text) {
  const lines = String(text || "").split("\n");
  const fields = {};

  for (const line of lines) {
    const match = line.match(/^(Source|Author|URL|Title|Date|Text)\s*:\s*(.+)/i);
    if (match) {
      fields[match[1].toLowerCase()] = match[2].trim();
    }
  }

  return fields;
}

/**
 * Extract text from an xAI /v1/responses response that used tools: [{ type: "web_search" }].
 *
 * When tools are used, the output array contains multiple items:
 *   output[0] = web_search_call (tool invocation — no text)
 *   output[N] = { type: "message", content: [{ type: "output_text", text: "..." }] }
 *
 * Per xAI docs, the final text is in the LAST output item.
 * We also check the top-level `output_text` convenience field first.
 */
function extractTextFromToolsResponse(data) {
  if (!data || typeof data !== "object") return "";

  // 1. Try top-level output_text convenience field (simplest path)
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text;
  }

  // 2. Iterate output array BACKWARDS to find the last message with output_text content
  if (Array.isArray(data.output)) {
    for (let i = data.output.length - 1; i >= 0; i--) {
      const item = data.output[i];
      if (!item || !item.content) continue;

      if (Array.isArray(item.content)) {
        const textItem = item.content.find((c) => c?.type === "output_text");
        if (textItem?.text && typeof textItem.text === "string" && textItem.text.trim()) {
          return textItem.text;
        }
      }

      // content is a string (unlikely but defensive)
      if (typeof item.content === "string" && item.content.trim()) {
        return item.content;
      }
    }
  }

  // 3. Fallback: try the shared extractor (handles /v1/chat/completions, other shapes)
  return extractTextFromXaiResponse(data);
}

async function scrapeReviewFromUrl(url) {
  const targetUrl = String(url || "").trim();
  if (!targetUrl) {
    return emptyResult("", "Missing url");
  }

  const resolvedBase = String(getXAIEndpoint() || "").trim();
  const key = String(getXAIKey() || "").trim();
  const apiUrl = resolveXaiEndpointForModel(resolvedBase, MODEL);

  if (!apiUrl || !key) {
    return emptyResult(targetUrl, "Missing XAI API configuration");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const headers = { "Content-Type": "application/json" };
    if (isAzureWebsitesUrl(apiUrl)) {
      headers["x-functions-key"] = key;
    } else {
      headers["Authorization"] = `Bearer ${key}`;
    }

    const payload = {
      model: MODEL,
      temperature: 0,
      input: [{ role: "user", content: PROMPT_TEMPLATE(targetUrl) }],
      tools: [{ type: "web_search" }],
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

    // Log raw response structure for debugging tools-based responses
    const outputTypes = Array.isArray(json.output)
      ? json.output.map((o, i) => `[${i}]=${o?.type || "unknown"}`).join(", ")
      : "no-output-array";
    console.log(
      `[reviewScrape] Response structure: output=[${outputTypes}], has_output_text=${typeof json.output_text === "string"}`
    );

    // Use local extractor that handles tools-based multi-item output arrays
    const responseText = extractTextFromToolsResponse(json);

    if (!responseText || !responseText.trim()) {
      console.log(`[reviewScrape] Empty response text for ${targetUrl}`);
      return emptyResult(targetUrl, "Empty response from XAI API");
    }

    // Check for "Invalid URL" response
    if (/invalid\s+url/i.test(responseText)) {
      return emptyResult(targetUrl, "Page is invalid or not a review");
    }

    // Parse plain-text fields from Grok's response
    console.log(`[reviewScrape] Extracted text (first 200 chars): ${responseText.slice(0, 200)}`);
    const fields = parseFieldsFromText(responseText);

    const title = String(fields.title || "").trim();
    const excerpt = String(fields.text || "").trim().slice(0, 500);
    const author = String(fields.author || "").trim();
    const date = String(fields.date || "").trim();
    const source_name = String(fields.source || "").trim();

    const hasContent = Boolean(title || excerpt);

    return {
      ok: hasContent,
      title,
      excerpt,
      author,
      date,
      source_name,
      source_url: fields.url || targetUrl,
      rating: null,
      strategy: "xai-browse",
      error: hasContent ? "" : "Could not extract meaningful content",
    };
  } catch (e) {
    return emptyResult(targetUrl, e?.message || String(e));
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { scrapeReviewFromUrl };
