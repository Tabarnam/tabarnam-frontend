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

const PROMPT_GUIDANCE_VERSION = "3.8.0";

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
    rules: `Identify the CURRENT official headquarters location. Companies relocate — return the active, current address, NOT a previous or registered address. Having the actual cities within the United States is crucial. Be accurate. No guessing or hallucinating.

STEP 1 — BROWSE THE COMPANY WEBSITE FIRST (mandatory, most authoritative source).
- Use browse_page on the company URL. Check the homepage, footer, contact page, and about page.
- Prioritize: /contact, /contact-us, then /about, /about-us, /our-story.
- For Shopify sites, also try /pages/ variants: /pages/contact, /pages/about, /pages/our-story.
- Look for: physical addresses in the footer or header, "headquartered in..." statements, contact page addresses, mailing addresses.
- If the website clearly states an address with a city (e.g., in the footer, banner, or contact page), that IS the headquarters. Accept it and move to formatting — no cross-referencing needed.

STEP 2 — WEB SEARCH (only if Step 1 found NO city-level address on the website).
- Run web_search: "[Company Name] headquarters location"
- Run web_search: "[Company Name] company profile site:linkedin.com OR site:crunchbase.com OR site:bloomberg.com"
- Use browse_page on the top 2-3 results to extract and verify the city.
- If the company may have been acquired, renamed, or operates as a subsidiary, also search: "[Company Name] parent company headquarters" or "[Previous Name] headquarters".

STEP 3 — VALIDATE AND RESOLVE CONFLICTS.
- Website states a location → that is the answer. No further cross-verification needed.
- CRITICAL — NAME COLLISIONS: Many brand names are shared by unrelated companies in different countries (e.g., "Uplift Desk" in Austin TX vs "Suzhou Uplift Intelligent Technology" in China). Always verify that the entity you are reporting on matches the EXACT website domain provided. If a similarly-named foreign entity appears in search results, explicitly confirm it is NOT the company being researched before including any of its locations.
- CRITICAL — PARENT COMPANY CONTAMINATION: If the company is a subsidiary or was acquired (e.g., Hekman Furniture under Howard Miller), report ONLY the address that belongs to the specific brand at the given website domain. Do NOT return the parent company's HQ address as the brand's HQ. The parent's address is NOT the brand's address unless the brand's own website confirms it.
- Website has no location info → search business directories for verified addresses:
  Run web_search: "[Company Name] address site:yelp.com OR site:yellowpages.com OR site:bbb.org"
  Require at least 2 independent external sources agreeing on the city. Prefer the most recently dated source.
- If only a US state is found, search "[Company Name] address [State]" or check the LinkedIn company page to pin down the city.
- When sources show different cities, look for dates — the most recently dated source with an address is more likely current. Companies relocate; older filings and directories may lag by years.
- SOURCE TRUST HIERARCHY (use when website has no location and sources conflict):
  1. Yelp, Yellow Pages, BBB verified business listings (actively maintained addresses)
  2. SEC/government filings dated within last 2 years
  3. Recent press releases or news articles (last 2 years)
  4. LinkedIn, Crunchbase, Bloomberg company profiles
  5. Business registration databases, WHOIS, older press releases
  Always go with the highest-ranked source when they conflict.

STEP 4 — HANDLE EDGE CASES (only if Steps 1-3 found nothing). Do NOT give up easily.
- Small/private companies: search "[Company Name] [founder name] location" or "[Company Name] business registration [state]".
- Subsidiaries or rebrands: search the parent company name if the brand itself has no disclosed HQ.
- Try WHOIS or domain registration data: "[domain] WHOIS registrant" for last-resort city identification.

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
    rules: `Identify ALL known CURRENT manufacturing locations worldwide. Include every city and country found. Be accurate. No guessing or hallucinating.

STEP 1 — BROWSE THE COMPANY WEBSITE FIRST (mandatory, most authoritative source).
- Use browse_page on the company URL. Check the homepage, footer, contact page, about page, FAQ, and shipping policy.
- Also try /about, /about-us, /our-story, /faq, /sustainability, /contact, /shipping-policy.
- For Shopify sites, also try /pages/ variants: /pages/about, /pages/our-story, /pages/faq, /pages/contact.
- Look for: "manufactured in...", "produced at our facility in...", "Made in...", "sourced and processed in...", facility addresses, supply chain or sustainability pages.
- Check product pages for descriptions that mention where the product is sourced, processed, cured, smoked, or packaged. For food companies, if raw materials are sourced AND processed at the same location, that location is a manufacturing site.
- If the website clearly states manufacturing locations with city-level detail, accept them and move to formatting. Only do additional web searches if the website is silent or only names a country.

