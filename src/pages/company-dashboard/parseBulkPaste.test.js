import { describe, it, expect } from "vitest";
import { parseBulkPasteText } from "./parseBulkPaste";

// Pinning tests — parseBulkPaste is under-tested and any silent regression on
// the existing labels would break the admin's daily workflow. These tests
// cover every label the parser is documented to recognize BEFORE we add any
// new labels to the regex, so downstream changes can be validated by
// diffing test results against a green baseline.
describe("parseBulkPasteText — existing label pinning", () => {
  it("first non-labeled non-empty line becomes company_name", () => {
    const { proposed, companyNameLine } = parseBulkPasteText(`Acme Widgets
Tagline: Widgets since 1901`);
    expect(companyNameLine).toBe("Acme Widgets");
    expect(proposed.company_name).toBe("Acme Widgets");
  });

  it("Tagline: label populates proposed.tagline", () => {
    const { proposed } = parseBulkPasteText(`Acme
Tagline: Widgets since 1901`);
    expect(proposed.tagline).toBe("Widgets since 1901");
  });

  it("Website: label populates proposed.website_url", () => {
    const { proposed } = parseBulkPasteText(`Acme
Website: https://acme.example.com/`);
    expect(proposed.website_url).toBe("https://acme.example.com/");
  });

  it("URL: top-level label populates proposed.website_url", () => {
    const { proposed } = parseBulkPasteText(`Acme
URL: https://acme.example.com/`);
    expect(proposed.website_url).toBe("https://acme.example.com/");
  });

  it("HQ: single entry populates proposed.headquarters_locations", () => {
    const { proposed } = parseBulkPasteText(`Acme
HQ: San Francisco, CA, USA`);
    expect(proposed.headquarters_locations).toHaveLength(1);
    expect(proposed.headquarters_locations[0].city).toBe("San Francisco");
    expect(proposed.headquarters_locations[0].region).toBe("CA");
    expect(proposed.headquarters_locations[0].country).toBe("USA");
  });

  it("HQ: semicolon-separated multi-entry becomes multiple locations", () => {
    const { proposed } = parseBulkPasteText(`Acme
HQ: San Francisco, CA, USA; London, UK`);
    expect(proposed.headquarters_locations).toHaveLength(2);
    expect(proposed.headquarters_locations[0].city).toBe("San Francisco");
    expect(proposed.headquarters_locations[1].city).toBe("London");
  });

  it("Headquarters: aliases to headquarters_locations", () => {
    const { proposed } = parseBulkPasteText(`Acme
Headquarters: San Francisco, CA, USA`);
    expect(proposed.headquarters_locations).toHaveLength(1);
  });

  it("Manufacturing: semicolon list populates proposed.manufacturing_locations", () => {
    const { proposed } = parseBulkPasteText(`Acme
Manufacturing: Charlotte, NC, USA; Portland, OR, USA`);
    expect(proposed.manufacturing_locations).toHaveLength(2);
    expect(proposed.manufacturing_locations[0].city).toBe("Charlotte");
    expect(proposed.manufacturing_locations[0].region).toBe("NC");
    expect(proposed.manufacturing_locations[0].country).toBe("USA");
    expect(proposed.manufacturing_locations[1].city).toBe("Portland");
    expect(proposed.manufacturing_locations[1].region).toBe("OR");
  });

  it("Industries: comma list populates proposed.industries", () => {
    const { proposed } = parseBulkPasteText(`Acme
Industries: Snack Foods, Beef Jerky, Dried Meats`);
    expect(proposed.industries).toEqual(["Snack Foods", "Beef Jerky", "Dried Meats"]);
  });

  it("Products: comma list populates proposed.keywords", () => {
    const { proposed } = parseBulkPasteText(`Acme
Products: original, teriyaki, peppered`);
    expect(proposed.keywords).toEqual(["original", "teriyaki", "peppered"]);
  });

  it("Keywords: is an alias for Products: (same target field)", () => {
    const { proposed } = parseBulkPasteText(`Acme
Keywords: original, teriyaki, peppered`);
    expect(proposed.keywords).toEqual(["original", "teriyaki", "peppered"]);
  });

  it("Review block with all YAML keys parses into curated_reviews", () => {
    const { proposed } = parseBulkPasteText(`Acme

Source: Snack Mag
Author: J. Reviewer
URL: https://snackmag.example.com/acme-review
Title: Acme Is Best
Date: 2026-01-15
Text: Crunchy and flavorful. Worth the price.`);
    expect(proposed.curated_reviews).toHaveLength(1);
    const r = proposed.curated_reviews[0];
    expect(r.source_name).toBe("Snack Mag");
    expect(r.author).toBe("J. Reviewer");
    expect(r.url).toBe("https://snackmag.example.com/acme-review");
    expect(r.title).toBe("Acme Is Best");
    expect(r.text).toBe("Crunchy and flavorful. Worth the price.");
  });

  it("returns warnings array with missing-field messages", () => {
    const { warnings } = parseBulkPasteText(`Acme
Tagline: Only a tagline`);
    // Warnings should note the missing common fields but NOT the tagline
    // (which was supplied). We assert on presence-of-strings, not exact
    // order or count, so a small copy tweak downstream doesn't trip this.
    expect(warnings).toContain("No website URL found");
    expect(warnings).toContain("No HQ location found");
    expect(warnings).toContain("No manufacturing locations found");
    expect(warnings).toContain("No industries found");
    expect(warnings).toContain("No keywords found");
    expect(warnings).toContain("No reviews found");
    expect(warnings).not.toContain("No tagline found");
  });

  it("absent labels do NOT appear on proposed", () => {
    const { proposed } = parseBulkPasteText(`Acme
Tagline: only-tagline`);
    expect(proposed.website_url).toBeUndefined();
    expect(proposed.headquarters_locations).toBeUndefined();
    expect(proposed.manufacturing_locations).toBeUndefined();
    expect(proposed.industries).toBeUndefined();
    expect(proposed.keywords).toBeUndefined();
    expect(proposed.curated_reviews).toBeUndefined();
    // addresses should also stay absent (pinning current behavior — will
    // change in the address-support pass below)
    expect(proposed.addresses).toBeUndefined();
  });

  it("empty input returns empty proposed + Empty input warning", () => {
    const { proposed, warnings } = parseBulkPasteText("");
    expect(proposed).toEqual({});
    expect(warnings).toContain("Empty input");
  });
});

