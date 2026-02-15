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

const PROMPT_GUIDANCE_VERSION = "1.1.0";

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
    rules: `- Conduct thorough research. Cross-reference multiple sources.
- Use web search (do not rely only on the company website).
- Check LinkedIn, SEC filings, Crunchbase, official press releases, business registrations, state corporation records.
- Do deep dives for HQ location if necessary.
- Having the actual city is crucial — do not return just the state or country if city-level data exists.
- Use initials for state or province (e.g., "Austin, TX" not "Austin, Texas").
- Format: "City, ST" for US/Canada, "City, Country" for international.
- If only country is known, return "Country".
- No explanatory info – just the location.
- No guessing or hallucinating. Only report verified information.`,
    jsonSchema: `"headquarters_location": "City, ST"`,
    jsonSchemaWithSources: `{
  "headquarters_location": "...",
  "location_source_urls": { "hq_source_urls": ["https://...", "https://..."] }
}`,
  },

  manufacturing: {
    rules: `- Conduct thorough research to identify ALL known manufacturing locations worldwide.
- Include every city and country found. Deep-dive on any US sites to confirm actual cities.
- Check press releases, job postings, facility announcements, regulatory filings, news articles, LinkedIn.
- List them exhaustively without missing any.
- Having the actual cities within the United States is crucial. Be accurate.
- Use initials for state or province (e.g., "Los Angeles, CA" not "Los Angeles, California").
- Format: "City, ST" for US/Canada, "City, Country" for international.
- Return an array of one or more locations. Include multiple cities when applicable.
- If only country-level is available, country-only entries are acceptable.
- No explanatory info – just locations.
- If manufacturing is not publicly disclosed after thorough searching, return ["Not disclosed"].
- Provide the supporting URLs you used for the manufacturing determination.
- No guessing or hallucinating. Only report verified information.`,
    jsonSchema: `"manufacturing_locations": ["City, ST", "City, Country"]`,
    jsonSchemaWithSources: `{
  "manufacturing_locations": ["City, ST", "City, Country"],
  "location_source_urls": { "mfg_source_urls": ["https://...", "https://..."] }
}`,
  },

  industries: {
    rules: `- Use web search.
- Return an array of industries/categories that best describe what the company makes or sells.
- Provide not industry codes but the type of business they do.
- Be thorough and complete in identifying all relevant industries.
- Avoid store navigation terms (e.g. "New Arrivals", "Shop", "Sale") and legal terms.
- Prefer industry labels that can be mapped to standard business taxonomies.
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
    rulesCompact: () => `Use web_search to find third-party reviews, then use browse_page on each candidate to verify it loads and is a real review. Return up to 5 verified reviews with source, author, URL, title, date, and excerpt. Only include reviews you successfully browsed. Quality over quantity.`,
    // Full investigation rules for dedicated review fetcher (uses web_search + browse_page chaining)
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
      return `Use web_search to find third-party reviews of ${companyRef}.
Then, for each candidate URL from the search results, use browse_page to confirm the page loads and contains a real review of ${companyName}.

For each verified review, extract:
- Source (publication or channel name)
- Author (name)
- URL (the exact URL you browsed — do not modify it)
- Title (exact title as published)
- Date (publication date, any format)
- Text (1-3 sentence excerpt or summary of the review)

Rules:
- Only return reviews you successfully browsed and confirmed
- Skip any URL that fails to load, is paywalled, or doesn't contain a review of ${companyName}
- Reviews must be about ${companyName} or its products (not just mentioning the company in passing)
- Prefer a mix of sources: YouTube videos, magazine articles, blog posts, news articles
- Do not return any URL from: ${excludeStr}
- Return up to 5 verified reviews. If only 3 exist, return 3 — quality over quantity
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
  locations: `Do deep dives for hq and manufacturing locations if necessary. Including city or cities. Having the actual cities within the United States is crucial. No explanatory info - just locations. Use initials for state or province in location info.`,
  industries: `Return as a JSON array of industry strings.`,
  keywords: `Keywords should be exhaustive, complete and all-inclusive list of all the products that the company produces.`,
};

module.exports = {
  PROMPT_GUIDANCE_VERSION,
  QUALITY_RULES,
  FIELD_SCHEMA,
  FIELD_GUIDANCE,
  FIELD_SUMMARIES,
};
