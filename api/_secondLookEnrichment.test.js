// _secondLookEnrichment.test.js
// Second-look pass — prompt builder, plain-text parser, trigger decision,
// and union-merge helpers. Pure-helper tests, no network.

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  SECOND_LOOK_FIELDS,
  decideSecondLook,
  buildSecondLookPrompt,
  parseSecondLookOutput,
  unionKeywordStrings,
  unionLocationArrays,
} = require("./_secondLookEnrichment");
const { OTHER_UNKNOWN_LOCATIONS_SENTINEL } = require("./_canonicalImport");

// ── Prompt builder ───────────────────────────────────────────────────────────

test("buildSecondLookPrompt includes header, identity line, and only requested field blocks", () => {
  const prompt = buildSecondLookPrompt({
    companyName: "Archies",
    websiteUrl: "https://archiesfootwear.com/",
    fields: ["headquarters_location", "product_keywords"],
  });
  assert.match(prompt, /^For the Company: Archies \/ https:\/\/archiesfootwear\.com\//);
  assert.match(prompt, /Fields to populate: HQ, keywords/);
  assert.match(prompt, /Do NOT use any markdown formatting/);
  assert.match(prompt, /HQ: Conduct thorough research/);
  assert.match(prompt, /Keywords: Exhaustive, complete list of all products/);
  // Not requested — must be absent.
  assert.doesNotMatch(prompt, /Manufacturing: Conduct thorough research/);
  assert.doesNotMatch(prompt, /Reviews: Find 3 unique/);
});

test("buildSecondLookPrompt preserves canonical field order regardless of input order", () => {
  const prompt = buildSecondLookPrompt({
    companyName: "X",
    websiteUrl: "https://x.com",
    fields: ["reviews", "tagline", "manufacturing_locations"],
  });
  assert.match(prompt, /Fields to populate: tagline, manufacturing, reviews/);
});

test("buildSecondLookPrompt defaults to all six fields", () => {
  const prompt = buildSecondLookPrompt({ companyName: "X", websiteUrl: "https://x.com" });
  assert.match(prompt, /Fields to populate: tagline, HQ, manufacturing, industries, keywords, reviews/);
});

// ── Parser ───────────────────────────────────────────────────────────────────

const FULL_OUTPUT = `Archies

Tagline: Support you can feel.
HQ: Spanish Fork, UT, USA
Manufacturing: Hanoi, Vietnam; Spanish Fork, UT, USA
Industries: Footwear, Health & Wellness, Consumer Goods
Keywords: arch support flip flops, slides, slippers, socks
Reviews: Source: YouTube
Author: The Foot Practice
URL: https://www.youtube.com/watch?v=abc123
Title: Archies Flip Flops Review — A Podiatrist's Take
Date: March 2026
Text: A detailed review of the arch support and build quality.

Source: Runner's World
Author: Jane Miller
URL: https://www.runnersworld.com/gear/archies-review
Title: We Tested Archies Recovery Sandals
Date: 2026-01-15
Text: Testers found them supportive for post-run recovery.`;

test("parseSecondLookOutput parses a full well-formed response", () => {
  const { found_any, parsed, labels_found } = parseSecondLookOutput(FULL_OUTPUT);
  assert.equal(found_any, true);
  assert.deepEqual(labels_found.sort(), [
    "headquarters_location", "industries", "manufacturing_locations",
    "product_keywords", "reviews", "tagline",
  ].sort());
  assert.equal(parsed.tagline, "Support you can feel.");
  assert.equal(parsed.headquarters_location, "Spanish Fork, UT, USA");
  assert.deepEqual(parsed.manufacturing_locations, ["Hanoi, Vietnam", "Spanish Fork, UT, USA"]);
  assert.deepEqual(parsed.industries, ["Footwear", "Health & Wellness", "Consumer Goods"]);
  assert.equal(parsed.product_keywords, "arch support flip flops, slides, slippers, socks");
  assert.equal(parsed.reviews.length, 2);
  assert.equal(parsed.reviews[0].source, "YouTube");
  assert.equal(parsed.reviews[0].url, "https://www.youtube.com/watch?v=abc123");
  assert.equal(parsed.reviews[1].author, "Jane Miller");
});

test("parseSecondLookOutput tolerates markdown contamination and leading narrative", () => {
  const messy = [
    "I researched the company thoroughly. Here is what I found:",
    "",
    "**Tagline:** Support you can feel.",
    "- HQ: Spanish Fork, UT, USA",
    "## Industries: Footwear, Consumer Goods",
  ].join("\n");
  const { found_any, parsed } = parseSecondLookOutput(messy);
  assert.equal(found_any, true);
  assert.equal(parsed.tagline, "Support you can feel.");
  assert.equal(parsed.headquarters_location, "Spanish Fork, UT, USA");
  assert.deepEqual(parsed.industries, ["Footwear", "Consumer Goods"]);
});

test("parseSecondLookOutput handles missing fields and truncated tail", () => {
  const partial = "Tagline: Great stuff.\nHQ: Austin, TX, U";
  const { found_any, parsed } = parseSecondLookOutput(partial);
  assert.equal(found_any, true);
  assert.equal(parsed.tagline, "Great stuff.");
  assert.equal(parsed.headquarters_location, "Austin, TX, U");
  assert.deepEqual(parsed.manufacturing_locations, []);
  assert.deepEqual(parsed.reviews, []);
});

test("parseSecondLookOutput returns found_any=false for pure narrative", () => {
  const { found_any } = parseSecondLookOutput("I could not find anything about this company.");
  assert.equal(found_any, false);
});

test("parseSecondLookOutput drops reviews without a URL and de-dups by url/author", () => {
  const text = `Reviews: Source: Blog A
Author: Sam
URL: https://a.example/review
Title: T1
Date: 2026
Text: Good.

Source: Blog B
Author: Sam
URL: https://b.example/review
Title: T2
Date: 2026
Text: Also good.

Source: Blog C
Author: Alex
Title: No URL here
Date: 2026
Text: Dropped.

Source: Blog D
Author: Dana
URL: https://a.example/review
Title: Duplicate URL
Date: 2026
Text: Dropped too.`;
  const { parsed } = parseSecondLookOutput(text);
  assert.equal(parsed.reviews.length, 1);
  assert.equal(parsed.reviews[0].author, "Sam");
  assert.equal(parsed.reviews[0].url, "https://a.example/review");
});

test("parseSecondLookOutput keeps review Title/Text lines from being mistaken for top labels", () => {
  const text = `Keywords: sandals, slides
Reviews: Source: YouTube
Author: Reviewer
URL: https://youtube.com/watch?v=x
Title: Industries of Comfort — Review
Date: 2026
Text: Keywords like comfort come to mind.`;
  const { parsed } = parseSecondLookOutput(text);
  assert.equal(parsed.product_keywords, "sandals, slides");
  assert.deepEqual(parsed.industries, []);
  assert.equal(parsed.reviews.length, 1);
  assert.equal(parsed.reviews[0].title, "Industries of Comfort — Review");
});

test("parseSecondLookOutput accepts multi-line continuation in review text", () => {
  const text = `Reviews: Source: Blog
Author: A
URL: https://x.example/r
Title: T
Date: 2026
Text: First sentence.
Second sentence continues the excerpt.`;
  const { parsed } = parseSecondLookOutput(text);
  assert.equal(parsed.reviews.length, 1);
  assert.match(parsed.reviews[0].text, /First sentence\. Second sentence continues/);
});

// ── Trigger decision ─────────────────────────────────────────────────────────

function completeDoc() {
  return {
    tagline: "Support you can feel.",
    headquarters_location: "Spanish Fork, UT, USA",
    manufacturing_locations: ["Hanoi, Vietnam"],
    industries: ["Footwear"],
    product_keywords: "arch support flip flops, slides, slippers",
    keywords: ["arch support flip flops", "slides", "slippers"],
    curated_reviews: [{ source: "YouTube", url: "https://youtube.com/watch?v=1" }],
  };
}

test("decideSecondLook: complete doc → no trigger, no request", () => {
  const d = decideSecondLook(completeDoc());
  assert.deepEqual(d.trigger, []);
  assert.deepEqual(d.requested, []);
});

test("decideSecondLook: missing tagline triggers, keywords ride along with merge", () => {
  const doc = completeDoc();
  doc.tagline = "";
  const d = decideSecondLook(doc);
  assert.deepEqual(d.trigger, ["tagline"]);
  assert.ok(d.requested.includes("tagline"));
  assert.ok(d.requested.includes("product_keywords"));
  assert.ok(d.merge_fields.includes("product_keywords"));
});

test("decideSecondLook: empty keywords is a trigger (fill, not merge)", () => {
  const doc = completeDoc();
  doc.product_keywords = "";
  doc.keywords = [];
  const d = decideSecondLook(doc);
  assert.ok(d.trigger.includes("product_keywords"));
  assert.ok(!d.merge_fields.includes("product_keywords"));
});

test("decideSecondLook: sentinel-carrying manufacturing rides along with merge when something else triggers", () => {
  const doc = completeDoc();
  doc.tagline = "";
  doc.manufacturing_locations = ["Hanoi, Vietnam", OTHER_UNKNOWN_LOCATIONS_SENTINEL];
  const d = decideSecondLook(doc);
  assert.ok(!d.trigger.includes("manufacturing_locations"));
  assert.ok(d.requested.includes("manufacturing_locations"));
  assert.ok(d.merge_fields.includes("manufacturing_locations"));
});

test("decideSecondLook: sentinel alone (nothing else missing) triggers nothing", () => {
  const doc = completeDoc();
  doc.manufacturing_locations = ["Hanoi, Vietnam", OTHER_UNKNOWN_LOCATIONS_SENTINEL];
  const d = decideSecondLook(doc);
  assert.deepEqual(d.trigger, []);
  assert.deepEqual(d.requested, []);
});

test("decideSecondLook: sentinel-only manufacturing list counts as empty (defensive)", () => {
  const doc = completeDoc();
  doc.manufacturing_locations = [OTHER_UNKNOWN_LOCATIONS_SENTINEL];
  const d = decideSecondLook(doc);
  assert.ok(d.trigger.includes("manufacturing_locations"));
});

test("decideSecondLook: reviews-only miss respects SECOND_LOOK_ON_REVIEWS_ONLY knob", () => {
  const doc = completeDoc();
  doc.curated_reviews = [];

  const prev = process.env.SECOND_LOOK_ON_REVIEWS_ONLY;
  try {
    delete process.env.SECOND_LOOK_ON_REVIEWS_ONLY; // default on
    let d = decideSecondLook(doc);
    assert.deepEqual(d.trigger, ["reviews"]);

    process.env.SECOND_LOOK_ON_REVIEWS_ONLY = "off";
    d = decideSecondLook(doc);
    assert.deepEqual(d.trigger, []);
    assert.deepEqual(d.requested, []);
  } finally {
    if (prev === undefined) delete process.env.SECOND_LOOK_ON_REVIEWS_ONLY;
    else process.env.SECOND_LOOK_ON_REVIEWS_ONLY = prev;
  }
});

test("decideSecondLook: reviews still requested alongside other triggers even with knob off", () => {
  const doc = completeDoc();
  doc.curated_reviews = [];
  doc.tagline = "";

  const prev = process.env.SECOND_LOOK_ON_REVIEWS_ONLY;
  try {
    process.env.SECOND_LOOK_ON_REVIEWS_ONLY = "off";
    const d = decideSecondLook(doc);
    assert.ok(d.trigger.includes("reviews"));
    assert.ok(d.trigger.includes("tagline"));
  } finally {
    if (prev === undefined) delete process.env.SECOND_LOOK_ON_REVIEWS_ONLY;
    else process.env.SECOND_LOOK_ON_REVIEWS_ONLY = prev;
  }
});

test("decideSecondLook: stub doc requests all six fields", () => {
  const d = decideSecondLook({});
  assert.deepEqual([...d.trigger].sort(), [...SECOND_LOOK_FIELDS].sort());
  assert.deepEqual(d.requested, SECOND_LOOK_FIELDS);
});

// ── Union merges ─────────────────────────────────────────────────────────────

test("unionKeywordStrings merges case-insensitively, preserving existing order first", () => {
  const merged = unionKeywordStrings("hot sauce, salsa", "Salsa, taco kits, hot sauce, queso");
  assert.equal(merged, "hot sauce, salsa, taco kits, queso");
});

test("unionKeywordStrings handles empty existing", () => {
  assert.equal(unionKeywordStrings("", "a, b"), "a, b");
  assert.equal(unionKeywordStrings("a, b", ""), "a, b");
});

test("unionLocationArrays merges strings and object entries without dupes", () => {
  const merged = unionLocationArrays(
    ["Hanoi, Vietnam", { location: "Austin, TX, USA" }],
    ["hanoi, vietnam", "Da Nang, Vietnam"]
  );
  assert.deepEqual(merged, ["Hanoi, Vietnam", "Austin, TX, USA", "Da Nang, Vietnam"]);
});
