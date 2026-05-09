// _xaiPromptGuidance.test.js
// Phase 1 — verifies the canonical-import prompt + JSON schema + parser.
// Run: node --test C:/dev/tabarnam-frontend/api/_xaiPromptGuidance.test.js

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  PROMPT_GUIDANCE_VERSION,
  DEFAULT_CANONICAL_FIELDS,
  CANONICAL_IMPORT_JSON_SCHEMA,
  buildCanonicalImportPrompt,
  parseCanonicalJson,
} = require("./_xaiPromptGuidance");

// ── PROMPT_GUIDANCE_VERSION ─────────────────────────────────────────────────

test("PROMPT_GUIDANCE_VERSION reflects single-call canonical cut", () => {
  assert.match(PROMPT_GUIDANCE_VERSION, /^7\./);
});

test("buildCanonicalImportPrompt explicitly forbids fabrication and requires per-field empty types (Phase 2.3)", () => {
  const prompt = buildCanonicalImportPrompt({
    companyName: "Acme",
    websiteUrl: "https://acme.example.com",
  });
  // Grok-validated guard: lock down the "empty when unverified, never
  // fabricate" contract so missing fields are trustworthy ("not available
  // online") rather than guesses dressed up as facts.
  // Phase 2.3: phrasing changed to "Do not fabricate or hallucinate" + per-field types.
  assert.ok(
    /do not fabricate or hallucinate/i.test(prompt),
    "must instruct the model to never fabricate missing fields (case-insensitive)"
  );
  // Phase 2.3 — per-field empty types replace the generic "empty value" sentence.
  assert.ok(
    /tagline.*headquarters_location.*product_keywords.*→.*""/.test(prompt) ||
    /tagline,\s*headquarters_location,\s*product_keywords\s*→\s*""/.test(prompt),
    "string fields must be told to use empty string \"\" when unverified"
  );
  assert.ok(
    /manufacturing_locations,\s*industries,\s*reviews\s*→\s*\[\]/.test(prompt),
    "array fields must be told to use empty array [] when unverified"
  );
  assert.ok(
    /Never use ""\s*for an array field/.test(prompt),
    "must explicitly forbid empty string for array fields (the Beek failure mode)"
  );
});

// ── DEFAULT_CANONICAL_FIELDS ────────────────────────────────────────────────

test("DEFAULT_CANONICAL_FIELDS lists the 6 canonical JSON keys in order", () => {
  assert.deepEqual(DEFAULT_CANONICAL_FIELDS, [
    "tagline",
    "headquarters_location",
    "manufacturing_locations",
    "industries",
    "product_keywords",
    "reviews",
  ]);
});

// ── buildCanonicalImportPrompt ──────────────────────────────────────────────

