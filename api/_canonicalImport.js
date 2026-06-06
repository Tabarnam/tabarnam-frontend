// _canonicalImport.js
// Single-call canonical xAI import — Phase 2 of the single-call import plan.
//
// Replaces the multi-stage runDirectEnrichment pipeline with one
// /v1/responses call that asks for all fields at once, modelled on the
// grok.com prompt admin uses for manual cleanup.
//
// Activated by XAI_SINGLE_CALL_MODE=on in the Function App config. Default
// is off; the legacy multi-stage path stays the production behavior until
// production-parity testing confirms the single-call output quality.
//
// Output contract MIRRORS runDirectEnrichment so the handler doesn't need
// to special-case the result downstream. applyEnrichmentToCompany,
// markFieldSuccess, terminalize*, etc. all keep working unchanged.

"use strict";

const {
  buildCanonicalImportPrompt,
  CANONICAL_IMPORT_JSON_SCHEMA,
  parseCanonicalJson,
  DEFAULT_CANONICAL_FIELDS,
  PROMPT_GUIDANCE_VERSION,
  // Phase 3.0 — multi-call parallel canonical
  buildCorePrompt,
  buildLocationsPrompt,
  buildReviewsPrompt,
} = require("./_xaiPromptGuidance");

const { xaiLiveSearch, xaiLiveSearchStreaming, extractTextFromXaiResponse } = require("./_xaiLiveSearch");
// Phase 4.0 — centralized default xAI model (grok-4.3).
const { DEFAULT_XAI_MODEL } = require("./_shared");
const { buildSearchParameters } = require("./_buildSearchParameters");
const { prefetchHomepageContext } = require("./_homepagePrefetch");

// Phase 2.4: bumped 150s → 240s (4 min). Empirical: complex brands
// (Birkenstock) hit the 150s timeout with 0 text emitted because the
// model was still browsing. grok.com finishes the same prompt in 43s, so
// 240s leaves ample headroom. Worker is async (UI returned 202 already),
// so user-facing latency is unaffected.
// Phase 3.4 — bumped 240s → 270s (4.5 min). At the new 18-tool budget
// (vs prior 12), 18 × ~10s + reasoning overhead can plausibly cross
// 4 min. 270s leaves headroom for the slowest-disambiguating brands
// while keeping SSE-stall detection + Phase 3.3 grace timer (25s) as
// the dominant abort path — both fire well before the timeout.
// Grok-4 reviewed and specifically preferred 270s over 300s for this
// reason.
const DEFAULT_TIMEOUT_MS = 270_000;
// Phase 2.5: tightened 12 → 10 to align with the prompt's new TOOL BUDGET
// block. With Phase 2.5's account-level serialization (one xAI call active
// at a time) the model no longer competes for xAI rate-limit headroom, so
// it doesn't need the extra cushion that 12 provided. The stronger EMIT
// EARLY trigger ("6+ calls AND have tagline + HQ → stop") means most
// imports will end well below the cap anyway.
// Phase 2.19.A — bumped 10 → 12. UGG hit the 10-cap exactly with all
// 6 fields populated and just barely emitted text within the 45s grace
// window. Complex multi-region brands (UGG: Goleta + China + Vietnam +
// 1 more, Birkenstock-class portfolios) are right at the boundary.
// Two extra calls give legitimate complex brands headroom without
// changing simpler-brand behaviour (most finish in 5-8 calls).
// Phase 3.4 — bumped 12 → 18. Empirical (2026-05-11 Amagabeli + Camp
// Chef on grok.com): the same Grok-4 model with the same web_search
// tool uses ~14-15 tool calls per company when coordinated by
// grok.com's internal multi-agent loop. Our prior 12-cap killed the
// model mid-disambiguation (Amagabeli's Redding/CA vs Beijing HQ
// conflict took 8+ searches on grok.com). 18 = grok.com's observed
// 14-15 + 3-tool headroom. Pairs with Phase 3.4's revert to single-
// call architecture (XAI_MULTI_CALL_MODE=off).
const DEFAULT_MAX_TOOL_CALLS = 18;
const MIN_TIMEOUT_MS = 30_000;

function asString(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function isComplete(field, value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "boolean") return true;
  return value != null;
}

function extractWebsiteHost(websiteUrl) {
  const raw = asString(websiteUrl).trim();
  if (!raw) return "";
  try {
    return new URL(raw.startsWith("http") ? raw : `https://${raw}`).hostname || "";
  } catch {
    return "";
  }
}

/**
 * Build the response_format declaration for the canonical schema.
 * Pulled out so tests can assert the exact shape we send to xAI.
 */
function buildResponseFormat() {
  return {
    type: "json_schema",
    json_schema: {
      name: "company_research",
      schema: CANONICAL_IMPORT_JSON_SCHEMA,
      strict: true,
    },
  };
}

// Phase 2.3 — strip leaked prompt labels from string field values.
// Empirical (Beek import, 2026-05-08): model emitted
// `headquarters_location: "HQ: Newport Beach, CA, USA"` — the prompt's
// label `HQ:` bled into the JSON value. Tagline came back clean, but
// belt-and-suspenders we strip any of the canonical short labels from
// any string field. Only matches an exact known prefix at start of
// string, so we won't mangle real content like "Manufacturing in TX".
const KNOWN_PROMPT_LABEL_PREFIX = /^(HQ|Tagline|Manufacturing|Industries|Products|Reviews):\s*/i;
function stripLabel(value) {
  if (typeof value !== "string") return value;
  return value.replace(KNOWN_PROMPT_LABEL_PREFIX, "").trim();
}

