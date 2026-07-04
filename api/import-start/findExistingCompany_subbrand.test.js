// Phase 4.38 — sub-brand override tests for the bulk-path duplicate check
// in api/import-start/_importStartSaveCompanies.js:findExistingCompany.
//
// Mirrors the /api/import-one contract: when a `parentCompanyIdHint` is
// passed AND it matches the id of the existing doc that fires the
// duplicate, return null so the bulk save flow proceeds with the import.
// Without the hint (or with a mismatched hint), the existing behavior is
// preserved — the caller sees the match and blocks with
// save_outcome: "duplicate_detected".

const test = require("node:test");
const assert = require("node:assert/strict");

const { findExistingCompany } = require("./_importStartSaveCompanies.js");

// Minimal in-memory container that returns canned matching docs based on
// the query's @domain parameter. Emulates Cosmos's items.query().fetchAll()
// closely enough to exercise the dup-check helper.
function makeContainer(matches) {
  return {
    items: {
      query(spec) {
        const domainParam = (spec.parameters || []).find((p) => p.name === "@domain");
        const nameParam = (spec.parameters || []).find((p) => p.name === "@name");
        return {
          async fetchAll() {
            if (domainParam && matches.byDomain && matches.byDomain[domainParam.value]) {
              return { resources: [matches.byDomain[domainParam.value]] };
            }
            if (nameParam && matches.byName && matches.byName[nameParam.value]) {
              return { resources: [matches.byName[nameParam.value]] };
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
  company_name: "HP",
  normalized_domain: "hp.com",
  partition_key: "hp.com",
  canonical_url: "https://hp.com/",
  website_url: "https://hp.com/",
};

test("Phase 4.38 bulk: without hint, existing domain returns match (blocks import)", async () => {
  const container = makeContainer({ byDomain: { "hp.com": hpMatch } });
  const result = await findExistingCompany(container, "hp.com", "HP Calculators", "https://hp.com/us-en/calculators.html");
  assert.ok(result, "expected match without hint");
  assert.equal(result.id, "company_hp_1234");
  assert.equal(result.duplicate_match_key, "normalized_domain");
});

test("Phase 4.38 bulk: matching parent_company_id triggers sub-brand override → null", async () => {
  const container = makeContainer({ byDomain: { "hp.com": hpMatch } });
  const result = await findExistingCompany(
    container,
    "hp.com",
    "HP Calculators",
    "https://hp.com/us-en/calculators.html",
    "company_hp_1234"
  );
  assert.equal(result, null, "sub-brand path must return null (no duplicate)");
});

test("Phase 4.38 bulk: MISMATCHED parent_company_id still blocks (regression guard)", async () => {
  const container = makeContainer({ byDomain: { "hp.com": hpMatch } });
  const result = await findExistingCompany(
    container,
    "hp.com",
    "HP Calculators",
    "https://hp.com/us-en/calculators.html",
    "company_someone_else_5678"
  );
  assert.ok(result, "wrong parent id must NOT allow the import through");
  assert.equal(result.id, "company_hp_1234");
});

test("Phase 4.38 bulk: empty / whitespace parent hint behaves as no hint", async () => {
  const container = makeContainer({ byDomain: { "hp.com": hpMatch } });
  for (const bad of ["", "   ", null, undefined]) {
    const result = await findExistingCompany(
      container,
      "hp.com",
      "HP Calculators",
      "https://hp.com/",
      bad
    );
    assert.ok(result, `hint=${JSON.stringify(bad)} must not bypass the dup check`);
  }
});

test("Phase 4.38 bulk: same-name true-duplicate blocked even WITH hint mismatch (regression)", async () => {
  // Admin retries importing "HP" (same name as existing) and accidentally
  // pastes some wrong parent id. Must still block.
  const container = makeContainer({ byDomain: { "hp.com": hpMatch } });
  const result = await findExistingCompany(container, "hp.com", "HP", "https://hp.com/", "company_random_9999");
  assert.ok(result, "true duplicate must still be caught");
  assert.equal(result.id, "company_hp_1234");
});

test("Phase 4.38 bulk: no match found + hint set → clean pass-through", async () => {
  const container = makeContainer({}); // no matches
  const result = await findExistingCompany(
    container,
    "totally-new-brand.example",
    "New Brand",
    "https://totally-new-brand.example/",
    "company_hp_1234"
  );
  assert.equal(result, null);
});

test("Phase 4.38 bulk: EXACT canonical_url match STILL BLOCKS with matching parent hint (defense-in-depth)", async () => {
  // Simulate the URL-tier (tier 2) branch: no domain match but the
  // canonical_url matches. This is a same-URL accidental double-import,
  // not a legitimate sub-brand — the hint must NOT let it through.
  const container = {
    items: {
      query(spec) {
        const domainParam = (spec.parameters || []).find((p) => p.name === "@domain");
        const canonParams = (spec.parameters || []).filter((p) => p.name.startsWith("@canon"));
        return {
          async fetchAll() {
            if (domainParam) return { resources: [] }; // no domain match
            if (canonParams.length > 0) return { resources: [hpMatch] };
            return { resources: [] };
          },
        };
      },
    },
  };
  const result = await findExistingCompany(
    container,
    "cdn-different-domain.example",
    "HP Calculators",
    "https://hp.com/", // exact match to hpMatch.canonical_url via variants
    "company_hp_1234"
  );
  assert.ok(result, "exact canonical_url match must block even with matching parent hint");
  assert.equal(result.id, "company_hp_1234");
  assert.equal(result.duplicate_match_key, "canonical_url");
});

// Phase 4.38.C — force-new bypass tests for the bulk-path helper.
test("Phase 4.38.C bulk: forceNew=true bypasses domain match", async () => {
  const container = makeContainer({ byDomain: { "sierracantabria.com": hpMatch } });
  const result = await findExistingCompany(
    container,
    "sierracantabria.com",
    "Sierra Cantabria",
    "https://sierracantabria.com/",
    "", // no parent hint
    true // forceNew
  );
  assert.equal(result, null, "forceNew must short-circuit BEFORE any tier match runs");
});

test("Phase 4.38.C bulk: forceNew=true bypasses same-name true duplicate too", async () => {
  const container = makeContainer({ byDomain: { "hp.com": hpMatch } });
  // Same name, matching parent hint, forceNew set — admin explicitly overrode.
  const result = await findExistingCompany(
    container,
    "hp.com",
    "HP",
    "https://hp.com/",
    "company_hp_1234",
    true
  );
  assert.equal(result, null, "admin-authorized bypass must win over dup signals");
});

test("Phase 4.38.C bulk: forceNew=false / undefined preserves legacy behavior", async () => {
  const container = makeContainer({ byDomain: { "hp.com": hpMatch } });
  const noFlag = await findExistingCompany(container, "hp.com", "HP Calc", "https://hp.com/", "");
  assert.ok(noFlag, "no flag: dup check runs");
  const falseFlag = await findExistingCompany(container, "hp.com", "HP Calc", "https://hp.com/", "", false);
  assert.ok(falseFlag, "false flag: dup check runs");
});

test("Phase 4.38 bulk: EXACT company_name match STILL BLOCKS with matching parent hint (defense-in-depth)", async () => {
  // Simulate the name-tier (tier 3) branch: no domain match, no URL
  // variant match, but the name matches. Same-name is a strong duplication
  // signal — the hint must NOT let it through.
  const container = {
    items: {
      query(spec) {
        const domainParam = (spec.parameters || []).find((p) => p.name === "@domain");
        const nameParam = (spec.parameters || []).find((p) => p.name === "@name");
        return {
          async fetchAll() {
            if (domainParam) return { resources: [] };
            if (nameParam) return { resources: [hpMatch] };
            return { resources: [] };
          },
        };
      },
    },
  };
  const result = await findExistingCompany(
    container,
    "some-other-domain.example",
    "HP", // matches hpMatch.company_name exactly
    "https://some-other-domain.example/",
    "company_hp_1234"
  );
  assert.ok(result, "exact company_name match must block even with matching parent hint");
  assert.equal(result.id, "company_hp_1234");
  assert.equal(result.duplicate_match_key, "company_name");
});
