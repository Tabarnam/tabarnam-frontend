import { describe, test, expect } from "vitest";
import { render } from "@testing-library/react";
import { highlightExactPhrase, isExactChipMatch } from "@/lib/highlightMatch";

// Renders the helper's output and returns { text, markHtmls } where markHtmls
// is the array of innerHTML strings from each <mark>. Lets us assert both the
// full visible text and exactly which spans got highlighted.
function renderHighlight(text, query) {
  const { container } = render(<span>{highlightExactPhrase(text, query)}</span>);
  const marks = [...container.querySelectorAll("mark")].map((m) => m.textContent);
  return { text: container.textContent, marks };
}

describe("isExactChipMatch", () => {
  test("true when chip equals query (case/space-insensitive)", () => {
    expect(isExactChipMatch("Ballet Flats", "ballet flats")).toBe(true);
    expect(isExactChipMatch("  Ballet  Flats ", "ballet flats")).toBe(true);
  });

  test("true via compact form (MyPillow chip ~ 'my pillow' query)", () => {
    expect(isExactChipMatch("MyPillow", "my pillow")).toBe(true);
  });

  test("false when chip only contains the query (not equal)", () => {
    expect(isExactChipMatch("Ballet Flat Shoes", "ballet flats")).toBe(false);
    expect(isExactChipMatch("Memory Foam Pillow", "pillow")).toBe(false);
  });

  test("false for empty / missing inputs", () => {
    expect(isExactChipMatch("", "x")).toBe(false);
    expect(isExactChipMatch("x", "")).toBe(false);
    expect(isExactChipMatch(null, undefined)).toBe(false);
  });

  test("diacritic-insensitive", () => {
    expect(isExactChipMatch("Café", "cafe")).toBe(true);
  });
});

describe("highlightExactPhrase", () => {
  test("returns the plain string unchanged when no query", () => {
    expect(highlightExactPhrase("Rollerblade USA", "")).toBe("Rollerblade USA");
  });

  test("returns the plain string unchanged when no match", () => {
    expect(highlightExactPhrase("Acme Corp", "pillow")).toBe("Acme Corp");
  });

  test("highlights a standalone word inside a longer name", () => {
    const { text, marks } = renderHighlight("Rollerblade USA", "rollerblade");
    expect(text).toBe("Rollerblade USA");
    expect(marks).toEqual(["Rollerblade"]); // original casing preserved
  });

  test("highlights a multi-word phrase inside a tagline", () => {
    const { marks } = renderHighlight(
      "Handmade ballet flats since 1990",
      "ballet flats"
    );
    expect(marks).toEqual(["ballet flats"]);
  });

  test("does NOT highlight a partial word (paint inside Painterly)", () => {
    const { marks } = renderHighlight("Painterly Studio", "paint");
    expect(marks).toEqual([]); // no partial-word match
  });

  test("does NOT highlight mid-word (paint inside fingerpaint)", () => {
    const { marks } = renderHighlight("fingerpaint co", "paint");
    expect(marks).toEqual([]);
  });

  test("case-insensitive match, preserves original casing in the mark", () => {
    const { marks } = renderHighlight("CANDLE Works", "candle");
    expect(marks).toEqual(["CANDLE"]);
  });

  test("highlights multiple occurrences", () => {
    const { marks } = renderHighlight("paint and more paint", "paint");
    expect(marks).toEqual(["paint", "paint"]);
  });

  test("matches across punctuation/whitespace runs between words", () => {
    // "ballet, flats" in source vs "ballet flats" query — between-word run is
    // ", " which the matcher treats as a single separator.
    const { marks } = renderHighlight("our ballet, flats line", "ballet flats");
    expect(marks.length).toBe(1);
    expect(marks[0].toLowerCase().replace(/[^a-z]/g, "")).toBe("balletflats");
  });

  test("whole-string exact match highlights the whole string", () => {
    const { text, marks } = renderHighlight("Rollerblade", "rollerblade");
    expect(text).toBe("Rollerblade");
    expect(marks).toEqual(["Rollerblade"]);
  });
});
