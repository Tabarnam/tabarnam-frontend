import { describe, it, expect } from "vitest";
import { kebab, flagEmoji, aggregateByCountry, companyHref } from "./madeIn";

describe("kebab", () => {
  it("slugifies names", () => {
    expect(kebab("United States")).toBe("united-states");
    expect(kebab("Côte d'Ivoire")).toBe("cote-d-ivoire");
    expect(kebab("  New  Zealand ")).toBe("new-zealand");
  });
});

describe("flagEmoji", () => {
  it("builds regional-indicator flags from ISO codes", () => {
    expect(flagEmoji("US")).toBe("🇺🇸");
    expect(flagEmoji("it")).toBe("🇮🇹");
    expect(flagEmoji("")).toBe("");
    expect(flagEmoji("USA")).toBe("");
  });
});

describe("aggregateByCountry", () => {
  const pins = new Map([
    ["a", { id: "a", name: "Zeta", domain: "z.com", hqCC: "US", mfgCCs: ["US", "IT"] }],
    ["b", { id: "b", name: "Alpha", domain: "a.com", hqCC: "US", mfgCCs: ["US"] }],
    ["c", { id: "c", name: "Mid", domain: "", hqCC: "FR", mfgCCs: [] }],
  ]);

  it("buckets manufacturers per country, sorted by name", () => {
    const { byCC, total } = aggregateByCountry(pins);
    expect(total).toBe(3);
    expect(byCC.get("US").companies.map((c) => c.name)).toEqual(["Alpha", "Zeta"]);
    expect(byCC.get("IT").companies.map((c) => c.name)).toEqual(["Zeta"]);
    expect(byCC.has("FR")).toBe(true); // hq-only bucket exists
    expect(byCC.get("FR").companies).toEqual([]);
  });

  it("counts headquarters separately from manufacturers", () => {
    const { byCC } = aggregateByCountry(pins);
    expect(byCC.get("US").hqCount).toBe(2);
    expect(byCC.get("FR").hqCount).toBe(1);
    expect(byCC.get("IT").hqCount).toBe(0);
  });

  it("tolerates junk input", () => {
    expect(aggregateByCountry(null).total).toBe(0);
  });
});

describe("companyHref", () => {
  it("prefers the domain exact-match flow", () => {
    expect(companyHref({ id: "x", name: "Acme", domain: "acme.com" })).toBe("/results?domain=acme.com");
    expect(companyHref({ id: "x", name: "Acme Co", domain: "" })).toBe("/results?q=Acme%20Co&expand=x");
  });
});
