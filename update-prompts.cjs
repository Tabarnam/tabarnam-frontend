const fs = require('fs');
let content = fs.readFileSync('api/_grokEnrichment.js', 'utf8');

// Replace curly quotes with straight quotes first
content = content.replace(/[\u201C\u201D]/g, '"');

// 1. Update the reviews prompt
const oldReviewsPrompt = `  // Required query language (basis for prompt):
  // "For the company (https://www.xxxxxxxxxxxx.com/) please provide HQ, manufacturing (including city or cities), industries, keywords (products), and reviews."
  const prompt = \`For the company (\${websiteUrlForPrompt || "(unknown website)"}) please provide HQ, manufacturing (including city or cities), industries, keywords (products), and reviews.

Task: Find EXACTLY 4 third-party product/company reviews we can show in the UI.

Hard rules:
- Use web search.
- 2 reviews must be YouTube videos focused on the company or one of its products.
- 2 reviews must be magazine or blog reviews (NOT the company website).
- Provide MORE than 4 candidates (up to 20) so we can verify URLs.
- Exclude sources from these domains or subdomains: \${excludeDomains.join(", ")}
- Do NOT invent titles/authors/dates/excerpts; we will extract metadata ourselves.

Output STRICT JSON only as (use key "reviews_url_candidates"; legacy name: "review_candidates"):
{
  "reviews_url_candidates": [
    { "source_url": "https://...", "category": "youtube" },
    { "source_url": "https://...", "category": "blog" }
  ]
}\`.trim();`;

const newReviewsPrompt = `  // Required query language (basis for prompt):
  // "For the company (https://www.xxxxxxxxxxxx.com/) please provide their tagline, HQ, manufacturing (including city or cities), industries, keywords (products), and reviews."
  const prompt = \`For the company (\${websiteUrlForPrompt || "(unknown website)"}) please provide their tagline, HQ, manufacturing (including city or cities), industries, keywords (products), and reviews.

Task: Find EXACTLY 3 unique third-party product/company reviews we can show in the UI.

Hard rules:
- Use web search.
- 2 reviews must be YouTube videos focused on the company or one of its products.
- 1 review must be from a magazine or blog (NOT the company website).
- Provide MORE than 3 candidates (up to 20) so we can verify URLs.
- Exclude sources from these domains or subdomains: \${excludeDomains.join(", ")}
- Ensure reviews are legitimate with working URLs. Confirm that each URL is functional.
- Do NOT hallucinate or embellish review titles, authors, dates, excerpts, or anything else. Accuracy is paramount.
- We will extract metadata ourselves, but include fields if readily available: source_name, author, title, date, excerpt (share an excerpt or summary of the review).

Output STRICT JSON only as (use key "reviews_url_candidates"; legacy name: "review_candidates"):
{
  "reviews_url_candidates": [
    { "source_url": "https://...", "category": "youtube" },
    { "source_url": "https://...", "category": "blog" }
  ]
}\`.trim();`;

if (content.includes(oldReviewsPrompt)) {
  content = content.replace(oldReviewsPrompt, newReviewsPrompt);
  console.log('Updated reviews prompt');
} else {
  console.log('Reviews prompt not found - may have special chars');
}

// 2. Update review validation logic (4 -> 3 reviews)
content = content.replace(
  'const curated_reviews = [...verified_youtube.slice(0, 2), ...verified_blog.slice(0, 2)];',
  'const curated_reviews = [...verified_youtube.slice(0, 2), ...verified_blog.slice(0, 1)];'
);

content = content.replace(
  'const hasTwoBlog =\n    curated_reviews.length - curated_reviews.filter((r) => isYouTubeUrl(r?.source_url)).length >= 2;',
  'const hasOneBlog =\n    curated_reviews.length - curated_reviews.filter((r) => isYouTubeUrl(r?.source_url)).length >= 1;'
);

content = content.replace(
  'const ok = curated_reviews.length === 4 && hasTwoYoutube && hasTwoBlog;',
  'const ok = curated_reviews.length === 3 && hasTwoYoutube && hasOneBlog;'
);

content = content.replace(
  'if (!hasTwoBlog) reasonParts.push("missing_blog_reviews");',
  'if (!hasOneBlog) reasonParts.push("missing_blog_reviews");'
);

content = content.replace(
  'if (curated_reviews.length < 4) reasonParts.push("insufficient_verified_reviews");',
  'if (curated_reviews.length < 3) reasonParts.push("insufficient_verified_reviews");'
);

content = content.replace(
  'if (verified_youtube.length >= 2 && verified_blog.length >= 2) break;',
  'if (verified_youtube.length >= 2 && verified_blog.length >= 1) break;'
);

content = content.replace(
  'const needsBlog = verified_blog.length < 2;',
  'const needsBlog = verified_blog.length < 1;'
);

console.log('Updated review validation logic');

