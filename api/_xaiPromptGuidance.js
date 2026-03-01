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

const PROMPT_GUIDANCE_VERSION = "3.5.0";

// ---------------------------------------------------------------------------
// QUALITY RULES — shared preamble for all XAI prompts
// ---------------------------------------------------------------------------
const QUALITY_RULES = `If you don't find credible info for a field, use "" (or [] / false).
No backticks. No extra keys.`;

// ---------------------------------------------------------------------------
// SEARCH PREAMBLE — prepended to prompts that require live web data.
// Per xAI guidance: explicitly instruct the model to use its tools.
// ---------------------------------------------------------------------------
const SEARCH_PREAMBLE = `Use web_search and browse_page tools explicitly to research this query. Do not rely on training data alone.
Confirm all info with working URLs and sources; do not hallucinate.
If data conflicts with the official company site, prioritize the browsed page content.`;

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
    rules: `Conduct thorough research using web_search and browse_page tools to identify the CURRENT official headquarters location. Companies relocate — you MUST return the active, current address, NOT a previous or registered address. Having the actual cities within the United States is crucial. Be accurate. No guessing or hallucinating.

STEP 1 — BROWSE THE COMPANY WEBSITE (mandatory, most authoritative source).
- ONLY use text that appears on the company's LIVE official website (contact page, about page, footer, shipping policy, privacy page).
- Use browse_page on the company URL. Prioritize: /contact, /contact-us, then /about, /about-us, /our-story.
- The CONTACT PAGE is the single most reliable source for the current address. Check it first.
- Also check: footer addresses, legal/privacy page addresses, ordering/shipping pages.
- Look for: physical addresses, "headquartered in..." statements, mailing addresses.
- If the website states a location, that is the PRIMARY source of truth for the CURRENT address.
- Re-browse the contact/about page one final time before answering to confirm the address is still live.

STEP 2 — WEB SEARCH FOR CROSS-REFERENCING (secondary to the live website).
- Run web_search: "[Company Name] headquarters location"
- Run web_search: "[Company Name] company profile site:linkedin.com OR site:crunchbase.com OR site:bloomberg.com"
- Use browse_page on the top 2-3 results to extract and verify the city.
- If the company may have been acquired, renamed, or operates as a subsidiary, also search: "[Company Name] parent company headquarters" or "[Previous Name] headquarters".

STEP 3 — VALIDATE AND RESOLVE CONFLICTS.
- Website + external source agree → report that location.
- Conflict → trust the company website over third-party data. Do NOT use LinkedIn, old GSA filings, directories, press releases, or any third-party site when they conflict with the live website.
- CRITICAL: LinkedIn, business directories, MapQuest, older press releases, and business registration databases FREQUENTLY show PREVIOUS or OUTDATED addresses. If the live company website (especially the contact page) shows a different address than these sources, the website address is the CURRENT one. Do NOT return the directory address.
- CRITICAL — NAME COLLISIONS: Many brand names are shared by unrelated companies in different countries (e.g., "Uplift Desk" in Austin TX vs "Suzhou Uplift Intelligent Technology" in China). Always verify that the entity you are reporting on matches the EXACT website domain provided. If a similarly-named foreign entity appears in search results, explicitly confirm it is NOT the company being researched before including any of its locations.
- Website has no location info → require at least 2 external sources that agree on the city. Prefer the most recently dated source.
- If only a US state is found, search "[Company Name] address [State]" or check the LinkedIn company page to pin down the city.
- When sources show different cities, look for dates — the most recently dated source with an address is more likely current. Companies relocate; older filings and directories may lag by years.

STEP 4 — HANDLE EDGE CASES. Do NOT give up easily.
- Small/private companies: search "[Company Name] [founder name] location" or "[Company Name] business registration [state]".
- Subsidiaries or rebrands: search the parent company name if the brand itself has no disclosed HQ.
- Try WHOIS or domain registration data: "[domain] WHOIS registrant" for last-resort city identification.
- Always verify with sources. Do NOT rely on training data — you MUST verify by actually visiting pages.

FORMAT RULES:
- Return ONLY the current, active headquarters address — never a previous or registered address.
- City-level precision is crucial — do not return just a state or country if city-level data exists.
- Use state/province abbreviations (e.g., "Austin, TX" not "Austin, Texas").
- Format: "City, ST, USA" for US; "City, ST, Canada" for Canada; "City, Country" for international.
- Always append the country. Use "USA" (not "United States" or "U.S.A.").
- If only country is known, return just the country (e.g., "USA").
- No explanatory text — just the location string.`,
    jsonSchema: `"headquarters_location": "City, ST, USA"`,
    jsonSchemaWithSources: `{
  "headquarters_location": "...",
  "location_source_urls": { "hq_source_urls": ["https://...", "https://..."] }
}`,
  },

  manufacturing: {
    rules: `Conduct thorough research using web_search and browse_page tools to identify ALL known CURRENT manufacturing locations worldwide. Include every city and country found, with a deep dive on any US sites to confirm actual cities. List them exhaustively without missing any. Be accurate. No guessing or hallucinating.

STEP 1 — BROWSE THE COMPANY WEBSITE (mandatory, most authoritative source).
- ONLY use text that appears on the company's LIVE official website. Do NOT attribute manufacturing locations from third-party sources unless the official website is silent.
- Use browse_page on the company URL. Also try /about, /about-us, /our-story, /faq, /sustainability, /contact, /shipping-policy.
- Look for: "manufactured in...", "produced at our facility in...", "Made in...", facility addresses, supply chain or sustainability pages.
- Check product pages and packaging images for "Made in [Country]" labels.
- If the website states manufacturing locations, that is the PRIMARY source of truth.

STEP 2 — WEB SEARCH TO FIND ALL FACILITIES (secondary to the live website).
- Run web_search: "[Company Name] manufacturing facilities locations"
- Run web_search: "[Company Name] factory OR plant OR production facility"
- For US companies, try: "[Company Name] manufacturing site:sec.gov OR site:fda.gov" (regulatory filings list facility addresses).
- Also try: "[Company Name] supply chain report" or "[Company Name] where is it made" for lesser-known sites.
- Search for contract/co-pack arrangements: "[Company Name] co-manufacturer OR co-packer OR contract manufacturer".
- Use browse_page on the top 2-3 results to extract and verify cities.

STEP 3 — VALIDATE AND RESOLVE CONFLICTS.
- Website + external source agree → report that location.
- Conflict → trust the company website over third-party data.
- CRITICAL — NAME COLLISIONS: Many brand names are shared by unrelated companies in different countries. For example, "Uplift Desk" (upliftdesk.com, Austin TX) is a completely different entity from "Suzhou Uplift Intelligent Technology Co., Ltd" (a Chinese manufacturer). Always verify that any manufacturing location you report belongs to the EXACT company at the given website domain — NOT a similarly-named foreign entity. If a similarly-named company appears in search results, explicitly confirm it is the same entity before including its locations.
- Never assume or import a manufacturing city unless the official website itself names it, or you have confirmed the source refers to the exact same entity at the given domain.
- Distinguish between OWNED facilities and CONTRACT manufacturers when evidence is available.
- Website has no manufacturing info → require at least 2 external sources that agree, AND confirm they reference the exact same company (same domain/parent company).
- For vague US locations (just a state), check SEC 10-K filings, LinkedIn, or Glassdoor job postings for exact city.
- If the company was acquired or rebranded, search the parent company's manufacturing footprint too.
- IMPORTANT: Verify locations are current — companies close or relocate facilities. Prefer the most recently dated sources.

STEP 4 — DEEPER INVESTIGATION BEFORE GIVING UP.
- Do NOT return an empty result after only one search. Try at least 3 different search queries.
- Check: "[Company Name] made in USA", "[Company Name] production location", "[Company Name] where are products made".
- Look for news articles about factory openings, expansions, or closures.
- For international companies, try "[Company Name] manufacturing [country]" for key markets.
- Check government buyer guides, B2B directories, and trade databases for facility listings.
- If ONLY country-level info exists (e.g., "Made in USA"), that is acceptable — include it.
- If the company only states "Made in USA" or "assembled in the USA" with no specific city or facility name, return "USA" — do NOT guess a city.
- If nothing is found after exhaustive searching, return an empty array [].

FORMAT RULES:
- List ALL known CURRENT manufacturing locations worldwide. Be exhaustive.
- City-level precision within the USA is crucial — but only when a specific city is actually disclosed on the official website or in a confirmed source for the exact same entity.
- Use state/province abbreviations (e.g., "Los Angeles, CA" not "Los Angeles, California").
- Format: "City, ST, USA" for US; "City, ST, Canada" for Canada; "City, Country" for international.
- Always append the country. Use "USA" (not "United States" or "U.S.A.").
- Return an array of locations. Include multiple entries when applicable.
- Country-only entries are acceptable when city-level data is unavailable (e.g., "China", "USA").
- No explanatory text — just location strings.
- Provide the supporting URLs you used for the manufacturing determination.`,
    jsonSchema: `"manufacturing_locations": ["City, ST, USA", "City, Country"]`,
    jsonSchemaWithSources: `{
  "manufacturing_locations": ["City, ST, USA", "City, Country"],
  "location_source_urls": { "mfg_source_urls": ["https://...", "https://..."] }
}`,
  },

  industries: {
    rules: `- Use web_search "[Company Name] industry" or "[Company Name] company profile" to find LinkedIn, Bloomberg, or industry directory classifications.
- Return an array of up to 3 specific, descriptive industry labels that describe what the company actually manufactures or sells (e.g., "Home Textiles Manufacturing", "Bedding Products", "Bath Linens").
- Do NOT return generic umbrella terms like "Consumer Goods", "Food and Beverage", "Retail", "E-Commerce".
- Maximum 3 industries. Pick the most specific and descriptive ones.
- No guessing or hallucinating. Only report verified information.`,
    jsonSchema: `"industries": ["Industry 1", "Industry 2", "..."]`,
  },

  keywords: {
    rules: `- STEP 1: Use browse_page on the company URL. Navigate to product, shop, or collections pages.
  Also try these URL paths: /shop, /collections/all, /products, /all-products, /our-products.
  Read ALL product names, product lines, flavors, varieties, and SKUs from every page.
  If the catalog is organized into categories, browse EACH category page to capture all items.
- STEP 2: Use web_search with at least 2 different queries:
  Run web_search: "[Company Name] full product list"
  Run web_search: "[Company Name] products catalog"
  Also try: "[Company Name] flavors" or "[Company Name] all varieties" for food/beverage companies.
  Use browse_page on retailer or distributor listings to find products not on the main site.
- STEP 3: If the company has named product lines (e.g., brand names, model names, series names), list EACH named product separately. Include both the product line name AND individual product variants.
  Example: "Vellux Original Blanket", "Vellux Plush Blanket", "Martex 225 Thread Count Sheet Set" — NOT just "blankets", "sheets".
- STEP 4: VERIFY COMPLETENESS. Compare your list against what you saw on the shop/products pages.
  If you found category pages with products you haven't listed, go back and add them.
  If your list has fewer than 15 items for a company with a full product catalog, you are likely missing products — search harder.
- Keywords should be exhaustive, complete and all-inclusive of all products the company produces.
- Return up to 30 of the company's most important products and product lines. Stop when you reach 30 or when you cannot find any more.
- If a customer could search for it and find this company's product, include it.
- Return ONLY actual products/product lines. Do NOT include:
  Navigation labels: Shop All, Collections, New, Best Sellers, Sale, Limited Edition, All
  Site features: Account, Cart, Store Locator, FAQ, Shipping, Returns, Contact, About, Blog
  Generic category labels unless they ARE an actual product line name
  Bundle/pack descriptors unless they are a named product (e.g. "Starter Kit" is OK if it's a real product name)
- The list must be materially more complete than what appears in the site's top navigation.
- If you are uncertain about completeness, expand your search. Check category pages, seasonal items, discontinued-but-listed products.
- Set "completeness" to "incomplete" if you know there are more products you couldn't extract. Set to "complete" only if you are confident the list covers the full catalog.
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
    rules: `Provide the company's tagline, slogan, or motto — the short phrase they use to describe their brand.
- Browse the company homepage and look for: hero section text, header/nav area near the logo, footer, meta description, og:description, and <title> tag.
- Also web_search "[Company Name] tagline" or "[Company Name] slogan" to cross-reference.
- Accept a tagline, slogan, motto, or brand promise — whichever appears most prominently on the company's website.
- Return the EXACT text as displayed on the website. Do not paraphrase or embellish.
- A sentence fragment is acceptable.
- Do NOT return: navigation menu labels, promotional sale text, legal disclaimers, or page titles that are just the company name.
- If no tagline/slogan/motto is found anywhere, return empty string.`,
    jsonSchema: `"tagline": "..."`,
  },

  reviews: {
    // Compact rules for unified prompts (enrichment) — accepts company name and URL for brand disambiguation
    rulesCompact: (companyName, websiteUrl) => {
      const nameRef = companyName || "this company";
      const urlRef = websiteUrl || "(see URL above)";
      return `Find 5 unique, legitimate third-party reviews of ${nameRef} using web_search.
CRITICAL — BRAND DISAMBIGUATION: Verify each review is actually about ${nameRef} at ${urlRef} — not a similarly-named company, different brand, or unrelated product. Do NOT include reviews of products by other companies that happen to share a word in the name.
PRIMARY SUBJECT: Each review must be primarily ABOUT ${nameRef}'s products. REJECT articles that merely mention the company in passing, as a partner/sponsor, or in a large roundup. A valid review = a reader would say "this article is ABOUT ${nameRef}."
For each candidate, use browse_page to confirm: (1) the URL loads, (2) it contains a substantive review or opinion, (3) it is about this company's products specifically, (4) the article's primary subject is ${nameRef}.
SOURCE PREFERENCE: Strongly prefer reviews from magazines, YouTube, blogs, and X (Twitter). Other sources (news sites, Facebook, forums) are acceptable only if preferred source coverage is unavailable.
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

PRIMARY SUBJECT RULE — CRITICAL:
The review must be primarily ABOUT ${companyName}'s products or brand.
REJECT reviews where:
- The company is merely mentioned in passing within a broader article
- The company appears as one item in a roundup of 10+ brands
- The company is referenced as a partner, sponsor, or collaboration in an article about ANOTHER entity (e.g., a restaurant article that mentions the company's soda as a drink option)
- The article's headline/title does not reference ${companyName} or its products
A valid review is one where a reader would say "this article is ABOUT ${companyName}."
Exception: "top 5"/"best of" lists where the company has a dedicated section with 2+ sentences of substantive commentary are acceptable.

SEARCH STRATEGY — run at least 3 separate searches, prioritizing magazines, YouTube, and blogs:
1. YouTube reviews: web_search "${companyName} review site:youtube.com" — product reviews, taste tests, unboxing, comparison videos
2. Magazine/blog reviews: web_search "${companyName} review" — look specifically for lifestyle blogs, food/drink magazines, industry magazines, and independent review blogs (e.g., tastingtable.com, thedailymeal.com, eater.com, bonappetit.com, wirecutter.com)
3. Product-specific: web_search "${companyName} [flagship product name] review" — target the company's main products by name for more precise results
4. If those yield fewer than 3: try "${companyName} honest review", "${companyName} [product] comparison", or "${companyName} worth it"
5. Website testimonial: Also browse ${websiteUrl || "the company website"} and look for an About page, Testimonials page, or customer quotes. If found, include exactly ONE entry using Source: "${companyName} Website" — this signals it is a company-sourced testimonial, not a third-party review. Include this alongside any third-party reviews found above.

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

SOURCE PREFERENCE: Strongly prefer magazines, YouTube, blogs, and X (Twitter) as review sources. Aim for 2-3 YouTube videos from different creators plus 2-3 written articles from magazines, blogs, or X threads. Other sources (news sites, Facebook, forums) are acceptable ONLY as fallbacks when preferred source coverage is insufficient. Do not include the same author more than once.
${excludeStr ? `Do NOT return any URL from: ${excludeStr}` : ""}
Return up to 5 verified reviews. Quality over quantity — 3 strong reviews beat 5 weak ones.
Always include one website testimonial (strategy 5) in addition to any third-party reviews found.
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

  logo: {
    rules: `STEP 1 — BROWSE THE COMPANY WEBSITE (mandatory first step).
- Use browse_page on the company URL. Inspect the page source for logo images:
  - Look for <img> tags with alt text containing "logo" or class/id like "logo", "header-logo", "brand-logo", "site-logo", or "wordmark".
  - Look for <img> tags inside <header>, <nav>, or the first <a> element that links to "/" or the homepage.
  - Check <link rel="icon" type="image/png"> or <link rel="apple-touch-icon"> for high-res icon URLs (NOT favicon.ico — only 180x180+ icons).
  - Check <meta property="og:image"> for a social sharing image that may be the logo.
  - If the logo appears to be lazy-loaded (data-src, data-lazy, loading="lazy"), extract the data-src or original source URL.
- If you find an image URL in the header area, that is the PRIMARY logo source.

STEP 2 — CHECK ADDITIONAL PAGES.
- Browse /about, /about-us, /press, /press-kit, /brand, /media for press kit or brand asset downloads.
- Some companies provide high-resolution logo files on their press/media pages — prefer these when available.
- Try web_search: "[Company Name] logo download" or "[Company Name] press kit" for official brand asset pages.

STEP 3 — WEB SEARCH AS FALLBACK.
- Run web_search: "[Company Name] logo PNG" or "[Company Name] logo SVG".
- Run web_search: "[Company Name] site:linkedin.com" — the company's LinkedIn page often has a square logo image.
- Use browse_page on results to find direct image URLs.

STEP 4 — SOCIAL MEDIA PROFILE IMAGES (last resort).
- If nothing above works, try the company's Twitter/X profile or Facebook page for profile images.

STEP 5 — VERIFY THE URL BEFORE RETURNING (critical).
- Use browse_page on the candidate logo URL to confirm it loads (is not a 404 or error page).
- If view_image is available, use it to confirm the image is an actual company logo (matches brand name/colors, not a hero banner or product image).
- If the URL returns an error, go back to Step 1-4 and try a different candidate.
- Do NOT return a URL you have not verified. Dead URLs waste processing time.

FORMAT RULES:
- Return the direct URL to the logo image file (PNG, SVG, JPG, WebP).
- Do NOT return favicon.ico or generic 16x16 favicons.
- Do NOT return product images, hero banners, or promotional graphics.
- If the logo is an inline SVG with no separate image URL, return null for logo_url.
- If multiple logo variants exist, prefer the main/primary version displayed in the header.
- The URL must point directly to an image file, not an HTML page.`,
    jsonSchema: `"logo_url": "https://..." | null`,
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
// DEPRECATED: CONDENSED FIELD SUMMARIES — no longer used by the two-call
// enrichment pipeline (v3.0).  The new fetchStructuredFields() uses
// FIELD_GUIDANCE.*.rules directly for higher quality results.
// Kept for backward compatibility with legacy callers.
// ---------------------------------------------------------------------------
const FIELD_SUMMARIES = {
  locations: `MANDATORY PROCESS — follow these steps in order:
1. Use browse_page on the company URL above. Read About, Contact, Footer, Our Story, facility pages. Extract any HQ address or manufacturing location statements. The company website is the PRIMARY authority — trust what it says over all other sources.
2. Use web_search to cross-reference: "[Company] headquarters location site:linkedin.com OR site:crunchbase.com" and "[Company] manufacturing facilities locations". Use browse_page on top results to verify cities.
3. If the website and an external source agree, report that city. If they conflict, trust the website. If the website has no location info, require 2+ external sources that agree.
4. Do NOT rely on your training data or general knowledge — you MUST verify by actually visiting pages. No hallucinations.
Having the actual cities within the USA is crucial. Use initials for state or province. Use "USA" not "United States". No explanatory info — just locations. Also return "location_source_urls" with the URLs you actually visited to determine each location.`,
  industries: `Use web_search for industry classifications. Return a JSON array of up to 3 specific, descriptive industry strings (e.g., "Home Textiles Manufacturing", "Bedding Products"). Avoid generic umbrella terms like "Consumer Goods" or "Food and Beverage". Maximum 3 industries.`,
  keywords: `Use browse_page on the company URL to find all products. Keywords must be exhaustive — include every named product, product line, variant, and SKU. Use specific product names (e.g., "Vellux Original Blanket") not generic categories (e.g., "blankets"). Use web_search "[Company] products" for completeness.`,
};

module.exports = {
  PROMPT_GUIDANCE_VERSION,
  QUALITY_RULES,
  SEARCH_PREAMBLE,
  FIELD_SCHEMA,
  FIELD_GUIDANCE,
  FIELD_SUMMARIES,
};
