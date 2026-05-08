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

test("buildCanonicalImportPrompt explicitly forbids fabrication / requires empty over hallucination", () => {
  const prompt = buildCanonicalImportPrompt({
    companyName: "Acme",
    websiteUrl: "https://acme.example.com",
  });
  // Grok-validated guard: lock down the "empty when unverified, never
  // fabricate" contract so missing fields are trustworthy ("not available
  // online") rather than guesses dressed up as facts.
  assert.ok(
    prompt.includes("do not fabricate"),
    "must instruct the model to never fabricate missing fields"
  );
  assert.ok(
    prompt.includes("appropriate empty value"),
    "must instruct the model to use empty values for unverified fields"
  );
  assert.ok(
    /\bexhaustive search\b/i.test(prompt),
    "the empty-over-hallucination guard should fire only AFTER exhaustive search"
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
  assert.ok(prompt.includes("web_search and browse_page tools aggressively"), "missing tool-use directive");

  // 3-source cross-verify rule
  assert.ok(prompt.includes("Cross-verify every fact with at least 3 independent sources"), "missing 3-source rule");

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
  assert.ok(prompt.includes("Find 5 unique, legitimate third-party reviews"), "reviews 5-count rule missing");
  assert.ok(prompt.includes("1-2 YouTube reviews"), "YouTube source mix rule missing");

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

  // Phase 2.2 — explicit "stop searching after 5 tool calls" instruction
  // counters the failure mode where Grok-4 + tools + strict-json_schema
  // entered an aggressive tool-use loop. The prose-level guard backs up
  // the streaming-handler tool cap.
  assert.ok(
    /After 5 web_search or browse_page tool calls/i.test(prompt),
    "prompt must instruct the model to stop tool-calling after 5 calls"
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