// Phase 4.4.B — defensive parse-time sanitizer for "filler rationale" values.
// Empirical (user-reported 2026-05-13, GRILLART + Grillight on grok-4.3):
// the model occasionally emits parenthetical explanations INSIDE a field
// value instead of returning the type-correct empty value. Examples we've
// observed (verified by user against grok.com Expert mode):
//
//   headquarters_location: "(no specific city or state identified in
//     sources; U.S. brand under Weetiee)"
//   manufacturing_locations: ["(no specific cities or factories identified
//     in sources; U.S. branded products with likely overseas production
//     common for category)"]
//
// These are catastrophic for two reasons:
//   1. Admin Issues column flags empty/missing — filler text passes as
//      non-empty and slips into production unchecked.
//   2. Downstream semicolon-split parsing turns the explanation into
//      multiple "locations" (e.g. "(no X" + "Y)" → 2 chips).
//
// This sanitizer detects the most common Grok-4.3 filler patterns and
// converts them to the type-correct empty value. Conservative — only
// strips values that match HIGH-CONFIDENCE filler patterns (starts with
// "(" + contains a known rationale phrase like "no specific", "identified
// in sources", "common for category"). Real parenthetical clarifications
// (e.g. "Linz am Rhein (formerly West Germany)") are preserved.
const FILLER_PATTERNS = [
  // Most common Grok-4.3 form: "(no specific X identified ...)"
  /^\s*\(\s*no\s+specific\b.*?\bidentified\b/i,
  // Variant: "(no X identified in sources)"
  /^\s*\(\s*no\s+\w+(?:\s+\w+){0,3}\s+identified\s+in\s+sources/i,
  // "(... common for category)" — typically the tail half of a semicolon split
  /\bcommon\s+for\s+category\s*\)?\s*$/i,
  // "(... likely overseas production ...)"
  /\blikely\s+overseas\s+production\b/i,
  // "(U.S. brand under X)" — bare-brand-pedigree filler (the tail of a split)
  /^\s*[Uu]\.?[Ss]\.?\s+(?:brand|branded\s+products?)\s+(?:under|with)\b/,
  // "(no factories disclosed)" / "(no manufacturing disclosed)"
  /^\s*\(\s*no\s+(?:factories|manufacturing|facilities|locations?)\s+(?:disclosed|found|listed|known)/i,
];

function isFillerValue(value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (!v) return false;
  for (const pat of FILLER_PATTERNS) {
    if (pat.test(v)) return true;
  }
  return false;
}

function stripFillerString(value, fieldName = "") {
  if (typeof value !== "string") return value;
  if (isFillerValue(value)) {
    // Log so we can monitor occurrences in production
    try {
      console.log("[canonicalImport] filler_stripped", {
        field: fieldName || "(unknown)",
        original_preview: value.slice(0, 120),
      });
    } catch { /* logging is best-effort */ }
    return "";
  }
  return value;
}

function stripFillerArray(arr, fieldName = "") {
  if (!Array.isArray(arr)) return arr;
  const cleaned = [];
  for (const item of arr) {
    if (typeof item === "string" && isFillerValue(item)) {
      try {
        console.log("[canonicalImport] filler_stripped", {
          field: fieldName || "(unknown)",
          original_preview: item.slice(0, 120),
        });
      } catch { /* best-effort */ }
      continue; // drop the filler entry from the array
    }
    cleaned.push(item);
  }
  return cleaned;
}

// ─── Phase 4.12 — strict geographic location validator ─────────────────────
//
// Empirical (2026-05-13 batch, Harbour Outdoor + Harmonia Living):
// grok-4.3 occasionally emits manufacturing_locations / headquarters_location
// values that are NOT clean geographic strings:
//   - "Pelham, AL, USA (tailored made in the US with marine-grade wood...)"
//     — valid location prefix + parenthetical description
//   - "US-based production for luxury outdoor furniture"
//     — narrative description, no actual location
//   - "Various global locations with handcrafted designs..."
//     — meta-statement, no location
//   - "USA (cushions and some components)"
//     — country + scope qualifier
//
// Tabarnam's core feature is proximity-based discovery (user → manufacturer
// distance on a map). This requires clean geocodable strings: "City, ST,
// USA" / "City, Region, Country" / "City, Country" / "Country". Any noise
// breaks the geocoder and pollutes the map UI.
//
// Two-step defense (Grok-4 approved, 2026-05-14):
//   1. stripParentheticals — remove "(...)" content from any location
//      string. "Pelham, AL, USA (tailored made in the US...)" → "Pelham,
//      AL, USA". Single + nested-shallow handling.
//   2. isValidLocationEntry — reject entries that look like narrative
//      rather than location. Red-flag words ("production", "various",
//      "with", "using"), length cap (80 chars max), capital-letter start.
//      Country-only strings ("USA", "Vietnam") pass cleanly.
//
// Run BOTH on every manufacturing_locations[] entry AND on headquarters_
// location. For HQ, split on ";" first (multiple locations can be
// semicolon-separated per the prompt rule).
//
// Phase 4.13 candidate (not yet shipped): geocoder feedback loop —
// drop entries that fail downstream geocoding as the final safety net.

function stripParentheticals(value) {
  if (typeof value !== "string") return value;
  // Repeat once to handle single-level nesting like "X (Y (Z))".
  let v = value.replace(/\s*\([^()]*\)\s*/g, " ");
  v = v.replace(/\s*\([^()]*\)\s*/g, " ");
  // Collapse repeated whitespace, strip trailing punctuation that comes
  // from removing a trailing parenthetical (e.g. "USA," when input was
  // "USA, (cushions and some components)").
  v = v.replace(/\s+/g, " ").trim();
  v = v.replace(/[\s,;]+$/g, "").trim();
  return v;
}

// Phase 4.31 — sentinel string the model may append as the FINAL entry of
// manufacturing_locations to signal "I found some specific cities, but
// the brand sources from more places I couldn't pin down." Documented in
// the prompt's "Incompleteness signal" paragraph. The string is the only
// non-geocodable entry permitted in the array; the existing geocoder
// gracefully skips entries that don't resolve (._directEnrichment.js
// `.catch(() => null)`), so we don't need extra handling there. The
// admin UI shows the string inline with the other entries — informative
// to the human reviewer.
const OTHER_UNKNOWN_LOCATIONS_SENTINEL = "Other unknown locations";

function isOtherUnknownLocationsSentinel(value) {
  if (typeof value !== "string") return false;
  return value.trim().toLowerCase() === OTHER_UNKNOWN_LOCATIONS_SENTINEL.toLowerCase();
}

// Red-flag words that strongly indicate narrative/marketing prose rather
// than a clean geographic string. Each entry is checked case-insensitively.
const LOCATION_NARRATIVE_RED_FLAGS = [
  /\b(production|manufacturing|sourcing|operations|distribution|design|assembly|headquartered|headquarters)\b/i,
  /\b(luxury|premium|handcrafted|handmade|using|featuring|including)\b/i,
  /\bwith\s+/i,
  /\bfor\s+/i,
  /\bvarious\b/i,
  /\bglobal\s+locations\b/i,
  /\boutdoor\s+furniture\b/i,
  /\bsustainable\s+materials\b/i,
  /\bcorporate\s+office\b/i,
  /\bsince\b/i,        // "headquartered since 2010"
  /\bsome\b/i,         // "some components"
];

function isValidLocationEntry(value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (!v) return false;
  // Phase 4.31 — explicit allowlist for the "Other unknown locations"
  // sentinel. Today's red flags don't catch it, but adding the explicit
  // pass keeps the sentinel safe even if future red-flag additions would
  // otherwise reject it.
  if (isOtherUnknownLocationsSentinel(v)) return true;
  // Real locations are short. Longest realistic legitimate string:
  // "Linz am Rhein, Rhineland-Palatinate, Germany" = 44 chars. 80 is
  // generous; narrative entries are typically 60-150 chars.
  if (v.length > 80) return false;
  // Reject anything matching narrative red flags.
  for (const pat of LOCATION_NARRATIVE_RED_FLAGS) {
    if (pat.test(v)) return false;
  }
  // Require capital letter start (real place names start with a capital).
  if (!/^[A-Z]/.test(v)) return false;
  return true;
}

function sanitizeLocationString(value, fieldName = "") {
  if (typeof value !== "string") return value;
  const original = value;
  // Phase 4.31 — short-circuit the "Other unknown locations" sentinel
  // BEFORE stripping parentheticals so an upstream variant like "Other
  // unknown locations (per supplier list)" still normalizes to the
  // canonical sentinel and survives.
  if (isOtherUnknownLocationsSentinel(value.trim())) {
    return OTHER_UNKNOWN_LOCATIONS_SENTINEL;
  }
  const stripped = stripParentheticals(value);
  if (stripped !== original) {
    try {
      console.log("[canonicalImport] parenthetical_stripped", {
        field: fieldName || "(unknown)",
        original_preview: original.slice(0, 120),
        cleaned: stripped.slice(0, 120),
      });
    } catch { /* best-effort */ }
  }
  // Re-check sentinel after parenthetical strip too — covers cases like
  // "Other unknown locations (per the parent company list)".
  if (isOtherUnknownLocationsSentinel(stripped)) {
    return OTHER_UNKNOWN_LOCATIONS_SENTINEL;
  }
  if (!isValidLocationEntry(stripped)) {
    try {
      console.log("[canonicalImport] narrative_dropped", {
        field: fieldName || "(unknown)",
        original_preview: original.slice(0, 120),
        after_strip: stripped.slice(0, 120),
      });
    } catch { /* best-effort */ }
    return "";
  }
  return stripped;
}

function sanitizeLocationArray(arr, fieldName = "") {
  if (!Array.isArray(arr)) return arr;
  const cleaned = [];
  for (const item of arr) {
    if (typeof item !== "string") continue;
    // Split on semicolons first — model is instructed to use ; as a
    // separator for multi-location entries. After Phase 4.4.B filler
    // stripping, semicolons can still be present inside legitimate
    // multi-location strings like "Sydney, Australia; Melbourne, Australia".
    // Each token gets its own strip + validate.
    const tokens = item.includes(";") ? item.split(";") : [item];
    for (const token of tokens) {
      const sanitized = sanitizeLocationString(token, fieldName);
      if (sanitized) cleaned.push(sanitized);
    }
  }
  return cleaned;
}

// Phase 3.7 — strip JSON unicode escape sequences that leak through as
// literal text. Empirical (Slap Ya Mama import, 2026-05-11): model emitted
// `industries: ["Cajun Seasonings ⚡"]` — the website uses emoji
// decoration (⚡) in industry labels; the model preserved the JSON-escaped
// form (`⚡`) as literal 6-character text rather than rendering the
// codepoint. Same for accented-character escapes.
//
// Two cases handled:
//   1. Genuine escapes that JSON.parse already decoded → trailing emoji
//      character left in place: trim Unicode-class control / non-printable
//      noise from the end of strings.
//   2. Literal `\uXXXX` text that survived parsing → decode or strip.
const UNICODE_ESCAPE_LITERAL = /\\u([0-9a-fA-F]{4})/g;
function stripUnicodeEscapeLeaks(value) {
  if (typeof value !== "string") return value;
  let v = value;
  // Decode literal `\uXXXX` sequences. If the resulting char is a printable
  // emoji or letter, keep it; otherwise strip the escape entirely.
  v = v.replace(UNICODE_ESCAPE_LITERAL, (_, hex) => {
    try {
      const code = parseInt(hex, 16);
      if (!Number.isFinite(code)) return "";
      const ch = String.fromCharCode(code);
      // Strip emoji / symbol decorations that clutter category labels:
      // Misc Symbols & Pictographs / Emoji / Dingbats / Geometric Shapes
      // / Misc Technical / Arrows / Currency / etc. Keep letters,
      // numbers, common punctuation, and Latin-1 accented chars.
      if (code < 0x20) return "";              // control
      if (code >= 0x2000 && code <= 0x2BFF) return "";  // symbols, arrows, dingbats
      if (code >= 0x2600 && code <= 0x27BF) return "";  // misc symbols + dingbats (⚡ = U+26A1)
      if (code >= 0xE000 && code <= 0xF8FF) return "";  // private use
      if (code >= 0x1F300) return "";          // beyond BMP emoji ranges (handled at char level if surrogate pair survives)
      return ch;
    } catch {
      return "";
    }
  });
  // Strip trailing whitespace + commas + decorative chars left behind.
  v = v.replace(/[\s,\-–—•·]+$/u, "").trim();
  return v;
}

// Phase 3.7 — filter low-quality industry/keyword entries:
//   - Drop bare lowercase one-word entries that look truncated
//     (e.g. "baking" from Simple Mills — partial bleed of the JSON
//     "baking mixes" key into the array)
//   - Drop entries that are <= 2 chars (almost always garbage)
//   - Drop entries that contain only punctuation/symbols
const VALID_NOUN_PHRASE = /[A-Za-z]/;
function isQualityNounPhraseEntry(value, { allowLowercaseSingleWord = false } = {}) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v.length < 3) return false;
  if (!VALID_NOUN_PHRASE.test(v)) return false;
  // Lowercase single-word entries (e.g. "baking", "cookware") are usually
  // truncated bleed — real industry labels are Title Case or multi-word.
  // Allow them only when the caller explicitly opts in (product_keywords,
  // where lowercase single-word entries are normal).
  if (!allowLowercaseSingleWord) {
    const tokens = v.split(/\s+/);
    if (tokens.length === 1 && v === v.toLowerCase()) return false;
  }
  return true;
}

function cleanNounPhraseArray(arr, opts = {}) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    const v = stripUnicodeEscapeLeaks(asString(raw));
    if (!isQualityNounPhraseEntry(v, opts)) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function cleanProductKeywordsString(value) {
  if (typeof value !== "string") return value;
  // product_keywords is a single comma-separated string. Split, clean each
  // token, rejoin. Lowercase single-word entries are valid here ("hot sauce",
  // "fish fry") — only filter out garbage and decorative escapes.
  //
  // Phase 4.4.B — also filter individual filler tokens like "(no specific
  // named lines identified in sources)" that the model may emit alongside
  // real product lines.
  const tokens = value.split(",");
  const cleaned = [];
  const seen = new Set();
  for (const raw of tokens) {
    const v = stripUnicodeEscapeLeaks(raw.trim());
    if (!isQualityNounPhraseEntry(v, { allowLowercaseSingleWord: true })) continue;
    if (isFillerValue(v)) {
      try {
        console.log("[canonicalImport] filler_stripped", {
          field: "product_keywords",
          original_preview: v.slice(0, 120),
        });
      } catch { /* best-effort */ }
      continue;
    }
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(v);
  }
  return cleaned.join(", ");
}

/**
 * Map a parsed canonical JSON object (already conforming to
 * CANONICAL_IMPORT_JSON_SCHEMA) into the enriched-result shape that
 * applyEnrichmentToCompany expects. Defensive — the schema guarantees
 * structural validity, but the parser can return null on transport
 * failures, AND (Phase 2.3) the model occasionally leaks prompt labels
 * (e.g. "HQ: ") into string field values.
 */
function shapeEnrichedFromParsed(parsed) {
  // Phase 3.7 — clean string fields through the unicode-escape + label
  // stripper, and run array fields (industries) through the noun-phrase
  // quality filter (drops emoji-decorated entries, single lowercase words
  // like "baking", entries < 3 chars). product_keywords runs through a
  // dedicated cleaner that allows lowercase single-word entries (legitimate
  // for product names like "hot sauce").
  //
  // Phase 4.4.B — additionally strip "filler rationale" values that
  // Grok-4.3 occasionally emits in place of empty strings/arrays (e.g.
  // "(no specific cities identified in sources; ... common for category)").
  // Filler strings on tagline/HQ become empty string "". Filler entries in
  // arrays (manufacturing_locations) get dropped. See stripFillerString /
  // stripFillerArray + FILLER_PATTERNS above for the detection rules.
  return {
    tagline: stripFillerString(
      stripUnicodeEscapeLeaks(stripLabel(asString(parsed?.tagline))),
      "tagline",
    ),
    // Phase 4.12 — strict geographic location validator. HQ can contain
    // multiple semicolon-separated locations. After Phase 4.4.A filler
    // strip + Phase 4.12 parenthetical strip + narrative validator, HQ is
    // re-joined with "; " if multiple tokens survived, or single string if
    // one survived, or "" if none did.
    headquarters_location: (() => {
      const initial = stripFillerString(
        stripUnicodeEscapeLeaks(stripLabel(asString(parsed?.headquarters_location))),
        "headquarters_location",
      );
      if (!initial) return "";
      const tokens = initial.includes(";") ? initial.split(";") : [initial];
      const cleaned = [];
      for (const token of tokens) {
        const sanitized = sanitizeLocationString(token, "headquarters_location");
        if (sanitized) cleaned.push(sanitized);
      }
      return cleaned.join("; ");
    })(),
    manufacturing_locations: sanitizeLocationArray(
      stripFillerArray(
        cleanNounPhraseArray(parsed?.manufacturing_locations, { allowLowercaseSingleWord: true }),
        "manufacturing_locations",
      ),
      "manufacturing_locations",
    ),
    industries: stripFillerArray(
      cleanNounPhraseArray(parsed?.industries),
      "industries",
    ),
    product_keywords: cleanProductKeywordsString(stripLabel(asString(parsed?.product_keywords))),
    reviews: Array.isArray(parsed?.reviews) ? parsed.reviews : [],
    location_source_urls:
      parsed?.location_source_urls && typeof parsed.location_source_urls === "object"
        ? {
            hq_source_urls: Array.isArray(parsed.location_source_urls.hq_source_urls)
              ? parsed.location_source_urls.hq_source_urls
              : [],
            mfg_source_urls: Array.isArray(parsed.location_source_urls.mfg_source_urls)
              ? parsed.location_source_urls.mfg_source_urls
              : [],
          }
        : { hq_source_urls: [], mfg_source_urls: [] },
    red_flag: Boolean(parsed?.red_flag),
    social: parsed?.social && typeof parsed.social === "object" ? parsed.social : {},
  };
}

