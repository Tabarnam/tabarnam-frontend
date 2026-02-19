// _xaiPromptGuidance.js
// Shared XAI prompt guidance — single source of truth for field schemas,
// quality rules, and per-field instructions used by both company import
// (tabarnam-functions/xai/index.js) and admin refresh search (_grokEnrichment.js).
//
// The import prompt is the canonical origin for field names, JSON shape,
// and quality rules. Per-field guidance blocks elaborate on how each field
// should be researched and formatted.
//
// Bump PROMPT_GUIDANCE_VERSION when making changes, then run sync-shared.ps1
// to copy this file to the functions repo.

"use strict";

const PROMPT_GUIDANCE_VERSION = "1.4.0";

// ---------------------------------------------------------------------------
// QUALITY RULES — shared preamble for all XAI prompts
// ---------------------------------------------------------------------------
const QUALITY_RULES = `If you don't find credible info for a field, use "" (or [] / false).
No backticks. No extra keys.`;

// ---------------------------------------------------------------------------
// FIELD SCHEMA — canonical field list from the import prompt.
// Each entry describes the JSON key, its type hint, and example shape.
// ---------------------------------------------------------------------------
const FIELD_SCHEMA = `company_name, industries[], product_keywords (string), url (https://...), email_address, headquarters_location, manufacturing_locations[], amazon_url, red_flag (boolean), reviews[] (objects with { "text": "...", "link": "https://..." }), notes, company_contact_info { "contact_page_url": "https://...", "contact_email": "name@example.com" }`;

