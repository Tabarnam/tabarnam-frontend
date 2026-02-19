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

const PROMPT_GUIDANCE_VERSION = "2.0.0";

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
    rules: `STEP 1 — BROWSE THE COMPANY WEBSITE. This is mandatory and the most authoritative source.
- Use browse_page on the company URL. Read the About page, Contact page, Footer, and any legal/privacy pages.
- Extract any physical address, city name, or "headquartered in..." statement.
- If the website states a location, that is the PRIMARY source of truth.

STEP 2 — USE WEB SEARCH FOR CROSS-REFERENCING.
- Run web_search: "[Company Name] headquarters location site:linkedin.com OR site:crunchbase.com OR site:bloomberg.com"
- Also try: "[Company Name] headquarters address" for broader results.
- Use browse_page on the most promising results to extract and verify the city.

STEP 3 — VALIDATE AND RESOLVE CONFLICTS.
- If the company website and an external source agree, report that location.
- If they conflict, trust the company website over third-party data.
- If the website has no location info, require at least 2 external sources that agree on the city.
- For vague US locations (e.g., just a state), browse LinkedIn company profile or state business registrations to confirm the actual city.

STEP 4 — HANDLE EDGE CASES.
- Small companies with limited info: search "[Company Name] founder interview location" or check social media.
- Always verify with sources. No hallucinations. Do NOT rely on training data — you MUST verify by actually visiting pages.

FORMAT RULES:
- Having the actual city is crucial — do not return just the state or country if city-level data exists.
- Use initials for state or province (e.g., "Austin, TX" not "Austin, Texas").
- Format: "City, ST, USA" for US, "City, ST, Canada" for Canada, "City, Country" for international.
- Always append the country. Use "USA" (not "United States" or "U.S.A.").
- If only country is known, return "Country" (e.g., "USA").
- No explanatory info – just the location.`,
    jsonSchema: `"headquarters_location": "City, ST, USA"`,
    jsonSchemaWithSources: `{
  "headquarters_location": "...",
  "location_source_urls": { "hq_source_urls": ["https://...", "https://..."] }
}`,
  },

  manufacturing: {
    rules: `STEP 1 — BROWSE THE COMPANY WEBSITE. This is mandatory and the most authoritative source.
- Use browse_page on the company URL. Read the About page, Our Story, FAQ, product pages, and any facility or "Made in..." pages.
- Extract any manufacturing addresses, "manufactured in...", "produced at our facility in...", or similar statements.
- If the website states a manufacturing location, that is the PRIMARY source of truth.

STEP 2 — USE WEB SEARCH TO FIND ALL FACILITIES.
- Run web_search: "[Company Name] manufacturing facilities locations OR factories"
- Also try: "[Company Name] supply chain report" or "[Company Name] factory tour" to uncover lesser-known sites.
- For US companies, try: "[Company Name] manufacturing site:sec.gov OR site:fda.gov" (regulatory filings often list facility addresses).
- Use browse_page on the most promising results to extract and verify cities.

STEP 3 — VALIDATE AND RESOLVE CONFLICTS.
- If the company website and an external source agree, report that location.
- If they conflict, trust the company website over third-party data.
- If the website has no manufacturing info, require at least 2 external sources that agree on the city.
- For vague US locations (e.g., just a state), browse LinkedIn, Glassdoor, or SEC 10-K filings for exact addresses.
- Search for "[Company Name] co-manufacturing locations" to capture contract/partner facilities.

STEP 4 — HANDLE EDGE CASES.
- Small companies: search "[Company Name] where is it made" or check product labels shown on the website.
- Always verify with sources. No hallucinations. Do NOT rely on training data — you MUST verify by actually visiting pages.

FORMAT RULES:
- Identify ALL known manufacturing locations worldwide. List them exhaustively.
- Having the actual cities within the USA is crucial. Be accurate.
- Use initials for state or province (e.g., "Los Angeles, CA" not "Los Angeles, California").
- Format: "City, ST, USA" for US, "City, ST, Canada" for Canada, "City, Country" for international.
- Always append the country. Use "USA" (not "United States" or "U.S.A.").
- Return an array of one or more locations. Include multiple cities when applicable.
- If only country-level is available, country-only entries are acceptable (e.g., "USA").
- No explanatory info – just locations.
- If manufacturing is not publicly disclosed after thorough searching, return ["Not disclosed"].
- Provide the supporting URLs you used for the manufacturing determination.`,
    jsonSchema: `"manufacturing_locations": ["City, ST, USA", "City, Country"]`,
    jsonSchemaWithSources: `{
  "manufacturing_locations": ["City, ST, USA", "City, Country"],
  "location_source_urls": { "mfg_source_urls": ["https://...", "https://..."] }
}`,
  },

  industries: {
    rules: `- STEP 1: Use browse_page on the company URL. Read the homepage, About page, and product pages to understand what the company makes or sells.
- STEP 2: Use web_search "[Company Name] industry" or "[Company Name] company profile" to find LinkedIn, Bloomberg, or industry directory classifications.
- Return an array of specific, descriptive industry labels that describe what the company actually manufactures or sells (e.g., "Home Textiles Manufacturing", "Bedding Products", "Bath Linens").
- Do NOT return generic umbrella terms like "Consumer Goods", "Food and Beverage", "Retail", "E-Commerce".
- Each label should be specific enough to distinguish this company from unrelated companies.
- Provide the type of business, not industry codes.
- Be thorough — include all relevant industry verticals.
- Avoid store navigation terms ("New Arrivals", "Shop", "Sale") and legal terms.
- No guessing or hallucinating. Only report verified information.`,
    jsonSchema: `"industries": ["Industry 1", "Industry 2", "..."]`,
  },

  keywords: {
    rules: `- STEP 1: Use browse_page on the company URL. Navigate to product/shop/collections pages. Read ALL product names, product lines, flavors, varieties, and SKUs.
- STEP 2: Use web_search "[Company Name] products" or "[Company Name] product line" to find comprehensive product listings from retailers, distributors, or press releases.
- STEP 3: If the company has named product lines (e.g., brand names, model names, series names), list EACH named product separately. Include both the product line name AND individual product variants.
  Example: "Vellux Original Blanket", "Vellux Plush Blanket", "Martex 225 Thread Count Sheet Set" — NOT just "blankets", "sheets".
- Keywords should be exhaustive, complete and all-inclusive of all products the company produces.
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
    rules: `- STEP 1: Use browse_page on the company URL. Look for the tagline in: the homepage hero section, meta description, og:description, the header/nav area near the logo, and the footer.
- STEP 2: Use web_search "[Company Name] tagline" or "[Company Name] slogan" to cross-reference.
- If the website displays a tagline prominently (hero, header, footer), use that. If multiple taglines exist, prefer the one displayed most prominently on the homepage.
- A sentence fragment is acceptable.
- Do NOT return: navigation labels, promotional text, legal disclaimers, or page titles.
- Do NOT hallucinate or embellish. Accuracy is paramount.
- If no tagline is found, return empty string.`,
    jsonSchema: `"tagline": "..."`,
  },

  reviews: {
    // Compact rules for unified prompts (enrichment) — accepts company name and URL for brand disambiguation
    rulesCompact: (companyName, websiteUrl) => {
      const nameRef = companyName || "this company";
      const urlRef = websiteUrl || "(see URL above)";
      return `Find 5 unique, legitimate third-party reviews of ${nameRef} using web_search.
CRITICAL — BRAND DISAMBIGUATION: Verify each review is actually about ${nameRef} at ${urlRef} — not a similarly-named company, different brand, or unrelated product. Do NOT include reviews of products by other companies that happen to share a word in the name.
For each candidate, use browse_page to confirm: (1) the URL loads, (2) it contains a substantive review or opinion, (3) it is about this company's products specifically.
SENTIMENT: Prefer reviews that are positive, neutral, or constructively critical. Do NOT include reviews whose primary message is that the product is bad, disliked, or not recommended.
Return up to 5 verified reviews. Quality over quantity.`;
    },
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

CRITICAL — BRAND DISAMBIGUATION:
${companyName} must refer to the company at ${websiteUrl || "(see URL above)"}.
Before including ANY review, verify it discusses products sold on that website — not a similarly-named company, different division, or unrelated brand.
For example, if the company is "WestPoint Home" (home textiles), do NOT include reviews of "WestPoint" kitchen appliances (a different company).

SEARCH STRATEGY — run at least 3 separate searches to build a broad candidate pool:
1. Video reviews: web_search "${companyName} review site:youtube.com" — product reviews, unboxing, comparison videos
2. Blog/magazine reviews: web_search "${companyName} review" — lifestyle blogs, magazines, review sites (tastingtable.com, thedailymeal.com, etc.)
3. Product-specific: web_search "${companyName} [flagship product name] review" — target the company's main products by name for more precise results
4. If those yield fewer than 3: try "${companyName} honest review", "${companyName} [product] comparison", or "${companyName} worth it"

VERIFICATION — for EACH candidate URL, use browse_page to confirm:
- The page loads without errors (no 404, "page not found", paywall)
- Contains a substantive review, taste test, or opinion about ${companyName}'s products
- The reviewer is NOT affiliated with ${companyName}
- The review is about THIS specific company's products (match against ${websiteUrl || "the company website"})

REJECT:
- Error pages, brand-not-found notices, paywall, empty brand pages
- Generic product listings without review content
- Reviews of a DIFFERENT company with a similar name
- Reviews that are predominantly negative or dismissive — prefer positive, neutral, or constructively critical coverage

REVIEW SENTIMENT PREFERENCE:
Our platform presents these reviews to help consumers discover products. Prefer reviews that highlight product quality, features, or value. Constructive criticism is fine. Do NOT include reviews whose primary message is that the product is bad, disliked, or not recommended — unless that is the ONLY coverage available.

SOURCE MIX: Aim for a mix — ideally 2-3 YouTube videos from different creators plus 2-3 written articles from blogs or magazines. Do not include the same author more than once.
${excludeStr ? `Do NOT return any URL from: ${excludeStr}` : ""}
Return up to 5 verified reviews. Quality over quantity — 3 strong reviews beat 5 weak ones.
If you cannot find ANY legitimate third-party reviews after trying multiple search strategies, return an empty reviews array.
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
  locations: `MANDATORY PROCESS — follow these steps in order:
1. Use browse_page on the company URL above. Read About, Contact, Footer, Our Story, facility pages. Extract any HQ address or manufacturing location statements. The company website is the PRIMARY authority — trust what it says over all other sources.
2. Use web_search to cross-reference: "[Company] headquarters location site:linkedin.com OR site:crunchbase.com" and "[Company] manufacturing facilities locations". Use browse_page on top results to verify cities.
3. If the website and an external source agree, report that city. If they conflict, trust the website. If the website has no location info, require 2+ external sources that agree.
4. Do NOT rely on your training data or general knowledge — you MUST verify by actually visiting pages. No hallucinations.
Having the actual cities within the USA is crucial. Use initials for state or province. Use "USA" not "United States". No explanatory info — just locations. Also return "location_source_urls" with the URLs you actually visited to determine each location.`,
  industries: `Use browse_page on the company URL to understand their business, then web_search for industry classifications. Return as a JSON array of specific, descriptive industry strings (e.g., "Home Textiles Manufacturing", "Bedding Products"). Avoid generic umbrella terms like "Consumer Goods" or "Food and Beverage". Each label should describe what the company actually manufactures or sells.`,
  keywords: `Use browse_page on the company URL to find all products. Keywords must be exhaustive — include every named product, product line, variant, and SKU. Use specific product names (e.g., "Vellux Original Blanket") not generic categories (e.g., "blankets"). Use web_search "[Company] products" for completeness.`,
};

module.exports = {
  PROMPT_GUIDANCE_VERSION,
  QUALITY_RULES,
  FIELD_SCHEMA,
  FIELD_GUIDANCE,
  FIELD_SUMMARIES,
};