/**
 * Phase 2.8 — Wrap the flat enriched object into the nested-envelope shape
 * that applyEnrichmentToCompany (in api/_directEnrichment.js) expects.
 *
 * Empirically (Crocs import 2026-05-09 + earlier Chaco/Clarks runs), the
 * canonical call's flat result silently bypassed applyEnrichmentToCompany's
 * per-field processing — the helper checks `enriched.headquarters_location`
 * for an OBJECT (then reads `.headquarters_location` from inside), but our
 * flat shape gave it a string. Result: stale `hq_unknown: true` flags from
 * the URL-seed step were never cleared, HQ display gated on the flag, and
 * the admin UI showed HQ blank even though Cosmos held the correct value.
 *
 * The nested envelope unlocks:
 *   - hq_unknown / mfg_unknown / *_unknown flag clearing
 *   - {tagline,headquarters_location,manufacturing_locations,industries,
 *      product_keywords,reviews}_status fields (audit trail)
 *   - *_searched_at timestamps
 *   - HQ + manufacturing geocoding (sets hq_lat / hq_lng + manufacturing_geocodes)
 *   - headquarters_locations plural structured array (some UI components
 *     read this instead of the singular string)
 *   - keywords[] sync (when product_keywords is array form — not used here
 *     since canonical returns string)
 *   - hq_source_urls / mfg_source_urls extracted to top level
 *
 * Internal flat shape is preserved for intermediateSave (which uses
 * Object.assign(doc, flat) for an immediate Cosmos write before
 * applyEnrichmentToCompany runs) and for classifyFields.
 */
function shapeEnvelopeForApply(flatEnriched) {
  const now = new Date().toISOString();
  const e = flatEnriched || {};
  const sourceUrls = e.location_source_urls || { hq_source_urls: [], mfg_source_urls: [] };

  return {
    tagline: {
      tagline: e.tagline || "",
      tagline_status: "ok",
      searched_at: now,
    },
    headquarters_location: {
      headquarters_location: e.headquarters_location || "",
      headquarters_location_status: "ok",
      searched_at: now,
      location_source_urls: { hq_source_urls: sourceUrls.hq_source_urls || [] },
    },
    manufacturing_locations: {
      manufacturing_locations: Array.isArray(e.manufacturing_locations) ? e.manufacturing_locations : [],
      manufacturing_locations_status: "ok",
      searched_at: now,
      location_source_urls: { mfg_source_urls: sourceUrls.mfg_source_urls || [] },
    },
    industries: {
      industries: Array.isArray(e.industries) ? e.industries : [],
      industries_status: "ok",
      searched_at: now,
    },
    product_keywords: {
      // Kept as a string (matches existing Cosmos schema). The keywords[]
      // array is synced separately by intermediateSave's flat path.
      product_keywords: e.product_keywords || "",
      product_keywords_status: "ok",
      searched_at: now,
    },
    reviews: {
      reviews: Array.isArray(e.reviews) ? e.reviews : [],
      reviews_status: "ok",
      searched_at: now,
    },
  };
}

/**
 * Decide per-field success from the enriched output. A field is "completed"
 * if the model returned a non-empty value (string non-blank, array non-empty,
 * boolean considered always complete). Empty values are treated as
 * "not_found" — the canonical prompt explicitly instructs the model to
 * return empty rather than hallucinate, so empty IS the verified signal.
 */
function classifyFields(fieldsToEnrich, enriched) {
  const fields_completed = [];
  const fields_failed = [];
  const errors = {};
  for (const f of fieldsToEnrich) {
    const v = enriched[f];
    if (isComplete(f, v)) {
      fields_completed.push(f);
    } else {
      fields_failed.push(f);
      errors[f] = "not_found";
    }
  }
  return { fields_completed, fields_failed, errors };
}

function buildFailureResult({ fieldsToEnrich, errorCode, elapsedMs, diagnostics }) {
  const fields = Array.isArray(fieldsToEnrich) && fieldsToEnrich.length ? fieldsToEnrich : DEFAULT_CANONICAL_FIELDS;
  const errors = Object.fromEntries(fields.map((f) => [f, errorCode]));
  return {
    ok: false,
    fields_completed: [],
    fields_failed: [...fields],
    errors,
    enriched: {},
    elapsed_ms: elapsedMs,
    diagnostics: {
      canonical_call: true,
      guidance_version: PROMPT_GUIDANCE_VERSION,
      ...(diagnostics || {}),
    },
  };
}

/**
 * Phase 2.19.7 — homepage-extraction fallback.
 * Phase 3.6 — extended from 2 fields → 6 fields. The prior version only
 * pulled tagline + HQ, leaving rich-brand cap-exhaustion failures
 * (Fleischmann's, King Arthur, Adams, Camp Chef) at Partial-30% even
 * though the pre-fetched homepage often contains industries, products,
 * manufacturing hints, and even press-mention review-like content. Now
 * the fallback tries to populate all 6 canonical fields from the
 * homepage text alone.
 *
 * When the canonical call fails (model_emitted_no_text, upstream_503,
 * sse_stall, upstream_timeout, unparseable_json, post-cap-abort), the
 * homepage prefetch we already ran often contains visible facts the
 * model can summarize. This helper makes a SHORT, bounded xAI call with
 * NO tools enabled. Pure summarization, no web_search, no tool-loop
 * possible.
 *
 * Empirical (2026-05-09 to 2026-05-11): cap-exhausted brands like
 * Fleischmann's (yeast), King Arthur (baking), Adams (peanut butter)
 * all had non-empty homepage prefetches with multiple field hints in
 * them. Pre-3.6 fallback rescued only tagline + HQ → Partial-30%.
 * Post-3.6 fallback aims for Partial-70-90%.
 *
 * Returns null on any failure (fall through to original buildFailureResult).
 * Otherwise returns an object with keys tagline / headquarters_location /
 * manufacturing_locations / industries / product_keywords / reviews
 * (each may be empty string/array if not findable in the prefetch) plus
 * diagnostics about the fallback call.
 */
async function tryHomepageExtractionFallback({
  homepageContext,
  companyName,
  websiteUrl,
  sessionId,
  conversationId,  // Phase 2.19.9 — per-company id for fresh prefix-cache namespace
  signal,
  model,
}) {
  if (!homepageContext || homepageContext.length < 100) {
    return null;  // Nothing useful to extract from
  }

  // Phase 3.6 — expanded extraction prompt covering all 6 canonical fields.
  // Still tools-disabled: pure summarization of the homepage text. The
  // explicit "If not visible, emit empty/[]" instruction is key — without
  // it the model can hallucinate (especially for manufacturing_locations
  // which is rarely on the homepage). For reviews, we accept on-site
  // testimonials / press mentions only — no third-party search.
  const fallbackPrompt = `You are extracting facts from the company's homepage text below. Use ONLY the homepage text provided — do not search the web, do not make up information.

Company: ${companyName}
Website: ${websiteUrl}

Homepage text (already fetched):
${homepageContext}

Extract these 6 fields. For any field whose information is NOT clearly visible in the homepage text, emit the type-correct empty value (string → "", array → []). Do NOT invent or guess.

- tagline: the company's tagline, slogan, mission statement, or brand promise as it appears on the homepage. If absent, emit "".
- headquarters_location: city + state/province + country of the headquarters if visible (often in footer, contact section, or about paragraph). Format "City, ST, USA" or "City, Country". If absent, emit "".
- manufacturing_locations: cities/countries where the company manufactures, if explicitly mentioned in the homepage text (e.g., "made in USA", "manufactured in Vermont"). Output as an array of strings. If not mentioned, emit [].
- industries: 3-8 short noun phrases describing what the company sells, derived ONLY from the homepage text. Format as an array of strings. If the text doesn't make this clear, emit a short list (3-5) based on what IS visible, or [] if truly indeterminate.
- product_keywords: 5-12 product categories or notable lines mentioned in the homepage text, as a single comma-separated string. If only a handful are visible, list those. If none discernible, emit "".
- reviews: any testimonials, press mentions, "as seen in" badges, or customer feedback visible in the homepage text. Output as an array of objects with keys source, author, url, title, date, text. If none visible, emit [].

Output ONLY a JSON object with exactly these 6 keys: tagline (string), headquarters_location (string), manufacturing_locations (array), industries (array), product_keywords (string), reviews (array). No markdown, no prose, no extra text.`;

  // Phase 2.19.10: removed fallbackSchema; switched to response_format
  // { type: "json_object" } below. The shape constraint now lives in the
  // prompt's "exactly these two keys" sentence rather than schema enforcement.

  const startedAt = Date.now();
  try {
    const res = await xaiLiveSearchStreaming({
      // Phase 2.19.10 — bumped timeout 30s → 60s. Empirical (Jeff's Garden +
      // Kosterina, 2026-05-10): the fallback's 30s timeout was firing
      // before the model emitted text. Doubling to 60s gives the
      // tools-disabled summarization call enough room to finish on cold-
      // start xAI workers without affecting success-path latency (fallback
      // only runs when canonical has already failed).
      prompt: fallbackPrompt,
      timeoutMs: 60_000,
      model: model || asString(process.env.XAI_MODEL).trim() || DEFAULT_XAI_MODEL,
      // No search_parameters → no tools array built (also maxToolCalls=0
      // omits the tools field entirely; both belt-and-suspenders).
      enableImageUnderstanding: false,
      maxToolCalls: 0,  // Tools disabled — pure summarization
      conversationId: conversationId || sessionId,  // prefer per-company id (Phase 2.19.9)
      signal,
      // Phase 2.19.10 — switched from strict json_schema to json_object.
      // Per Phase 2.19.9's Grok-aligned reasoning: strict schema with
      // required fields creates a "perfect-or-nothing trap" even when
      // tools are disabled. The model can hesitate to emit if it can't
      // satisfy the schema confidently. json_object is looser — it nudges
      // toward JSON output without the all-or-nothing semantic. We keep
      // the fallback prompt's explicit "Output ONLY a JSON object with
      // exactly these two keys" instruction to guide the shape.
      response_format: { type: "json_object" },
    });

    const elapsed = Date.now() - startedAt;

    if (!res?.ok) {
      console.warn(`[canonicalImport] fallback_failed`, {
        session_id: sessionId,
        elapsed_ms: elapsed,
        error: res?.error || "unknown",
      });
      return null;
    }

    const text = extractTextFromXaiResponse(res.resp);
    if (!text || text.length === 0) {
      console.warn(`[canonicalImport] fallback_no_text`, {
        session_id: sessionId,
        elapsed_ms: elapsed,
      });
      return null;
    }

    const parsed = parseCanonicalJson(text);
    if (!parsed || typeof parsed !== "object") {
      console.warn(`[canonicalImport] fallback_unparseable`, {
        session_id: sessionId,
        elapsed_ms: elapsed,
        text_preview: text.slice(0, 200),
      });
      return null;
    }

    const tagline = asString(parsed.tagline).trim();
    const hq = asString(parsed.headquarters_location).trim();
    // Phase 3.6 — extract the additional 4 fields. Defensive: each field
    // must be the right type; if not, default to empty so downstream code
    // doesn't choke on a hallucinated shape.
    const mfg = Array.isArray(parsed.manufacturing_locations)
      ? parsed.manufacturing_locations.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim())
      : [];
    const industries = Array.isArray(parsed.industries)
      ? parsed.industries.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim())
      : [];
    const productKeywords = asString(parsed.product_keywords).trim();
    const reviews = Array.isArray(parsed.reviews)
      ? parsed.reviews.filter((r) => r && typeof r === "object")
      : [];

    console.log(`[canonicalImport] fallback_succeeded`, {
      session_id: sessionId,
      elapsed_ms: elapsed,
      tagline_chars: tagline.length,
      hq_chars: hq.length,
      mfg_count: mfg.length,
      industries_count: industries.length,
      product_keywords_chars: productKeywords.length,
      reviews_count: reviews.length,
    });

    return {
      tagline,
      headquarters_location: hq,
      manufacturing_locations: mfg,
      industries,
      product_keywords: productKeywords,
      reviews,
      _diagnostics: {
        fallback_used: true,
        fallback_elapsed_ms: elapsed,
        fallback_tagline_found: tagline.length > 0,
        fallback_hq_found: hq.length > 0,
        fallback_mfg_found: mfg.length > 0,
        fallback_industries_found: industries.length > 0,
        fallback_product_keywords_found: productKeywords.length > 0,
        fallback_reviews_found: reviews.length > 0,
      },
    };
  } catch (err) {
    console.warn(`[canonicalImport] fallback_threw`, {
      session_id: sessionId,
      elapsed_ms: Date.now() - startedAt,
      error: String(err?.message || err),
    });
    return null;
  }
}

