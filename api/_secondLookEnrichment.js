// api/_secondLookEnrichment.js
//
// Second-look pass — a DIFFERENTLY-PHRASED gap-fill search that runs once,
// after the canonical import call, for only the fields the canonical call
// left empty.
//
// History note (why this exists and why it is NOT a retry cycle): the
// Feb-Mar 2026 retry cycles (killed in f72a444a / 1475cc6c / da036907)
// re-ran the IDENTICAL canonical search and never recovered anything —
// "across four analyzed sessions no retry cycle ever recovered data that a
// properly-timed first cycle missed." What DOES recover data is the
// operator's manual grok.com "Tab single company search" prompt, which uses
// different language, plain-text labeled output (no JSON schema pressure),
// and unrestricted browsing. This module is that prompt, automated:
//   - prompt text is the operator's grok.com prompt, verbatim per field
//   - NO response_format (plain text) — per Grok's API review (2026-08),
//     plain text degrades to partial output where json_schema degrades to
//     zero output
//   - server-side max_turns cap instead of relying on client stream aborts
//   - single attempt; if the second look also comes up empty, the field
//     stays empty (no cycles, ever)
//
// Ride-along rules (operator-specified):
//   - Keywords is ALWAYS requested when any second look fires (union-merge:
//     a deep search for e.g. manufacturing almost always surfaces new
//     products for free).
//   - Manufacturing rides along with union-merge when its list carries the
//     "Other unknown locations" sentinel (the model's own statement that
//     more locations exist unconfirmed) and something else triggered.
//
// Trigger contract (operator-specified):
//   - tagline / HQ / manufacturing / industries / keywords: empty or
//     placeholder after the canonical apply
//   - reviews: zero curated reviews, gated by SECOND_LOOK_ON_REVIEWS_ONLY
//     (default on)
//   - NEVER: amazon_url (always an admin "issue"), logo / homepage
//     (image pipeline), website_url / company name (identity), social.

"use strict";

const { xaiLiveSearch, xaiLiveSearchStreaming, extractTextFromXaiResponse } = require("./_xaiLiveSearch");
const {
  shapeEnrichedFromParsed,
  shapeEnvelopeForApply,
  classifyFields,
  isOtherUnknownLocationsSentinel,
} = require("./_canonicalImport");
const { isRealValue } = require("./_requiredFields");
const { getXAIEndpoint, getXAIKey, DEFAULT_XAI_MODEL } = require("./_shared");

const SECOND_LOOK_VERSION = "1.1.0-hq-echo-guard-and-customs-probe";

// The six text fields the second look can research (same universe as the
// canonical call). Logo/amazon/homepage are structurally excluded.
const SECOND_LOOK_FIELDS = [
  "tagline",
  "headquarters_location",
  "manufacturing_locations",
  "industries",
  "product_keywords",
  "reviews",
];

// Prompt-facing field names, in the operator's grok.com prompt vocabulary.
const FIELD_PROMPT_NAMES = {
  tagline: "tagline",
  headquarters_location: "HQ",
  manufacturing_locations: "manufacturing",
  industries: "industries",
  product_keywords: "keywords",
  reviews: "reviews",
};

function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function envInt(name, fallback, { min = 1, max = 1_000_000 } = {}) {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(Math.trunc(raw), max));
}

function secondLookEnabled() {
  const raw = String(process.env.SECOND_LOOK_ENABLED ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "0" || raw === "false") return false;
  // Default ON — rollout gate is the env var being set to off.
  return true;
}

function reviewsOnlyTriggerEnabled() {
  const raw = String(process.env.SECOND_LOOK_ON_REVIEWS_ONLY ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "0" || raw === "false") return false;
  return true;
}

// ── Trigger decision ─────────────────────────────────────────────────────────

/**
 * Decide whether a company doc needs a second look and which fields to
 * request. Pure function of the doc — evaluated AFTER the canonical apply.
 *
 * Returns { trigger: string[], requested: string[], merge_fields: string[] }.
 *   trigger      — fields that independently justify the call (empty fields)
 *   requested    — trigger ∪ ride-alongs (what goes in the prompt)
 *   merge_fields — requested fields applied with union-merge instead of
 *                  fill-only (keywords always; manufacturing when riding
 *                  along on the sentinel)
 */
