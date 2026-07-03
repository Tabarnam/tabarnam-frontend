// Phase 4.38 — sub-brand override tests for /api/import-one duplicate check.
//
// The dup-check normally blocks any new URL whose normalized_domain matches
// an existing catalog entry (HTTP 409 duplicate_company). When the request
// carries `parent_company_id` AND that id equals the matched doc's id, we
// treat the row as a sub-brand and allow the import.
//
// Regression guard (option D belt-and-suspenders): a request WITHOUT the
// parent hint, or with a MISMATCHED parent hint, must still be blocked so
// accidental double-imports and stray-parent-id payloads don't leak
// duplicates through the sub-brand path.

const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("./index.js");
const { checkExistingCompanyByDomain } = _test;

// Minimal in-memory container that returns a canned matching doc for
// specified domain / URL queries. Emulates Cosmos's items.query().fetchAll()
// shape enough to exercise the dup-check helper.
function makeContainer(matches) {
  return {
    items: {
      query(spec) {
        const domainParam = (spec.parameters || []).find((p) => p.name === "@domain");
        const urlParam = (spec.parameters || []).find((p) => p.name === "@urlLower");
        return {
          async fetchAll() {
            if (domainParam && matches.byDomain && matches.byDomain[domainParam.value]) {
              return { resources: [matches.byDomain[domainParam.value]] };
            }
            if (urlParam && matches.byUrl && matches.byUrl[urlParam.value]) {
              return { resources: [matches.byUrl[urlParam.value]] };
            }
            return { resources: [] };
          },
        };
      },
    },
  };
}

const hpMatch = {
  id: "company_hp_1234",
  company_id: "company_hp_1234",
  company_name: "HP",
  normalized_domain: "hp.com",
  website_url: "https://hp.com/",
};

test("Phase 4.38: without parent hint, existing domain match returns exists:true (409 path)", async () => {
  const container = makeContainer({ byDomain: { "hp.com": hpMatch } });
  const result = await checkExistingCompanyByDomain({
    domain: "hp.com",
    url: "https://hp.com/us-en/calculators.html",
    container,
  });
  assert.equal(result.exists, true);
  assert.equal(result.match_type, "normalized_domain");
  assert.equal(result.existing_company.id, "company_hp_1234");
  assert.equal(result.sub_brand_of, undefined);
});

test("Phase 4.38: matching parent_company_id triggers sub-brand override", async () => {
  const container = makeContainer({ byDomain: { "hp.com": hpMatch } });
  const result = await checkExistingCompanyByDomain({
    domain: "hp.com",
    url: "https://hp.com/us-en/calculators.html",
    container,
    parentCompanyIdHint: "company_hp_1234",
  });
  assert.equal(result.exists, false, "sub-brand should NOT be reported as a duplicate");
  assert.ok(result.sub_brand_of, "sub_brand_of metadata should be returned");
  assert.equal(result.sub_brand_of.id, "company_hp_1234");
  assert.equal(result.sub_brand_of.company_name, "HP");
});

test("Phase 4.38: MISMATCHED parent_company_id still blocks (regression guard)", async () => {
  const container = makeContainer({ byDomain: { "hp.com": hpMatch } });
  const result = await checkExistingCompanyByDomain({
    domain: "hp.com",
    url: "https://hp.com/us-en/calculators.html",
    container,
    parentCompanyIdHint: "company_someone_else_5678",
  });
  assert.equal(result.exists, true, "wrong parent id must NOT allow the import through");
  assert.equal(result.existing_company.id, "company_hp_1234");
  assert.equal(result.sub_brand_of, undefined);
});

test("Phase 4.38: empty / whitespace parent_company_id behaves as no hint", async () => {
  const container = makeContainer({ byDomain: { "hp.com": hpMatch } });
  for (const bad of ["", "   ", null, undefined]) {
    const result = await checkExistingCompanyByDomain({
      domain: "hp.com",
      url: "https://hp.com/",
      container,
      parentCompanyIdHint: bad,
    });
    assert.equal(result.exists, true, `hint=${JSON.stringify(bad)} must not bypass the dup check`);
  }
});

test("Phase 4.38: exact URL match STILL BLOCKS even with parent hint (defense-in-depth)", async () => {
  // No domain match; only the URL-variant tier 2 finds a match.
  // A sub-brand by definition has a distinct URL from its parent, so an
  // exact URL match is an accidental double-import — the hint must NOT
  // let it through. This guards against a client that skipped the
  // frontend name/URL comparison from bypassing dedup.
  const container = makeContainer({
    byUrl: { "https://hp.com/us-en/calculators": hpMatch },
  });
  const result = await checkExistingCompanyByDomain({
    domain: "some-cdn-host.example",
    url: "https://hp.com/us-en/calculators",
    container,
    parentCompanyIdHint: "company_hp_1234",
  });
  assert.equal(result.exists, true, "exact URL match must block even with parent hint");
  assert.equal(result.match_type, "url");
  assert.equal(result.existing_company.id, "company_hp_1234");
  assert.equal(result.sub_brand_of, undefined);
});

test("Phase 4.38: no match found + hint set → clean pass-through (no duplicate)", async () => {
  const container = makeContainer({}); // no matches
  const result = await checkExistingCompanyByDomain({
    domain: "totally-new-brand.example",
    url: "https://totally-new-brand.example/",
    container,
    parentCompanyIdHint: "company_hp_1234",
  });
  assert.equal(result.exists, false);
  // sub_brand_of is only set when we actually found a match AND overrode it.
  assert.equal(result.sub_brand_of, undefined);
});