/**
 * Phase 2.19.7 wrapper — try homepage-extraction fallback before falling
 * through to the all-empty failure result. Returns either a partial-success
 * result (when fallback finds tagline or HQ) or the original failure result.
 */
async function buildFailureOrPartialFromFallback({
  fieldsToEnrich,
  errorCode,
  elapsedMs,
  diagnostics,
  fallbackArgs,
}) {
  const fallback = fallbackArgs ? await tryHomepageExtractionFallback(fallbackArgs) : null;

  // Phase 3.6 — fallback now extracts up to 6 fields, not just 2. A
  // populated value in ANY field triggers the partial-success path so
  // we land Partial-X% with however much data was on the homepage,
  // rather than degrading to Stub-0% for rich-brand cap-exhaustion.
  const fallbackHasAnything = Boolean(
    fallback && (
      fallback.tagline
      || fallback.headquarters_location
      || (Array.isArray(fallback.manufacturing_locations) && fallback.manufacturing_locations.length)
      || (Array.isArray(fallback.industries) && fallback.industries.length)
      || fallback.product_keywords
      || (Array.isArray(fallback.reviews) && fallback.reviews.length)
    )
  );

  if (fallbackHasAnything) {
    // Partial success: at least one canonical field was extractable.
    const fields = Array.isArray(fieldsToEnrich) && fieldsToEnrich.length ? fieldsToEnrich : DEFAULT_CANONICAL_FIELDS;
    const completed = [];
    const failed = [];
    const errors = {};
    for (const f of fields) {
      if (f === "tagline" && fallback.tagline) {
        completed.push("tagline");
      } else if (f === "headquarters_location" && fallback.headquarters_location) {
        completed.push("headquarters_location");
      } else if (f === "manufacturing_locations" && Array.isArray(fallback.manufacturing_locations) && fallback.manufacturing_locations.length) {
        completed.push("manufacturing_locations");
      } else if (f === "industries" && Array.isArray(fallback.industries) && fallback.industries.length) {
        completed.push("industries");
      } else if (f === "product_keywords" && fallback.product_keywords) {
        completed.push("product_keywords");
      } else if (f === "reviews" && Array.isArray(fallback.reviews) && fallback.reviews.length) {
        completed.push("reviews");
      } else {
        failed.push(f);
        errors[f] = errorCode;
      }
    }

    const flatEnriched = {
      tagline: fallback.tagline || "",
      headquarters_location: fallback.headquarters_location || "",
      manufacturing_locations: Array.isArray(fallback.manufacturing_locations) ? fallback.manufacturing_locations : [],
      industries: Array.isArray(fallback.industries) ? fallback.industries : [],
      product_keywords: fallback.product_keywords || "",
      reviews: Array.isArray(fallback.reviews) ? fallback.reviews : [],
      location_source_urls: { hq_source_urls: [], mfg_source_urls: [] },
      red_flag: false,
    };

    return {
      ok: true,  // Partial-but-real beats Stub-0%
      fields_completed: completed,
      fields_failed: failed,
      errors,
      enriched: shapeEnvelopeForApply(flatEnriched),
      elapsed_ms: elapsedMs,
      diagnostics: {
        canonical_call: true,
        guidance_version: PROMPT_GUIDANCE_VERSION,
        ...(diagnostics || {}),
        ...(fallback._diagnostics || {}),
      },
    };
  }

  // Fallback didn't help — return the original failure result.
  return buildFailureResult({ fieldsToEnrich, errorCode, elapsedMs, diagnostics });
}

/**
 * Single-call replacement for runDirectEnrichment. Returns the same shape
 * so resume-worker handler.js can consume the result without branching
 * downstream.
 *
 * @param {Object} opts
 * @param {Object} opts.company - The company doc (provides company_name,
 *        url, website_url, normalized_domain).
 * @param {string} opts.sessionId - Session id; reused as conversation_id
 *        for prefix caching across companies in the same batch.
 * @param {number} opts.budgetMs - Remaining wall-clock budget. Timeout is
 *        clamped to [MIN_TIMEOUT_MS, DEFAULT_TIMEOUT_MS].
 * @param {string[]} [opts.fieldsToEnrich] - Fields to populate (JSON-key
 *        names). Defaults to DEFAULT_CANONICAL_FIELDS.
 * @param {AbortSignal} [opts.signal] - Worker orphan-detection signal.
 * @param {Function} [opts.onIntermediateSave] - Optional callback to flush
 *        verified fields to Cosmos before the function returns. Mirrors
 *        runDirectEnrichment's intermediate-save behavior.
 * @param {Object} [opts.modelOverride] - Optional override of the model
 *        used (mostly for testing).
 * @returns {Promise<Object>} { ok, fields_completed, fields_failed, errors,
 *        enriched, elapsed_ms, diagnostics }
 */

// ─── Phase 3.0 — multi-call orchestrator ────────────────────────────────────
//
// Replaces the single canonical call with 3 parallel calls (Core / Locations
// / Reviews) per Grok-4's architectural review. Each call has a focused
// per-field rule set, a narrower tool budget, and a tighter timeout. All 3
// share the same homepage prefetch context and per-company conversation_id
// for prefix-cache benefits.
//
// Gated behind XAI_MULTI_CALL_MODE=on. Kill-switch: set =off (or unset) to
// fall back to the single-call path (Phase 2.19.x behavior).
//
// Success contract: `ok: true` iff Calls 1+2 (Core+Locations) both succeeded.
// Call 3 (Reviews) is bonus content — its failure does NOT flip ok to false.
//
// On any-essential-call-failure (ok=false), the existing
// tryHomepageExtractionFallback is invoked (Phase 2.19.7) to rescue tagline/HQ
// from homepage prefetch — same safety net as single-call mode.

// Phase 3.0 per-call timeouts and tool budgets.
const MULTI_CALL_TIMEOUT_CORE_MS = 60_000;        // tools-disabled summarization
const MULTI_CALL_TIMEOUT_LOCATIONS_MS = 90_000;   // 5 tools, parent-co digging
const MULTI_CALL_TIMEOUT_REVIEWS_MS = 90_000;     // 5 tools, review search
const MULTI_CALL_TOOLS_CORE = 0;                  // pure summarization
const MULTI_CALL_TOOLS_LOCATIONS = 5;
const MULTI_CALL_TOOLS_REVIEWS = 5;

/**
 * Run a single sub-call (Core / Locations / Reviews) for the multi-call
 * orchestrator. Returns a shape that's easy to merge:
 *   { ok, parsed, error_code, diagnostics, raw_text }
 *
 * Internal helper — not exported.
 */
async function _runMultiSubCall({
  callName,
  prompt,
  model,
  timeoutMs,
  maxToolCalls,
  search_parameters,
  conversationId,
  signal,
  response_format,
}) {
  const startedAt = Date.now();
  let res;
  try {
    res = await xaiLiveSearchStreaming({
      prompt,
      timeoutMs,
      model,
      search_parameters,
      enableImageUnderstanding: false,
      maxToolCalls,
      conversationId,
      signal,
      response_format,
      // Phase 3.3 — replaced Phase 3.0.1's `disablePostCapAbort: true` with
      // a tolerance of 2 tool calls past cap. Empirical (Amagabeli + Camp
      // Chef, 2026-05-11): multi-call brands' Call 2/3 went 6+ calls past
      // cap with 0 text emitted, burning the full grace timer. tolerance=2
      // catches Mezzetta-style "one more search before emit" (Mezzetta
      // emitted at #6, well within tolerance) while bounding Amagabeli-
      // style deep-research runaway (#8 forces abort).
      postCapToolCallTolerance: 2,
    });
  } catch (err) {
    return {
      ok: false,
      parsed: null,
      error_code: "streaming_threw",
      diagnostics: {
        call_name: callName,
        elapsed_ms: Date.now() - startedAt,
        tool_calls_counted: 0,
        text_chars: 0,
        stream_threw: String(err?.message || err),
      },
      raw_text: "",
    };
  }

  const elapsed = Date.now() - startedAt;

  if (!res || !res.ok) {
    const rawText = res?.ok ? extractTextFromXaiResponse(res.resp) : "";
    return {
      ok: false,
      parsed: null,
      error_code: res?.error_code || res?.error || "upstream_unreachable",
      diagnostics: {
        call_name: callName,
        elapsed_ms: elapsed,
        tool_calls_counted: res?.diagnostics?.tool_calls_counted ?? 0,
        upstream_status: res?.diagnostics?.upstream_http_status ?? null,
        text_chars: rawText.length,
      },
      raw_text: rawText,
    };
  }

  const rawText = extractTextFromXaiResponse(res.resp);

  if (!rawText || rawText.length === 0) {
    const outputSummary = Array.isArray(res?.resp?.output)
      ? res.resp.output.map((o) => o?.type).filter(Boolean)
      : [];
    return {
      ok: false,
      parsed: null,
      error_code: "model_emitted_no_text",
      diagnostics: {
        call_name: callName,
        elapsed_ms: elapsed,
        tool_calls_counted: res.diagnostics?.tool_calls_counted ?? 0,
        text_chars: 0,
        upstream_completed_no_text: true,
        output_summary: outputSummary,
      },
      raw_text: "",
    };
  }

  const parsed = parseCanonicalJson(rawText);
  if (!parsed || typeof parsed !== "object") {
    return {
      ok: false,
      parsed: null,
      error_code: "unparseable_json",
      diagnostics: {
        call_name: callName,
        elapsed_ms: elapsed,
        tool_calls_counted: res.diagnostics?.tool_calls_counted ?? 0,
        text_chars: rawText.length,
        unparseable_text_preview: rawText.slice(0, 200),
      },
      raw_text: rawText,
    };
  }

  return {
    ok: true,
    parsed,
    error_code: null,
    diagnostics: {
      call_name: callName,
      elapsed_ms: elapsed,
      tool_calls_counted: res.diagnostics?.tool_calls_counted ?? 0,
      text_chars: rawText.length,
    },
    raw_text: rawText,
  };
}

