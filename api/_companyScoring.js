/**
 * _companyScoring.js
 *
 * Computes reputation (star4) and quality (star5) scores for a company
 * using the existing xAI/Grok streaming integration.
 *
 * No web_search — scores from reviews and site content already captured.
 * Returns two 0.0–1.0 floats plus xAI-generated reasoning.
 * Bullet-point format (newline-separated, '- ' prefix), max 250 characters total, xAI-generated.
 */

const { xaiLiveSearchStreaming, extractTextFromXaiResponse } = require("./_xaiLiveSearch");
const { extractJsonFromText } = require("./_curatedReviewsXai");

// ── Tunable constants ──────────────────────────────────────────────────
// Edit these to adjust scoring behavior without touching logic.

const SCORING_SYSTEM_PROMPT = `Analyze the provided company data, captured reviews, and site content. Output **only** a clean JSON object with exactly these four fields:

{
  "reputation_score": number between 0.0 and 1.0,
  "reputation_reasoning": "2-5 short plain-English bullet points (max 250 characters total including newlines and '- ' prefixes). Each bullet MUST be a complete declarative sentence that explains what customers, editorial sources, or accreditation bodies actually say about the company's trustworthiness, service, ethics, or post-sale behavior. Good: '- Trustpilot reviewers consistently praise fast returns and responsive support.' '- BBB A+ accreditation with no unresolved complaints on file.' '- Reddit parenting threads repeatedly report gentle, effective results on infants.' Bad (do NOT produce): '- BBB A+ accredited' (fragment), '- Reviews from 6-7 users' (metadata about corpus), '- Positive reddit = no baby acne, no cradle cap' (regurgitated tokens).",
  "quality_score": number between 0.0 and 1.0,
  "quality_reasoning": "2-5 short plain-English bullet points (max 250 characters total including newlines and '- ' prefixes). Each bullet MUST be a complete declarative sentence about the product itself — materials, construction, durability, formulation, performance, or third-party testing. Good: '- Uses recycled ocean plastics and dermatologist-tested formulations.' '- Garments are woven from long-staple Egyptian cotton with reinforced stitching.' Bad (do NOT produce): '- Recycled ocean plastics' (fragment), '- Manufacturing star rating 0.5' (metadata)."
}

Strict rules:
- Base scores and bullets ONLY on what reviewers, editorial sources, accreditation bodies, or the company's own product/service materials actually say.
- NEVER cite star ratings, numeric scores, review counts, reviewer counts, or any metadata describing the data you were given.
- NEVER mention the company's headquarters location, manufacturing location, or country of origin in either reasoning field — those dimensions are scored separately.
- If the input contains no substantive signal, output fewer bullets (minimum 1, but only write a bullet you can back with evidence) and pull the corresponding score toward 0.
- Do NOT write filler bullets like "- no complaints in captured data", "- limited data available", or "- insufficient information". Omit the bullet instead.
- Default both scores toward 0 when evidence is thin. Be specific, balanced, and honest.
- Output only the JSON object. No preamble, no code fence, no trailing commentary.`;

const SCORING_MAX_TOKENS = 300;       // JSON + reasoning ≈ 200 tokens
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
  // Deliberately excluded from the prompt: star1/star2/star3 numeric ratings,
  // headquarters_location, manufacturing_locations count. Those are scored
  // elsewhere and were leaking into reputation/quality bullets when included
  // (e.g., "Manufacturing star rating 0.5" appearing in Quality reasoning).
  const industries = Array.isArray(company.industries) ? company.industries.join(", ") : "";
  const keywords = Array.isArray(company.product_keywords)
    ? company.product_keywords.map((k) => (typeof k === "string" ? k : k?.keyword || "")).filter(Boolean).join(", ")
    : "";

  const reviewsSummary = buildReviewsSummary(company);
  const aboutContent = buildAboutContent(company);

  const parts = [
    `Company: ${asString(company.company_name || company.name).trim()}`,
    `URL: ${asString(company.normalized_domain).trim()}`,
  ];

  if (industries) parts.push(`Industries: ${industries}`);
  if (keywords) parts.push(`Keywords: ${keywords}`);

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
 * @returns {Promise<{ok: boolean, reputation_score?: number, quality_score?: number, reputation_reasoning?: string, quality_reasoning?: string, reason?: string}>}
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
    console.log(`[scoring] Raw response for ${companyDoc.company_name}: ${(responseText || "(empty)").substring(0, 500)}`);

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

    // Use xAI-generated reasoning (bullet-point format, newline-separated), truncated to 250 chars
    const reputation_reasoning = (parsed.reputation_reasoning || "").substring(0, 250);
    const quality_reasoning = (parsed.quality_reasoning || "").substring(0, 250);

    console.log(`[scoring] Parsed for ${companyDoc.company_name}: rep=${parsed.reputation_score} → ${reputation_score}, qual=${parsed.quality_score} → ${quality_score}`);

    return {
      ok: true,
      reputation_score,
      quality_score,
      reputation_reasoning,
      quality_reasoning,
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
