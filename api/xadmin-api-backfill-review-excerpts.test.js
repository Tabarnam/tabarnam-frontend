// Tests for Phase 4.33 backfill-review-excerpts endpoint helpers.
//
// We do not exercise the full handler here (it requires a fake `app.http`
// registration + Cosmos mock + xAI mock chain that the existing test
// harness sets up at the integration level). Instead we test the pure
// helper exports — `isExcerptMissing` and `buildExcerptPrompt` — which
// own the decision boundary of the endpoint:
//
//   - isExcerptMissing decides which review entries get patched.
//   - buildExcerptPrompt decides what we ask xAI for each one.
//
// Getting these right is the whole game; the surrounding endpoint is
// straight Cosmos read → loop → write plumbing.

const test = require("node:test");
const assert = require("node:assert");

// The endpoint module registers an Azure Function on require via
// `app.http(...)`. To keep the test isolated, stub _app's `app.http` to
// a no-op before requiring the module. (The same pattern other endpoint
// tests in this repo use.)
const Module = require("module");
const originalResolve = Module._resolve_filename || Module._resolveFilename;

// Provide a minimal stub so require("../_app") returns a fake `app`.
require.cache[require.resolve("./_app")] = {
  id: require.resolve("./_app"),
  filename: require.resolve("./_app"),
  loaded: true,
  exports: { app: { http: () => {} } },
};

const {
  isExcerptMissing,
  buildExcerptPrompt,
} = require("./xadmin-api-backfill-review-excerpts");

test("Phase 4.33: isExcerptMissing returns true for empty/short text", () => {
  assert.strictEqual(isExcerptMissing({}), true, "no text field");
  assert.strictEqual(isExcerptMissing({ text: "" }), true, "empty string");
  assert.strictEqual(isExcerptMissing({ text: "   " }), true, "whitespace only");
  assert.strictEqual(isExcerptMissing({ text: "short" }), true, "shorter than 10 chars");
  assert.strictEqual(isExcerptMissing({ text: null }), true, "null text");
  assert.strictEqual(isExcerptMissing({ text: undefined }), true, "undefined text");
});

test("Phase 4.33: isExcerptMissing returns true for known placeholder shapes", () => {
  // Common shapes the model occasionally emits in lieu of a real excerpt.
  assert.strictEqual(isExcerptMissing({ text: "n/a" }), true);
  assert.strictEqual(isExcerptMissing({ text: "N/A" }), true);
  assert.strictEqual(isExcerptMissing({ text: "no excerpt" }), true);
  assert.strictEqual(isExcerptMissing({ text: "No excerpt available" }), true);
  assert.strictEqual(isExcerptMissing({ text: "no text" }), true);
  assert.strictEqual(isExcerptMissing({ text: "tbd" }), true);
  assert.strictEqual(isExcerptMissing({ text: "TODO" }), true);
  assert.strictEqual(isExcerptMissing({ text: "placeholder" }), true);
  assert.strictEqual(isExcerptMissing({ text: "null" }), true);
});

test("Phase 4.33: isExcerptMissing returns false for substantive text", () => {
  const realExcerpt =
    "The Cloudmonster delivers exceptional cushioning for long runs, " +
    "with a softer foam compound than previous On models.";
  assert.strictEqual(isExcerptMissing({ text: realExcerpt }), false);

  // Just over the 10-char minimum still passes.
  assert.strictEqual(
    isExcerptMissing({ text: "Solid sandals." }),
    false,
    "14-char substantive blurb should pass"
  );
});

test("Phase 4.33: isExcerptMissing handles bad input shapes safely", () => {
  assert.strictEqual(isExcerptMissing(null), false, "null is not a review entry");
  assert.strictEqual(isExcerptMissing(undefined), false, "undefined is not a review entry");
  assert.strictEqual(isExcerptMissing("string"), false, "string is not a review entry");
  assert.strictEqual(isExcerptMissing(42), false, "number is not a review entry");
});

test("Phase 4.33: buildExcerptPrompt includes URL, title, source, and company", () => {
  const prompt = buildExcerptPrompt(
    {
      url: "https://runrepeat.com/on-cloudmonster-review",
      title: "On Cloudmonster review",
      source: "RunRepeat",
      author: "Jens Jakob Andersen",
    },
    "On Running"
  );
  assert.ok(prompt.includes("On Running"), "must include company name");
  assert.ok(
    prompt.includes("https://runrepeat.com/on-cloudmonster-review"),
    "must include URL"
  );
  assert.ok(prompt.includes("On Cloudmonster review"), "must include title");
  assert.ok(prompt.includes("RunRepeat"), "must include source");
  assert.ok(prompt.includes("Jens Jakob Andersen"), "must include author");
});

test("Phase 4.33: buildExcerptPrompt mandates 1-3 sentence summary and JSON shape", () => {
  const prompt = buildExcerptPrompt(
    { url: "https://example.com/r", title: "T", source: "S" },
    "TestCo"
  );
  assert.ok(
    /1-3 sentence summary/i.test(prompt),
    "must specify 1-3 sentence summary"
  );
  assert.ok(
    /"text"/.test(prompt),
    "must specify the exact JSON key 'text'"
  );
  assert.ok(
    /Return ONLY a single JSON object/i.test(prompt),
    "must instruct ONLY JSON output (no prose)"
  );
  assert.ok(
    /Do NOT fabricate/i.test(prompt),
    "must instruct no fabrication"
  );
});

test("Phase 4.33: buildExcerptPrompt handles missing optional review fields gracefully", () => {
  // Author missing — should not throw, should produce a coherent prompt.
  const prompt = buildExcerptPrompt(
    { url: "https://example.com/x", title: "X", source: "Y" },
    "TestCo"
  );
  assert.ok(typeof prompt === "string" && prompt.length > 200);
  // Should not contain literal "undefined" / "null" leakage.
  assert.ok(!/undefined|null/.test(prompt), "no JS-leakage tokens in prompt");
});

test("Phase 4.33: buildExcerptPrompt handles entirely empty review object", () => {
  // Defensive: even with no fields at all, prompt should not throw and
  // should ask the model to skip if the URL is missing.
  const prompt = buildExcerptPrompt({}, "TestCo");
  assert.ok(typeof prompt === "string" && prompt.length > 100);
  assert.ok(prompt.includes("TestCo"));
});