/**
 * Merge the 3 sub-call results into the unified flat enriched shape that
 * shapeEnvelopeForApply consumes. Missing fields land empty (per Phase 3.0
 * spec: type-correct empty values, not undefined).
 */
function mergeMultiCallResults({ coreResult, locationsResult, reviewsResult }) {
  const core = coreResult?.ok ? coreResult.parsed : {};
  const loc = locationsResult?.ok ? locationsResult.parsed : {};
  const rev = reviewsResult?.ok ? reviewsResult.parsed : {};

  // Phase 3.7 — multi-call merge also applies the data-cleanup helpers
  // so dormant XAI_MULTI_CALL_MODE=on path stays parity with the
  // single-call's cleanup.
  // Phase 4.4.B — same filler-strip parity for the multi-call path.
  // Phase 4.12 — same strict location validator parity for the multi-call
  // path. Even though it's dormant (XAI_MULTI_CALL_MODE=off), keep behavior
  // identical so re-enabling multi-call doesn't reintroduce the parenthetical
  // / narrative location bugs Phase 4.12 fixes.
  return {
    tagline: stripFillerString(
      stripUnicodeEscapeLeaks(stripLabel(asString(core?.tagline))),
      "tagline",
    ),
    headquarters_location: (() => {
      const initial = stripFillerString(
        stripUnicodeEscapeLeaks(stripLabel(asString(loc?.headquarters_location))),
        "headquarters_location",
      );
      if (!initial) return "";
      const tokens = initial.includes(";") ? initial.split(";") : [initial];
      const cleaned = [];
      for (const token of tokens) {
        const sanitized = sanitizeLocationString(token, "headquarters_location");
        if (sanitized) cleaned.push(sanitized);
      }
      return cleaned.join("; ");
    })(),
    manufacturing_locations: sanitizeLocationArray(
      stripFillerArray(
        cleanNounPhraseArray(loc?.manufacturing_locations, { allowLowercaseSingleWord: true }),
        "manufacturing_locations",
      ),
      "manufacturing_locations",
    ),
    industries: stripFillerArray(cleanNounPhraseArray(core?.industries), "industries"),
    product_keywords: cleanProductKeywordsString(stripLabel(asString(core?.product_keywords))),
    reviews: Array.isArray(rev?.reviews) ? rev.reviews : [],
    location_source_urls: loc?.location_source_urls && typeof loc.location_source_urls === "object"
      ? {
          hq_source_urls: Array.isArray(loc.location_source_urls.hq_source_urls)
            ? loc.location_source_urls.hq_source_urls
            : [],
          mfg_source_urls: Array.isArray(loc.location_source_urls.mfg_source_urls)
            ? loc.location_source_urls.mfg_source_urls
            : [],
        }
      : { hq_source_urls: [], mfg_source_urls: [] },
    red_flag: false,  // Not in any of the 3 calls; default false (Phase 3.0 doesn't research red_flag)
    social: {},       // Same — not part of any of the 3 calls
  };
}

/**
 * Run the 3-parallel-call canonical orchestrator. Returns the same shape as
 * runCanonicalImportCall so handler.js doesn't need changes.
 *
 * Called from runCanonicalImportCall when XAI_MULTI_CALL_MODE=on.
 */
