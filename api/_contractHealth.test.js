const test = require("node:test");
const assert = require("node:assert/strict");

const { computeContractEnrichmentHealth } = require("./_contractHealth.js");
const { computeIssuesCount } = require("./_sortKeys.js");

// Simulates what the resume-worker now does before persisting: refresh
// enrichment_health from the live contract, THEN compute issues_count. This is
// the fix for the "Incomplete badge under-counts vs Issues column" drift on
// fresh imports.
function refreshedIssuesCount(doc) {
  const h = computeContractEnrichmentHealth(doc);
  if (h && typeof h === "object") doc.enrichment_health = h;
  return computeIssuesCount(doc);
}

test("computeContractEnrichmentHealth: bare imported doc flags its missing fields", () => {
  // A freshly imported company with almost nothing filled and NO stored
  // enrichment_health — exactly the state the resume-worker writes.
  const doc = {
    id: "company_import_stub",
    company_id: "company_import_stub",
    company_name: "Stub Imports Co",
    name: "Stub Imports Co",
    website_url: "https://example.com",
    normalized_domain: "example.com",
  };

  const health = computeContractEnrichmentHealth(doc);
  assert.ok(health && typeof health === "object", "returns a health object");
  assert.ok(Array.isArray(health.missing_fields), "missing_fields is an array");
  // HQ, MFG and keyword/product coverage are all absent -> must be flagged.
  for (const f of ["headquarters_location", "manufacturing_locations"]) {
    assert.ok(
      health.missing_fields.includes(f),
      `expected missing_fields to include "${f}", got: ${JSON.stringify(health.missing_fields)}`
    );
  }
});

test("refresh-then-count yields a non-zero issues_count for an incomplete import", () => {
  const doc = {
    id: "company_import_stub2",
    company_id: "company_import_stub2",
    company_name: "Stub Imports Co 2",
    name: "Stub Imports Co 2",
    website_url: "https://example.com",
    normalized_domain: "example.com",
    // no hq / mfg / keywords / logo / reviews / amazon_url
  };

  const count = refreshedIssuesCount(doc);
  assert.ok(count > 0, `expected issues_count > 0 after refresh, got ${count}`);
});

test("a fully-populated doc refreshes to zero issues", () => {
  const doc = {
    id: "company_complete",
    company_id: "company_complete",
    company_name: "Complete Co",
    name: "Complete Co",
    website_url: "https://example.com",
    normalized_domain: "example.com",
    headquarters_locations: [{ city: "Austin", state: "TX", country: "USA" }],
    manufacturing_locations: [{ city: "Austin", state: "TX", country: "USA" }],
    industries: ["Apparel"],
    keywords: ["shirts", "pants", "jackets", "hats", "socks"],
    product_keywords: "shirts, pants, jackets, hats, socks",
    tagline: "We make clothes",
    logo_url: "https://img/logo.png",
    homepage_image_url: "https://img/home.png",
    amazon_url: "https://amazon.com/store",
    amazon_url_approved: true,
    no_reviews: true,
  };

  const count = refreshedIssuesCount(doc);
  assert.equal(count, 0, `expected 0 issues for a complete company, got ${count}`);
});
