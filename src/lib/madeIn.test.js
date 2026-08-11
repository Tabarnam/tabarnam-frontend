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

describe("getRegionRegistry", () => {
  it("registers US states, DC, and territories with slugs", async () => {
    const { getRegionRegistry } = await import("./madeIn");
    const { bySlug, byCode } = getRegionRegistry("US");
    expect(byCode.size).toBe(56); // 50 states + DC + 5 territories
    expect(bySlug.get("california")).toMatchObject({ code: "US-CA", name: "California" });
    expect(bySlug.get("new-york").code).toBe("US-NY");
    expect(bySlug.get("washington-dc").code).toBe("US-DC");
    expect(bySlug.get("puerto-rico").code).toBe("US-PR");
    expect(bySlug.get("us-virgin-islands").code).toBe("US-VI");
    expect(bySlug.get("atlantis")).toBeUndefined();
  });

  it("returns an empty registry for countries without published state pages", async () => {
    const { getRegionRegistry } = await import("./madeIn");
    expect(getRegionRegistry("IT").byCode.size).toBe(0);
  });
});

describe("aggregateByRegion", () => {
  const pins = new Map([
    ["a", { id: "a", name: "Zeta", hqRegion: "US-CA", mfgRegions: ["US-CA", "US-OR"] }],
    ["b", { id: "b", name: "Alpha", hqRegion: "US-CA", mfgRegions: ["US-CA"] }],
    ["c", { id: "c", name: "Foreign", hqRegion: "AU-SA", mfgRegions: ["AU-SA"] }],
    ["d", { id: "d", name: "CountryOnly", hqRegion: null, mfgRegions: [] }],
  ]);

  it("buckets by subdivision, scoped to the country prefix", async () => {
    const { aggregateByRegion } = await import("./madeIn");
    const { byRegion, withRegion } = aggregateByRegion(pins, "US");
    expect(byRegion.get("US-CA").companies.map((c) => c.name)).toEqual(["Alpha", "Zeta"]);
    expect(byRegion.get("US-OR").companies.map((c) => c.name)).toEqual(["Zeta"]);
    expect(byRegion.has("AU-SA")).toBe(false);
    expect(withRegion).toBe(2); // only companies with a US region
  });

  it("counts state headquarters separately", async () => {
    const { aggregateByRegion } = await import("./madeIn");
    const { byRegion } = aggregateByRegion(pins, "US");
    expect(byRegion.get("US-CA").hqCount).toBe(2);
    expect(byRegion.get("US-OR").hqCount).toBe(0);
  });

  it("scopes to other countries on request", async () => {
    const { aggregateByRegion } = await import("./madeIn");
    const { byRegion } = aggregateByRegion(pins, "AU");
    expect(byRegion.get("AU-SA").companies.map((c) => c.name)).toEqual(["Foreign"]);
  });
});
