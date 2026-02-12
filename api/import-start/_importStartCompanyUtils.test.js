const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  normalizeIndustries,
  toBrandTokenFromWebsiteUrl,
  normalizeKeywordList,
  normalizeProductKeywords,
  keywordListToString,
  safeNum,
  safeCenter,
  toFiniteNumber,
  toNormalizedDomain,
  enrichCompany,
  normalizeLocationEntries,
  buildImportLocations,
  normalizeUrlForCompare,
  computeReviewDedupeKey,
  dedupeCuratedReviews,
  buildReviewCursor,
  isMeaningfulString,
  hasMeaningfulSeedEnrichment,
  isValidSeedCompany,
  computeEnrichmentMissingFields,
} = require("./_importStartCompanyUtils");

// ── normalizeIndustries ─────────────────────────────────────────────────────

test("normalizeIndustries returns deduped array from array input", () => {
  assert.deepEqual(normalizeIndustries(["Tech", "Finance", "Tech"]), ["Tech", "Finance"]);
});

test("normalizeIndustries splits comma/semicolon/pipe delimited string", () => {
  assert.deepEqual(normalizeIndustries("Tech, Finance; Health|Tech"), ["Tech", "Finance", "Health"]);
});

test("normalizeIndustries trims whitespace from entries", () => {
  assert.deepEqual(normalizeIndustries(["  Tech  ", " Finance "]), ["Tech", "Finance"]);
});

test("normalizeIndustries filters out empty strings", () => {
  assert.deepEqual(normalizeIndustries(["Tech", "", "  ", "Finance"]), ["Tech", "Finance"]);
});

test("normalizeIndustries returns empty array for non-string non-array input", () => {
  assert.deepEqual(normalizeIndustries(null), []);
  assert.deepEqual(normalizeIndustries(undefined), []);
  assert.deepEqual(normalizeIndustries(42), []);
});

// ── toBrandTokenFromWebsiteUrl ──────────────────────────────────────────────

test("toBrandTokenFromWebsiteUrl extracts brand token from URL", () => {
  assert.equal(toBrandTokenFromWebsiteUrl("https://www.acme.com/about"), "acme");
});

test("toBrandTokenFromWebsiteUrl strips www prefix", () => {
  assert.equal(toBrandTokenFromWebsiteUrl("https://www.example.com"), "example");
});

test("toBrandTokenFromWebsiteUrl handles URL without protocol", () => {
  assert.equal(toBrandTokenFromWebsiteUrl("acme.com"), "acme");
});

test("toBrandTokenFromWebsiteUrl returns empty string for empty input", () => {
  assert.equal(toBrandTokenFromWebsiteUrl(""), "");
  assert.equal(toBrandTokenFromWebsiteUrl(null), "");
  assert.equal(toBrandTokenFromWebsiteUrl(undefined), "");
});

test("toBrandTokenFromWebsiteUrl returns empty string for invalid URL", () => {
  assert.equal(toBrandTokenFromWebsiteUrl("not a url at all"), "");
});

// ── normalizeKeywordList ────────────────────────────────────────────────────

test("normalizeKeywordList splits string on comma/semicolon/pipe/newline", () => {
  assert.deepEqual(normalizeKeywordList("a, b; c|d\ne"), ["a", "b", "c", "d", "e"]);
});

test("normalizeKeywordList flattens array input", () => {
  assert.deepEqual(normalizeKeywordList(["a, b", "c; d"]), ["a", "b", "c", "d"]);
});

test("normalizeKeywordList dedupes case-insensitively preserving first casing", () => {
  assert.deepEqual(normalizeKeywordList("Apple, apple, APPLE"), ["Apple"]);
});

test("normalizeKeywordList returns empty array for null/undefined", () => {
  assert.deepEqual(normalizeKeywordList(null), []);
  assert.deepEqual(normalizeKeywordList(undefined), []);
});

// ── normalizeProductKeywords ────────────────────────────────────────────────

test("normalizeProductKeywords filters out company name from keywords", () => {
  const result = normalizeProductKeywords("widgets, acme widgets, gadgets", {
    companyName: "Acme",
  });
  assert.ok(!result.some((k) => k.toLowerCase().includes("acme")));
  assert.ok(result.includes("widgets"));
  assert.ok(result.includes("gadgets"));
});

