// Phase 4.38.H — regression tests for the in-request dedup helper that
// guards saveCompaniesToCosmos against a same-batch double-write.
//
// Observed bug (2026-08-06): a single Ritz import produced TWO Cosmos
// documents 3ms apart with the same normalized_domain (snackworks.com)
// and identical URL fields — one carried parent_company_id correctly,
// the other did not. Mechanism: the enriched companies list handed to
// saveCompaniesToCosmos contained two entries mapping to the same
// (normalized_domain, company_name), so the outer Promise.all fired
// findExistingCompany for both before either commit landed. Neither
// found the other, both created with fresh company_${Date.now()} ids.
//
// dedupeCompaniesInRequest collapses those entries BEFORE the parallel
// write loop, preferring the entry with a non-empty parent_company_id
// when the hint diverges between duplicates. Bug-A (double-write) and
// Bug-B (parent hint dropped) both close under this contract, so this
// test is the canonical repro for the pair.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { dedupeCompaniesInRequest } = require("./_importStartSaveCompanies");

test("no dedup needed: single entry passes through unchanged", () => {
  const list = [{ company_name: "Ritz", website_url: "https://snackworks.com/" }];
  const { deduped, collapsed } = dedupeCompaniesInRequest(list);
  assert.equal(deduped.length, 1);
  assert.equal(collapsed.length, 0);
  assert.equal(deduped[0].company_name, "Ritz");
});

test("no dedup needed: distinct company_name at same domain (sub-brands) both preserved", () => {
  const list = [
    { company_name: "Ritz",       website_url: "https://snackworks.com/", parent_company_id: "p1" },
    { company_name: "Triscuit",   website_url: "https://snackworks.com/", parent_company_id: "p1" },
    { company_name: "Wheat Thins", website_url: "https://snackworks.com/", parent_company_id: "p1" },
  ];
  const { deduped, collapsed } = dedupeCompaniesInRequest(list);
  assert.equal(deduped.length, 3, "three distinct sub-brands under one parent must all survive");
  assert.equal(collapsed.length, 0);
});

test("Bug A repro: same (domain, name) entries collapse to one", () => {
  const list = [
    { company_name: "Ritz", website_url: "https://snackworks.com/", parent_company_id: "" },
    { company_name: "Ritz", website_url: "https://snackworks.com/", parent_company_id: "" },
  ];
  const { deduped, collapsed } = dedupeCompaniesInRequest(list);
  assert.equal(deduped.length, 1, "duplicate Ritz must collapse to a single save target");
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].dropped_index, 1);
  assert.equal(collapsed[0].kept_index, 0);
});

test("Bug B repro: when only ONE of two same-(domain,name) entries carries a parent hint, kept entry adopts it", () => {
  // Real-world shape: the primary xAI response returned Ritz with no
  // parent_company_id, and the company_url_hint injection also inserted
  // Ritz (with the hint parent_company_id stamped by the caller). Without
  // merge, dedup keeping the first entry would drop the hint and reproduce
  // Bug B on top of Bug A. With merge, the kept entry carries the hint.
  const list = [
    { company_name: "Ritz", website_url: "https://snackworks.com/" },
    { company_name: "Ritz", website_url: "https://snackworks.com/", parent_company_id: "company_snackworks_7eojvql29fx" },
  ];
  const { deduped } = dedupeCompaniesInRequest(list);
  assert.equal(deduped.length, 1);
  assert.equal(
    deduped[0].parent_company_id,
    "company_snackworks_7eojvql29fx",
    "kept entry must adopt the parent hint from the dropped duplicate"
  );
});

test("Bug B repro (reversed): parent hint on first entry survives dedup", () => {
  const list = [
    { company_name: "Ritz", website_url: "https://snackworks.com/", parent_company_id: "company_snackworks_7eojvql29fx" },
    { company_name: "Ritz", website_url: "https://snackworks.com/" },
  ];
  const { deduped } = dedupeCompaniesInRequest(list);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].parent_company_id, "company_snackworks_7eojvql29fx");
});

test("case-insensitive collapse on company_name", () => {
  const list = [
    { company_name: "Ritz", website_url: "https://snackworks.com/" },
    { company_name: "RITZ", website_url: "https://snackworks.com/" },
    { company_name: "ritz", website_url: "https://snackworks.com/" },
  ];
  const { deduped, collapsed } = dedupeCompaniesInRequest(list);
  assert.equal(deduped.length, 1);
  assert.equal(collapsed.length, 2);
});

test("URL-only differences with same normalized domain still collapse", () => {
  // Same company at same site, presented via canonical_url vs website_url.
  const list = [
    { company_name: "Ritz", website_url: "https://www.snackworks.com/" },
    { company_name: "Ritz", canonical_url: "https://snackworks.com/brands/ritz" },
  ];
  const { deduped } = dedupeCompaniesInRequest(list);
  assert.equal(deduped.length, 1, "normalized_domain is what matters, not the raw URL string");
});

