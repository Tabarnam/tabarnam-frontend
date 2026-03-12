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
    rules: `Conduct thorough research using web_search and browse_page tools to identify the HQ location, cross-verifying across at least 3 independent sources (e.g., official website, company profiles like LinkedIn or Crunchbase, and recent articles or filings) and resolving any discrepancies. Use initials for states or provinces (e.g., City, State Initials, Country). Use USA, not US. No explanatory info — just the location. If multiple HQ locations, separate with semicolons. Format: City, ST, Country or City, ST, Country; City2, ST2, Country2`,
    jsonSchema: `"headquarters_location": "City, ST, USA"`,
    jsonSchemaWithSources: `{
  "headquarters_location": "...",
  "location_source_urls": { "hq_source_urls": ["https://...", "https://..."] }
}`,
  },

  manufacturing: {
    rules: `Conduct thorough research using web_search and browse_page tools to identify all known manufacturing locations worldwide, cross-verifying across at least 3 independent sources (e.g., official website, company profiles like LinkedIn or Crunchbase, and recent articles or filings) and resolving any discrepancies. Include every city and country found, with a deep dive on any US sites to confirm actual cities. List them exhaustively without missing any. Use initials for states or provinces. Use USA, not US. No explanatory info — just the locations. If part of a location is unspecified, include only what is known. Do not write "unspecified." Separate each location with semicolons. Format: City, ST, Country; City2, ST2, Country2`,
    jsonSchema: `"manufacturing_locations": ["City, ST, USA", "City, Country"]`,
    jsonSchemaWithSources: `{
  "manufacturing_locations": ["City, ST, USA", "City, Country"],
  "mfg_status": "ok | not_applicable",
  "location_source_urls": { "mfg_source_urls": ["https://...", "https://..."] }
}
mfg_status: use "ok" when manufacturing locations were found, "not_applicable" when the company is a retailer/marketplace/reseller (not a manufacturer). Omit or use "ok" by default.`,
  },

  industries: {
    rules: `- Use web_search "[Company Name] [Website URL] industry" or "[Company Name] company profile" to find industry classifications.
- Return an array of up to 3 specific, descriptive industry labels that describe what the company actually manufactures or sells (e.g., "Home Textiles Manufacturing", "Bedding Products", "Bath Linens").
- Do NOT return generic umbrella terms like "Consumer Goods", "Food and Beverage", "Retail", "E-Commerce".
- Maximum 3 industries. Pick the most specific and descriptive ones.
- No guessing or hallucinating. Only report verified information.`,
    jsonSchema: `"industries": ["Industry 1", "Industry 2", "..."]`,
  },

  keywords: {
    rules: `Use browse_page on the company URL and its product/shop/collections pages to find all products. Use web_search "[Company Name] products" for completeness. Return all products, product lines, flavors, and varieties — up to 100 items. IMPORTANT: If the catalog is large (30+ products), prioritize returning what you have found from the main product/shop/collections pages rather than spending time browsing every sub-page. Return ONLY actual products (not navigation labels, site features, or generic categories). Set "completeness" to "incomplete" if you know there are more products you couldn't extract. No guessing or hallucinating.`,
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

      // ── Single-call prompt: third-party reviews + company website fallback ──
      return `For the company: ${companyName} / ${websiteUrl || "(unknown website)"}
Reviews: Find 2 unique, legitimate third-party reviews with working URLs. Use 1-2 YouTube reviews focused solely on the current company or its products; do not include unrelated reviews or reviews from or about previously discussed companies. The remaining reviews should be from X (Twitter), a magazine or blog, strictly related to the current company and its products, excluding any overlap with prior companies. Confirm all URLs are functional. Do not hallucinate or embellish. Do not include the same author or URL more than once. Accuracy is paramount.
If fewer than 2 third-party reviews are found, supplement by browsing ${websiteUrl || "the company website"} for press mentions, testimonials, or "as seen in" sections. Use source_name "Website - [page type]" for these.
${excludeStr ? `Do NOT return any URL from: ${excludeStr}` : ""}
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
