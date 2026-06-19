// Phase 4.37 — lock the looksLikeUrlOrDomain classifier against the
// dotted-brand-name regression that misrouted "Pretti.Cool" to
// /api/import-one (synchronous, SWA-timed-out) instead of the bulk
// /api/import-start (202 + polling).

import { describe, it, expect } from "vitest";
import { looksLikeUrlOrDomain } from "./importUtils";

describe("looksLikeUrlOrDomain", () => {
  describe("classifies real URLs as URLs", () => {
    it.each([
      "https://pretti.cool/",
      "http://example.com",
      "https://www.zara.com/us",
      "www.zara.com",
      "pretti.cool",
      "example.com",
      "shop.example.co.uk",
    ])("%s → true", (input) => {
      expect(looksLikeUrlOrDomain(input)).toBe(true);
    });
  });

  describe("classifies brand names with dotted TLDs as names (Phase 4.37 regression guard)", () => {
    it.each([
      "Pretti.Cool", // the case the user hit
      "Buy.me",
      "Tools.io",
      "Hi.co",
      "Design.studio",
      "Build.tech",
      "Acme.AI",
      "Acme.Ai",
    ])("%s → false", (input) => {
      expect(looksLikeUrlOrDomain(input)).toBe(false);
    });
  });

  describe("mixed case is allowed when scheme is explicit (user clearly intends a URL)", () => {
    it.each([
      "https://Pretti.Cool/",
      "https://Acme.AI",
      "http://Example.COM",
    ])("%s → true", (input) => {
      expect(looksLikeUrlOrDomain(input)).toBe(true);
    });
  });

  describe("non-URL inputs stay non-URL", () => {
    it.each([
      "",
      "   ",
      "Acme Widgets", // whitespace
      "single", // no dot
      "no-dot-name", // no TLD
      "a.b", // 1-char TLD
    ])("%s → false", (input) => {
      expect(looksLikeUrlOrDomain(input)).toBe(false);
    });
  });

  describe("null / non-string input doesn't throw", () => {
    // Note: numeric inputs like 42 get coerced to "42" which Node's URL parser
    // treats as an IPv4 address (0.0.0.42) — pre-existing behavior, out of
    // scope for the Pretti.Cool regression fix. We only assert null-safety here.
    it.each([null, undefined, {}, []])("%s → false", (input) => {
      expect(looksLikeUrlOrDomain(input)).toBe(false);
    });
  });
});
