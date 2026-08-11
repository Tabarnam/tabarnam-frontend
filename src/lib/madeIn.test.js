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

describe("companiesForMode", () => {
  const bucket = {
    companies: [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }],
    hqCompanies: [{ id: "b", name: "Beta" }, { id: "c", name: "Gamma" }],
    hqCount: 2,
  };

  it("returns manufacturers by default", async () => {
    const { companiesForMode } = await import("./madeIn");
    expect(companiesForMode(bucket).map((c) => c.id)).toEqual(["a", "b"]);
    expect(companiesForMode(bucket, "mfg").map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("returns headquarters for hq mode", async () => {
    const { companiesForMode } = await import("./madeIn");
    expect(companiesForMode(bucket, "hq").map((c) => c.id)).toEqual(["b", "c"]);
  });

  it("unions and dedupes for both mode, sorted by name", async () => {
    const { companiesForMode } = await import("./madeIn");
    expect(companiesForMode(bucket, "both").map((c) => c.name)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("tolerates a missing bucket", async () => {
    const { companiesForMode } = await import("./madeIn");
    expect(companiesForMode(null, "both")).toEqual([]);
  });
});

describe("aggregations expose hq company lists", () => {
  const pins = new Map([
    ["a", { id: "a", name: "Alpha", hqCC: "US", mfgCCs: ["MX"], hqRegion: "US-CA", mfgRegions: [] }],
    ["b", { id: "b", name: "Beta", hqCC: "US", mfgCCs: ["US"], hqRegion: "US-TX", mfgRegions: ["US-TX"] }],
  ]);

  it("country buckets carry hqCompanies alongside manufacturers", async () => {
    const { aggregateByCountry } = await import("./madeIn");
    const { byCC } = aggregateByCountry(pins);
    expect(byCC.get("US").companies.map((c) => c.id)).toEqual(["b"]);
    expect(byCC.get("US").hqCompanies.map((c) => c.id)).toEqual(["a", "b"]);
    expect(byCC.get("MX").hqCompanies).toEqual([]);
  });

  it("region buckets carry hqCompanies too", async () => {
    const { aggregateByRegion } = await import("./madeIn");
    const { byRegion } = aggregateByRegion(pins, "US");
    expect(byRegion.get("US-CA").companies).toEqual([]);
    expect(byRegion.get("US-CA").hqCompanies.map((c) => c.id)).toEqual(["a"]);
    expect(byRegion.get("US-TX").companies.map((c) => c.id)).toEqual(["b"]);
  });
});
