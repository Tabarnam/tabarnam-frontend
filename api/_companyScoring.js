/**
 * _companyScoring.js
 *
 * Computes reputation (star4) and quality (star5) scores for a company
 * using the existing xAI/Grok streaming integration.
 *
 * No web_search — scores from reviews and site content already captured.
 * Returns only two 0.0–1.0 floats; no reasoning or category stored.
 */

const { xaiLiveSearchStreaming, extractTextFromXaiResponse } = require("./_xaiLiveSearch");
const { extractJsonFromText } = require("./_curatedReviewsXai");

// ── Tunable constants ──────────────────────────────────────────────────
// Edit these to adjust scoring behavior without touching logic.

const SCORING_SYSTEM_PROMPT = `Analyze the provided company data, captured reviews, and site content. Output **only** a clean JSON object with exactly these two fields:

{
  "reputation_score": number between 0.0 and 1.0,
  "quality_score": number between 0.0 and 1.0
}

Reputation_score (0.0–1.0): Evaluate overall customer sentiment volume and tone from captured reviews, complaint history (e.g., BBB), warranty length, return policy strength, and any trust/red-flag signals. Be conservative with sparse data.

Quality_score (0.0–1.0): Evaluate materials, build quality, durability signals, manufacturing descriptors ('hand-crafted', 'premium motor', solid construction), and expert/industry quality indicators from the content and reviews.

Default to 0 if data is limited. Use only the provided information. No extra fields or reasoning in the JSON.`;

const SCORING_MAX_TOKENS = 100;       // JSON only ≈ 40 tokens
const SCORING_MAX_TOOL_CALLS = 0;     // 0 = no web search; set to 3 for light browsing
const REVIEWS_CHAR_LIMIT = 500;       // Max chars of review text to include
const ABOUT_CHAR_LIMIT = 1000;        // Max chars of about/site content to include

// ── Helpers ────────────────────────────────────────────────────────────