EARLY EXIT — NOT A MANUFACTURER:
- If Step 1 reveals the company is a RETAILER, MARKETPLACE, or RESELLER that sells products from multiple OTHER brands/companies (not its own), STOP immediately and return an empty array [].
- Indicators: the website sells products from many different brand names, has no "Made by us" or "Our facility" language, describes itself as a retailer/distributor/marketplace, or is an e-commerce storefront aggregating third-party products.
- Do NOT spend time searching for manufacturing data for retailers — they do not manufacture. Return [] promptly.

STEP 2 — WEB SEARCH (only if Step 1 found NO city-level manufacturing info on the website).
- Run web_search: "[Company Name] manufacturing facilities locations"
- Run web_search: "[Company Name] factory OR plant OR production facility"
- For US companies, try: "[Company Name] manufacturing site:sec.gov OR site:fda.gov" (regulatory filings list facility addresses).
- Also try: "[Company Name] supply chain report" or "[Company Name] where is it made" for lesser-known sites.
- Search for contract/co-pack arrangements: "[Company Name] co-manufacturer OR co-packer OR contract manufacturer".
- Use browse_page on the top 2-3 results to extract and verify cities.

STEP 3 — VALIDATE AND RESOLVE CONFLICTS.
- Website states manufacturing locations → accept them. No further cross-verification needed.
- CRITICAL — NAME COLLISIONS: Many brand names are shared by unrelated companies in different countries. For example, "Uplift Desk" (upliftdesk.com, Austin TX) is a completely different entity from "Suzhou Uplift Intelligent Technology Co., Ltd" (a Chinese manufacturer). Always verify that any manufacturing location you report belongs to the EXACT company at the given website domain — NOT a similarly-named foreign entity. If a similarly-named company appears in search results, explicitly confirm it is the same entity before including its locations.
- CRITICAL — PARENT COMPANY CONTAMINATION: If the company is a subsidiary or was acquired (e.g., Hekman Furniture under Howard Miller), report ONLY manufacturing locations that belong to the specific brand being researched. Do NOT include the parent company's factories, other subsidiaries' plants, or the parent's HQ as a manufacturing site. Only include a parent's facility if the brand's own website confirms that specific facility produces the brand's products.
- CRITICAL — SHOWROOMS ARE NOT FACTORIES: Trade show locations (e.g., High Point Market NC, Las Vegas Market NV), showrooms, design centers, and sales offices are NOT manufacturing facilities. Do NOT include them as manufacturing locations.
- Never assume or import a manufacturing city unless the official website itself names it, or you have confirmed the source refers to the exact same entity at the given domain.
- Website has no manufacturing info → search business directories for verified addresses:
  Run web_search: "[Company Name] address site:yelp.com OR site:yellowpages.com OR site:bbb.org"
  Require at least 2 independent external sources agreeing, AND confirm they reference the exact same company (same domain/parent company).
- For vague US locations (just a state), check SEC 10-K filings, LinkedIn, or Glassdoor job postings for exact city.
- IMPORTANT: Verify locations are current — companies close or relocate facilities. Prefer the most recently dated sources.
- SOURCE TRUST HIERARCHY (use when website has no manufacturing info and sources conflict):
  1. Yelp, Yellow Pages, BBB verified business listings (actively maintained addresses)
  2. SEC 10-K filings, FDA facility registrations dated within last 2 years
  3. Recent news articles about factory openings/closings (last 2 years)
  4. Trade directories, B2B databases, LinkedIn facility listings
  5. Older filings, press releases, and business registrations
  A location found ONLY in lower-ranked sources should be included only if the source is recent and specifically names this company.