describe("parseBulkPasteText — HQ address / Mfg address labels", () => {
  it("HQ address: one entry populates proposed.addresses with type=hq", () => {
    const { proposed } = parseBulkPasteText(`Show Sushi
HQ address: 957 West Arrow Highway, San Dimas, CA, 91773, USA`);
    expect(proposed.addresses).toHaveLength(1);
    const a = proposed.addresses[0];
    expect(a.street).toBe("957 West Arrow Highway");
    expect(a.locality).toBe("San Dimas");
    expect(a.region).toBe("CA");
    expect(a.postal_code).toBe("91773");
    expect(a.country).toBe("USA");
    expect(a.type).toBe("hq");
    expect(a.is_public).toBe(false);
    expect(a.source_url).toBe("");
    expect(typeof a.fetched_at).toBe("string");
    expect(a.fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("Mfg address: semicolon-separated entries populate with type=manufacturing", () => {
    const { proposed } = parseBulkPasteText(`Acme
Mfg address: 100 Industrial Way, Detroit, MI, 48201, USA; 200 Factory Rd, Guangzhou, Guangdong, 510000, China`);
    expect(proposed.addresses).toHaveLength(2);
    expect(proposed.addresses[0].type).toBe("manufacturing");
    expect(proposed.addresses[0].street).toBe("100 Industrial Way");
    expect(proposed.addresses[0].country).toBe("USA");
    expect(proposed.addresses[1].type).toBe("manufacturing");
    expect(proposed.addresses[1].street).toBe("200 Factory Rd");
    expect(proposed.addresses[1].country).toBe("China");
  });

  it("HQ address + Mfg address together merge into a single array with correct types", () => {
    const { proposed } = parseBulkPasteText(`Acme
HQ address: 1 Corporate Plaza, San Francisco, CA, 94105, USA
Mfg address: 100 Industrial Way, Detroit, MI, 48201, USA`);
    expect(proposed.addresses).toHaveLength(2);
    // hq entries come first (label parsing order)
    expect(proposed.addresses[0].type).toBe("hq");
    expect(proposed.addresses[0].street).toBe("1 Corporate Plaza");
    expect(proposed.addresses[1].type).toBe("manufacturing");
    expect(proposed.addresses[1].street).toBe("100 Industrial Way");
  });

  it("missing country defaults to 'US'", () => {
    const { proposed } = parseBulkPasteText(`Acme
HQ address: 1 Main St, Portland, OR, 97201`);
    expect(proposed.addresses).toHaveLength(1);
    expect(proposed.addresses[0].country).toBe("US");
  });

  it("entry with empty street is dropped", () => {
    const { proposed } = parseBulkPasteText(`Acme
HQ address: 1 Main St, Portland, OR, 97201, USA; , Chicago, IL, 60601, USA`);
    // Both entries have text on both sides of the ; but the second has an
    // empty street. Only the first survives.
    expect(proposed.addresses).toHaveLength(1);
    expect(proposed.addresses[0].locality).toBe("Portland");
  });

  it("alias 'HQ addresses' (plural) is treated as an alias of 'HQ address'", () => {
    const { proposed } = parseBulkPasteText(`Acme
HQ addresses: 1 Main St, Portland, OR, 97201, USA`);
    expect(proposed.addresses).toHaveLength(1);
    expect(proposed.addresses[0].type).toBe("hq");
  });

  it("alias 'HQ street #s' is treated as an alias of 'HQ address'", () => {
    const { proposed } = parseBulkPasteText(`Acme
HQ street #s: 1 Main St, Portland, OR, 97201, USA`);
    expect(proposed.addresses).toHaveLength(1);
    expect(proposed.addresses[0].type).toBe("hq");
  });

  it("alias 'Mfg street #s' is treated as an alias of 'Mfg address'", () => {
    const { proposed } = parseBulkPasteText(`Acme
Mfg street #s: 100 Industrial Way, Detroit, MI, 48201, USA`);
    expect(proposed.addresses).toHaveLength(1);
    expect(proposed.addresses[0].type).toBe("manufacturing");
  });

  it("bare 'Street #s:' without HQ/Mfg prefix is NOT matched (guard against ambiguity)", () => {
    const { proposed } = parseBulkPasteText(`Acme
Street #s: 1 Main St, Portland, OR, 97201, USA`);
    // Line falls through to the "subsequent unlabeled lines are ignored" branch.
    // No addresses field on the result.
    expect(proposed.addresses).toBeUndefined();
  });

  it("absent HQ/Mfg address labels → no addresses field on proposed", () => {
    const { proposed } = parseBulkPasteText(`Acme
Tagline: only-tagline`);
    expect(proposed.addresses).toBeUndefined();
  });

  it("empty value after label (e.g. 'HQ address:') does not emit an addresses field", () => {
    const { proposed } = parseBulkPasteText(`Acme
HQ address:
Tagline: x`);
    expect(proposed.addresses).toBeUndefined();
  });
});

describe("parseBulkPasteText — review URLs must not become website_url", () => {
  // Regression (C.H. Berres, 2026-08-14): a paste with no Website: line but an
  // inline "Reviews: Source: …" first review had that review's URL: line parsed
  // as the company website_url, which would clobber the real website on apply.
  const berres = `C.H. Berres
Tagline: Tradition paired with innovation is definitely tasteable!
Industries: Riesling, Mosel Riesling
HQ: Ürzig, RP, Germany
Manufacturing: Ürzig, RP, Germany
Products: Ürziger Würzgarten Riesling Kabinett, Riesling Secco
Reviews: Source: Wine Enthusiast
Author: Anna Lee C. Iijima
URL: https://www.wineenthusiast.com/buying-guide/ch-berres-2011/
Title: C.H. Berres 2011 Ürziger Goldwingert Riesling (Mosel)
Date: 2014
Text: Tropical mango and guava flavors cut by racy lime acidity.

Source: Wine Spectator
Author: Wine Spectator
URL: https://www.thesortingtable.com/wines/c-h-berres/x/reviews/pdf/
Title: Ürziger Würzgarten Riesling Trockenbeerenauslese Mosel – 2010
Date: March 2012
Text: A rich, buttery aroma leads to ripe apricot.`;

  it("does NOT propose a website_url when the paste has no Website line", () => {
    const { proposed } = parseBulkPasteText(berres);
    expect(proposed.website_url).toBeUndefined();
  });

  it("still parses both reviews, with their URLs and source names intact", () => {
    const { proposed } = parseBulkPasteText(berres);
    const reviews = proposed.curated_reviews || [];
    expect(reviews).toHaveLength(2);
    expect(reviews.map((r) => r.source_name)).toEqual(["Wine Enthusiast", "Wine Spectator"]);
    expect(reviews[0].url).toBe("https://www.wineenthusiast.com/buying-guide/ch-berres-2011/");
    expect(reviews[1].url).toBe("https://www.thesortingtable.com/wines/c-h-berres/x/reviews/pdf/");
  });

  it("still reads a real Website: line into website_url (control)", () => {
    const withSite = `C.H. Berres
Website: https://www.berres.de/
Tagline: Tradition paired with innovation.

Source: Wine Enthusiast
Author: A. Iijima
URL: https://www.wineenthusiast.com/buying-guide/ch-berres-2011/
Title: Review
Text: Lovely.`;
    const { proposed } = parseBulkPasteText(withSite);
    expect(proposed.website_url).toBe("https://www.berres.de/");
    expect((proposed.curated_reviews || [])[0]?.url).toBe(
      "https://www.wineenthusiast.com/buying-guide/ch-berres-2011/"
    );
  });
});