test("normalizeProductKeywords filters out brand token from website URL", () => {
  const result = normalizeProductKeywords("foocorp, widgets, foocorp tools", {
    websiteUrl: "https://www.foocorp.com",
  });
  assert.ok(!result.some((k) => k.toLowerCase().includes("foocorp")));
  assert.ok(result.includes("widgets"));
});

test("normalizeProductKeywords caps at 25 keywords", () => {
  const many = Array.from({ length: 30 }, (_, i) => `keyword${i}`).join(", ");
  const result = normalizeProductKeywords(many);
  assert.equal(result.length, 25);
});

test("normalizeProductKeywords handles empty input gracefully", () => {
  assert.deepEqual(normalizeProductKeywords(""), []);
  assert.deepEqual(normalizeProductKeywords(null), []);
});

// ── keywordListToString ─────────────────────────────────────────────────────

test("keywordListToString joins array with comma-space", () => {
  assert.equal(keywordListToString(["a", "b", "c"]), "a, b, c");
});

test("keywordListToString returns empty string for non-array", () => {
  assert.equal(keywordListToString(null), "");
  assert.equal(keywordListToString("string"), "");
});

// ── safeNum ─────────────────────────────────────────────────────────────────

test("safeNum converts valid number strings", () => {
  assert.equal(safeNum("42"), 42);
  assert.equal(safeNum("3.14"), 3.14);
});

test("safeNum returns undefined for non-finite values", () => {
  assert.equal(safeNum("abc"), undefined);
  assert.equal(safeNum(NaN), undefined);
  assert.equal(safeNum(Infinity), undefined);
});

test("safeNum treats null as 0 (Number(null) is 0)", () => {
  assert.equal(safeNum(null), 0);
});

test("safeNum passes through finite numbers", () => {
  assert.equal(safeNum(0), 0);
  assert.equal(safeNum(-5), -5);
});

// ── safeCenter ──────────────────────────────────────────────────────────────

test("safeCenter returns lat/lng for valid coordinates", () => {
  assert.deepEqual(safeCenter({ lat: 40.7, lng: -74.0 }), { lat: 40.7, lng: -74.0 });
});

test("safeCenter returns undefined if lat or lng is missing", () => {
  assert.equal(safeCenter({ lat: 40.7 }), undefined);
  assert.equal(safeCenter({ lng: -74.0 }), undefined);
  assert.equal(safeCenter(null), undefined);
  assert.equal(safeCenter(undefined), undefined);
});

test("safeCenter returns undefined for non-finite coordinates", () => {
  assert.equal(safeCenter({ lat: "abc", lng: -74.0 }), undefined);
});

// ── toFiniteNumber ──────────────────────────────────────────────────────────

test("toFiniteNumber converts string numbers", () => {
  assert.equal(toFiniteNumber("42"), 42);
  assert.equal(toFiniteNumber("0"), 0);
});

test("toFiniteNumber passes through finite numbers", () => {
  assert.equal(toFiniteNumber(3.14), 3.14);
});

test("toFiniteNumber returns undefined for non-finite", () => {
  assert.equal(toFiniteNumber(Infinity), undefined);
  assert.equal(toFiniteNumber(NaN), undefined);
  assert.equal(toFiniteNumber(""), undefined);
  assert.equal(toFiniteNumber("abc"), undefined);
  assert.equal(toFiniteNumber(null), undefined);
  assert.equal(toFiniteNumber(undefined), undefined);
});

// ── toNormalizedDomain ──────────────────────────────────────────────────────

test("toNormalizedDomain extracts hostname from full URL", () => {
  assert.equal(toNormalizedDomain("https://www.example.com/page"), "example.com");
});

test("toNormalizedDomain strips www prefix", () => {
  assert.equal(toNormalizedDomain("https://www.acme.com"), "acme.com");
});

test("toNormalizedDomain adds https when protocol missing", () => {
  assert.equal(toNormalizedDomain("acme.com"), "acme.com");
});

test("toNormalizedDomain returns 'unknown' for empty/invalid input", () => {
  assert.equal(toNormalizedDomain(""), "unknown");
  assert.equal(toNormalizedDomain(), "unknown");
});

// ── enrichCompany ───────────────────────────────────────────────────────────

test("enrichCompany normalizes industries when source is grok", () => {
  const result = enrichCompany({
    industries_source: "grok",
    industries: "Tech, Finance",
    company_name: "Acme",
    website_url: "https://acme.com",
  });
  assert.deepEqual(result.industries, ["Tech", "Finance"]);
});

