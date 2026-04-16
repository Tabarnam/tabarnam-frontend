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
const crypto = require("crypto");

// ── Tunable constants ──────────────────────────────────────────────────
// Edit these to adjust scoring behavior without touching logic.

const SCORING_SYSTEM_PROMPT = `Analyze the provided company data, captured reviews, site content, and admin notes. Output **only** a clean JSON object with exactly these four fields:

{
  "reputation_score": number between 0.0 and 1.0,
  "reputation_reasoning": "1-5 terse bullet points (max 250 characters total, including newlines). Each bullet must start with '- '. Bullets may be fragments or short phrases — prose sentences not required. Cite only signals that appear IN the provided reviews and site snippet. Good: '- Forbes: synonymous with exceptional customer service', '- Positive reddit = no baby acne, no cradle cap, soft clear skin', '- Trustpilot complaints about VAT taxes', '- NYT: ended lifetime guarantee due to policy abuse'. No filler, no hedging, no vague phrases like 'garners' or 'aligning with'.",
  "quality_score": number between 0.0 and 1.0,
  "quality_reasoning": "1-5 terse bullet points (max 250 characters total, including newlines). Each bullet must start with '- '. Bullets may be fragments or short phrases. Cite only signals that appear IN the provided reviews and site snippet about the product itself — materials, construction, durability, formulation, performance. Good: '- Recycled ocean plastics per About page', '- Reviewers praise Class-D amplification, full bass, inviting midrange', '- 100% long-staple cotton, pill-resistant in lab tests (per review)'. No filler, no hedging."
}

Strict rules:
- You are scoring from a narrow slice of data: a handful of editorial review excerpts, a short About/homepage snippet, and (optionally) admin notes left by Tabarnam moderators. You have NOT browsed the company's full site, you have NOT checked BBB, you have NOT looked up certifications. Do not claim things are missing. Only cite what the provided data actually contains.
- Base scores and bullets ONLY on what the provided reviews, site snippet, and admin notes actually say.
- Admin notes (when present) are authoritative signal from Tabarnam moderators who have reviewed this company's situation directly. Treat them as high-priority evidence: if an admin note reports a concrete positive or negative signal, cite it in the matching star's bullets (prefix source as '- Admin note:' when the bullet originates from a note) and let it move the score accordingly. Notes attached to star4 inform reputation; notes attached to star5 inform quality. Do not ignore admin notes even if other captured data is thin.
- NEVER cite star ratings, numeric scores, review counts, reviewer counts, or any other metadata describing the data you were given (bad: '- Reviews from 6-7 users', '- Reviews star rating of 1').
- NEVER mention the company's headquarters location, manufacturing location, or country of origin in either reasoning field — those dimensions are scored separately.
- NEVER write absence bullets. Forbidden patterns: '- No BBB accreditation', '- No warranty signals', '- No third-party testing', '- No independent reviews captured', '- No certifications referenced', '- Marketing-only content'. We didn't look for those things, so their absence from the provided data is not evidence. Similarly forbidden: pure filler like '- limited data available' or '- insufficient information'.
- A valid negative bullet MUST cite a concrete negative signal that appears IN the provided data: a complaint from a review ('- Trustpilot complaints about sheets tearing'), a recall ('- 2023 recall for lead contamination'), a controversy ('- NYT reports ending lifetime guarantee due to abuse'), or mixed review sentiment ('- Reviewers report inconsistent sizing'). No concrete negative in the data = no negative bullet.
- Score the evidence as it actually reads:
  - Uniformly positive signal in the data → 0.6–0.9
  - Mixed signal (both positives and negatives present) → 0.35–0.65
  - Uniformly negative concrete signal → 0.05–0.25
  - Thin data with only weak/light positives and no negatives → 0.25–0.45
  - Essentially no substantive signal → around 0.25
- If the data is thin, output fewer bullets (minimum 1) citing only what IS there. Do not invent absences to justify a low score — the 0.25 baseline already handles thin data.
- Tabarnam's job is to give consumers an honest picture of what the captured data shows, not to cheerlead and not to fabricate weaknesses. Balanced bullets that reflect the actual data win.
- Output only the JSON object. No preamble, no code fence, no trailing commentary.`;

const SCORING_MAX_TOKENS = 300;       // JSON + reasoning ≈ 200 tokens
const SCORING_MAX_TOOL_CALLS = 0;     // 0 = no web search; set to 3 for light browsing
const REVIEWS_CHAR_LIMIT = 500;       // Max chars of review text to include
const ABOUT_CHAR_LIMIT = 1000;        // Max chars of about/site content to include

