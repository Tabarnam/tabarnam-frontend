import { describe, expect, test } from "vitest";

import { __test__ } from "./AdminEditHistory.jsx";

const { pretty } = __test__;

// Regression: pretty() fed ValueBlock, which does text.length. JSON.stringify
// RETURNS undefined (it does not throw) for undefined/functions/symbols, so an
// "added field" diff entry — whose `before` is legitimately undefined — crashed
// the whole edit dialog with "Cannot read properties of undefined (reading
// 'length')". pretty() must always hand back a string.
describe("AdminEditHistory pretty()", () => {
  test("undefined (a newly-added field's `before`) renders as a placeholder, not undefined", () => {
    const out = pretty(undefined);
    expect(typeof out).toBe("string");
    expect(out).toBe("—");
  });

  test("functions and symbols also stringify to a string", () => {
    expect(typeof pretty(() => {})).toBe("string");
    expect(typeof pretty(Symbol("x"))).toBe("string");
  });

  test("null still renders as JSON null, not the placeholder", () => {
    expect(pretty(null)).toBe("null");
  });

  test("strings pass through untouched", () => {
    expect(pretty("Stinkbug")).toBe("Stinkbug");
  });

  test("objects and arrays pretty-print", () => {
    expect(pretty({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(pretty([1, 2])).toBe("[\n  1,\n  2\n]");
  });

  test("every result is safe to call .length on", () => {
    for (const v of [undefined, null, 0, false, "", { a: 1 }, [], () => {}]) {
      expect(() => pretty(v).length).not.toThrow();
    }
  });
});
