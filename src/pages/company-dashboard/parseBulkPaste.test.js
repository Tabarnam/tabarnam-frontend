import { describe, it, expect } from "vitest";
import { parseBulkPasteText } from "./parseBulkPaste";

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