test("enrichCompany clears industries when source is not grok", () => {
  const result = enrichCompany({
    industries_source: "manual",
    industries: ["Tech"],
    company_name: "Acme",
    website_url: "https://acme.com",
  });
  assert.deepEqual(result.industries, []);
});

test("enrichCompany normalizes product_keywords when source is grok", () => {
  const result = enrichCompany({
    product_keywords_source: "grok",
    product_keywords: "widgets, gadgets",
    company_name: "Acme",
    website_url: "https://acme.com",
  });
  assert.equal(typeof result.product_keywords, "string");
  assert.ok(result.product_keywords.includes("widgets"));
});

test("enrichCompany clears product_keywords when source is not grok", () => {
  const result = enrichCompany({
    product_keywords_source: "manual",
    product_keywords: "widgets",
    company_name: "Acme",
    website_url: "https://acme.com",
  });
  assert.equal(result.product_keywords, "");
});

test("enrichCompany sets normalized_domain from canonical_url", () => {
  const result = enrichCompany({
    canonical_url: "https://www.example.com/about",
    company_name: "Example",
  });
  assert.equal(result.normalized_domain, "example.com");
});

test("enrichCompany normalizes manufacturing_locations from array", () => {
  const result = enrichCompany({
    manufacturing_locations: ["  Detroit, MI ", "", "Austin, TX"],
    company_name: "Acme",
  });
  assert.deepEqual(result.manufacturing_locations, ["Detroit, MI", "Austin, TX"]);
});

test("enrichCompany normalizes manufacturing_locations from string", () => {
  const result = enrichCompany({
    manufacturing_locations: "  Detroit, MI  ",
    company_name: "Acme",
  });
  assert.deepEqual(result.manufacturing_locations, ["Detroit, MI"]);
});

test("enrichCompany defaults manufacturing_locations to empty array", () => {
  const result = enrichCompany({ company_name: "Acme" });
  assert.deepEqual(result.manufacturing_locations, []);
});

test("enrichCompany normalizes location_sources with type aliases", () => {
  const result = enrichCompany({
    location_sources: [
      { location: "HQ City", location_type: "hq", source_url: "https://example.com" },
      { location: "MFG City", location_type: "mfg", source_url: "https://example.com" },
      { location: "Other", location_type: "other" },
    ],
    company_name: "Acme",
  });
  assert.equal(result.location_sources[0].location_type, "headquarters");
  assert.equal(result.location_sources[1].location_type, "manufacturing");
  assert.equal(result.location_sources[2].location_type, "other");
});

test("enrichCompany filters out location_sources without location", () => {
  const result = enrichCompany({
    location_sources: [
      { location: "Valid", location_type: "hq" },
      { location: "", location_type: "hq" },
      null,
    ],
    company_name: "Acme",
  });
  assert.equal(result.location_sources.length, 1);
});

test("enrichCompany coerces red_flag to boolean", () => {
  assert.equal(enrichCompany({ red_flag: 1, company_name: "A" }).red_flag, true);
  assert.equal(enrichCompany({ red_flag: 0, company_name: "A" }).red_flag, false);
  assert.equal(enrichCompany({ red_flag: null, company_name: "A" }).red_flag, false);
});

test("enrichCompany defaults location_confidence to medium", () => {
  assert.equal(enrichCompany({ company_name: "A" }).location_confidence, "medium");
});

// ── normalizeLocationEntries ────────────────────────────────────────────────

test("normalizeLocationEntries converts strings to address objects", () => {
  const result = normalizeLocationEntries(["Austin, TX", "  ", "Detroit, MI"]);
  assert.deepEqual(result, [{ address: "Austin, TX" }, { address: "Detroit, MI" }]);
});

test("normalizeLocationEntries passes through objects", () => {
  const obj = { address: "Austin, TX", lat: 30.27, lng: -97.74 };
  const result = normalizeLocationEntries([obj]);
  assert.deepEqual(result, [obj]);
});

test("normalizeLocationEntries filters out nulls and empty strings", () => {
  assert.deepEqual(normalizeLocationEntries([null, "", "  ", undefined]), []);
});

test("normalizeLocationEntries returns empty array for non-array", () => {
  assert.deepEqual(normalizeLocationEntries(null), []);
  assert.deepEqual(normalizeLocationEntries("string"), []);
});

// ── buildImportLocations ────────────────────────────────────────────────────

test("buildImportLocations uses headquarters array when present", () => {
  const result = buildImportLocations({
    headquarters: [{ address: "NYC" }],
  });
  assert.deepEqual(result.headquartersBase, [{ address: "NYC" }]);
});