test("buildCanonicalImportPrompt full-field prompt contains canonical structural elements", () => {
  const prompt = buildCanonicalImportPrompt({
    companyName: "Acme Corp",
    websiteUrl: "https://acme.example.com",
  });

  // Targeting line — verbatim shape from the user's grok.com prompt
  assert.ok(
    prompt.includes("For the Company: Acme Corp / https://acme.example.com"),
    "missing canonical 'For the Company:' targeting line"
  );

  // Tool-use directive
  // Phase 2.4: preamble was softened from "aggressively" → "efficiently"
  // because the prior wording contributed to runaway tool calls on complex
  // brands. The test checks the core tool-use directive without locking in
  // a specific adjective.
  assert.ok(
    /web_search and browse_page tools (efficiently|aggressively)/i.test(prompt),
    "missing tool-use directive (web_search + browse_page)"
  );

  // Phase 2.4 — the old "Cross-verify every fact with at least 3 independent
  // sources" rule was REMOVED because it caused tool-loop runaway on complex
  // brands (Birkenstock: model went 11+ tool calls trying to satisfy 3
  // sources × 6 fields, hit 150s timeout with 0 text). Replaced with
  // "official site + 1 additional source" floor. Verification of the
  // removal lives in the Phase 2.4 assertions further down.

  // Per-field rule blocks (verbatim from grok.com — short labels)
  assert.ok(/^Tagline:/m.test(prompt), "missing Tagline section");
  assert.ok(/^HQ:/m.test(prompt), "missing HQ section");
  assert.ok(/^Manufacturing:/m.test(prompt), "missing Manufacturing section");
  assert.ok(/^Industries:/m.test(prompt), "missing Industries section");
  assert.ok(/^Products:/m.test(prompt), "missing Products section");
  assert.ok(/^Reviews:/m.test(prompt), "missing Reviews section");

  // Specific verbatim grok.com phrases (production-refined wording)
  assert.ok(prompt.includes("Use initials for states or provinces"), "HQ format rule missing");
  assert.ok(prompt.includes("Use USA, not US"), "USA-not-US rule missing");
  assert.ok(prompt.includes("8-15 short noun phrases"), "industries count rule missing");
  // Phase 2.4: relaxed from "Find 5 unique, legitimate third-party reviews"
  // to "Find up to 5 unique third-party reviews" — accepts fewer-than-5
  // results without padding (matches the user's "quality over quantity"
  // preference and prevents the model from spinning on review searches
  // when only 2-3 are credibly available).
  assert.ok(
    /Find up to 5 unique third-party reviews/i.test(prompt) ||
    /Find 5 unique, legitimate third-party reviews/i.test(prompt),
    "reviews 5-count rule missing (Phase 2.4: 'up to 5' or earlier 'Find 5')"
  );
  // Phase 2.4: rewording dropped "1-2 YouTube reviews" → "Prefer 1-2 from YouTube"
  assert.ok(
    /1-2 YouTube reviews/i.test(prompt) || /1-2 from YouTube/i.test(prompt),
    "YouTube source mix rule missing (1-2 from YouTube)"
  );

  // Source-URL request (the bridge to JSON schema field)
  assert.ok(prompt.includes("location_source_urls"), "missing location_source_urls request");
  assert.ok(prompt.includes("hq_source_urls"), "missing hq_source_urls field");
  assert.ok(prompt.includes("mfg_source_urls"), "missing mfg_source_urls field");

  // JSON-output framing — bare object, no array wrapper
  assert.ok(prompt.includes("Return ONLY a single JSON object"), "missing JSON-object output instruction");
  assert.ok(!/array wrapper/i.test(prompt) || prompt.includes("no extra"), "should disallow array wrapper");

  // Field-name bridging — the prompt now lists property names inline
  // (Phase 2.2 dropped strict json_schema enforcement, so the trailing
  // sentence enumerates exact JSON keys instead of referencing "the schema
  // below"). The point is still that short labels (HQ:, Manufacturing:)
  // are translated to canonical schema keys.
  assert.ok(
    prompt.includes("with these exact property names"),
    "missing inline property-names enumeration"
  );
  assert.ok(prompt.includes("headquarters_location"), "must enumerate canonical headquarters_location key");
  assert.ok(prompt.includes("manufacturing_locations"), "must enumerate canonical manufacturing_locations key");
  assert.ok(prompt.includes("product_keywords"), "must enumerate canonical product_keywords key");

  // Phase 2.4 — TOOL BUDGET block with explicit per-field allocation,
  // EMIT EARLY trigger at 6+ calls, and hard cap at 12. Replaces the
  // single-sentence "after N tool calls" guard from earlier phases.
  assert.ok(
    /TOOL BUDGET/i.test(prompt),
    "prompt must include TOOL BUDGET block (Phase 2.4)"
  );
  assert.ok(
    /maximum of 10 web_search/i.test(prompt),
    "prompt must declare 10-call ceiling (Phase 2.5 tightened from 12 alongside serialization lock)"
  );
  assert.ok(
    /EMIT EARLY/i.test(prompt) && /6 or more tool calls/i.test(prompt),
    "prompt must include EMIT EARLY trigger at 6+ tool calls"
  );
  // Phase 2.5 — EMIT EARLY now requires tagline AND headquarters_location
  // specifically (was: any 2 fields). Tagline + HQ are the cheapest fields
  // to verify and the most important for user-facing display, so making
  // them the trigger means the model emits with the highest-value data.
  assert.ok(
    /tagline and headquarters_location/i.test(prompt),
    "Phase 2.5: EMIT EARLY trigger must require tagline AND headquarters_location specifically"
  );
  assert.ok(
    /After 10 tool calls you MUST stop/i.test(prompt),
    "prompt must include hard cap at 10 tool calls (Phase 2.5)"
  );

  // Phase 2.3 — explicit "no label leakage" instruction. Without this, the
  // model bled "HQ:" into the headquarters_location JSON value (Beek import).
  assert.ok(
    /Do NOT include any field labels/i.test(prompt),
    "prompt must explicitly forbid label leakage into JSON values"
  );

  // Phase 2.3 — Reviews rule must specify JSON array of objects. The
  // previous wording described plaintext blank-line format which conflicted
  // with the JSON contract — every review attempt failed because the model
  // emitted plaintext but the parser expected an array.
  // Phase 2.3 fix: Reviews must emit a JSON array of objects (the prior
  // plaintext "Source: / Author: / URL: ..." block was removed).
  // Phase 2.4: rewording dropped the word "reviews" from the directive
  // ("Output as a JSON array of objects" rather than "Output reviews as
  // a JSON array of objects") — both are valid contracts.
  assert.ok(
    /Output (reviews )?as a JSON array of objects/i.test(prompt),
    "Reviews rule must specify JSON array of objects (Phase 2.3 fix preserved)"
  );
  // The plaintext blank-line block must be GONE.
  assert.ok(
    !/Source:\s*\[Name of publication/i.test(prompt),
    "obsolete plaintext-format Reviews block must be removed"
  );
  assert.ok(
    !/Separate each review with one blank line/i.test(prompt),
    "blank-line separator language must be removed (was for plaintext output)"
  );

  // ── Phase 2.4 — softened verification language ────────────────────────────
  // Original "cross-verify with at least 3 independent sources" language was
  // the largest contributor to runaway tool calls. Replaced with "official
  // site + 1 additional source". The prompt must NOT contain the old
  // hard-three-source demand.
  assert.ok(
    !/at least 3 independent sources/i.test(prompt),
    "Phase 2.4: hard '3 independent sources' demand must be removed (caused tool-loop runaway on complex brands)"
  );
  assert.ok(
    !/cross-verifying across at least 3/i.test(prompt),
    "Phase 2.4: 'cross-verifying across at least 3' phrasing must be removed from HQ/Manufacturing rules"
  );
  assert.ok(
    /official website/i.test(prompt) && /one additional/i.test(prompt),
    "Phase 2.4: HQ/Manufacturing rules must reference 'official site + 1 additional' as the verification floor"
  );
  assert.ok(
    /prefer emitting partial JSON/i.test(prompt),
    "Phase 2.4: preamble must include 'prefer emitting partial JSON' bounded-budget framing"
  );

  // ── Phase 2.4 — Products rule (universal categories, NOT exhaustive) ──────
  // User preference: universal/category-level terms over SKU-by-SKU lists.
  // Empirical: grok.com produces this style naturally; our previous
  // "Exhaustive, complete list" wording pushed the model into deep crawls
  // that exhausted the tool budget before any text emitted.
  assert.ok(
    /universal product categories/i.test(prompt) || /universal product categor/i.test(prompt),
    "Phase 2.4: Products rule must specify 'universal product categories' (user preference)"
  );
  assert.ok(
    !/Exhaustive, complete list of all products/i.test(prompt),
    "Phase 2.4: 'Exhaustive, complete list of all products' wording must be removed"
  );
  assert.ok(
    /Do NOT enumerate every SKU/i.test(prompt),
    "Phase 2.4: Products rule must explicitly forbid enumerating every SKU/variant"
  );
  // Concrete examples nudge the model toward the right style.
  assert.ok(
    /Arizona sandals/i.test(prompt) && /Boston clogs/i.test(prompt),
    "Phase 2.4: Products rule must include concrete footwear examples (Arizona sandals, Boston clogs)"
  );

  // ── Phase 2.4 — Reviews URL verification dropped ──────────────────────────
  // Costs ~5 tool calls (1 per review). Empirically grok.com doesn't
  // re-verify URLs and produces high-quality reviews; we accept the model's
  // search results without spot-check.
  assert.ok(
    !/Confirm all URLs are functional/i.test(prompt),
    "Phase 2.4: 'Confirm all URLs are functional' must be removed (costs ~5 tool calls)"
  );
  assert.ok(
    /NOT required to revisit each URL/i.test(prompt),
    "Phase 2.4: Reviews rule must explicitly state URL re-verification is NOT required"
  );

  // ── Phase 2.4 — Industries rule examples ──────────────────────────────────
  assert.ok(
    /Cork Footbed Sandals/i.test(prompt) && /Orthopedic Footwear/i.test(prompt),
    "Phase 2.4: Industries rule must include Birkenstock-style category examples"
  );

  // No markdown formatting
  assert.ok(!/^# /m.test(prompt), "should not contain Markdown headers");
  assert.ok(!prompt.includes("**"), "should not contain Markdown bold");
});

test("buildCanonicalImportPrompt fields-list line uses provided fields parameter verbatim", () => {
  const prompt = buildCanonicalImportPrompt({
    companyName: "Acme",
    websiteUrl: "https://acme.example.com",
    fields: ["tagline", "headquarters_location"],
  });
  assert.ok(prompt.includes("Fields to populate: tagline, headquarters_location"), "fields line should reflect input");
});

test("buildCanonicalImportPrompt defaults to full canonical field list when fields omitted", () => {
  const prompt = buildCanonicalImportPrompt({
    companyName: "Acme",
    websiteUrl: "https://acme.example.com",
  });
  const expected = DEFAULT_CANONICAL_FIELDS.join(", ");
  assert.ok(prompt.includes(`Fields to populate: ${expected}`), "default fields list missing");
});

test("buildCanonicalImportPrompt empty company name falls back to placeholder", () => {
  const prompt = buildCanonicalImportPrompt({});
  assert.ok(prompt.includes("(unknown company) / (unknown website)"), "missing unknown-company placeholder");
});

test("buildCanonicalImportPrompt includeSourceUrls=false omits source-URL request line", () => {
  const prompt = buildCanonicalImportPrompt({
    companyName: "Acme",
    websiteUrl: "https://acme.example.com",
    includeSourceUrls: false,
  });
  // The bridging sentence at the very end still mentions source URL fields by
  // name, but the standalone request line ("Also include location_source_urls
  // with hq_source_urls and mfg_source_urls arrays...") should be absent.
  assert.ok(!prompt.includes("Also include location_source_urls"), "should not request location_source_urls when disabled");
});

// ── CANONICAL_IMPORT_JSON_SCHEMA — ajv strict validation ────────────────────

const Ajv = require("ajv");
const addFormats = (() => {
  try { return require("ajv-formats"); } catch { return null; }
})();
const ajv = new Ajv({ strict: false, allErrors: true });
if (addFormats) addFormats(ajv);

test("CANONICAL_IMPORT_JSON_SCHEMA validates a minimal valid response", () => {
  const validate = ajv.compile(CANONICAL_IMPORT_JSON_SCHEMA);
  const minimal = {
    tagline: "We make things",
    headquarters_location: "Austin, TX, USA",
    manufacturing_locations: ["Austin, TX, USA"],
    industries: ["Specialty Foods", "Snack Foods"],
    product_keywords: "jerky, dried meats, snack packs",
    reviews: [
      {
        source: "Foodie Mag",
        author: "J. Smith",
        url: "https://foodiemag.example.com/review-acme",
        title: "Acme Snacks Reviewed",
        date: "2026-01-15",
        text: "Crunchy and flavorful. Worth the price.",
      },
    ],
    location_source_urls: { hq_source_urls: [], mfg_source_urls: [] },
    red_flag: false,
  };
  const ok = validate(minimal);
  assert.ok(ok, "minimal payload should validate. errors=" + JSON.stringify(validate.errors));
});

test("CANONICAL_IMPORT_JSON_SCHEMA rejects extra top-level keys (additionalProperties:false)", () => {
  const validate = ajv.compile(CANONICAL_IMPORT_JSON_SCHEMA);
  const bad = {
    tagline: "x",
    headquarters_location: "x",
    manufacturing_locations: [],
    industries: [],
    product_keywords: "",
    reviews: [],
    location_source_urls: { hq_source_urls: [], mfg_source_urls: [] },
    red_flag: false,
    surprise_field: "should not be here",
  };
  const ok = validate(bad);
  assert.equal(ok, false, "extra top-level keys must be rejected");
});

test("CANONICAL_IMPORT_JSON_SCHEMA rejects missing required fields", () => {
  const validate = ajv.compile(CANONICAL_IMPORT_JSON_SCHEMA);
  const bad = {
    tagline: "x",
    // headquarters_location missing
    manufacturing_locations: [],
    industries: [],
    product_keywords: "",
    reviews: [],
    location_source_urls: { hq_source_urls: [], mfg_source_urls: [] },
    red_flag: false,
  };
  const ok = validate(bad);
  assert.equal(ok, false, "missing required field must be rejected");
});

test("CANONICAL_IMPORT_JSON_SCHEMA rejects review object missing required keys", () => {
  const validate = ajv.compile(CANONICAL_IMPORT_JSON_SCHEMA);
  const bad = {
    tagline: "x",
    headquarters_location: "x",
    manufacturing_locations: [],
    industries: [],
    product_keywords: "",
    reviews: [{ source: "X", author: "Y", url: "https://x.example.com", title: "T", date: "D" /* text missing */ }],
    location_source_urls: { hq_source_urls: [], mfg_source_urls: [] },
    red_flag: false,
  };
  const ok = validate(bad);
  assert.equal(ok, false, "review missing 'text' must be rejected");
});

test("CANONICAL_IMPORT_JSON_SCHEMA enforces product_keywords as string (not array)", () => {
  const validate = ajv.compile(CANONICAL_IMPORT_JSON_SCHEMA);
  const bad = {
    tagline: "x",
    headquarters_location: "x",
    manufacturing_locations: [],
    industries: [],
    product_keywords: ["should", "be", "string"],
    reviews: [],
    location_source_urls: { hq_source_urls: [], mfg_source_urls: [] },
    red_flag: false,
  };
  const ok = validate(bad);
  assert.equal(ok, false, "product_keywords as array must be rejected");
});

// ── parseCanonicalJson ──────────────────────────────────────────────────────

test("parseCanonicalJson parses a bare object", () => {
  assert.deepEqual(parseCanonicalJson('{"tagline":"hi"}'), { tagline: "hi" });
});

test("parseCanonicalJson strips ```json code fences", () => {
  const text = "```json\n{\"tagline\":\"hi\"}\n```";
  assert.deepEqual(parseCanonicalJson(text), { tagline: "hi" });
});

test("parseCanonicalJson strips bare ``` code fences", () => {
  const text = "```\n{\"tagline\":\"hi\"}\n```";
  assert.deepEqual(parseCanonicalJson(text), { tagline: "hi" });
});

test("parseCanonicalJson tolerates leading/trailing whitespace", () => {
  assert.deepEqual(parseCanonicalJson('  \n  {"tagline":"hi"}  \n  '), { tagline: "hi" });
});

test("parseCanonicalJson tolerates array-of-1 wrapping (defensive)", () => {
  assert.deepEqual(parseCanonicalJson('[{"tagline":"hi"}]'), { tagline: "hi" });
});

test("parseCanonicalJson returns null on unparseable input", () => {
  assert.equal(parseCanonicalJson("not json at all"), null);
  assert.equal(parseCanonicalJson(""), null);
  assert.equal(parseCanonicalJson(null), null);
  assert.equal(parseCanonicalJson(undefined), null);
});

test("parseCanonicalJson returns null when content is a primitive (not object)", () => {
  assert.equal(parseCanonicalJson('"just a string"'), null);
  assert.equal(parseCanonicalJson("42"), null);
});

test("parseCanonicalJson handles model preamble + JSON object", () => {
  const text = "Sure, here is the JSON:\n\n{\"tagline\":\"hi\",\"red_flag\":false}\n\nLet me know if you need more.";
  assert.deepEqual(parseCanonicalJson(text), { tagline: "hi", red_flag: false });
});

// ── _xaiLiveSearch response_format passthrough ──────────────────────────────

test("_xaiLiveSearch.js exports xaiLiveSearch and xaiLiveSearchStreaming", () => {
  const ls = require("./_xaiLiveSearch");
  assert.equal(typeof ls.xaiLiveSearch, "function");
  assert.equal(typeof ls.xaiLiveSearchStreaming, "function");
});

test("_xaiLiveSearch source declares response_format parameter on both functions", () => {
  // Hard guarantee that Phase 1's response_format passthrough is present.
  // If this fails, the single-call worker (Phase 2) cannot enforce json_schema.
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.join(__dirname, "_xaiLiveSearch.js"), "utf8");
  // Both function signatures must declare the parameter.
  const matches = src.match(/response_format,\s*\/\//g) || [];
  assert.ok(matches.length >= 2, "response_format must be declared on both xaiLiveSearch and xaiLiveSearchStreaming");
  // Both payload builders must spread response_format conditionally.
  const passthroughMatches = src.match(/response_format && typeof response_format === "object" \? \{ response_format \}/g) || [];
  assert.ok(passthroughMatches.length >= 2, "response_format must flow into both payload builders");
});

// ── Phase 2.6 — mandatory emission + minimum tool-call floor ────────────────
//
// Replicates fixes for the Eliza B failure (model emitted no text after 1
// tool call). The prompt now MUST instruct the model that emitting nothing
// is unacceptable, AND require a minimum of 2 tool calls before deciding
// the company has no findable data.

test("Phase 2.6: PROMPT_GUIDANCE_VERSION is 7.1.2-mandatory-emission", () => {
  assert.match(
    PROMPT_GUIDANCE_VERSION,
    /^7\.1\.2-mandatory-emission/,
    "PROMPT_GUIDANCE_VERSION must be 7.1.2-mandatory-emission for Phase 2.6"
  );
});

test("Phase 2.6: prompt mandates JSON object emission (cannot output nothing)", () => {
  const prompt = buildCanonicalImportPrompt({
    companyName: "Acme",
    websiteUrl: "https://acme.example.com",
  });
  // The single most important Phase 2.6 instruction: model MUST emit JSON.
  assert.ok(
    /You MUST emit a JSON object/i.test(prompt),
    "prompt must explicitly mandate that the model emits a JSON object"
  );
  assert.ok(
    /Outputting nothing is NOT acceptable/i.test(prompt),
    "prompt must explicitly forbid emitting nothing"
  );
  assert.ok(
    /Emitting an all-empty JSON object is preferable/i.test(prompt),
    "prompt must clarify that all-empty JSON is preferable to no output"
  );
});

test("Phase 2.6: prompt requires minimum 2 tool calls before giving up", () => {
  const prompt = buildCanonicalImportPrompt({
    companyName: "Acme",
    websiteUrl: "https://acme.example.com",
  });
  assert.ok(
    /MINIMUM EFFORT/i.test(prompt),
    "prompt must include a MINIMUM EFFORT block"
  );
  assert.ok(
    /at least 2 tool calls/i.test(prompt),
    "prompt must require at least 2 tool calls"
  );
  assert.ok(
    /Do NOT terminate after 0 or 1 tool calls/i.test(prompt),
    "prompt must explicitly forbid 0-or-1-call termination"
  );
});