function decideSecondLook(doc) {
  const d = doc && typeof doc === "object" ? doc : {};
  const trigger = [];

  if (!isRealValue("tagline", d.tagline, d)) trigger.push("tagline");
  if (!isRealValue("headquarters_location", d.headquarters_location, d)) {
    trigger.push("headquarters_location");
  }
  const mfg = Array.isArray(d.manufacturing_locations) ? d.manufacturing_locations : [];
  const mfgReal = mfg.filter((loc) => {
    const s = typeof loc === "string" ? loc : asString(loc?.location || loc?.formatted || "");
    return s && !isOtherUnknownLocationsSentinel(s);
  });
  if (mfgReal.length === 0) trigger.push("manufacturing_locations");
  if (!isRealValue("industries", d.industries, d)) trigger.push("industries");
  if (!isRealValue("product_keywords", d.product_keywords, d)) trigger.push("product_keywords");

  const curatedCount = Array.isArray(d.curated_reviews)
    ? d.curated_reviews.filter((r) => r && typeof r === "object").length
    : 0;
  const reviewsEmpty = curatedCount === 0;
  if (reviewsEmpty) {
    const reviewsIsOnlyCandidate = trigger.length === 0;
    if (!reviewsIsOnlyCandidate || reviewsOnlyTriggerEnabled()) {
      trigger.push("reviews");
    }
  }

  if (trigger.length === 0) {
    return { trigger: [], requested: [], merge_fields: [] };
  }

  const requested = [...trigger];
  const merge_fields = [];

  // Keywords always ride along, union-merge.
  if (!requested.includes("product_keywords")) requested.push("product_keywords");
  if (isRealValue("product_keywords", d.product_keywords, d)) {
    merge_fields.push("product_keywords");
  }

  // Manufacturing rides along with union-merge when the sentinel is present
  // (i.e. field is populated but self-declared incomplete).
  const hasSentinel = mfg.some((loc) => {
    const s = typeof loc === "string" ? loc : asString(loc?.location || loc?.formatted || "");
    return isOtherUnknownLocationsSentinel(s);
  });
  if (hasSentinel && !requested.includes("manufacturing_locations")) {
    requested.push("manufacturing_locations");
    merge_fields.push("manufacturing_locations");
  }

  // Preserve canonical field order in the prompt.
  requested.sort((a, b) => SECOND_LOOK_FIELDS.indexOf(a) - SECOND_LOOK_FIELDS.indexOf(b));

  return { trigger, requested, merge_fields };
}

// ── Prompt (operator's grok.com prompt, verbatim per field) ─────────────────

const FIELD_BLOCKS = {
  tagline:
    "Tagline: Provide the company's tagline, slogan, or motto. Format: Tagline: [tagline text]",
  headquarters_location:
    "HQ: Conduct thorough research using web_search and browse_page tools to identify " +
    "the HQ location. Use initials for states or provinces (e.g., City, State Initials, Country). " +
    "Use USA, not US. No explanatory info — just the location. If multiple HQ locations, " +
    "separate with semicolons. Format: HQ: City, ST, Country or HQ: City, ST, Country; City2, ST2, Country2",
  manufacturing_locations:
    "Manufacturing: Conduct thorough research using web_search and browse_page tools " +
    "to identify all known manufacturing locations worldwide. Include every city and country " +
    "found, with a deep dive on any US sites to confirm actual cities. List them exhaustively " +
    "without missing any. Use initials for states or provinces. Use USA, not US. No " +
    "explanatory info — just the locations. If part of a location is unspecified, include only " +
    "what is known. Do not write \"unspecified.\" Separate each location with semicolons. " +
    "CRITICAL: do NOT list the company's headquarters city as a manufacturing location unless " +
    "a source explicitly states products are physically manufactured or assembled there " +
    "(\"made in\", \"manufactured at our [city] facility\"). \"Based in\", \"designed in\", " +
    "\"developed in\", or \"engineered in\" do NOT count — consumer hardware brands " +
    "headquartered in tech hubs almost never manufacture there. If no location is explicitly " +
    "disclosed, search \"[Brand]\" (\"made in China\" OR \"made in USA\" OR \"manufactured in\") " +
    "— U.S. customs/import records (Panjiva, ImportYeti, Volza) showing a dominant shipment " +
    "origin country are valid evidence: list that country. " +
    "Format: Manufacturing: City, ST, Country; City2, ST2, Country2",
  industries:
    "Industries: Exhaustive list of all industries, separated by commas. Format: Industries: " +
    "industry1, industry2, industry3",
  product_keywords:
    "Keywords: Exhaustive, complete list of all products, separated by commas. " +
    "Format: Keywords: product1, product2, product3",
  reviews:
    "Reviews: Find 3 unique, legitimate third-party reviews with working URLs. Use 1-2 " +
    "YouTube reviews focused solely on the current company or its products; do not include " +
    "unrelated reviews or reviews from or about previously discussed companies. The " +
    "remaining reviews should be from X (Twitter), a magazine or blog, strictly related to the " +
    "current company and its products, excluding any overlap with prior companies. Confirm " +
    "all URLs are functional. Do not hallucinate or embellish. Do not include the same author " +
    "or URL more than once. Accuracy is paramount. For a YouTube video, YouTube is the " +
    "source. Separate each review with one blank line. Output each review in this exact " +
    "plain-text format:\n" +
    "Source: [Name of publication, channel, or website]\n" +
    "Author: [Author or channel name]\n" +
    "URL: [Direct URL to the review/article/video, not the site root]\n" +
    "Title: [Exact title as published]\n" +
    "Date: [Publication date, any format]\n" +
    "Text: [1-3 sentence excerpt or summary of the review]",
};