STEP 4 — DEEPER INVESTIGATION (only if Steps 1-3 found nothing). Do NOT give up easily.
- Try at least 3 different search queries before returning empty.
- Check: "[Company Name] made in USA", "[Company Name] production location", "[Company Name] where are products made".
- Look for news articles about factory openings, expansions, or closures.
- For international companies, try "[Company Name] manufacturing [country]" for key markets.
- If ONLY country-level info exists (e.g., "Made in USA"), that is acceptable — include it.
- If the company only states "Made in USA" or "assembled in the USA" with no specific city or facility name, return "USA" — do NOT guess a city.
- If nothing is found after exhaustive searching, return an empty array [].

FORMAT RULES:
- List ALL known CURRENT manufacturing locations worldwide. Be exhaustive.
- City-level precision is crucial for ALL locations worldwide — not just the USA. Always include the city and region/province when disclosed in any source (official website, SEC filings, news articles, or trade directories).
- Use state/province abbreviations (e.g., "Los Angeles, CA" not "Los Angeles, California").
- Format: "City, ST, USA" for US; "City, ST, Canada" for Canada; "City, Country" for international.
- Always append the country. Use "USA" (not "United States" or "U.S.A.").
- Return an array of locations. Include multiple entries when applicable.
- Country-only entries are a LAST RESORT — acceptable ONLY after browsing the company website AND running at least 3 web searches that all fail to reveal a specific city. If any source names a city, you MUST include it (e.g., "Quito, Ecuador" not just "Ecuador").
- No explanatory text — just location strings.
- Provide the supporting URLs you used for the manufacturing determination.`,
    jsonSchema: `"manufacturing_locations": ["City, ST, USA", "City, Country"]`,
    jsonSchemaWithSources: `{
  "manufacturing_locations": ["City, ST, USA", "City, Country"],
  "mfg_status": "ok | not_applicable",
  "location_source_urls": { "mfg_source_urls": ["https://...", "https://..."] }
}
mfg_status: use "ok" when manufacturing locations were found, "not_applicable" when the company is a retailer/marketplace/reseller (not a manufacturer). Omit or use "ok" by default.`,
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
- STEP 3: EXPAND collection names into individual products — but ONLY if the product pages show collection headers without listing individual items.
  If the product pages already list individual products by name (e.g., "Original Beef Jerky", "Teriyaki Beef Jerky"), those ARE your keywords — no further expansion needed.
  Only expand when the site shows generic collection names (e.g., "Classic Towels") without individual product listings underneath. In that case, combine the collection name with each product type (e.g., "Classic Bath Towel", "Classic Hand Towel").
- STEP 4: VERIFY COMPLETENESS. Compare your list against what you saw on the shop/products pages.
  If you found category pages with products you haven't listed, go back and add them.
  If the product pages look complete (no pagination, no "load more" buttons, no unexplored categories), accept your list as complete — even if it is short.
  Only expand product lines into variants (STEP 3) or search harder if there is clear evidence of missing products.
- Keywords should be exhaustive, complete and all-inclusive of all products the company produces.
- Return up to 100 of the company's most important products and product lines. Stop when you reach 100 or when you cannot find any more.
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

STEP 1 — Look for an explicit tagline, slogan, or motto:
- Browse the company homepage and look for: hero section text, header/nav area near the logo, footer, meta description, og:description, and <title> tag.
- Also web_search "[Company Name] tagline" or "[Company Name] slogan" to cross-reference.
- Accept a tagline, slogan, motto, or brand promise — whichever appears most prominently on the company's website.

STEP 2 — If STEP 1 found nothing, look for a brand description:
- Check the company's About page, mission statement, or "Our Story" page for a short brand description (1 sentence max).
- Check social media bios (Instagram, X/Twitter, LinkedIn, Facebook) for a concise brand descriptor.
- web_search "[Company Name] brand description" or "[Company Name] about".
- Extract the most concise, brand-defining phrase (under 15 words preferred). Trim to the essential message.

RULES:
- Return the EXACT text as displayed on the source (STEP 1) or a faithful condensation (STEP 2).
- A sentence fragment is acceptable.
- Do NOT return: navigation menu labels, promotional sale text, legal disclaimers, or page titles that are just the company name.
- Do NOT return generic phrases like "Quality products" or "Welcome to our website."
- If neither step yields a result, return empty string.`,
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
    rulesFull: (companyName, excludeDomains, attemptedUrls, websiteUrl, opts = {}) => {
      const attemptedExclusion =
        Array.isArray(attemptedUrls) && attemptedUrls.length > 0
          ? `\nPREVIOUSLY TRIED URLs (all failed verification — do NOT return any of these):\n${attemptedUrls.map((u) => `- ${u}`).join("\n")}\nFind DIFFERENT sources instead.\n`
          : "";
      const excludeStr =
        Array.isArray(excludeDomains) && excludeDomains.length > 0
          ? excludeDomains.join(", ")
          : "";
      const companyRef = websiteUrl ? `${companyName} (${websiteUrl})` : companyName;

      // ── Fallback prompt: extract a "review" from the company's own website ──
      if (opts.browseAboutPage) {
        return `The standard review search for ${companyRef} did not find enough results.
Create ONE review entry from the company's own website content.

STEP 1 — Browse the HOMEPAGE at ${websiteUrl} FIRST.
Many company homepages feature press mentions, magazine logos, award badges, customer testimonials, or review quotes directly on the landing page. Look for:
- Press logos or "As seen in..." sections (e.g., Forbes, Men's Health, Food Magazine)
- Customer testimonial sections with quotes
- Award or competition mentions
- "Featured in..." or "Press" sections
If you find any of these on the homepage, use that content for your review entry.

STEP 2 — Only if the homepage has NO review/press content, try these pages:
- ${websiteUrl}/testimonials, /about, /our-story, /faq
- ${websiteUrl}/pages/testimonials, /pages/about, /pages/our-story, /pages/faq
- Check the site's navigation menu and footer for links to testimonials, about, or press pages.

From the FIRST page with usable content, create ONE review entry:
- source_name: "Website - [page type]" (e.g., "Website - Home", "Website - Testimonials", "Website - About")
- excerpt: A press mention, customer testimonial, or the company's story/mission. Minimum 30 characters.
- source_url: The actual page URL you visited
- author: The customer name (for testimonials), publication name (for press mentions), or "${companyName}" (for about/mission content)

Return exactly 1 review.
${attemptedExclusion}`;
      }

      // ── Standard first-attempt prompt ──
      return `Find 2 unique, legitimate third-party reviews of ${companyRef}.

BRAND DISAMBIGUATION:
${companyName} must refer to the company at ${websiteUrl || "(see URL above)"}. Before including ANY review, verify it discusses products sold on that website — not a similarly-named company or unrelated brand.

PRIMARY SUBJECT RULE:
The review must be primarily ABOUT ${companyName}'s products. REJECT reviews where the company is merely mentioned in passing, appears as one item in a 10+ brand roundup, or is referenced as a partner in an article about another entity.
Exception: "top 5"/"best of" lists with a dedicated section of 2+ sentences are acceptable.

SEARCH STRATEGY — run 1-2 searches:
1. web_search "${companyName} review" — look for YouTube videos, lifestyle blogs, food/drink magazines, and independent review sites
2. Only if search 1 yields fewer than 2 results: web_search "${companyName} [flagship product] review"

Do NOT use browse_page to verify candidate URLs — just return the best matches from search results.

REJECT: reviews of a DIFFERENT company with a similar name, generic product listings without review content, predominantly negative reviews.

SOURCE PREFERENCE: Prefer YouTube videos and written articles from magazines/blogs. Do not include the same author more than once.
${excludeStr ? `Do NOT return any URL from: ${excludeStr}` : ""}
Return up to 2 reviews. Quality over quantity.
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
    rules: `Browse the company homepage and find the logo image in the header or navigation area.
- Look for <img> tags with alt text containing "logo" or class/id like "logo", "header-logo", "brand-logo", "site-logo", or "wordmark".
- Look for <img> tags inside <header>, <nav>, or the first <a> element that links to "/" or the homepage.
- Check <meta property="og:image"> for a social sharing image that may be the logo.
- If the logo appears to be lazy-loaded (data-src, data-lazy), extract the data-src or original source URL.
- If you find a logo image in the header area, return it immediately.

FORMAT RULES:
- Return the direct URL to the logo image file (PNG, SVG, JPG, WebP).
- Do NOT return favicon.ico or generic 16x16 favicons.
- Do NOT return product images, hero banners, or promotional graphics.
- If the logo is an inline SVG with no separate image URL, return null for logo_url.
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
