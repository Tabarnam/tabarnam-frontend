import { describe, it, expect } from "vitest";
import {
  boundedEditDistance,
  makeActivityMatcher,
  filterActivity,
} from "./fuzzyActivityMatch";

describe("boundedEditDistance", () => {
  it("is 0 for equal strings", () => {
    expect(boundedEditDistance("aspectek", "aspectek", 2)).toBe(0);
  });
  it("counts a single deletion", () => {
    expect(boundedEditDistance("aspctek", "aspectek", 2)).toBe(1); // missing 'e'
  });
  it("counts an adjacent transposition as one edit", () => {
    expect(boundedEditDistance("aspetck", "aspectk", 2)).toBe(1);
  });
  it("early-exits past the bound", () => {
    // 'cinzano' vs 'aspectek' is far apart → returns max+1, not the true value
    expect(boundedEditDistance("cinzano", "aspectek", 2)).toBe(3);
  });
});

const rows = [
  { text: "Company Aspectek edited" },
  { text: "Applied 'electric bug zapper' as industry to 9 companies" },
  { text: "Company Cinzano edited" },
  { text: "score_rescore on PIC" },
  { text: "Company Béis edited" },
];
const getText = (r) => r.text;

describe("filterActivity — exact/normalized pass", () => {
  it("matches a plain substring", () => {
    const { rows: out, fuzzy } = filterActivity("aspectek", rows, getText);
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain("Aspectek");
    expect(fuzzy).toBe(false);
  });

  it("is case- and diacritic-insensitive (reuses queryNormalizer)", () => {
    const { rows: out } = filterActivity("beis", rows, getText);
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain("Béis");
  });

  it("is plural-insensitive via stemming", () => {
    const { rows: out } = filterActivity("company", rows, getText);
    // "companies" stems to "company" → matches the batch-apply row too
    expect(out.length).toBeGreaterThanOrEqual(4);
  });

  it("matches a multi-word term", () => {
    const { rows: out } = filterActivity("bug zapper", rows, getText);
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain("bug zapper");
  });
});

describe("filterActivity — fuzzy fallback", () => {
  it("finds a typo'd company only when no exact match exists", () => {
    const { rows: out, fuzzy } = filterActivity("aspctek", rows, getText);
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain("Aspectek");
    expect(fuzzy).toBe(true);
  });

  it("tolerates a transposition", () => {
    const { rows: out, fuzzy } = filterActivity("cinznao", rows, getText);
    expect(out.map((r) => r.text)).toContain("Company Cinzano edited");
    expect(fuzzy).toBe(true);
  });

  it("does NOT fuzz-match unrelated rows", () => {
    const { rows: out } = filterActivity("aspctek", rows, getText);
    expect(out.every((r) => !r.text.includes("Cinzano"))).toBe(true);
  });

  it("returns everything for an empty query", () => {
    const { rows: out, fuzzy } = filterActivity("   ", rows, getText);
    expect(out).toBe(rows);
    expect(fuzzy).toBe(false);
  });

  it("returns no rows (not fuzzy) for gibberish", () => {
    const { rows: out, fuzzy } = filterActivity("zzzqqqxyw", rows, getText);
    expect(out).toHaveLength(0);
    expect(fuzzy).toBe(false);
  });
});