async function runMultiCallCanonical({
  companyName,
  websiteUrl,
  websiteHost,
  homepageContext,
  conversationId,
  model,
  signal,
  onIntermediateSave,
  requested,
  startedAt,
}) {
  const sp = buildSearchParameters({ companyWebsiteHost: websiteHost });

  console.log(`[canonicalImport] multi_call_start`, {
    company_name: companyName,
    website_url: websiteUrl,
    homepage_context_chars: homepageContext.length,
    conversation_id: conversationId,
    guidance_version: PROMPT_GUIDANCE_VERSION,
  });

  // Build the 3 prompts. Each has identical shared prefix (system + homepage)
  // for prefix-cache hit; call-specific block in the middle; shared suffix.
  const corePrompt = buildCorePrompt({ companyName, websiteUrl, homepageContext });
  const locationsPrompt = buildLocationsPrompt({ companyName, websiteUrl, homepageContext });
  const reviewsPrompt = buildReviewsPrompt({ companyName, websiteUrl, homepageContext });

  // Response format: json_object (Phase 2.19.9 default). No strict schema —
  // each call's prompt already enumerates exact return keys.
  const response_format = { type: "json_object" };

  // Phase 3.1 — run the 3 calls SEQUENTIALLY within a company.
  //
  // Empirical (Betty Crocker + Bimbo Bakeries USA, 2026-05-10): even with
  // XAI_CONCURRENCY=1 (one company at a time), firing 3 parallel xAI streams
  // from one account caused chronic stream contention. Grok-4's first_text
  // arrived at 80-90 seconds — racing our 90s timeout. Cycle 1 just barely
  // succeeded (Call 2 at 85.7s); Cycle 2 lost the race (all 3 calls timed
  // out at 90s). Additionally, the worker died mid-fallback (Azure Functions
  // host-lease expired), requiring 3-min Phase 2.5 stale-takeover wait.
  //
  // Sequential firing (one stream at a time per company) eliminates the
  // same-account contention. Each call gets the model's full attention
  // and emits in 20-60s typically. Trade-off: nominal wall-clock goes
  // from ~90s (parallel ideal) → ~120-180s (sequential typical). In
  // practice this is FASTER because parallel was hitting host-death
  // recovery (7-9 min). Also reduces total in-flight time per worker,
  // reducing the surface for Azure host-recycle to interrupt us.
  //
  // Helper to wrap a sub-call invocation with try/catch (Promise.allSettled
  // shape-equivalent for the sequential path).
  const runSubCall = async (args) => {
    try {
      return await _runMultiSubCall(args);
    } catch (err) {
      return {
        ok: false,
        parsed: null,
        error_code: "promise_rejected",
        diagnostics: { call_name: args.callName, error: String(err?.message || err) },
        raw_text: "",
      };
    }
  };

  // Sequential: Call 1 → Call 2 → Call 3. Each waits for the previous to
  // complete. ONE xAI stream from this account at any time.
  const coreResult = await runSubCall({
    callName: "core",
    prompt: corePrompt,
    model,
    timeoutMs: MULTI_CALL_TIMEOUT_CORE_MS,
    maxToolCalls: MULTI_CALL_TOOLS_CORE,
    // No search_parameters → no tools array built (belt + suspenders with
    // maxToolCalls=0).
    search_parameters: undefined,
    conversationId,
    signal,
    response_format,
  });

  const locationsResult = await runSubCall({
    callName: "locations",
    prompt: locationsPrompt,
    model,
    timeoutMs: MULTI_CALL_TIMEOUT_LOCATIONS_MS,
    maxToolCalls: MULTI_CALL_TOOLS_LOCATIONS,
    search_parameters: sp.search_parameters,
    conversationId,
    signal,
    response_format,
  });

  const reviewsResult = await runSubCall({
    callName: "reviews",
    prompt: reviewsPrompt,
    model,
    timeoutMs: MULTI_CALL_TIMEOUT_REVIEWS_MS,
    maxToolCalls: MULTI_CALL_TOOLS_REVIEWS,
    search_parameters: sp.search_parameters,
    conversationId,
    signal,
    response_format,
  });

  // Aggregate diagnostics for logging.
  const totalToolCalls =
    (coreResult.diagnostics?.tool_calls_counted || 0) +
    (locationsResult.diagnostics?.tool_calls_counted || 0) +
    (reviewsResult.diagnostics?.tool_calls_counted || 0);

  const elapsedMs = Date.now() - startedAt;

  console.log(`[canonicalImport] multi_call_complete`, {
    elapsed_ms: elapsedMs,
    call_1_ok: coreResult.ok,
    call_2_ok: locationsResult.ok,
    call_3_ok: reviewsResult.ok,
    call_1_tool_calls: coreResult.diagnostics?.tool_calls_counted || 0,
    call_2_tool_calls: locationsResult.diagnostics?.tool_calls_counted || 0,
    call_3_tool_calls: reviewsResult.diagnostics?.tool_calls_counted || 0,
    tool_calls_total: totalToolCalls,
    core_error: coreResult.error_code,
    locations_error: locationsResult.error_code,
    reviews_error: reviewsResult.error_code,
  });

  // Failure semantics (Option C, Grok-recommended): ok=true iff Calls 1+2 both
  // succeeded. Reviews failure alone does NOT fail the company.
  const essentialOk = coreResult.ok && locationsResult.ok;

  // Phase 3.0.2 — detect xAI-infrastructure-only failure pattern.
  //
  // When the xAI API is unavailable (503s or circuit-breaker cooldown), all 3
  // sub-calls fail with infrastructure error codes (not model failures). The
  // homepage-extraction fallback would also fail with the same code. Writing
  // a Stub-0% doc to Cosmos in this case is misleading UX — the user sees a
  // "completed" company that has no data, when the real cause is "xAI was
  // down for ~10 seconds." Empirical (SBO + Baker's, 2026-05-10): both
  // companies failed in 12s with all-503 codes during an xAI outage.
  //
  // When this pattern is detected, set `infrastructure_failure_all_calls: true`
  // in the diagnostics so the handler can re-enqueue the company instead of
  // writing an empty result.
  const INFRASTRUCTURE_ERROR_CODES = new Set([
    "upstream_503_cooldown",
    "upstream_http_503",
    "upstream_unreachable",
  ]);
  const isInfraErr = (code) => INFRASTRUCTURE_ERROR_CODES.has(asString(code));
  const allCallsInfrastructureFailed =
    !coreResult.ok && isInfraErr(coreResult.error_code) &&
    !locationsResult.ok && isInfraErr(locationsResult.error_code) &&
    !reviewsResult.ok && isInfraErr(reviewsResult.error_code);

  // Build the merged flat enriched object (failing calls' fields land empty).
  const flatEnriched = mergeMultiCallResults({ coreResult, locationsResult, reviewsResult });

  // Determine per-field success for downstream classifyFields-compatible reporting.
  const errors = {};
  const fields_completed = [];
  const fields_failed = [];

  // Core fields: tagline, industries, product_keywords
  if (coreResult.ok) {
    if (flatEnriched.tagline) fields_completed.push("tagline");
    else { fields_failed.push("tagline"); errors.tagline = "not_found"; }
    if (flatEnriched.industries.length > 0) fields_completed.push("industries");
    else { fields_failed.push("industries"); errors.industries = "not_found"; }
    if (flatEnriched.product_keywords) fields_completed.push("product_keywords");
    else { fields_failed.push("product_keywords"); errors.product_keywords = "not_found"; }
  } else {
    fields_failed.push("tagline", "industries", "product_keywords");
    errors.tagline = coreResult.error_code;
    errors.industries = coreResult.error_code;
    errors.product_keywords = coreResult.error_code;
  }

  // Locations fields: headquarters_location, manufacturing_locations
  if (locationsResult.ok) {
    if (flatEnriched.headquarters_location) fields_completed.push("headquarters_location");
    else { fields_failed.push("headquarters_location"); errors.headquarters_location = "not_found"; }
    if (flatEnriched.manufacturing_locations.length > 0) fields_completed.push("manufacturing_locations");
    else { fields_failed.push("manufacturing_locations"); errors.manufacturing_locations = "not_found"; }
  } else {
    fields_failed.push("headquarters_location", "manufacturing_locations");
    errors.headquarters_location = locationsResult.error_code;
    errors.manufacturing_locations = locationsResult.error_code;
  }

  // Reviews field
  if (reviewsResult.ok) {
    if (flatEnriched.reviews.length > 0) fields_completed.push("reviews");
    else { fields_failed.push("reviews"); errors.reviews = "not_found"; }
  } else {
    fields_failed.push("reviews");
    errors.reviews = reviewsResult.error_code;
  }

  // Filter fields_completed/failed/errors to requested fields only.
  const requestedSet = new Set(requested);
  const filteredCompleted = fields_completed.filter((f) => requestedSet.has(f));
  const filteredFailed = fields_failed.filter((f) => requestedSet.has(f));
  const filteredErrors = {};
  for (const f of Object.keys(errors)) {
    if (requestedSet.has(f)) filteredErrors[f] = errors[f];
  }

  const diagnostics = {
    canonical_call: true,
    multi_call: true,
    guidance_version: PROMPT_GUIDANCE_VERSION,
    mode: "multi_call",
    elapsed_ms: elapsedMs,
    call_1_ok: coreResult.ok,
    call_2_ok: locationsResult.ok,
    call_3_ok: reviewsResult.ok,
    call_1_tool_calls: coreResult.diagnostics?.tool_calls_counted || 0,
    call_2_tool_calls: locationsResult.diagnostics?.tool_calls_counted || 0,
    call_3_tool_calls: reviewsResult.diagnostics?.tool_calls_counted || 0,
    tool_calls_total: totalToolCalls,
    call_1_error: coreResult.error_code,
    call_2_error: locationsResult.error_code,
    call_3_error: reviewsResult.error_code,
    text_chars_total:
      (coreResult.diagnostics?.text_chars || 0) +
      (locationsResult.diagnostics?.text_chars || 0) +
      (reviewsResult.diagnostics?.text_chars || 0),
    model,
    // Phase 3.0.2 — flag for handler.js to recognize xAI-infrastructure-only
    // failures and re-enqueue instead of writing Stub-0%.
    infrastructure_failure_all_calls: allCallsInfrastructureFailed,
  };

  // Phase 3.0.2 — short-circuit the fallback when ALL calls failed with
  // infrastructure errors. The fallback uses the same xAI endpoint and will
  // fail with the same circuit-breaker error. Skip the wasted 60s timeout.
  if (allCallsInfrastructureFailed) {
    console.warn(`[canonicalImport] multi_call_infrastructure_failure_all_calls`, {
      call_1_error: coreResult.error_code,
      call_2_error: locationsResult.error_code,
      call_3_error: reviewsResult.error_code,
      action: "skipping_fallback_returning_retry_marker",
    });
    return {
      ok: false,
      fields_completed: [],
      fields_failed: [...requested],
      errors: Object.fromEntries(requested.map((f) => [f, "upstream_503_cooldown"])),
      enriched: shapeEnvelopeForApply({}),
      elapsed_ms: Date.now() - startedAt,
      diagnostics: {
        ...diagnostics,
        fallback_used: false,
        fallback_skipped_reason: "infrastructure_failure_all_calls",
        enriched_envelope_shape: true,
      },
    };
  }

  // If essential calls failed, attempt the homepage-extraction fallback.
  // Phase 2.19.7's tryHomepageExtractionFallback rescues tagline+HQ from the
  // homepage prefetch (tools-disabled, 60s timeout, json_object format).
  if (!essentialOk) {
    console.warn(`[canonicalImport] multi_call_essential_fail`, {
      call_1_ok: coreResult.ok,
      call_2_ok: locationsResult.ok,
      // Trigger fallback if either Call 1 OR Call 2 failed.
    });

    const fallback = await tryHomepageExtractionFallback({
      homepageContext,
      companyName,
      websiteUrl,
      sessionId: conversationId,  // for diagnostic logging
      conversationId,
      signal,
      model,
    });

    if (fallback && (fallback.tagline || fallback.headquarters_location)) {
      // Fold the fallback's tagline/HQ into the merged enriched object.
      const upgradedEnriched = {
        ...flatEnriched,
        tagline: flatEnriched.tagline || fallback.tagline || "",
        headquarters_location: flatEnriched.headquarters_location || fallback.headquarters_location || "",
      };
      const upgradedCompleted = filteredCompleted.slice();
      const upgradedFailed = filteredFailed.slice();
      const upgradedErrors = { ...filteredErrors };
      if (fallback.tagline && !upgradedCompleted.includes("tagline")) {
        upgradedCompleted.push("tagline");
        const idx = upgradedFailed.indexOf("tagline");
        if (idx !== -1) upgradedFailed.splice(idx, 1);
        delete upgradedErrors.tagline;
      }
      if (fallback.headquarters_location && !upgradedCompleted.includes("headquarters_location")) {
        upgradedCompleted.push("headquarters_location");
        const idx = upgradedFailed.indexOf("headquarters_location");
        if (idx !== -1) upgradedFailed.splice(idx, 1);
        delete upgradedErrors.headquarters_location;
      }

      // intermediateSave with the rescued fields
      if (typeof onIntermediateSave === "function" && upgradedCompleted.length > 0) {
        try {
          await onIntermediateSave({
            verified: {
              tagline: upgradedEnriched.tagline,
              headquarters_location: upgradedEnriched.headquarters_location,
              manufacturing_locations: upgradedEnriched.manufacturing_locations,
              industries: upgradedEnriched.industries,
              product_keywords: upgradedEnriched.product_keywords,
              location_source_urls: upgradedEnriched.location_source_urls,
              red_flag: upgradedEnriched.red_flag,
              keywords: upgradedEnriched.product_keywords
                ? upgradedEnriched.product_keywords.split(",").map((s) => s.trim()).filter(Boolean)
                : [],
              curated_reviews: upgradedEnriched.reviews,
            },
          });
        } catch (err) {
          console.error(`[canonicalImport] multi_call_fallback_intermediate_save_threw`, {
            error: String(err?.message || err),
          });
        }
      }

      return {
        ok: true,
        fields_completed: upgradedCompleted,
        fields_failed: upgradedFailed,
        errors: upgradedErrors,
        enriched: shapeEnvelopeForApply(upgradedEnriched),
        elapsed_ms: Date.now() - startedAt,
        diagnostics: {
          ...diagnostics,
          fallback_used: true,
          fallback_tagline_rescued: !!fallback.tagline,
          fallback_hq_rescued: !!fallback.headquarters_location,
          enriched_envelope_shape: true,
        },
      };
    }

    // Fallback also failed — return failure with whatever Call 3 (reviews)
    // may have produced.
    return {
      ok: false,
      fields_completed: filteredCompleted,
      fields_failed: filteredFailed,
      errors: filteredErrors,
      enriched: shapeEnvelopeForApply(flatEnriched),
      elapsed_ms: Date.now() - startedAt,
      diagnostics: {
        ...diagnostics,
        fallback_used: true,
        fallback_succeeded: false,
        enriched_envelope_shape: true,
      },
    };
  }

  // Happy path: Calls 1+2 both succeeded. intermediateSave the merged data.
  if (typeof onIntermediateSave === "function" && filteredCompleted.length > 0) {
    try {
      await onIntermediateSave({
        verified: {
          tagline: flatEnriched.tagline,
          headquarters_location: flatEnriched.headquarters_location,
          manufacturing_locations: flatEnriched.manufacturing_locations,
          industries: flatEnriched.industries,
          product_keywords: flatEnriched.product_keywords,
          location_source_urls: flatEnriched.location_source_urls,
          red_flag: flatEnriched.red_flag,
          keywords: flatEnriched.product_keywords
            ? flatEnriched.product_keywords.split(",").map((s) => s.trim()).filter(Boolean)
            : [],
          curated_reviews: flatEnriched.reviews,
        },
      });
    } catch (err) {
      console.error(`[canonicalImport] multi_call_intermediate_save_threw`, {
        error: String(err?.message || err),
      });
    }
  }

  return {
    ok: true,
    fields_completed: filteredCompleted,
    fields_failed: filteredFailed,
    errors: filteredErrors,
    enriched: shapeEnvelopeForApply(flatEnriched),
    elapsed_ms: Date.now() - startedAt,
    diagnostics: {
      ...diagnostics,
      enriched_envelope_shape: true,
    },
  };
}