function buildSecondLookPrompt({ companyName, websiteUrl, fields } = {}) {
  const requested = (Array.isArray(fields) && fields.length ? fields : [...SECOND_LOOK_FIELDS])
    .filter((f) => SECOND_LOOK_FIELDS.includes(f));
  const ordered = [...requested].sort(
    (a, b) => SECOND_LOOK_FIELDS.indexOf(a) - SECOND_LOOK_FIELDS.indexOf(b)
  );
  const fieldList = ordered.map((f) => FIELD_PROMPT_NAMES[f]).join(", ");

  const lines = [
    `For the Company: ${asString(companyName).trim()} / ${asString(websiteUrl).trim()}`,
    `Fields to populate: ${fieldList}`,
    "Follow these baked-in rules for accuracy and formatting:",
    "Be thorough, exact, verify sources using web_search and browse_page tools, and do not",
    "hallucinate. Focus only on the specified company.",
    "Output the company name on its own line, then all fields with explicit labels in this",
    "exact order. Do NOT use any markdown formatting (no bold, no headers, no asterisks,",
    "no bullet points). Every field must start with its label followed by a colon.",
    "Line 1: The company name alone on its own line.",
  ];
  for (const f of ordered) {
    lines.push(FIELD_BLOCKS[f]);
  }
  return lines.join("\n");
}

// ── Plain-text parser ────────────────────────────────────────────────────────
//
// Guards per Grok's API review: tolerate leading narrative before the first
// label, markdown contamination, missing labels, truncation of the final
// field, and label-order variance. Treat the response as successful when at
// least one requested field is present.

const TOP_LABELS = {
  tagline: "tagline",
  hq: "headquarters_location",
  headquarters: "headquarters_location",
  manufacturing: "manufacturing_locations",
  industries: "industries",
  keywords: "product_keywords",
  products: "product_keywords",
  reviews: "reviews",
};

const REVIEW_LABELS = new Set(["source", "author", "url", "title", "date", "text"]);