// ---------------------------------------------------------------------------
// FIELD GUIDANCE — per-field rules for research depth and formatting.
// Used by the unified enrichment prompt and per-field fallback fetchers.
// ---------------------------------------------------------------------------
const FIELD_GUIDANCE = {
  headquarters: {
    rules: `- START by browsing the company website — check About, Contact, Footer, and legal pages for self-reported HQ address or city.
- Then cross-reference with at least 2 external sources: LinkedIn, SEC filings, Crunchbase, official press releases, business registrations, state corporation records.
- Do NOT return a location unless at least 2 sources agree on the city.
- Do deep dives for HQ location if necessary.
- Having the actual city is crucial — do not return just the state or country if city-level data exists.
- Use initials for state or province (e.g., "Austin, TX" not "Austin, Texas").
- Format: "City, ST, USA" for US, "City, ST, Canada" for Canada, "City, Country" for international.
- Always append the country. Use "USA" (not "United States" or "U.S.A.").
- If only country is known, return "Country" (e.g., "USA").
- No explanatory info – just the location.
- No guessing or hallucinating. Only report verified information.`,
    jsonSchema: `"headquarters_location": "City, ST, USA"`,
    jsonSchemaWithSources: `{
  "headquarters_location": "...",
  "location_source_urls": { "hq_source_urls": ["https://...", "https://..."] }
}`,
  },

  manufacturing: {
    rules: `- START by browsing the company website — check About, Our Story, FAQ, and product pages for any mention of where products are made.
- Then cross-reference with external sources: press releases, job postings, facility announcements, regulatory filings, news articles, LinkedIn.
- Conduct thorough research to identify ALL known manufacturing locations worldwide.
- Include every city and country found. Deep-dive on any US sites to confirm actual cities.
- List them exhaustively without missing any.
- Do NOT report a location unless you can corroborate it with at least 2 sources.
- Having the actual cities within the USA is crucial. Be accurate.
- Use initials for state or province (e.g., "Los Angeles, CA" not "Los Angeles, California").
- Format: "City, ST, USA" for US, "City, ST, Canada" for Canada, "City, Country" for international.
- Always append the country. Use "USA" (not "United States" or "U.S.A.").
- Return an array of one or more locations. Include multiple cities when applicable.
- If only country-level is available, country-only entries are acceptable (e.g., "USA").
- No explanatory info – just locations.
- If manufacturing is not publicly disclosed after thorough searching, return ["Not disclosed"].
- Provide the supporting URLs you used for the manufacturing determination.
- No guessing or hallucinating. Only report verified information.`,
    jsonSchema: `"manufacturing_locations": ["City, ST, USA", "City, Country"]`,
    jsonSchemaWithSources: `{
  "manufacturing_locations": ["City, ST, USA", "City, Country"],
  "location_source_urls": { "mfg_source_urls": ["https://...", "https://..."] }
}`,
  },

  industries: {
    rules: `- Use web search.
- Return an array of industries/categories that best describe what the company makes or sells.
- Return specific, descriptive industry labels that describe what the company actually makes or does
  (e.g., "Sparkling Water Production", "Non-Alcoholic Beverages", "Beverage Manufacturing").
- Do NOT return generic umbrella terms like "Consumer Goods", "Food and Beverage", "Retail", "E-Commerce".
- Each label should be specific enough to distinguish this company's business from unrelated companies.
- Provide not industry codes but the type of business they do.
- Be thorough and complete in identifying all relevant industries.
- Avoid store navigation terms (e.g. "New Arrivals", "Shop", "Sale") and legal terms.
- No guessing or hallucinating. Only report verified information.`,
    jsonSchema: `"industries": ["Industry 1", "Industry 2", "..."]`,
  },

  keywords: {
    rules: `- Browse the company website AND use web search. Check product pages, collections, "Shop" sections, "All Products" pages.
- List every individual product, product line, flavor, variety, and SKU you can find.
- For companies with product variants (flavors, sizes, formulations), list EACH variant separately.
- Keywords should be exhaustive, complete and all-inclusive list of all the products that the company produces.
- If a customer could search for it and find this company's product, include it.
- Return ONLY actual products/product lines. Do NOT include:
  Navigation labels: Shop All, Collections, New, Best Sellers, Sale, Limited Edition, All
  Site features: Account, Cart, Store Locator, FAQ, Shipping, Returns, Contact, About, Blog
  Generic category labels unless they ARE an actual product line name
  Bundle/pack descriptors unless they are a named product (e.g. "Starter Kit" is OK if it's a real product name)
- The list must be materially more complete than what appears in the site's top navigation.
- If you are uncertain about completeness, expand your search. Check category pages, seasonal items, discontinued-but-listed products.
- Do NOT return a short/partial list without marking it incomplete.
- No guessing or hallucinating. Only report verified product information.`,
    jsonSchema: `"product_keywords": "comma-separated string"`,
    jsonSchemaArray: `"product_keywords": ["Product 1", "Product 2", "..."]`,
    jsonSchemaWithCompleteness: `{
  "product_keywords": ["Product 1", "Product 2", "..."],
  "completeness": "complete" | "incomplete",
  "incomplete_reason": null | "..."
}`,
  },

  tagline: {
    rules: `- Use web search.
- Return the company's actual marketing tagline/slogan.
- A sentence fragment is acceptable.
- Do NOT return navigation labels, promotional text, or legal text.
- Do NOT hallucinate or embellish. Accuracy is paramount.
- If no tagline is found, return empty string.`,
    jsonSchema: `"tagline": "..."`,
  },

  reviews: {
    // Compact rules for unified prompts (enrichment)
    rulesCompact: () => `Find third-party reviews using web search. For each candidate, verify the URL loads and contains a real review before including it. Return up to 5 verified reviews with source, author, URL, exact title as published, date, and excerpt. Only include reviews you confirmed are live. Quality over quantity.`,
    // Full investigation rules for dedicated review fetcher (web_search includes page browsing)
    rulesFull: (companyName, excludeDomains, attemptedUrls, websiteUrl) => {
      const attemptedExclusion =
        Array.isArray(attemptedUrls) && attemptedUrls.length > 0
          ? `\nPREVIOUSLY TRIED URLs (all failed verification — do NOT return any of these):\n${attemptedUrls.map((u) => `- ${u}`).join("\n")}\nFind DIFFERENT sources instead.\n`
          : "";
      const excludeStr =
        Array.isArray(excludeDomains) && excludeDomains.length > 0
          ? excludeDomains.join(", ")
          : "";
      const companyRef = websiteUrl ? `${companyName} (${websiteUrl})` : companyName;
      return `Find 3-5 unique, legitimate third-party reviews of ${companyRef} using multiple search strategies.

SEARCH STRATEGY — run at least 2-3 separate searches to build a broad candidate pool:
1. Video reviews: search "${companyName} review site:youtube.com" — look for taste tests, product reviews, or comparison videos
2. Blog/magazine reviews: search "${companyName} review" — look for articles on food blogs, lifestyle magazines, or review sites (tastingtable.com, thedailymeal.com, etc.)
3. If those yield fewer than 3 total results, try broader queries: "${companyName} honest review", "${companyName} taste test", "${companyName} ranking", or "${companyName} vs" (comparison reviews)

VERIFICATION — for each candidate URL, visit the page and confirm:
- The page loads successfully without errors (no "page not found", "brand not found", "invalid", or error messages)
- The page contains an actual review, taste test, or substantive opinion about ${companyName} — not just a product listing, brand directory entry, or passing mention
- The reviewer is not affiliated with ${companyName}

REJECT any page that shows an error message, brand-not-found notice, paywall, empty brand page, or generic product listing without review content.

For each verified review, extract:
- Source (publication or channel name)
- Author (name)
- URL (the exact URL you visited — do not modify it)
- Title (exact title as published)
- Date (publication date, any format)
- Text (1-3 sentence excerpt or summary of the review)

SOURCE MIX: Aim for a mix — ideally 2-3 YouTube videos from different creators plus 2-3 written articles from blogs or magazines. Do not include the same author more than once.
${excludeStr ? `- Do not return any URL from: ${excludeStr}` : ""}
- Return up to 5 verified reviews. Quality over quantity — 3 strong reviews beat 5 weak ones.
- If you cannot find ANY legitimate third-party reviews after trying multiple search strategies, return an empty reviews array.
${attemptedExclusion}`;
    },
    // JSON shapes
    jsonSchemaSimple: `"reviews": [{ "text": "...", "link": "https://..." }]`,
    jsonSchemaRich: `"reviews": [
    {
      "source_name": "Channel or Publication Name",
      "author": "Author Name",
      "source_url": "https://...",
      "title": "Exact Title",
      "date": "YYYY-MM-DD or approximate",
      "excerpt": "Brief excerpt or summary"
    }
  ]`,
    // Plain-text output format for dedicated review fetcher
    plainTextFormat: `Output each review in the exact plain-text format below. Separate each review with one blank line. Do NOT use any markdown formatting (no bold, no headers, no asterisks, no bullet points).

Source: [Name of publication, channel, or website]
Author: [Author or channel name]
URL: [Direct URL to the review/article/video, not the site root]
Title: [Exact title as published]
Date: [Publication date, any format]
Text: [1-3 sentence excerpt or summary of the review]`,
  },

  contactInfo: {
    jsonSchema: `"company_contact_info": { "contact_page_url": "https://...", "contact_email": "name@example.com" }`,
  },

  redFlag: {
    jsonSchema: `"red_flag": false`,
  },

  notes: {
    jsonSchema: `"notes": "..."`,
  },
};

// ---------------------------------------------------------------------------
// CONDENSED FIELD SUMMARIES — short versions for the unified enrichment
// prompt where all fields are requested in a single call.  These are kept
// in sync with the full FIELD_GUIDANCE.*.rules above.
// ---------------------------------------------------------------------------
const FIELD_SUMMARIES = {
  locations: `START by browsing the company website (About, Contact, Footer, legal pages) for self-reported HQ and manufacturing locations. Then cross-reference with at least 2 external sources (LinkedIn, Crunchbase, SEC filings, business registrations, press releases). Do NOT report a location unless at least 2 sources agree on the city. Having the actual cities within the USA is crucial. No explanatory info — just locations. Use initials for state or province. Use "USA" not "United States". Also return "location_source_urls" with the URLs you used to verify each location.`,
  industries: `Return as a JSON array of specific, descriptive industry strings. Avoid generic umbrella terms like "Consumer Goods" or "Food and Beverage".`,
  keywords: `Keywords should be exhaustive, complete and all-inclusive list of all the products that the company produces.`,
};

module.exports = {
  PROMPT_GUIDANCE_VERSION,
  QUALITY_RULES,
  FIELD_SCHEMA,
  FIELD_GUIDANCE,
  FIELD_SUMMARIES,
};