test("buildImportLocations falls back to headquarters_locations", () => {
  const result = buildImportLocations({
    headquarters_locations: [{ address: "NYC" }],
  });
  assert.deepEqual(result.headquartersBase, [{ address: "NYC" }]);
});

test("buildImportLocations falls back to headquarters_location string", () => {
  const result = buildImportLocations({
    headquarters_location: "NYC",
  });
  assert.deepEqual(result.headquartersBase, [{ address: "NYC" }]);
});

test("buildImportLocations returns empty arrays when no location data", () => {
  const result = buildImportLocations({});
  assert.deepEqual(result.headquartersBase, []);
  assert.deepEqual(result.manufacturingBase, []);
});

test("buildImportLocations prefers manufacturing_geocodes over manufacturing_locations", () => {
  const result = buildImportLocations({
    manufacturing_geocodes: [{ address: "Detroit", lat: 42.3 }],
    manufacturing_locations: ["Austin"],
  });
  assert.deepEqual(result.manufacturingBase, [{ address: "Detroit", lat: 42.3 }]);
});

// ── normalizeUrlForCompare ──────────────────────────────────────────────────

test("normalizeUrlForCompare strips www, hash, trailing slash", () => {
  const result = normalizeUrlForCompare("https://www.example.com/page/#section");
  assert.equal(result, "https://example.com/page");
});

test("normalizeUrlForCompare preserves query params", () => {
  const result = normalizeUrlForCompare("https://example.com/page?id=123");
  assert.equal(result, "https://example.com/page?id=123");
});

test("normalizeUrlForCompare lowercases hostname", () => {
  const result = normalizeUrlForCompare("https://EXAMPLE.COM/Path");
  assert.equal(result, "https://example.com/Path");
});

test("normalizeUrlForCompare returns empty string for empty input", () => {
  assert.equal(normalizeUrlForCompare(""), "");
  assert.equal(normalizeUrlForCompare(null), "");
});

test("normalizeUrlForCompare falls back to lowercase for invalid URL", () => {
  assert.equal(normalizeUrlForCompare("not-a-url"), "not-a-url");
});

// ── computeReviewDedupeKey ──────────────────────────────────────────────────

test("computeReviewDedupeKey returns consistent hash for same review", () => {
  const review = {
    source_url: "https://example.com/review",
    title: "Great Product",
    author: "Jane",
    date: "2025-01-01",
    rating: 5,
    excerpt: "Loved it!",
  };
  const key1 = computeReviewDedupeKey(review);
  const key2 = computeReviewDedupeKey({ ...review });
  assert.equal(key1, key2);
  assert.ok(key1.length > 0);
});

test("computeReviewDedupeKey returns different hashes for different reviews", () => {
  const r1 = { title: "Review A", author: "X" };
  const r2 = { title: "Review B", author: "Y" };
  assert.notEqual(computeReviewDedupeKey(r1), computeReviewDedupeKey(r2));
});

test("computeReviewDedupeKey returns empty string for empty review", () => {
  assert.equal(computeReviewDedupeKey({}), "");
  assert.equal(computeReviewDedupeKey(null), "");
});

test("computeReviewDedupeKey normalizes URL for comparison", () => {
  const r1 = { source_url: "https://www.example.com/review#top" };
  const r2 = { source_url: "https://example.com/review" };
  assert.equal(computeReviewDedupeKey(r1), computeReviewDedupeKey(r2));
});

// ── dedupeCuratedReviews ────────────────────────────────────────────────────

test("dedupeCuratedReviews removes duplicate reviews", () => {
  const reviews = [
    { title: "Great", author: "A", excerpt: "text" },
    { title: "Great", author: "A", excerpt: "text" },
    { title: "Bad", author: "B", excerpt: "other" },
  ];
  const result = dedupeCuratedReviews(reviews);
  assert.equal(result.length, 2);
});

test("dedupeCuratedReviews preserves _dedupe_key on output", () => {
  const result = dedupeCuratedReviews([{ title: "Test", author: "A" }]);
  assert.ok(result[0]._dedupe_key);
});

test("dedupeCuratedReviews respects existing _dedupe_key", () => {
  const reviews = [
    { title: "A", _dedupe_key: "key1" },
    { title: "B", _dedupe_key: "key1" },
  ];
  const result = dedupeCuratedReviews(reviews);
  assert.equal(result.length, 1);
});