// xAI prefix caching: conversation_id lets xAI cache the shared system prompt
// across scoring calls, reducing token cost during batch rescoring.
// Enable by setting XAI_SCORING_CONV_ID to any truthy value (e.g. "1").
// The conversation_id is derived from a SHA-256 hash of the system prompt, so
// it automatically invalidates when the prompt changes.
const SCORING_CONVERSATION_ID = (() => {
  const flag = (process.env.XAI_SCORING_CONV_ID || "").trim();
  if (!flag || flag === "0" || flag.toLowerCase() === "false") return null;
  const hash = crypto.createHash("sha256").update(SCORING_SYSTEM_PROMPT).digest("hex").substring(0, 16);
  return `tabarnam-scoring-${hash}`;
})();

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
 * Build a compact text summary of admin notes attached to star4 (reputation)
 * and star5 (quality). Notes are authoritative ground truth from Tabarnam
 * moderators and should factor into both scores and reasoning bullets.
 *
 * Returns { star4Text, star5Text, combinedText }. combinedText is used for
 * the skip-call length check; star4Text/star5Text are emitted as labeled
 * sections in the user prompt so Grok can attribute them to the right star.
 */
function buildAdminNotes(company) {
  const rating = company && typeof company.rating === "object" && company.rating !== null ? company.rating : {};

  const pluckNoteTexts = (star) => {
    const notes = Array.isArray(star?.notes) ? star.notes : [];
    const out = [];
    for (const n of notes) {
      const text = asString(n?.text).trim();
      if (!text) continue;
      const visibility = n?.is_public ? "public" : "private";
      out.push(`(${visibility}) ${text}`);
    }
    return out;
  };

  const star4Notes = pluckNoteTexts(rating.star4);
  const star5Notes = pluckNoteTexts(rating.star5);

  const star4Text = star4Notes.join("\n- ");
  const star5Text = star5Notes.join("\n- ");
  const combinedText = [...star4Notes, ...star5Notes].join(" | ");

  return {
    star4Text: star4Text ? `- ${star4Text}` : "",
    star5Text: star5Text ? `- ${star5Text}` : "",
    combinedText,
  };
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
  const adminNotes = buildAdminNotes(company);

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

  if (adminNotes.star4Text) {
    parts.push(`\nAdmin notes on reputation (star4) — authoritative Tabarnam moderator input:\n${adminNotes.star4Text}`);
  }

  if (adminNotes.star5Text) {
    parts.push(`\nAdmin notes on quality (star5) — authoritative Tabarnam moderator input:\n${adminNotes.star5Text}`);
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

  // Skip-call short-circuit: if we have essentially no reviews AND no about/site content
  // AND no admin notes, the xAI call will produce low-quality hedged output. Return an
  // insufficient-info result directly and save the tokens. Threshold is low (40 chars)
  // to avoid skipping companies that have even a single short review, tagline, or admin
  // note worth scoring against. Admin notes always bypass the skip — if an admin took
  // the time to write one, we want the model to factor it in.
  const reviewsSummary = buildReviewsSummary(companyDoc);
  const aboutContent = buildAboutContent(companyDoc);
  const adminNotes = buildAdminNotes(companyDoc);
  if (
    reviewsSummary.length < 40 &&
    aboutContent.length < 40 &&
    adminNotes.combinedText.length < 1
  ) {
    console.log(`[scoring] Skipping xAI call for ${companyDoc.company_name} — insufficient signal (reviews=${reviewsSummary.length}ch, about=${aboutContent.length}ch, admin_notes=${adminNotes.combinedText.length}ch)`);
    return {
      ok: true,
      reputation_score: 0.25,
      quality_score: 0.25,
      reputation_reasoning: "- Not enough captured data to assess reputation.",
      quality_reasoning: "- Not enough captured data to assess product quality.",
      skipped_xai_call: true,
    };
  }

  const userPrompt = buildUserPrompt(companyDoc);
  const fullPrompt = `${SCORING_SYSTEM_PROMPT}\n\n---\n\n${userPrompt}`;

  console.log(`[scoring] Prompt for ${companyDoc.company_name} (${userPrompt.length} chars, conv_id=${SCORING_CONVERSATION_ID || "off"}):\n${userPrompt.substring(0, 500)}`);

  try {
    const result = await xaiLiveSearchStreaming({
      prompt: fullPrompt,
      timeoutMs: Math.max(5000, Math.trunc(Number(timeoutMs) || 60000)),
      maxToolCalls: SCORING_MAX_TOOL_CALLS,
      xaiUrl,
      xaiKey,
      ...(SCORING_CONVERSATION_ID ? { conversationId: SCORING_CONVERSATION_ID } : {}),
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
