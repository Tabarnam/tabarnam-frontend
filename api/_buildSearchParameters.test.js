const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  normalizeExcludedHost,
  buildExcludedHostsCandidates,
  buildCappedExcludedHosts,
  buildPromptExclusionText,
  buildSearchParameters,
} = require("./_buildSearchParameters");

// ── normalizeExcludedHost ───────────────────────────────────────────────────

test("normalizeExcludedHost returns hostname from bare domain", () => {
  assert.equal(normalizeExcludedHost("example.com"), "example.com");
});

test("normalizeExcludedHost strips www prefix", () => {
  assert.equal(normalizeExcludedHost("www.example.com"), "example.com");
});

test("normalizeExcludedHost extracts hostname from URL", () => {
  assert.equal(normalizeExcludedHost("https://www.example.com/path"), "example.com");
});

test("normalizeExcludedHost converts amazon.* wildcard", () => {
  assert.equal(normalizeExcludedHost("amazon.*"), "amazon.com");
});

test("normalizeExcludedHost converts google.* wildcard", () => {
  assert.equal(normalizeExcludedHost("google.*"), "google.com");
});

test("normalizeExcludedHost converts yelp.* wildcard", () => {
  assert.equal(normalizeExcludedHost("yelp.*"), "yelp.com");
});

test("normalizeExcludedHost lowercases host", () => {
  assert.equal(normalizeExcludedHost("EXAMPLE.COM"), "example.com");
});

test("normalizeExcludedHost returns null for empty/invalid", () => {
  assert.equal(normalizeExcludedHost(""), null);
  assert.equal(normalizeExcludedHost(null), null);
});

test("normalizeExcludedHost strips trailing dots", () => {
  assert.equal(normalizeExcludedHost("example.com."), "example.com");
});

// ── buildExcludedHostsCandidates ────────────────────────────────────────────

test("buildExcludedHostsCandidates includes defaults", () => {
  const candidates = buildExcludedHostsCandidates({});
  assert.ok(candidates.includes("amazon.com"));
  assert.ok(candidates.includes("google.com"));
  assert.ok(candidates.includes("trustpilot.com"));
});

test("buildExcludedHostsCandidates puts company host first", () => {
  const candidates = buildExcludedHostsCandidates({ companyWebsiteHost: "acme.com" });
  assert.equal(candidates[0], "acme.com");
});

test("buildExcludedHostsCandidates includes additional hosts", () => {
  const candidates = buildExcludedHostsCandidates({
    additionalExcludedHosts: ["custom.example.com"],
  });
  assert.ok(candidates.includes("custom.example.com"));
});

test("buildExcludedHostsCandidates deduplicates", () => {
  const candidates = buildExcludedHostsCandidates({
    companyWebsiteHost: "amazon.com",
  });
  const amazonCount = candidates.filter((h) => h === "amazon.com").length;
  assert.equal(amazonCount, 1);
});

// ── buildCappedExcludedHosts ────────────────────────────────────────────────

test("buildCappedExcludedHosts caps at maxExcluded", () => {
  const result = buildCappedExcludedHosts({ maxExcluded: 3 });
  assert.equal(result.used.length, 3);
  assert.ok(result.spilled.length > 0);
});

test("buildCappedExcludedHosts prioritizes company host", () => {
  const result = buildCappedExcludedHosts({
    companyWebsiteHost: "acme.com",
    maxExcluded: 2,
  });
  assert.equal(result.used[0], "acme.com");
});

test("buildCappedExcludedHosts provides telemetry", () => {
  const result = buildCappedExcludedHosts({ maxExcluded: 3 });
  assert.ok(result.telemetry.excluded_websites_original_count > 3);
  assert.equal(result.telemetry.excluded_websites_used_count, 3);
  assert.equal(result.telemetry.excluded_websites_truncated, true);
});

test("buildCappedExcludedHosts not truncated when all fit", () => {
  const result = buildCappedExcludedHosts({ maxExcluded: 100 });
  assert.equal(result.telemetry.excluded_websites_truncated, false);
  assert.equal(result.spilled.length, 0);
});

// ── buildPromptExclusionText ────────────────────────────────────────────────

test("buildPromptExclusionText returns text with hosts", () => {
  const text = buildPromptExclusionText(["extra1.com", "extra2.com"]);
  assert.ok(text.includes("extra1.com"));
  assert.ok(text.includes("extra2.com"));
  assert.ok(text.includes("Also avoid"));
});

test("buildPromptExclusionText returns empty for empty list", () => {
  assert.equal(buildPromptExclusionText([]), "");
});

test("buildPromptExclusionText caps at maxHostsInPrompt", () => {
  const hosts = Array.from({ length: 20 }, (_, i) => `host${i}.com`);
  const text = buildPromptExclusionText(hosts, { maxHostsInPrompt: 5 });
  assert.ok(text.includes("host0.com"));
  assert.ok(text.includes("host4.com"));
  assert.ok(!text.includes("host5.com"));
});

// ── buildSearchParameters ───────────────────────────────────────────────────

test("buildSearchParameters returns search_parameters with sources", () => {
  const result = buildSearchParameters({ companyWebsiteHost: "acme.com" });
  assert.equal(result.search_parameters.mode, "on");
  assert.equal(result.search_parameters.sources.length, 3);
  assert.equal(result.search_parameters.sources[0].type, "web");
  assert.equal(result.search_parameters.sources[1].type, "news");
  assert.equal(result.search_parameters.sources[2].type, "x");
});

test("buildSearchParameters includes company host in used exclusions", () => {
  const result = buildSearchParameters({ companyWebsiteHost: "acme.com" });
  assert.ok(result.excluded_hosts.used.includes("acme.com"));
});

test("buildSearchParameters includes telemetry", () => {
  const result = buildSearchParameters({});
  assert.ok(typeof result.telemetry.excluded_websites_original_count === "number");
  assert.ok(typeof result.telemetry.excluded_hosts_spilled_to_prompt_count === "number");
});