// 3. Update HQ prompt
const oldHqPrompt = `  const prompt = \`For the company (\${websiteUrlForPrompt || "(unknown website)"}) please provide HQ, manufacturing (including city or cities), industries, keywords (products), and reviews.

Task: Determine the company's HEADQUARTERS location.

Rules:
- Use web search (do not rely only on the company website).
- Prefer authoritative sources like LinkedIn, official filings, reputable business directories.
- Return best available HQ as a single formatted string: "City, State/Province, Country".
  - If state/province is not applicable, use "City, Country".
  - If only country is known, return "Country".
- Provide the supporting URLs you used for the HQ determination.
- Output STRICT JSON only.

Return:
{
  "headquarters_location": "...",
  "location_source_urls": { "hq_source_urls": ["https://...", "https://..."] }
}
\`.trim();`;

const newHqPrompt = `  const prompt = \`For the company (\${websiteUrlForPrompt || "(unknown website)"}) please provide their tagline, HQ, manufacturing (including city or cities), industries, keywords (products), and reviews.

Task: Determine the company's HEADQUARTERS location.

Rules:
- Use web search. Do deep dives if necessary.
- Prefer authoritative sources like LinkedIn, official filings, reputable business directories.
- Having the actual city is crucial, especially for locations in the United States.
- Use initials/abbreviations for states and provinces (e.g., "Austin, TX, USA" not "Austin, Texas, USA"; "Toronto, ON, Canada").
- Return best available HQ as a single formatted string: "City, State/Province, Country".
  - If state/province is not applicable, use "City, Country".
  - If only country is known, return "Country".
- No explanatory info - just the location.
- Provide the supporting URLs you used for the HQ determination.
- Output STRICT JSON only.

Return:
{
  "headquarters_location": "...",
  "location_source_urls": { "hq_source_urls": ["https://...", "https://..."] }
}
\`.trim();`;

if (content.includes(oldHqPrompt)) {
  content = content.replace(oldHqPrompt, newHqPrompt);
  console.log('Updated HQ prompt');
} else {
  console.log('HQ prompt not found');
}

// 4. Update manufacturing prompt
const oldMfgPrompt = `  const prompt = \`For the company (\${websiteUrlForPrompt || "(unknown website)"}) please provide HQ, manufacturing (including city or cities), industries, keywords (products), and reviews.

Task: Determine the company's MANUFACTURING locations.

Rules:
- Use web search (do not rely only on the company website).
- Return an array of one or more locations. Include city + country when known; include multiple cities when applicable.
- If only country-level is available, country-only entries are acceptable.
- If manufacturing is not publicly disclosed after searching, return ["Not disclosed"].
- Provide the supporting URLs you used for the manufacturing determination.
- Output STRICT JSON only.

Return:
{
  "manufacturing_locations": ["City, Country"],
  "location_source_urls": { "mfg_source_urls": ["https://...", "https://..."] }
}
\`.trim();`;

const newMfgPrompt = `  const prompt = \`For the company (\${websiteUrlForPrompt || "(unknown website)"}) please provide their tagline, HQ, manufacturing (including city or cities), industries, keywords (products), and reviews.

Task: Determine the company's MANUFACTURING locations.

Rules:
- Use web search. Do deep dives if necessary.
- Having the actual cities is crucial, especially for locations in the United States.
- Use initials/abbreviations for states and provinces (e.g., "Detroit, MI, USA" not "Detroit, Michigan, USA"; "Vancouver, BC, Canada").
- Return an array of one or more locations. Include city + state/province + country when known; include multiple cities when applicable.
- If only country-level is available, country-only entries are acceptable.
- If manufacturing is not publicly disclosed after searching, return ["Not disclosed"].
- No explanatory info - just locations.
- Provide the supporting URLs you used for the manufacturing determination.
- Output STRICT JSON only.

Return:
{
  "manufacturing_locations": ["City, State, Country"],
  "location_source_urls": { "mfg_source_urls": ["https://...", "https://..."] }
}
\`.trim();`;

if (content.includes(oldMfgPrompt)) {
  content = content.replace(oldMfgPrompt, newMfgPrompt);
  console.log('Updated manufacturing prompt');
} else {
  console.log('Manufacturing prompt not found');
}

// 5. Update tagline prompt
const oldTaglinePrompt = `  const prompt = \`For the company (\${websiteUrlForPrompt || "(unknown website)"}) please provide HQ, manufacturing (including city or cities), industries, keywords (products), and reviews.

Task: Provide ONLY the company tagline/slogan.

Rules:
- Use web search.
- Return a short marketing-style tagline (a sentence fragment is fine).
- Do NOT return navigation labels, promos, or legal text.
- Output STRICT JSON only.

Return:
{ "tagline": "..." }
\`.trim();`;

