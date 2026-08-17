// Apply Industries/Products matcher — regression tests.
//
// Bug context (2026-08-16): admin observed that names in the catalog are
// often ambiguous or reused across brands ("Ridge" alone matches Ridge
// Vineyards, Ridgeview, and Blue Ridge Farms) while URL is a reliable
// identity signal. The old applyBatchFields matcher inside AdminImport.jsx
// used a fuzzy substring test that accepted `name.includes(query) ||
// query.includes(name)` — the first search result matching that predicate
// won, so a URL row could silently apply industries to the wrong company.
//
// Fix — findApplyTarget:
//   - Row has companyUrl → require EXACT normalized_domain; no name fallback.
//   - Row has no companyUrl → require EXACT case-insensitive company_name.
// No fuzzy substring in either branch.

import { describe, expect, it } from "vitest";
import { findApplyTarget } from "./AdminImport";

describe("findApplyTarget — URL-only exact match when URL present", () => {
  const url = "ridgevineyards.com";

  it("returns the exact-domain match even when a same-substring name comes first", () => {
    const items = [
      { id: "wrong_1", company_name: "Ridge Runner Coffee", normalized_domain: "ridgerunner.coffee" },
      { id: "wrong_2", company_name: "Blue Ridge Farms", normalized_domain: "blueridgefarms.com" },
      { id: "right",   company_name: "Ridge Vineyards",   normalized_domain: "ridgevineyards.com" },
    ];
    const hit = findApplyTarget({ domain: url, name: "Ridge Vineyards", items });
    expect(hit).toBeTruthy();
    expect(hit.id).toBe("right");
  });

  it("strips leading www. from candidate normalized_domain before comparing", () => {
    const items = [{ id: "a", company_name: "Ridge Vineyards", normalized_domain: "www.ridgevineyards.com" }];
    const hit = findApplyTarget({ domain: url, name: "Ridge", items });
    expect(hit?.id).toBe("a");
  });

  it("returns null when URL is set but no candidate has that exact domain — never falls back to name", () => {
    // This is the safety property the fix delivers: a URL row that misses
    // stays a miss instead of drifting to a fuzzy-name match on an unrelated
    // brand. Row = { url: ridgevineyards.com, name: "Ridge" } and the search
    // returns three "Ridge*" names, none with the target domain.
    const items = [
      { id: "wrong_1", company_name: "Ridge Runner Coffee", normalized_domain: "ridgerunner.coffee" },
      { id: "wrong_2", company_name: "Blue Ridge Farms", normalized_domain: "blueridgefarms.com" },
      { id: "wrong_3", company_name: "Ridge",             normalized_domain: "someunrelated.com" },
    ];
    const hit = findApplyTarget({ domain: url, name: "Ridge", items });
    expect(hit).toBeNull();
  });

  it("case-insensitive domain match", () => {
    const items = [{ id: "a", normalized_domain: "RidgeVineyards.COM" }];
    const hit = findApplyTarget({ domain: "ridgevineyards.com", items });
    expect(hit?.id).toBe("a");
  });
});

describe("findApplyTarget — exact-name match when URL absent", () => {
  it("matches company_name case-insensitively", () => {
    const items = [
      { id: "wrong", company_name: "Apple Bakery" },
      { id: "right", company_name: "APPLE" },
    ];
    const hit = findApplyTarget({ name: "Apple", items });
    expect(hit?.id).toBe("right");
  });

  it("no longer accepts fuzzy substring — 'Apple' does NOT match 'Apple Inc' (regression: over-loose fuzzy)", () => {
    // Pre-fix: n.includes(name) → "apple inc".includes("apple") → true.
    // That's how one-word brand rows applied their bulk fields to unrelated
    // multi-word companies. Fix: exact match only.
    const items = [{ id: "wrong", company_name: "Apple Inc" }];
    expect(findApplyTarget({ name: "Apple", items })).toBeNull();
  });

  it("no longer accepts fuzzy substring in the OTHER direction — 'Apple Inc' does NOT match 'Apple'", () => {
    const items = [{ id: "wrong", company_name: "Apple" }];
    expect(findApplyTarget({ name: "Apple Inc", items })).toBeNull();
  });

  it("returns null when no candidate name matches exactly", () => {
    const items = [
      { id: "a", company_name: "Big Apple Bakery" },
      { id: "b", company_name: "Pineapple Co" },
    ];
    expect(findApplyTarget({ name: "Apple", items })).toBeNull();
  });
});

describe("findApplyTarget — defensive edges", () => {
  it("empty / missing items list → null", () => {
    expect(findApplyTarget({ domain: "x.com", items: [] })).toBeNull();
    expect(findApplyTarget({ domain: "x.com" })).toBeNull();
    expect(findApplyTarget({ domain: "x.com", items: null })).toBeNull();
  });

  it("no URL and no name → null (nothing to match on)", () => {
    const items = [{ id: "a", company_name: "Ridge", normalized_domain: "x.com" }];
    expect(findApplyTarget({ items })).toBeNull();
    expect(findApplyTarget({ domain: "", name: "", items })).toBeNull();
  });

  it("URL present but empty string — treated as absent, falls to name branch", () => {
    const items = [{ id: "a", company_name: "Ridge Vineyards" }];
    const hit = findApplyTarget({ domain: "", name: "Ridge Vineyards", items });
    expect(hit?.id).toBe("a");
  });

  it("candidate with no normalized_domain nor company_name — skipped", () => {
    const items = [
      { id: "a" }, // no fields
      { id: "b", normalized_domain: "ridgevineyards.com" },
    ];
    const hit = findApplyTarget({ domain: "ridgevineyards.com", items });
    expect(hit?.id).toBe("b");
  });
});

describe("findApplyTarget — real-world scenarios", () => {
  it("URL row where the exact-domain match is not the first search result — still wins", () => {
    // Search index returns fuzzy-name matches ranked ahead of the exact
    // domain match. Pre-fix .find() returned the first fuzzy match and
    // applied to the wrong company. Post-fix: skips fuzzy, keeps scanning
    // for the exact domain, and lands the right one.
    const items = [
      { id: "fuzzy_1", company_name: "Ridge Wine",       normalized_domain: "ridgewine.com" },
      { id: "fuzzy_2", company_name: "Ridge Vineyard",   normalized_domain: "ridge-vineyard.com" }, // note singular
      { id: "target",  company_name: "Ridge Vineyards",  normalized_domain: "ridgevineyards.com" },
    ];
    const hit = findApplyTarget({ domain: "ridgevineyards.com", name: "Ridge Vineyards", items });
    expect(hit?.id).toBe("target");
  });

  it("scenario: name-only row where two candidates share a substring", () => {
    // Row is name-only "Champagne Vilmart". Search returns three "Vilmart*"
    // items. Exact match wins.
    const items = [
      { id: "wrong_1", company_name: "Vilmart Wines LLC" },
      { id: "right",   company_name: "Champagne Vilmart" },
      { id: "wrong_2", company_name: "Vilmart et Cie" },
    ];
    const hit = findApplyTarget({ name: "Champagne Vilmart", items });
    expect(hit?.id).toBe("right");
  });
});
