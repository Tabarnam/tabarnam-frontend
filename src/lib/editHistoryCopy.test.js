import { describe, expect, test } from "vitest";

import { describeChange, describeEntry, fieldLabel, pretty, shortenUrl } from "./editHistoryCopy";

// Regression: pretty() feeds the raw-value <pre>, which reads .length.
// JSON.stringify RETURNS undefined (it does not throw) for undefined/functions/
// symbols, and a diff entry legitimately has an undefined `before` when the
// field was newly added — that crashed the whole edit dialog.
describe("pretty()", () => {
  test("undefined (a newly-added field's `before`) becomes a placeholder", () => {
    expect(pretty(undefined)).toBe("—");
  });

  test("functions and symbols still yield strings", () => {
    expect(typeof pretty(() => {})).toBe("string");
    expect(typeof pretty(Symbol("x"))).toBe("string");
  });

  test("null renders as JSON null, not the placeholder", () => {
    expect(pretty(null)).toBe("null");
  });

  test("every result is safe to call .length on", () => {
    for (const v of [undefined, null, 0, false, "", { a: 1 }, [], () => {}]) {
      expect(() => pretty(v).length).not.toThrow();
    }
  });
});

describe("fieldLabel()", () => {
  test("known schema keys get the name the editor uses", () => {
    expect(fieldLabel("amazon_url")).toBe("Amazon store link");
    expect(fieldLabel("manufacturing_geocodes")).toBe("Manufacturing locations");
    expect(fieldLabel("keywords")).toBe("Products");
  });

  test("unknown keys are humanized rather than shown raw", () => {
    expect(fieldLabel("some_new_field")).toBe("Some New Field");
  });
});

describe("describeChange()", () => {
  test("a boolean flag reads as the action, not the field name", () => {
    const on = describeChange("unknown_manufacturing", false, true);
    expect(on.summary).toBe("Marked the manufacturing location as unknown");
    expect(on.tone).toBe("on");

    const off = describeChange("amazon_url_approved", true, false);
    expect(off.summary).toBe("Withdrew approval of the Amazon store link");
    expect(off.tone).toBe("off");
  });

  test("a URL set from blank says so, and strips the protocol", () => {
    const c = describeChange("amazon_url", "", "https://www.amazon.com/stores/foo");
    expect(c.tone).toBe("added");
    expect(c.summary).toBe("Set to amazon.com/stores/foo");
  });

  test("a cleared URL keeps the old value visible", () => {
    const c = describeChange("logo_url", "https://img/logo.png", "");
    expect(c.tone).toBe("removed");
    expect(c.summary).toContain("img/logo.png");
  });

  test("list changes report the actual members added and removed", () => {
    const c = describeChange("industries", ["Apparel", "Shoes"], ["Apparel", "Bags"]);
    expect(c.tone).toBe("changed");
    expect(c.summary).toContain("Bags");
    expect(c.summary).toContain("Shoes");
  });

  test("location objects are flattened to City, State, Country", () => {
    const c = describeChange("manufacturing_locations", [], [{ city: "Austin", state: "TX", country: "USA" }]);
    expect(c.tone).toBe("added");
    expect(c.summary).toBe("Added Austin, TX, USA");
  });

  test("text changes show before and after", () => {
    const c = describeChange("tagline", "Old words", "New words");
    expect(c.summary).toBe("“Old words” → “New words”");
  });

  test("derived bookkeeping fields are flagged as system", () => {
    expect(describeChange("search_tokens", [], ["a"]).system).toBe(true);
    expect(describeChange("issues_count", 3, 1).system).toBe(true);
    expect(describeChange("tagline", "", "hi").system).toBe(false);
  });

  test("issue-count movement is phrased as a delta", () => {
    expect(describeChange("issues_count", 3, 1).summary).toBe("2 removed (3 → 1)");
  });
});

describe("describeEntry()", () => {
  const entry = {
    action: "update",
    actor_email: "jon@tabarnam.com",
    source: "admin-ui",
    diff: {
      amazon_url_approved: { before: false, after: true },
      tagline: { before: "", after: "Hand-poured soap" },
      search_tokens: { before: ["a"], after: ["a", "b"] },
      issues_count: { before: 2, after: 1 },
    },
  };

  test("separates admin edits from automatic updates", () => {
    const d = describeEntry(entry);
    expect(d.changes.map((c) => c.key).sort()).toEqual(["amazon_url_approved", "tagline"]);
    expect(d.systemChanges.map((c) => c.key).sort()).toEqual(["issues_count", "search_tokens"]);
  });

  test("headline names the fields when there are few", () => {
    expect(describeEntry(entry).headline).toBe("Edited amazon link, tagline");
  });

  test("headline counts them when there are many", () => {
    const many = {
      action: "update",
      diff: Object.fromEntries(
        ["tagline", "company_name", "website_url", "email", "notes"].map((k) => [k, { before: "", after: "x" }])
      ),
    };
    expect(describeEntry(many).headline).toBe("Edited 5 fields");
  });

  test("a save that only moved derived fields says so", () => {
    const sysOnly = { action: "update", diff: { search_tokens: { before: [], after: ["a"] } } };
    expect(describeEntry(sysOnly).headline).toBe("Saved — no field changes");
  });

  test("create and delete get their own headlines", () => {
    expect(describeEntry({ action: "create", diff: {} }).headline).toBe("Created this company");
    expect(describeEntry({ action: "delete", diff: {} }).headline).toBe("Deleted this company");
  });

  test("actor falls back to System when no admin is recorded", () => {
    expect(describeEntry({ action: "update", diff: {} }).actor).toBe("System");
    expect(describeEntry(entry).actor).toBe("jon@tabarnam.com");
  });

  test("source is shown in words", () => {
    expect(describeEntry(entry).source).toBe("Admin editor");
  });

  test("a malformed entry does not throw", () => {
    expect(() => describeEntry(null)).not.toThrow();
    expect(() => describeEntry({ diff: "nonsense" })).not.toThrow();
  });
});

describe("shortenUrl()", () => {
  test("drops protocol, www and trailing slash", () => {
    expect(shortenUrl("https://www.example.com/")).toBe("example.com");
  });

  test("truncates very long urls", () => {
    expect(shortenUrl(`https://example.com/${"a".repeat(200)}`, 20).length).toBe(20);
  });
});