const newTaglinePrompt = `  const prompt = \`For the company (\${websiteUrlForPrompt || "(unknown website)"}) please provide their tagline, HQ, manufacturing (including city or cities), industries, keywords (products), and reviews.

Task: Provide ONLY the company tagline/slogan.

Rules:
- Use web search.
- Return a short marketing-style tagline (a sentence fragment is fine).
- Do NOT return navigation labels, promos, or legal text.
- Do NOT hallucinate or embellish. Accuracy is paramount.
- Output STRICT JSON only.

Return:
{ "tagline": "..." }
\`.trim();`;

if (content.includes(oldTaglinePrompt)) {
  content = content.replace(oldTaglinePrompt, newTaglinePrompt);
  console.log('Updated tagline prompt');
} else {
  console.log('Tagline prompt not found');
}

// 6. Update industries prompt
const oldIndustriesPrompt = `  const prompt = \`For the company (\${websiteUrlForPrompt || "(unknown website)"}) please provide HQ, manufacturing (including city or cities), industries, keywords (products), and reviews.

Task: Identify the company's industries.

Rules:
- Use web search.
- Return a list of industries/categories that best describe what the company makes/sells.
- Avoid store navigation terms (e.g. "New Arrivals", "Shop", "Sale") and legal terms.
- Prefer industry labels that can be mapped to an internal taxonomy.
- Output STRICT JSON only.

Return:
{ "industries": ["..."] }
\`.trim();`;

const newIndustriesPrompt = `  const prompt = \`For the company (\${websiteUrlForPrompt || "(unknown website)"}) please provide their tagline, HQ, manufacturing (including city or cities), industries, keywords (products), and reviews.

Task: Identify the company's industries.

Rules:
- Use web search.
- Return a list of industries/categories that best describe what the company makes/sells.
- Industries should be returned as an array of strings, with each industry as a separate element.
- Avoid store navigation terms (e.g. "New Arrivals", "Shop", "Sale") and legal terms.
- Prefer industry labels that can be mapped to an internal taxonomy.
- Output STRICT JSON only.

Return:
{ "industries": ["Industry 1", "Industry 2", "Industry 3"] }
\`.trim();`;

if (content.includes(oldIndustriesPrompt)) {
  content = content.replace(oldIndustriesPrompt, newIndustriesPrompt);
  console.log('Updated industries prompt');
} else {
  console.log('Industries prompt not found');
}

// 7. Update product keywords prompt
const oldKeywordsPrompt = `  const prompt = \`For the company (\${websiteUrlForPrompt || "(unknown website)"}) please provide HQ, manufacturing (including city or cities), industries, keywords (products), and reviews.

Task: Provide an EXHAUSTIVE list of the PRODUCTS (SKUs/product names/product lines) this company sells.

Hard rules:
- Use web search (not just the company website).
- Return ONLY products/product lines. Do NOT include navigation/UX taxonomy such as: Shop All, Collections, New, Best Sellers, Sale, Account, Cart, Store Locator, FAQ, Shipping, Returns, Contact, About, Blog.
- Do NOT include generic category labels unless they are actual product lines.
- The list should be materially more complete than the top nav.
- If you are uncertain about completeness, expand the search and keep going until you can either:
  (a) justify completeness, OR
  (b) explicitly mark it incomplete with a reason.
- Do NOT return a short/partial list without marking it incomplete.
- Output STRICT JSON only.

Return:
{
  "product_keywords": ["Product 1", "Product 2"],
  "completeness": "complete" | "incomplete",
  "incomplete_reason": null | "..."
}
\`.trim();`;

const newKeywordsPrompt = `  const prompt = \`For the company (\${websiteUrlForPrompt || "(unknown website)"}) please provide their tagline, HQ, manufacturing (including city or cities), industries, keywords (products), and reviews.

Task: Provide an EXHAUSTIVE, COMPLETE, and ALL-INCLUSIVE list of the PRODUCTS (SKUs/product names/product lines) this company sells.

Hard rules:
- Use web search (not just the company website).
- Return ONLY products/product lines. Do NOT include navigation/UX taxonomy such as: Shop All, Collections, New, Best Sellers, Sale, Account, Cart, Store Locator, FAQ, Shipping, Returns, Contact, About, Blog.
- Do NOT include generic category labels unless they are actual product lines.
- Each product should be a separate array element with no commas within a product name.
- The list should be materially more complete than the top nav.
- Keywords should be exhaustive, complete and all-inclusive (all the products that the company produces).
- If you are uncertain about completeness, expand the search and keep going until you can either:
  (a) justify completeness, OR
  (b) explicitly mark it incomplete with a reason.
- Do NOT return a short/partial list without marking it incomplete.
- Output STRICT JSON only.

Return:
{
  "product_keywords": ["Product 1", "Product 2"],
  "completeness": "complete" | "incomplete",
  "incomplete_reason": null | "..."
}
\`.trim();`;

if (content.includes(oldKeywordsPrompt)) {
  content = content.replace(oldKeywordsPrompt, newKeywordsPrompt);
  console.log('Updated keywords prompt');
} else {
  console.log('Keywords prompt not found');
}

fs.writeFileSync('api/_grokEnrichment.js', content);
console.log('Done writing file');