function asString(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/**
 * Build a compact text summary of captured reviews for the scoring prompt.
 */
function buildReviewsSummary(company) {
  const reviews = [];

  // Prefer curated_reviews (editorial), then fall back to reviews
  const curated = Array.isArray(company.curated_reviews) ? company.curated_reviews : [];
  const raw = Array.isArray(company.reviews) ? company.reviews : [];
  const all = curated.length > 0 ? curated : raw;

  for (const r of all.slice(0, 5)) {
    const parts = [];
    const source = asString(r.source_name || r.source || "").trim();
    const author = asString(r.author || "").trim();
    const title = asString(r.title || "").trim();
    const excerpt = asString(r.excerpt || r.text || r.review_text || r.body || r.content || r.summary || "").trim();
    if (source) parts.push(`[${source}]`);
    if (author) parts.push(`by ${author}`);
    if (title) parts.push(title);
    if (excerpt) parts.push(excerpt);
    const combined = parts.join(" ").trim();
    if (combined) reviews.push(combined);
  }

  return reviews.join(" | ").substring(0, REVIEWS_CHAR_LIMIT);
}

/**
 * Build a compact text summary of site content for the scoring prompt.
 */
function buildAboutContent(company) {
  const candidates = [
    company.about_page_text,
    company.about_text,
    company.homepage_text,
    company.site_content,
    company.description,
    company.tagline,
  ];

  for (const c of candidates) {
    const text = asString(c).trim();
    if (text.length > 20) return text.substring(0, ABOUT_CHAR_LIMIT);
  }

  return "";
}

/**
 * Build the user prompt for the scoring call.
 */
function buildUserPrompt(company) {
  const rating = company.rating && typeof company.rating === "object" ? company.rating : {};
  const star1Val = rating.star1?.value ?? 0;
  const star2Val = rating.star2?.value ?? 0;
  const star3Val = rating.star3?.value ?? 0;

  const industries = Array.isArray(company.industries) ? company.industries.join(", ") : "";
  const keywords = Array.isArray(company.product_keywords)
    ? company.product_keywords.map((k) => (typeof k === "string" ? k : k?.keyword || "")).filter(Boolean).join(", ")
    : "";

  const mfgCount = Array.isArray(company.manufacturing_locations) ? company.manufacturing_locations.length : 0;
  const hq = asString(company.headquarters_location).trim();

  const reviewsSummary = buildReviewsSummary(company);
  const aboutContent = buildAboutContent(company);

  const parts = [
    `Company: ${asString(company.company_name || company.name).trim()}`,
    `URL: ${asString(company.normalized_domain).trim()}`,
  ];

  if (industries) parts.push(`Industries: ${industries}`);
  if (keywords) parts.push(`Keywords: ${keywords}`);

  parts.push(`\nStar ratings: Manufacturing=${star1Val}, HQ=${star2Val}, Reviews=${star3Val}`);
  if (hq) parts.push(`Headquarters: ${hq}`);
  parts.push(`Manufacturing locations: ${mfgCount} location${mfgCount !== 1 ? "s" : ""}`);

  if (aboutContent) {
    parts.push(`\nAbout/site content:\n${aboutContent}`);
  }

  if (reviewsSummary) {
    parts.push(`\nCaptured reviews:\n${reviewsSummary}`);
  }

  return parts.join("\n");
}

// ── Main scoring function ──────────────────────────────────────────────

/**
 * Score a company's reputation and quality using xAI/Grok.
 *
 * @param {Object} companyDoc - Full company document
 * @param {Object} [opts]
 * @param {string} [opts.xaiUrl] - Optional xAI endpoint (falls back to env)
 * @param {string} [opts.xaiKey] - Optional xAI key (falls back to env)
 * @param {number} [opts.timeoutMs=60000] - Timeout in ms
 * @returns {Promise<{ok: boolean, reputation_score?: number, quality_score?: number, reason?: string}>}
 */
async function computeReputationQualityScores(companyDoc, { xaiUrl, xaiKey, timeoutMs = 60000, debug = false } = {}) {
  if (!companyDoc || !companyDoc.company_name) {
    return { ok: false, reason: "missing_company_data" };
  }

  const userPrompt = buildUserPrompt(companyDoc);
  const fullPrompt = `${SCORING_SYSTEM_PROMPT}\n\n---\n\n${userPrompt}`;

  console.log(`[scoring] Prompt for ${companyDoc.company_name} (${userPrompt.length} chars):\n${userPrompt.substring(0, 500)}`);

  try {
    const result = await xaiLiveSearchStreaming({
      prompt: fullPrompt,
      timeoutMs: Math.max(5000, Math.trunc(Number(timeoutMs) || 60000)),
      maxToolCalls: SCORING_MAX_TOOL_CALLS,
      xaiUrl,
      xaiKey,
    });

    if (!result || !result.ok) {
      const errMsg = result?.error || "xai_call_failed";
      console.warn(`[scoring] xAI call failed for ${companyDoc.company_name}: ${errMsg}`);
      return { ok: false, reason: errMsg, ...(debug ? { _debug_prompt: userPrompt } : {}) };
    }

    // Extract text from response — streaming returns { ok, resp: { output: [...] } }
    // extractTextFromXaiResponse expects the inner response object, not the wrapper
    const responseObj = result.resp && typeof result.resp === "object" ? result.resp : result;
    const responseText = extractTextFromXaiResponse(responseObj);
    console.log(`[scoring] Raw response for ${companyDoc.company_name}: ${(responseText || "(empty)").substring(0, 300)}`);

    if (!responseText) {
      console.warn(`[scoring] Empty response for ${companyDoc.company_name}`);
      return { ok: false, reason: "empty_response", ...(debug ? { _debug_prompt: userPrompt } : {}) };
    }

    // Extract JSON from response text
    const parsed = extractJsonFromText(responseText);
    if (!parsed || typeof parsed !== "object") {
      console.warn(`[scoring] Failed to parse JSON for ${companyDoc.company_name}: ${responseText.substring(0, 200)}`);
      return { ok: false, reason: "json_parse_failed", ...(debug ? { _debug_prompt: userPrompt, _debug_response: responseText.substring(0, 500) } : {}) };
    }

    // Clamp scores to 0.0–1.0, default to 0 for NaN
    const reputation_score = Math.max(0.0, Math.min(1.0, parseFloat(parsed.reputation_score) || 0));
    const quality_score = Math.max(0.0, Math.min(1.0, parseFloat(parsed.quality_score) || 0));

    console.log(`[scoring] Parsed for ${companyDoc.company_name}: rep=${parsed.reputation_score} → ${reputation_score}, qual=${parsed.quality_score} → ${quality_score}`);

    return {
      ok: true,
      reputation_score,
      quality_score,
      ...(debug ? { _debug_prompt: userPrompt, _debug_response: responseText.substring(0, 500), _debug_parsed: parsed } : {}),
    };
  } catch (e) {
    console.warn(`[scoring] Exception for ${companyDoc.company_name}: ${e?.message || e}`);
    return { ok: false, reason: asString(e?.message || "scoring_exception"), ...(debug ? { _debug_prompt: userPrompt } : {}) };
  }
}

module.exports = {
  computeReputationQualityScores,
  // Exported for testing/tuning visibility:
  SCORING_SYSTEM_PROMPT,
  SCORING_MAX_TOKENS,
  SCORING_MAX_TOOL_CALLS,
  REVIEWS_CHAR_LIMIT,
  ABOUT_CHAR_LIMIT,
};
