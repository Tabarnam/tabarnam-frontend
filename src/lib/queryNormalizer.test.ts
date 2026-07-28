import { describe, it, expect } from "vitest";
import { extractNormalizedDomain, extractSearchTermFromUrl } from "./queryNormalizer";
// The canonical backend normalizer (pure — only requires `crypto`), imported so
// the two implementations are locked together by this test.
// @ts-expect-error — CommonJS module without types
import { toNormalizedDomain } from "../../api/import-start/_importStartCompanyUtils.js";

describe("extractNormalizedDomain ↔ toNormalizedDomain contract", () => {
  // URL / domain inputs must produce the SAME normalized_domain the backend
  // stores, so a ?domain= param exact-matches the record.
  const urlFixtures: Array<[string, string]> = [
    ["https://www.cove.com/products", "cove.com"],
    ["cove.com", "cove.com"],
    ["shop.cove.com", "shop.cove.com"], // subdomain kept (exact-only v1)
    ["Cove.COM/", "cove.com"],
    ["http://getcove.com", "getcove.com"],
    ["www.acme-corp.co.uk", "acme-corp.co.uk"],
    ["https://vitalyte.com/", "vitalyte.com"],
  ];

  for (const [input, expected] of urlFixtures) {
    it(`"${input}" → "${expected}" (and matches backend)`, () => {
      expect(extractNormalizedDomain(input)).toBe(expected);
      // Locked to the canonical backend implementation.
      expect(toNormalizedDomain(input)).toBe(expected);
    });
  }

  // Non-URL input: the client returns "" so no ?domain= is ever sent. (The
  // backend's looser toNormalizedDomain is only invoked defensively on
  // URL-looking raw queries, so its value on plain text doesn't matter here.)
  const nonUrl = ["organic soap", "not a query", "cove", "", "   "];
  for (const input of nonUrl) {
    it(`"${input}" is not a domain → ""`, () => {
      expect(extractNormalizedDomain(input)).toBe("");
    });
  }
});

describe("extractSearchTermFromUrl is unchanged (brand label fallback)", () => {
  const cases: Array<[string, string]> = [
    ["https://www.cove.com/products", "cove"],
    ["cove.com", "cove"],
    ["shop.vitalyte.com/products", "vitalyte"],
    ["www.acme-corp.co.uk", "acme-corp"],
    ["organic soap", "organic soap"], // plain text unchanged
    ["cove", "cove"],
  ];
  for (const [input, expected] of cases) {
    it(`"${input}" → "${expected}"`, () => {
      expect(extractSearchTermFromUrl(input)).toBe(expected);
    });
  }
});