test("dedupeCuratedReviews handles non-array input", () => {
  assert.deepEqual(dedupeCuratedReviews(null), []);
  assert.deepEqual(dedupeCuratedReviews("string"), []);
});

// ── buildReviewCursor ───────────────────────────────────────────────────────

test("buildReviewCursor builds cursor with success timestamp on success", () => {
  const now = "2025-06-01T00:00:00.000Z";
  const cursor = buildReviewCursor({ nowIso: now, count: 5, exhausted: true });
  assert.equal(cursor.source, "xai_reviews");
  assert.equal(cursor.last_offset, 5);
  assert.equal(cursor.total_fetched, 5);
  assert.equal(cursor.exhausted, true);
  assert.equal(cursor.last_attempt_at, now);
  assert.equal(cursor.last_success_at, now);
  assert.equal(cursor.last_error, null);
});

test("buildReviewCursor preserves prev success on error", () => {
  const now = "2025-06-02T00:00:00.000Z";
  const cursor = buildReviewCursor({
    nowIso: now,
    count: 0,
    exhausted: false,
    last_error: { message: "timeout" },
    prev_cursor: { last_success_at: "2025-06-01T00:00:00.000Z" },
  });
  assert.equal(cursor.last_success_at, "2025-06-01T00:00:00.000Z");
  assert.deepEqual(cursor.last_error, { message: "timeout" });
});

test("buildReviewCursor converts string error to object", () => {
  const cursor = buildReviewCursor({ nowIso: "now", count: 0, last_error: "oops" });
  assert.deepEqual(cursor.last_error, { message: "oops" });
});

test("buildReviewCursor clamps count to non-negative integer", () => {
  assert.equal(buildReviewCursor({ nowIso: "now", count: -5 }).last_offset, 0);
  assert.equal(buildReviewCursor({ nowIso: "now", count: 3.7 }).last_offset, 3);
  assert.equal(buildReviewCursor({ nowIso: "now", count: "abc" }).last_offset, 0);
});

// ── isMeaningfulString ──────────────────────────────────────────────────────

test("isMeaningfulString returns true for real content", () => {
  assert.equal(isMeaningfulString("Austin, TX"), true);
});

test("isMeaningfulString returns false for placeholders", () => {
  assert.equal(isMeaningfulString("unknown"), false);
  assert.equal(isMeaningfulString("N/A"), false);
  assert.equal(isMeaningfulString("na"), false);
  assert.equal(isMeaningfulString("none"), false);
});

test("isMeaningfulString returns false for empty/whitespace/null", () => {
  assert.equal(isMeaningfulString(""), false);
  assert.equal(isMeaningfulString("  "), false);
  assert.equal(isMeaningfulString(null), false);
  assert.equal(isMeaningfulString(undefined), false);
});

// ── hasMeaningfulSeedEnrichment ─────────────────────────────────────────────

test("hasMeaningfulSeedEnrichment returns true for company with industries", () => {
  assert.equal(hasMeaningfulSeedEnrichment({ industries: ["Tech"] }), true);
});

test("hasMeaningfulSeedEnrichment returns true for company with keywords string", () => {
  assert.equal(hasMeaningfulSeedEnrichment({ product_keywords: "widgets, gadgets" }), true);
});

test("hasMeaningfulSeedEnrichment returns true for company with keywords array", () => {
  assert.equal(hasMeaningfulSeedEnrichment({ keywords: ["widgets"] }), true);
});

test("hasMeaningfulSeedEnrichment returns true for company with HQ location", () => {
  assert.equal(hasMeaningfulSeedEnrichment({ headquarters_location: "Austin, TX" }), true);
});

test("hasMeaningfulSeedEnrichment returns false for HQ placeholder", () => {
  assert.equal(hasMeaningfulSeedEnrichment({ headquarters_location: "unknown" }), false);
});

test("hasMeaningfulSeedEnrichment returns true for company with manufacturing locations", () => {
  assert.equal(hasMeaningfulSeedEnrichment({ manufacturing_locations: ["Detroit, MI"] }), true);
});

test("hasMeaningfulSeedEnrichment returns true for company with curated reviews", () => {
  assert.equal(hasMeaningfulSeedEnrichment({ curated_reviews: [{ title: "Good" }] }), true);
});

test("hasMeaningfulSeedEnrichment returns true for nonzero review_count", () => {
  assert.equal(hasMeaningfulSeedEnrichment({ review_count: 3 }), true);
});