async function runCanonicalImportCall({
  company,
  sessionId,
  budgetMs,
  fieldsToEnrich,
  signal,
  onIntermediateSave,
  modelOverride,
} = {}) {
  const startedAt = Date.now();

  const companyName = asString(company?.company_name);
  const websiteUrl = asString(company?.url) || asString(company?.website_url);
  const websiteHost = extractWebsiteHost(websiteUrl);

  // Phase 2.19.9 — fresh conversation_id per company.
  //
  // Previously we reused sessionId as the xAI conversation_id across all
  // companies in a batch for prefix-cache benefits. Per Grok-4's review:
  // for thin-presence brands, cached context from earlier brands' research
  // can bias the model toward "I already covered something similar" patterns
  // and degrade emission. Use the company_id (stable per company) instead so
  // we still get prefix caching within a company's own retries / cycles, but
  // not across unrelated companies.
  const companyConversationId =
    asString(company?.company_id).trim() ||
    asString(company?.id).trim() ||
    asString(sessionId);

  const requested = Array.isArray(fieldsToEnrich) && fieldsToEnrich.length ? fieldsToEnrich : [...DEFAULT_CANONICAL_FIELDS];

  // Clamp timeout to budget but never below 30s (a tighter cap risks killing
  // calls before any tool work completes).
  const fromBudget = Number.isFinite(Number(budgetMs)) ? Number(budgetMs) - 5_000 : DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.max(MIN_TIMEOUT_MS, Math.min(DEFAULT_TIMEOUT_MS, fromBudget));

  const sp = buildSearchParameters({ companyWebsiteHost: websiteHost });

  // Phase 2.12 — pre-fetch homepage + key sub-pages BEFORE the canonical
  // call so the model has substantive context on turn 0. Empirically the
  // "model emits no text" failure mode (Eliza B / Flojos / Luna Sandals /
  // Kiwi Sandals) happens when the first 1-2 web_search calls don't
  // surface enough info — the model gives up rather than continue. Phase
  // 2.11's companyHost-include unlocked the model's ability to find the
  // company's site, but didn't change the give-up-after-thin-results
  // behaviour. Pre-fetching the homepage gives the model the data
  // directly, removing the search-required-then-give-up cascade.
  //
  // Best-effort: if prefetch fails (timeout, blocked by Cloudflare, JS-
  // rendered SPA with no static body, etc.) we proceed with empty context
  // — the existing prose research instructions still apply. So this is
  // additive, not load-bearing.
  let homepageContext = "";
  let homepageContextDiag = null;
  try {
    const prefetchResult = await prefetchHomepageContext({
      websiteUrl,
      maxChars: 3500,
      perPageChars: 1400,
      perFetchTimeoutMs: 8_000,
      signal,
    });
    homepageContext = prefetchResult.context || "";
    homepageContextDiag = prefetchResult.diagnostics || null;
    console.log(`[canonicalImport] homepage_prefetch_done`, {
      session_id: sessionId,
      website_url: websiteUrl,
      context_chars: homepageContext.length,
      pages_ok: homepageContextDiag?.pages_ok ?? null,
      pages_with_text: homepageContextDiag?.pages_with_text ?? null,
      elapsed_ms: homepageContextDiag?.elapsed_ms ?? null,
      truncated: homepageContextDiag?.truncated ?? false,
    });
  } catch (prefetchErr) {
    console.warn(`[canonicalImport] homepage_prefetch_threw`, {
      session_id: sessionId,
      error: String(prefetchErr?.message || prefetchErr),
    });
  }

  const model = asString(modelOverride).trim() || asString(process.env.XAI_MODEL).trim() || DEFAULT_XAI_MODEL;

  // Phase 3.0 — dispatch to multi-call orchestrator if XAI_MULTI_CALL_MODE=on.
  //
  // The multi-call path replaces the single canonical call with 3 parallel
  // calls (Core / Locations / Reviews) per Grok-4's architectural review.
  // Kill-switch: XAI_MULTI_CALL_MODE=off (or unset) preserves the legacy
  // single-call behavior. See plan file for the full architecture.
  const multiCallMode = String(process.env.XAI_MULTI_CALL_MODE || "off")
    .trim().toLowerCase() === "on";
  if (multiCallMode) {
    console.log(`[canonicalImport] dispatch_multi_call`, {
      session_id: sessionId,
      company_name: companyName,
      website_url: websiteUrl,
      homepage_context_chars: homepageContext.length,
      conversation_id_source: companyConversationId === sessionId ? "session" : "company",
      guidance_version: PROMPT_GUIDANCE_VERSION,
    });
    return runMultiCallCanonical({
      companyName,
      websiteUrl,
      websiteHost,
      homepageContext,
      conversationId: companyConversationId,
      model,
      signal,
      onIntermediateSave,
      requested,
      startedAt,
    });
  }

  const prompt = buildCanonicalImportPrompt({
    companyName,
    websiteUrl,
    fields: requested,
    includeSourceUrls: true,
    homepageContext,
  });
  const promptBody = `${prompt}${sp.prompt_exclusion_text || ""}`;

  // Phase 2.19.9 — three-mode response_format selector.
  //
  // Phase 2.10's claim that "strict json_schema FORCES emission server-side"
  // turned out to be wrong empirically (Spread the Love, Adams, Woodstock,
  // MaraNatha, etc.). Strict schema only validates IF the model emits text;
  // it does NOT prevent the model from terminating with status="completed"
  // and output containing only web_search_call items. Confirmed in the
  // 2026-05-09 batch with `has_response_format: true, text_chars: 0`.
  //
  // Per Grok-4's architectural review: strict schema + 8 required fields +
  // tools creates a "perfect-or-nothing trap" — the model keeps researching
  // to satisfy ALL required keys, runs out of budget, terminates without
  // emitting. JSON-mode (`{ type: "json_object" }`) is looser — it nudges
  // the model toward JSON output without the all-or-nothing semantic.
  //
  // Three modes via XAI_RESPONSE_FORMAT_MODE env var:
  //   - "strict"      → response_format: { type: "json_schema", strict: true, ... }
  //                     (Phase 2.10 behavior — prone to no-text failure)
  //   - "json_object" → response_format: { type: "json_object" }
  //                     (Phase 2.19.9 default — looser, emission-friendly)
  //   - "off"         → response_format omitted entirely; prompt-only enforcement
  //                     (Phase 2.2 → 2.9 behavior)
  //
  // Legacy XAI_USE_RESPONSE_FORMAT=off still maps to "off" for backward
  // compatibility with existing Azure Function App settings.
  const responseFormatMode = (() => {
    const newVar = String(process.env.XAI_RESPONSE_FORMAT_MODE || "").trim().toLowerCase();
    if (newVar === "strict" || newVar === "json_object" || newVar === "off") return newVar;
    // Legacy fallback: XAI_USE_RESPONSE_FORMAT=off → off; anything else → json_object default
    const legacyVar = String(process.env.XAI_USE_RESPONSE_FORMAT || "").trim().toLowerCase();
    if (legacyVar === "off") return "off";
    return "json_object";  // Phase 2.19.9 default
  })();
  const response_format =
    responseFormatMode === "strict" ? buildResponseFormat() :
    responseFormatMode === "json_object" ? { type: "json_object" } :
    undefined;

  // Phase 2.1 — log entry diagnostics so we can correlate the call with
  // its inputs (prompt size, model, tool/timeout config, schema presence).
  console.log(`[canonicalImport] call_start`, {
    session_id: sessionId,
    company_name: companyName,
    website_url: websiteUrl,
    website_host: websiteHost,
    requested_fields: requested,
    requested_field_count: requested.length,
    prompt_chars: promptBody.length,
    timeout_ms: timeoutMs,
    max_tool_calls: DEFAULT_MAX_TOOL_CALLS,
    model,
    has_response_format: Boolean(response_format),
    response_format_mode: responseFormatMode,  // Phase 2.19.9
    response_format_strict: !!response_format?.json_schema?.strict,
    excluded_domains_count: Array.isArray(sp.search_parameters?.sources)
      ? (sp.search_parameters.sources[0]?.excluded_websites?.length || 0)
      : 0,
    has_conversation_id: !!companyConversationId,  // Phase 2.19.9
    conversation_id_source: companyConversationId === sessionId ? "session" : "company",
    guidance_version: PROMPT_GUIDANCE_VERSION,
  });

  // Phase 2.19.7 — closure that builds the homepage-extraction fallback args
  // for the failure paths below. The fallback runs a tools-disabled,
  // strict-json_schema xAI call against the homepage prefetch text. It can
  // rescue tagline + HQ when the canonical call fails (model_emitted_no_text,
  // upstream 503, sse_stall, upstream_timeout, unparseable_json).
  const failureWithFallback = (errorCode, failureElapsedMs, diagnostics) =>
    buildFailureOrPartialFromFallback({
      fieldsToEnrich: requested,
      errorCode,
      elapsedMs: failureElapsedMs,
      diagnostics,
      fallbackArgs: {
        homepageContext,
        companyName,
        websiteUrl,
        sessionId,
        conversationId: companyConversationId,  // Phase 2.19.9
        signal,
        model,
      },
    });

  // Streaming first (preferred — partial-flush handler salvages tool-budget aborts).
  let res;
  let mode = "streaming";
  try {
    res = await xaiLiveSearchStreaming({
      prompt: promptBody,
      timeoutMs,
      model,
      search_parameters: sp.search_parameters,
      enableImageUnderstanding: false,
      maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
      conversationId: companyConversationId,  // Phase 2.19.9 — per-company id
      signal,
      response_format,
    });
  } catch (err) {
    console.error(`[canonicalImport] streaming_threw`, {
      session_id: sessionId,
      error: String(err?.message || err),
      elapsed_ms: Date.now() - startedAt,
    });
    return await failureWithFallback("upstream_unreachable", Date.now() - startedAt, {
      stream_threw: String(err?.message || err),
      mode,
    });
  }

  // xaiLiveSearchStreaming returns null when the configured endpoint is
  // /chat/completions instead of /responses. Fall back to the non-streaming
  // call so the canonical path works regardless of endpoint config.
  if (res === null) {
    mode = "non_streaming_fallback";
    console.log(`[canonicalImport] streaming_returned_null_falling_back`, {
      session_id: sessionId,
      reason: "endpoint_is_chat_completions_not_responses",
    });
    try {
      res = await xaiLiveSearch({
        prompt: promptBody,
        maxTokens: 4000,
        timeoutMs,
        model,
        search_parameters: sp.search_parameters,
        useTools: true,
        conversationId: companyConversationId,  // Phase 2.19.9 — per-company id
        signal,
        response_format,
      });
    } catch (err) {
      console.error(`[canonicalImport] non_streaming_threw`, {
        session_id: sessionId,
        error: String(err?.message || err),
        elapsed_ms: Date.now() - startedAt,
      });
      return await failureWithFallback("upstream_unreachable", Date.now() - startedAt, {
        non_stream_threw: String(err?.message || err),
        mode,
      });
    }
  }

  let elapsedMs = Date.now() - startedAt;

  // Phase 2.1 — log upstream return summary BEFORE parsing so we can see if
  // the call actually returned anything useful. Key diagnostic for the
  // "model went 22 tool calls and emitted 0 text" failure mode — text_chars
  // and tool_cap_aborted will tell us exactly what happened.
  let rawText = res?.ok ? extractTextFromXaiResponse(res.resp) : "";
  console.log(`[canonicalImport] upstream_returned`, {
    session_id: sessionId,
    mode,
    elapsed_ms: elapsedMs,
    ok: !!res?.ok,
    upstream_error: res?.error || null,
    upstream_error_code: res?.error_code || null,
    upstream_status: res?.diagnostics?.upstream_http_status ?? null,
    tool_calls_counted: res?.diagnostics?.tool_calls_counted ?? null,
    tool_cap_aborted: res?.diagnostics?.tool_cap_aborted ?? null,
    streaming: res?.diagnostics?.streaming ?? null,
    text_chars: rawText.length,
    text_preview: rawText.slice(0, 200),
  });

  // Phase 3.9 — one-time auto-retry on transient sse_stall.
  //
  // Empirical (Sir Scrubbington, Solo Stove, Twin Eagles 2026-05-11 to
  // 2026-05-12): xAI occasionally accepts the request and then sends zero
  // SSE events. Our 60s stall detector aborts correctly, but the canonical
  // ends up at Stub-0% (or Partial-X% via fallback) when a simple retry
  // 2s later would have succeeded.
  //
  // Gate the retry tightly to bound cost:
  //   - upstream_error_code === "sse_stall"
  //   - tool_calls_counted === 0 (xAI emitted NO events; nothing to discard)
  //   - text_chars === 0 (no partial JSON to preserve)
  //   - first call elapsed < 90s (don't retry a long-running stall — its
  //     own behavior suggests xAI is broader-degraded, not transient)
  //   - mode === "streaming" (don't retry the non-streaming fallback —
  //     that path is already a degraded mode)
  //
  // The preserved-info question (user 3.9 request "can we keep the info
  // already accumulated"): with the 0/0/0 gate above, there IS nothing to
  // preserve from the first call. Per-company conversation_id is reused
  // for the retry so xAI's prefix cache stays hot. If a future variant
  // wants to retry partial-progress stalls (text_chars > 0), we can
  // preserve `rawText_first_attempt` for merge — but the current data
  // doesn't show that case being common.
  let phase39_retry_attempted = false;
  let phase39_retry_used = false;
  let phase39_first_error_code = null;
  let phase39_first_elapsed_ms = null;
  const FIRST_CALL_MAX_FOR_RETRY_MS = 90_000;
  if (
    mode === "streaming"
    && !res?.ok
    && res?.error_code === "sse_stall"
    && (res?.diagnostics?.tool_calls_counted ?? 0) === 0
    && rawText.length === 0
    && elapsedMs < FIRST_CALL_MAX_FOR_RETRY_MS
  ) {
    phase39_retry_attempted = true;
    phase39_first_error_code = res?.error_code || null;
    phase39_first_elapsed_ms = elapsedMs;
    const retryStartedAt = Date.now();
    console.warn(`[canonicalImport] sse_stall_retry_attempting`, {
      session_id: sessionId,
      first_elapsed_ms: elapsedMs,
      first_tool_calls: res?.diagnostics?.tool_calls_counted ?? 0,
      first_text_chars: 0,
      backoff_ms: 2000,
    });

    // Brief backoff so xAI's stuck SSE worker can recycle. Empirical
    // (Sir Scrubbington / Solo Stove): stalls cleared within seconds when
    // a fresh request reached a different xAI backend instance.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    let retryRes;
    try {
      retryRes = await xaiLiveSearchStreaming({
        prompt: promptBody,
        timeoutMs,
        model,
        search_parameters: sp.search_parameters,
        enableImageUnderstanding: false,
        maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
        conversationId: companyConversationId,
        signal,
        response_format,
      });
    } catch (retryErr) {
      console.error(`[canonicalImport] sse_stall_retry_threw`, {
        session_id: sessionId,
        error: String(retryErr?.message || retryErr),
        retry_elapsed_ms: Date.now() - retryStartedAt,
      });
      retryRes = null;
    }

    const retryElapsedMs = Date.now() - retryStartedAt;
    const retryRawText = retryRes?.ok ? extractTextFromXaiResponse(retryRes.resp) : "";

    // Prefer the retry result if it made meaningful progress — defined as
    // either:
    //   (a) retryRes.ok === true AND retry has more text than original, OR
    //   (b) retry fired at least one tool call (vs the original's zero), OR
    //   (c) retry's text is non-empty
    const retryProgressed = Boolean(
      retryRes?.ok
      || (retryRes?.diagnostics?.tool_calls_counted ?? 0) > 0
      || retryRawText.length > 0
    );

    if (retryProgressed) {
      phase39_retry_used = true;
      res = retryRes;
      rawText = retryRawText;
      // Update elapsedMs to reflect TOTAL time (first attempt + backoff + retry)
      // so the diagnostics record the real wall-clock cost of the retry.
      elapsedMs = Date.now() - startedAt;
      console.log(`[canonicalImport] sse_stall_retry_succeeded`, {
        session_id: sessionId,
        retry_elapsed_ms: retryElapsedMs,
        retry_ok: !!retryRes?.ok,
        retry_tool_calls: retryRes?.diagnostics?.tool_calls_counted ?? null,
        retry_text_chars: retryRawText.length,
        total_elapsed_ms_inc_first_call: elapsedMs,
      });
    } else {
      // Retry also stalled / failed. Keep the first call's res to preserve
      // the original error code for diagnostics, but record that the retry
      // happened so the fallback path knows.
      console.warn(`[canonicalImport] sse_stall_retry_failed`, {
        session_id: sessionId,
        retry_elapsed_ms: retryElapsedMs,
        retry_ok: !!retryRes?.ok,
        retry_error: retryRes?.error || null,
        retry_error_code: retryRes?.error_code || null,
        retry_tool_calls: retryRes?.diagnostics?.tool_calls_counted ?? null,
        retry_text_chars: retryRawText.length,
      });
    }
  }

  if (!res || !res.ok) {
    return await failureWithFallback(
      res?.error_code || "upstream_unreachable",
      elapsedMs,
      {
        mode,
        upstream_status: res?.diagnostics?.upstream_http_status ?? null,
        tool_calls_counted: res?.diagnostics?.tool_calls_counted ?? null,
        tool_cap_aborted: res?.diagnostics?.tool_cap_aborted ?? null,
        upstream_error: res?.error || null,
        text_chars: rawText.length,
        text_preview_on_failure: rawText.slice(0, 200),
        // Phase 3.9 — retry telemetry on the failure path.
        phase39_sse_stall_retry_attempted: phase39_retry_attempted,
        phase39_sse_stall_retry_used: phase39_retry_used,
        phase39_first_error_code: phase39_first_error_code,
        phase39_first_elapsed_ms: phase39_first_elapsed_ms,
      }
    );
  }

  // Phase 2.6 — model_emitted_no_text: upstream returned ok with
  // `response.completed`, but the output array contained no text-bearing
  // item (only a web_search_call or similar). Empirically (Eliza B
  // session 91d1ade3): the model decided "I have nothing useful, I'm done"
  // and terminated the response with status=completed, incomplete=null,
  // and no output_text/message item.
  //
  // Without this branch, extractTextFromXaiResponse used to return
  // JSON.stringify(envelope), parseCanonicalJson succeeded on the envelope,
  // and we reported all-fields-empty as "parsed_ok" — false-positive
  // success that masked the real failure mode.
  if (rawText.length === 0) {
    const outputSummary = Array.isArray(res?.resp?.output)
      ? res.resp.output.map((o) => o?.type).filter(Boolean)
      : [];
    console.warn(`[canonicalImport] model_emitted_no_text`, {
      session_id: sessionId,
      tool_calls_counted: res.diagnostics?.tool_calls_counted ?? null,
      output_summary: outputSummary,
      upstream_status: res.resp?.status ?? null,
      upstream_incomplete: res.resp?.incomplete_details ?? null,
    });
    return await failureWithFallback("model_emitted_no_text", elapsedMs, {
      mode,
      upstream_status: res.diagnostics?.upstream_http_status ?? null,
      tool_calls_counted: res.diagnostics?.tool_calls_counted ?? null,
      text_chars: 0,
      upstream_completed_no_text: true,
      output_summary: outputSummary,
      upstream_response_status: res.resp?.status ?? null,
      // Phase 3.9 — retry telemetry on the no-text failure path.
      phase39_sse_stall_retry_attempted: phase39_retry_attempted,
      phase39_sse_stall_retry_used: phase39_retry_used,
      phase39_first_error_code: phase39_first_error_code,
      phase39_first_elapsed_ms: phase39_first_elapsed_ms,
    });
  }

  const text = rawText;
  const parsed = parseCanonicalJson(text);

  if (!parsed) {
    console.warn(`[canonicalImport] unparseable_json`, {
      session_id: sessionId,
      text_chars: text.length,
      text_preview: text.slice(0, 400),
    });
    return await failureWithFallback("unparseable_json", elapsedMs, {
      mode,
      upstream_status: res.diagnostics?.upstream_http_status ?? null,
      tool_calls_counted: res.diagnostics?.tool_calls_counted ?? null,
      text_chars: text.length,
      unparseable_text_preview: asString(text).slice(0, 400),
      // Phase 3.9 — retry telemetry on the unparseable-json failure path.
      phase39_sse_stall_retry_attempted: phase39_retry_attempted,
      phase39_sse_stall_retry_used: phase39_retry_used,
      phase39_first_error_code: phase39_first_error_code,
      phase39_first_elapsed_ms: phase39_first_elapsed_ms,
    });
  }

  // Phase 2.8 — keep the flat shape internally for classifyFields and the
  // intermediateSave path (which uses Object.assign(doc, flat) for an
  // immediate Cosmos write before applyEnrichmentToCompany runs). Then
  // wrap into nested envelopes for the returned result.enriched, which is
  // what handler.js feeds into applyEnrichmentToCompany — that's the helper
  // that clears stale *_unknown flags, geocodes HQ + manufacturing, builds
  // headquarters_locations plural array, and sets *_status / *_searched_at
  // audit fields.
  const flatEnriched = shapeEnrichedFromParsed(parsed);
  const { fields_completed, fields_failed, errors } = classifyFields(requested, flatEnriched);

  console.log(`[canonicalImport] parsed_ok`, {
    session_id: sessionId,
    fields_completed,
    fields_failed,
    tagline_len: flatEnriched.tagline.length,
    hq_len: flatEnriched.headquarters_location.length,
    mfg_count: flatEnriched.manufacturing_locations.length,
    industries_count: flatEnriched.industries.length,
    product_keywords_len: flatEnriched.product_keywords.length,
    reviews_count: flatEnriched.reviews.length,
    hq_source_count: flatEnriched.location_source_urls?.hq_source_urls?.length || 0,
    mfg_source_count: flatEnriched.location_source_urls?.mfg_source_urls?.length || 0,
  });

  // Fire the intermediate save callback with FLAT values — the handler's
  // existing callback persists verified fields immediately via
  // Object.assign(doc, flat), so a worker killed before the function returns
  // still preserves the values. Phase 2.8 unchanged: flat in, flat out at
  // this seam.
  if (typeof onIntermediateSave === "function" && fields_completed.length > 0) {
    const verified = {};
    for (const f of fields_completed) {
      verified[f] = flatEnriched[f];
    }
    if (flatEnriched.location_source_urls) verified.location_source_urls = flatEnriched.location_source_urls;
    verified.red_flag = flatEnriched.red_flag;
    try {
      await onIntermediateSave(verified);
    } catch {
      // Non-fatal; the handler's logger will catch save failures separately.
    }
  }

  // Phase 2.8 — return the NESTED ENVELOPE for handler.js →
  // applyEnrichmentToCompany. This is the Variant 2 architectural fix that
  // unlocks: stale *_unknown flag clearing, *_status / *_searched_at audit
  // fields, HQ + manufacturing geocoding (sets hq_lat/hq_lng), plural
  // headquarters_locations structured array, and source-url top-level
  // extraction. Previously runCanonicalImportCall returned the flat shape,
  // which silently bypassed applyEnrichmentToCompany's per-field processing.
  const enriched = shapeEnvelopeForApply(flatEnriched);

  // Preserve the non-canonical fields on the envelope so handler.js still
  // has access to them via existing object-spread paths. red_flag and
  // social are not consumed by applyEnrichmentToCompany but are read
  // directly elsewhere; keeping them on the result avoids breaking those
  // call sites.
  enriched.red_flag = flatEnriched.red_flag;
  enriched.social = flatEnriched.social;
  enriched.location_source_urls = flatEnriched.location_source_urls;

  return {
    ok: fields_completed.length > 0,
    fields_completed,
    fields_failed,
    errors,
    enriched,
    elapsed_ms: elapsedMs,
    diagnostics: {
      canonical_call: true,
      guidance_version: PROMPT_GUIDANCE_VERSION,
      mode,
      tool_calls_counted: res.diagnostics?.tool_calls_counted ?? null,
      tool_cap_aborted: res.diagnostics?.tool_cap_aborted ?? null,
      upstream_status: res.diagnostics?.upstream_http_status ?? null,
      text_chars: text.length,
      model,
      enriched_envelope_shape: true,  // marker: handler.js can rely on nested per-field shape
      // Phase 3.9 — surface auto-retry telemetry on the success path so we
      // can correlate "imports that succeeded only because of the retry"
      // vs "first-attempt successes" in production data.
      phase39_sse_stall_retry_attempted: phase39_retry_attempted,
      phase39_sse_stall_retry_used: phase39_retry_used,
      phase39_first_error_code: phase39_first_error_code,
      phase39_first_elapsed_ms: phase39_first_elapsed_ms,
    },
  };
}

module.exports = {
  runCanonicalImportCall,
  // Exported for tests.
  shapeEnrichedFromParsed,
  shapeEnvelopeForApply,
  classifyFields,
  buildResponseFormat,
  stripLabel,
  tryHomepageExtractionFallback,
  buildFailureOrPartialFromFallback,
  // Phase 3.0: multi-call parallel canonical
  runMultiCallCanonical,
  mergeMultiCallResults,
  // Phase 3.7: data-cleanup helpers
  stripUnicodeEscapeLeaks,
  isQualityNounPhraseEntry,
  cleanNounPhraseArray,
  cleanProductKeywordsString,
  // Phase 4.4.B: filler-pattern sanitizer
  isFillerValue,
  stripFillerString,
  stripFillerArray,
  FILLER_PATTERNS,
  // Phase 4.12: strict geographic location validator
  stripParentheticals,
  isValidLocationEntry,
  sanitizeLocationString,
  sanitizeLocationArray,
  // Phase 4.31: incompleteness sentinel for manufacturing locations
  OTHER_UNKNOWN_LOCATIONS_SENTINEL,
  isOtherUnknownLocationsSentinel,
  LOCATION_NARRATIVE_RED_FLAGS,
};