function stripMarkdownLine(line) {
  let s = asString(line);
  // Code fences / heading markers / blockquotes / bullets at line start.
  s = s.replace(/^\s*(?:```+|#{1,6}\s+|>\s+|[-*•]\s+)/, "");
  // Bold/italic wrappers around the label or whole line.
  s = s.replace(/\*\*/g, "").replace(/__/g, "");
  return s;
}

function matchTopLabel(line) {
  const m = stripMarkdownLine(line).match(
    /^\s*(tagline|hq|headquarters|manufacturing|industries|keywords|products|reviews)\s*:\s*(.*)$/i
  );
  if (!m) return null;
  return { field: TOP_LABELS[m[1].toLowerCase()], rest: m[2] || "" };
}

function matchReviewLabel(line) {
  const m = stripMarkdownLine(line).match(/^\s*(source|author|url|title|date|text)\s*:\s*(.*)$/i);
  if (!m) return null;
  return { key: m[1].toLowerCase(), rest: (m[2] || "").trim() };
}

function splitSemicolons(value) {
  return asString(value)
    .split(";")
    .map((s) => s.trim().replace(/[.\s]+$/, ""))
    .filter(Boolean);
}

function splitCommasToArray(value) {
  return asString(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseReviewBlocks(lines) {
  const reviews = [];
  let current = null;
  let lastKey = null;

  const flush = () => {
    if (current && asString(current.url).startsWith("http")) {
      reviews.push({
        source: asString(current.source).trim(),
        author: asString(current.author).trim(),
        url: asString(current.url).trim(),
        title: asString(current.title).trim(),
        date: asString(current.date).trim(),
        text: asString(current.text).trim(),
      });
    }
    current = null;
    lastKey = null;
  };

  for (const rawLine of lines) {
    const line = rawLine ?? "";
    if (!line.trim()) {
      // Blank line — block separator (only meaningful once a block started).
      if (current) flush();
      continue;
    }
    const labeled = matchReviewLabel(line);
    if (labeled) {
      if (labeled.key === "source" && current && current.source) {
        // New block started without a blank separator.
        flush();
      }
      current = current || {};
      current[labeled.key] = labeled.rest;
      lastKey = labeled.key;
      continue;
    }
    // Continuation line (multi-line Text excerpt, wrapped title, etc.).
    if (current && lastKey) {
      current[lastKey] = `${current[lastKey]} ${stripMarkdownLine(line).trim()}`.trim();
    }
  }
  flush();

  // De-dup by URL and by author (prompt contract).
  const seenUrl = new Set();
  const seenAuthor = new Set();
  return reviews.filter((r) => {
    const urlKey = r.url.toLowerCase();
    const authorKey = r.author.toLowerCase();
    if (seenUrl.has(urlKey)) return false;
    if (authorKey && seenAuthor.has(authorKey)) return false;
    seenUrl.add(urlKey);
    if (authorKey) seenAuthor.add(authorKey);
    return true;
  });
}

/**
 * Parse the grok plain-text labeled output into a canonical parsed shape
 * (same property names CANONICAL_IMPORT_JSON_SCHEMA uses, so the result can
 * flow through shapeEnrichedFromParsed's sanitizers unchanged).
 *
 * Returns { found_any, parsed, labels_found } — parsed values are raw
 * (pre-sanitizer); shapeEnrichedFromParsed applies filler/location/quality
 * filtering downstream.
 */
function parseSecondLookOutput(rawText) {
  const text = asString(rawText).replace(/\r\n/g, "\n");
  const lines = text.split("\n");

  const sections = {}; // field → array of content lines (first line = label rest)
  let currentField = null;
  const labelsFound = [];

  for (const line of lines) {
    const top = matchTopLabel(line);
    if (top) {
      // "Text:" inside a review block also matches nothing here (review
      // labels are distinct), but guard against a reviews-section line like
      // "Title: Industries of tomorrow" being mistaken for a top label:
      // review labels take precedence while inside the reviews section.
      if (currentField === "reviews" && matchReviewLabel(line)) {
        sections.reviews.push(line);
        continue;
      }
      currentField = top.field;
      if (!sections[currentField]) {
        sections[currentField] = [];
        labelsFound.push(currentField);
      }
      if (top.rest.trim()) sections[currentField].push(top.rest);
      continue;
    }
    if (currentField) {
      sections[currentField].push(line);
    }
    // Lines before the first label (company name, narrative) are ignored.
  }

  const joined = (field) =>
    (sections[field] || []).join(" ").replace(/\s+/g, " ").trim();

  const parsed = {
    tagline: joined("tagline"),
    headquarters_location: splitSemicolons(joined("headquarters_location")).join("; "),
    manufacturing_locations: splitSemicolons(joined("manufacturing_locations")),
    industries: splitCommasToArray(joined("industries")),
    product_keywords: splitCommasToArray(joined("product_keywords")).join(", "),
    reviews: sections.reviews ? parseReviewBlocks(sections.reviews) : [],
    location_source_urls: { hq_source_urls: [], mfg_source_urls: [] },
    red_flag: false,
    social: {},
  };

  return {
    found_any: labelsFound.length > 0,
    labels_found: labelsFound,
    parsed,
  };
}

// ── Merge helpers (union semantics for ride-along fields) ────────────────────

function unionKeywordStrings(existing, incoming) {
  const seen = new Set();
  const out = [];
  for (const src of [existing, incoming]) {
    for (const token of asString(src).split(",")) {
      const v = token.trim();
      if (!v) continue;
      const key = v.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(v);
    }
  }
  return out.join(", ");
}

function unionLocationArrays(existing, incoming) {
  const seen = new Set();
  const out = [];
  for (const arr of [existing, incoming]) {
    if (!Array.isArray(arr)) continue;
    for (const loc of arr) {
      const s = typeof loc === "string" ? loc : asString(loc?.location || loc?.formatted || "");
      const v = s.trim();
      if (!v) continue;
      const key = v.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(v);
    }
  }
  return out;
}

// ── The call ─────────────────────────────────────────────────────────────────

/**
 * Run the second-look call for one company. Single attempt — no retries.
 * Returns the same result contract as runCanonicalImportCall:
 * { ok, fields_completed, fields_failed, errors, enriched (envelope),
 *   flat, elapsed_ms, diagnostics }
 *
 * `enriched` contains ONLY the requested fields, so downstream
 * applyEnrichmentToCompany touches nothing else. Honest statuses are
 * recorded in diagnostics.field_outcomes (the envelope keeps the existing
 * "ok" status semantics that import_missing_fields recomputation depends
 * on — see feedback_no_reflag_legacy).
 */
async function runSecondLookCall({ company, fields, budgetMs, signal, modelOverride, mode = "import" } = {}) {
  const startedAt = Date.now();
  const requested = (Array.isArray(fields) && fields.length ? fields : [...SECOND_LOOK_FIELDS])
    .filter((f) => SECOND_LOOK_FIELDS.includes(f));

  const companyName = asString(company?.company_name).trim();
  const websiteUrl = asString(company?.website_url).trim() || asString(company?.url).trim();

  const failure = (errorCode, diagnostics = {}) => ({
    ok: false,
    fields_completed: [],
    fields_failed: [...requested],
    errors: Object.fromEntries(requested.map((f) => [f, errorCode])),
    enriched: {},
    flat: {},
    elapsed_ms: Date.now() - startedAt,
    diagnostics: {
      second_look: true,
      second_look_version: SECOND_LOOK_VERSION,
      mode,
      error_code: errorCode,
      ...diagnostics,
    },
  });

  if (!companyName || !websiteUrl) return failure("missing_company_identity");
  if (requested.length === 0) return failure("no_fields_requested");

  const timeoutMs = Math.max(
    60_000,
    Math.min(
      envInt("SECOND_LOOK_TIMEOUT_MS", 270_000, { min: 60_000, max: 540_000 }),
      Number.isFinite(Number(budgetMs)) ? Number(budgetMs) - 5_000 : Infinity
    )
  );
  const maxToolCalls = envInt("SECOND_LOOK_MAX_TOOL_CALLS", 18, { min: 1, max: 40 });
  const maxTurns = envInt("SECOND_LOOK_MAX_TURNS", 8, { min: 1, max: 24 });
  const model = asString(modelOverride).trim()
    || asString(process.env.SECOND_LOOK_MODEL).trim()
    || asString(process.env.XAI_MODEL).trim()
    || DEFAULT_XAI_MODEL;

  const prompt = buildSecondLookPrompt({ companyName, websiteUrl, fields: requested });
  // Grok.com-fidelity search: NO excluded_websites. The canonical import's
  // amazon.com/amzn.to exclusions (via buildSearchParameters) blocked review
  // sources the operator's manual grok run finds routinely (empirical, first
  // prod batch 2026-08-06: 2 of 3 Clear Eyes reviews were Amazon/Walmart).
  const search_parameters = {
    mode: "on",
    sources: [{ type: "web" }, { type: "news" }, { type: "x" }],
  };

  console.log(`[secondLook] call_start`, {
    company_id: company?.id || null,
    company_name: companyName,
    website_url: websiteUrl,
    requested_fields: requested,
    mode,
    prompt_chars: prompt.length,
    timeout_ms: timeoutMs,
    max_tool_calls: maxToolCalls,
    max_turns: maxTurns,
    model,
    version: SECOND_LOOK_VERSION,
  });

  // Plain text on purpose — NO response_format. Fresh conversation per
  // company (no cross-company prefix bias), tolerance 2 on the client-side
  // backstop cap so max_turns does the real pacing.
  let res;
  let callMode = "streaming";
  try {
    res = await xaiLiveSearchStreaming({
      prompt,
      timeoutMs,
      model,
      search_parameters,
      enableImageUnderstanding: false,
      maxToolCalls,
      maxTurns,
      postCapToolCallTolerance: 2,
      conversationId: asString(company?.id).trim() ? `sl-${company.id}` : undefined,
      signal,
    });
  } catch (err) {
    return failure("upstream_unreachable", { stream_threw: String(err?.message || err), call_mode: callMode });
  }

  if (res === null) {
    callMode = "non_streaming_fallback";
    try {
      res = await xaiLiveSearch({
        prompt,
        maxTokens: 4000,
        timeoutMs,
        model,
        search_parameters,
        useTools: true,
        xaiUrl: getXAIEndpoint(),
        xaiKey: getXAIKey(),
        signal,
      });
    } catch (err) {
      return failure("upstream_unreachable", { fallback_threw: String(err?.message || err), call_mode: callMode });
    }
  }

  const elapsedMs = Date.now() - startedAt;
  const baseDiag = {
    call_mode: callMode,
    upstream: res?.diagnostics || null,
    tool_calls_counted: res?.diagnostics?.tool_calls_counted ?? null,
  };

  if (!res?.ok) {
    return failure(asString(res?.error_code || res?.error || "upstream_failed"), baseDiag);
  }

  const rawText = extractTextFromXaiResponse(res.resp);
  if (!asString(rawText).trim()) {
    return failure("model_emitted_no_text", { ...baseDiag, text_chars: 0 });
  }

  const { found_any, labels_found, parsed } = parseSecondLookOutput(rawText);
  if (!found_any) {
    return failure("unparseable_text", {
      ...baseDiag,
      text_chars: rawText.length,
      text_preview: rawText.slice(0, 400),
    });
  }

  // Sanitize through the SAME pipeline the canonical call uses (filler
  // strip, location validation, noun-phrase quality, unicode leaks).
  const flatAll = shapeEnrichedFromParsed(parsed);

  // Restrict to requested fields only.
  const flat = {};
  for (const f of requested) flat[f] = flatAll[f];
  if (requested.includes("headquarters_location")) {
    flat.location_source_urls = flatAll.location_source_urls;
  }

  const { fields_completed, fields_failed, errors } = classifyFields(requested, flat);

  // Envelope for applyEnrichmentToCompany — requested fields only.
  const fullEnvelope = shapeEnvelopeForApply({ ...flatAll, ...flat });
  const enriched = {};
  for (const f of requested) {
    if (fullEnvelope[f]) enriched[f] = fullEnvelope[f];
  }

  console.log(`[secondLook] call_end`, {
    company_id: company?.id || null,
    ok: true,
    fields_completed,
    fields_failed,
    labels_found,
    elapsed_ms: elapsedMs,
    text_chars: rawText.length,
    tool_calls: baseDiag.tool_calls_counted,
    // Raw model text (truncated) whenever any requested field failed, so log
    // captures show WHAT the model answered for the failed label instead of
    // only that it failed.
    raw_text_sample: fields_failed.length > 0 ? rawText.slice(0, 800) : undefined,
  });

  return {
    ok: fields_completed.length > 0,
    fields_completed,
    fields_failed,
    errors,
    enriched,
    flat,
    elapsed_ms: elapsedMs,
    diagnostics: {
      second_look: true,
      second_look_version: SECOND_LOOK_VERSION,
      mode,
      ...baseDiag,
      text_chars: rawText.length,
      labels_found,
      // Honest per-field outcome — the envelope statuses stay "ok" for
      // compatibility, so this is the audit trail.
      field_outcomes: Object.fromEntries(
        requested.map((f) => [f, fields_completed.includes(f) ? "ok" : "not_found_second_look"])
      ),
    },
  };
}

module.exports = {
  SECOND_LOOK_FIELDS,
  SECOND_LOOK_VERSION,
  secondLookEnabled,
  reviewsOnlyTriggerEnabled,
  decideSecondLook,
  buildSecondLookPrompt,
  parseSecondLookOutput,
  unionKeywordStrings,
  unionLocationArrays,
  runSecondLookCall,
};