test("hasMeaningfulSeedEnrichment returns false for empty company", () => {
  assert.equal(hasMeaningfulSeedEnrichment({}), false);
  assert.equal(hasMeaningfulSeedEnrichment(null), false);
});

// ── isValidSeedCompany ──────────────────────────────────────────────────────

test("isValidSeedCompany rejects company without name", () => {
  assert.equal(isValidSeedCompany({ website_url: "https://acme.com" }), false);
});

test("isValidSeedCompany rejects company without website", () => {
  assert.equal(isValidSeedCompany({ company_name: "Acme" }), false);
});

test("isValidSeedCompany accepts company with persisted id (non-import)", () => {
  assert.equal(
    isValidSeedCompany({ company_name: "Acme", website_url: "https://acme.com", id: "abc123" }),
    true,
  );
});

test("isValidSeedCompany rejects _import_ prefixed id without source", () => {
  assert.equal(
    isValidSeedCompany({
      company_name: "Acme",
      website_url: "https://acme.com",
      id: "_import_123",
    }),
    false,
  );
});

test("isValidSeedCompany accepts company_url_shortcut with seed_ready flag", () => {
  assert.equal(
    isValidSeedCompany({
      company_name: "Acme",
      website_url: "https://acme.com",
      source: "company_url_shortcut",
      seed_ready: true,
    }),
    true,
  );
});

test("isValidSeedCompany accepts company_url_shortcut with meaningful enrichment", () => {
  assert.equal(
    isValidSeedCompany({
      company_name: "Acme",
      website_url: "https://acme.com",
      source: "company_url_shortcut",
      industries: ["Tech"],
    }),
    true,
  );
});

test("isValidSeedCompany rejects company_url_shortcut without enrichment or seed_ready", () => {
  assert.equal(
    isValidSeedCompany({
      company_name: "Acme",
      website_url: "https://acme.com",
      source: "company_url_shortcut",
    }),
    false,
  );
});

test("isValidSeedCompany accepts company with any other source", () => {
  assert.equal(
    isValidSeedCompany({
      company_name: "Acme",
      website_url: "https://acme.com",
      source: "manual",
    }),
    true,
  );
});

test("isValidSeedCompany accepts company with primary_candidate marker", () => {
  assert.equal(
    isValidSeedCompany({
      company_name: "Acme",
      website_url: "https://acme.com",
      primary_candidate: true,
    }),
    true,
  );
});

test("isValidSeedCompany accepts company with seed marker", () => {
  assert.equal(
    isValidSeedCompany({
      company_name: "Acme",
      website_url: "https://acme.com",
      seed: true,
    }),
    true,
  );
});

test("isValidSeedCompany accepts company with source_stage=primary", () => {
  assert.equal(
    isValidSeedCompany({
      company_name: "Acme",
      website_url: "https://acme.com",
      source_stage: "primary",
    }),
    true,
  );
});

// ── computeEnrichmentMissingFields ──────────────────────────────────────────

test("computeEnrichmentMissingFields returns empty for complete company", () => {
  assert.deepEqual(
    computeEnrichmentMissingFields({
      company_name: "Acme",
      website_url: "https://acme.com",
    }),
    [],
  );
});

test("computeEnrichmentMissingFields reports missing company_name", () => {
  const missing = computeEnrichmentMissingFields({ website_url: "https://acme.com" });
  assert.ok(missing.includes("company_name"));
});

test("computeEnrichmentMissingFields reports missing website_url", () => {
  const missing = computeEnrichmentMissingFields({ company_name: "Acme" });
  assert.ok(missing.includes("website_url"));
});

test("computeEnrichmentMissingFields rejects placeholder URLs", () => {
  const missing = computeEnrichmentMissingFields({
    company_name: "Acme",
    website_url: "unknown",
  });
  assert.ok(missing.includes("website_url"));
});

test("computeEnrichmentMissingFields accepts URL without protocol", () => {
  assert.deepEqual(
    computeEnrichmentMissingFields({
      company_name: "Acme",
      website_url: "acme.com",
    }),
    [],
  );
});

test("computeEnrichmentMissingFields rejects URL without dot in hostname", () => {
  const missing = computeEnrichmentMissingFields({
    company_name: "Acme",
    website_url: "localhost",
  });
  assert.ok(missing.includes("website_url"));
});

test("computeEnrichmentMissingFields handles null input", () => {
  const missing = computeEnrichmentMissingFields(null);
  assert.ok(missing.includes("company_name"));
  assert.ok(missing.includes("website_url"));
});