test("does NOT collapse when normalized_domain is 'unknown' (would over-collapse)", () => {
  // A pair of entries with no derivable domain must stay separate.
  // toNormalizedDomain returns 'unknown' when it can't parse anything —
  // if we collapsed on that, unrelated rows with the same placeholder
  // name would silently merge.
  const list = [
    { company_name: "Placeholder", normalized_domain: "unknown" },
    { company_name: "Placeholder", normalized_domain: "unknown" },
  ];
  const { deduped } = dedupeCompaniesInRequest(list);
  assert.equal(deduped.length, 2);
});

test("does NOT collapse when company_name is empty", () => {
  // Empty name means we can't tell whether two entries are the same
  // company. Better to save both and let downstream dedup catch it.
  const list = [
    { website_url: "https://snackworks.com/" },
    { website_url: "https://snackworks.com/" },
  ];
  const { deduped } = dedupeCompaniesInRequest(list);
  assert.equal(deduped.length, 2);
});

test("preserves order of first-occurrence when collapsing", () => {
  const list = [
    { company_name: "Wheat Thins", website_url: "https://snackworks.com/" },
    { company_name: "Ritz",        website_url: "https://snackworks.com/" },
    { company_name: "Ritz",        website_url: "https://snackworks.com/" }, // dup
    { company_name: "Triscuit",    website_url: "https://snackworks.com/" },
  ];
  const { deduped } = dedupeCompaniesInRequest(list);
  assert.deepEqual(
    deduped.map((c) => c.company_name),
    ["Wheat Thins", "Ritz", "Triscuit"]
  );
});

test("scenario deliverable: 1 parent + 3 sub-brands as one batch — exactly 4 unique rows, all sub-brands carry parent hint", () => {
  // This mirrors the SnackWorks + Triscuit + Wheat Thins + Ritz shape
  // called out in the bug report deliverables. The parent has no
  // parent_company_id; each sub-brand does. After dedup: 4 rows survive,
  // hints preserved.
  const PARENT_ID = "company_snackworks_7eojvql29fx";
  const list = [
    { company_name: "SnackWorks",   website_url: "https://snackworks.com/" },
    { company_name: "Wheat Thins",  website_url: "https://snackworks.com/", parent_company_id: PARENT_ID },
    { company_name: "Triscuit",     website_url: "https://snackworks.com/", parent_company_id: PARENT_ID },
    { company_name: "Ritz",         website_url: "https://snackworks.com/", parent_company_id: PARENT_ID },
  ];
  const { deduped } = dedupeCompaniesInRequest(list);
  assert.equal(deduped.length, 4, "exactly 4 docs (a) — the parent plus 3 distinct sub-brands");
  const parent = deduped.find((c) => c.company_name === "SnackWorks");
  assert.ok(parent && !parent.parent_company_id, "parent must NOT carry a parent_company_id");
  for (const name of ["Wheat Thins", "Triscuit", "Ritz"]) {
    const sub = deduped.find((c) => c.company_name === name);
    assert.ok(sub, `${name} must be in deduped list`);
    assert.equal(sub.parent_company_id, PARENT_ID, `${name} must carry parent_company_id (b)`);
  }
});

test("scenario deliverable: same batch with an accidental Ritz duplicate — still exactly 4 unique rows, Ritz keeps parent hint", () => {
  // This is the actual observed pattern: the user's list (or xAI's
  // response) surfaced Ritz twice with divergent parent hints. Before
  // this fix, both writes landed as separate docs 3ms apart, one
  // without the parent link. After dedup, one Ritz survives with the
  // hint from whichever duplicate carried it.
  const PARENT_ID = "company_snackworks_7eojvql29fx";
  const list = [
    { company_name: "SnackWorks",   website_url: "https://snackworks.com/" },
    { company_name: "Wheat Thins",  website_url: "https://snackworks.com/", parent_company_id: PARENT_ID },
    { company_name: "Triscuit",     website_url: "https://snackworks.com/", parent_company_id: PARENT_ID },
    { company_name: "Ritz",         website_url: "https://snackworks.com/" }, // Bug B shape: missing hint
    { company_name: "Ritz",         website_url: "https://snackworks.com/", parent_company_id: PARENT_ID }, // Bug A shape: dup
  ];
  const { deduped, collapsed } = dedupeCompaniesInRequest(list);
  assert.equal(deduped.length, 4);
  assert.equal(collapsed.length, 1);
  const ritz = deduped.find((c) => c.company_name === "Ritz");
  assert.equal(ritz.parent_company_id, PARENT_ID, "hint from second Ritz entry must survive dedup");
});

test("handles empty and non-array inputs safely", () => {
  assert.deepEqual(dedupeCompaniesInRequest([]).deduped, []);
  assert.deepEqual(dedupeCompaniesInRequest(null).deduped, []);
  assert.deepEqual(dedupeCompaniesInRequest(undefined).deduped, []);
});

test("preserves entries that are not objects (defensive)", () => {
  const list = [null, undefined, { company_name: "Ritz", website_url: "https://snackworks.com/" }];
  const { deduped } = dedupeCompaniesInRequest(list);
  assert.equal(deduped.length, 3);
});
