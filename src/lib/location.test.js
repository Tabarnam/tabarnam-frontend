import { describe, it, expect } from "vitest";
import { countryTokensFor, isLocationInCountry } from "./location";

describe("countryTokensFor", () => {
  it("US → includes usa + united states, excludes the ambiguous 'america'", async () => {
    const t = await countryTokensFor("US");
    expect(t).toContain("usa");
    expect(t).toContain("united states");
    expect(t).not.toContain("america"); // would false-match 'South America'
    expect(t).not.toContain("us"); // bare 2-letter code excluded (collides w/ state abbrevs)
  });
  it("CA → includes canada", async () => {
    const t = await countryTokensFor("CA");
    expect(t).toContain("canada");
  });
  it("empty → []", async () => {
    expect(await countryTokensFor("")).toEqual([]);
  });
});

describe("isLocationInCountry (US)", () => {
  // Tokens as countryTokensFor("US") would produce.
  const US = ["united states", "usa", "united states of america", "the united states"];

  it("bare address string with 'USA' is domestic", () => {
    expect(isLocationInCountry("North Mankato, MN, USA", "US", US)).toBe(true);
    expect(isLocationInCountry("Los Angeles, CA, USA", "US", US)).toBe(true);
  });
  it("a Mexican address is NOT domestic for a US user", () => {
    expect(isLocationInCountry("Tijuana, Baja California, Mexico", "US", US)).toBe(false);
  });
  it("does not false-match a California 'CA' abbreviation as Canada-ish", () => {
    // No 'ca' token in the US set, and 'usa'/'united states' don't hit 'CA'.
    expect(isLocationInCountry("San Diego, CA", "US", US)).toBe(false); // no country in string → unknown
  });
  it("structured country_code wins", () => {
    expect(isLocationInCountry({ country_code: "US", formatted: "somewhere" }, "US", US)).toBe(true);
    expect(isLocationInCountry({ country_code: "MX", formatted: "somewhere" }, "US", US)).toBe(false);
  });
  it("object with country name in a field is domestic", () => {
    expect(isLocationInCountry({ city: "Austin", country: "United States" }, "US", US)).toBe(true);
  });
  it("empty inputs → false", () => {
    expect(isLocationInCountry("", "US", US)).toBe(false);
    expect(isLocationInCountry("Austin, TX, USA", "", US)).toBe(false);
    expect(isLocationInCountry("Austin, TX, USA", "US", [])).toBe(false);
  });
});
