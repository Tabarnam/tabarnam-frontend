/**
 * Compute normalized search text fields for companies
 * These fields are used for fast normalized search matching
 */

const { normalizeQuery } = require("./_queryNormalizer");

/**
 * Join and normalize an array of strings into a single searchable text
 */
function normalizeSearchContent(content) {
  if (Array.isArray(content)) {
    content = content.filter((c) => c && typeof c === "string").join(", ");
  }
  const str = typeof content === "string" ? content : "";
  return str.toLowerCase().trim();
}

/**
 * Compute the normalized and compact search text for a company record
 * Combines company name, tagline, industries, product keywords, keywords, categories
 * 
 * Returns { search_text_norm, search_text_compact }
 * - search_text_norm: normalized text with spaces (used with word boundary matching)
 * - search_text_compact: normalized text without spaces (used with contains matching)
 */
function computeSearchText(company) {
  if (!company || typeof company !== "object") {
    return { search_text_norm: "", search_text_compact: "" };
  }

  // Collect all searchable text parts
  const parts = [];

  // Company identification
  if (company.company_name) parts.push(company.company_name);
  if (company.display_name) parts.push(company.display_name);
  if (company.name) parts.push(company.name);

  // Descriptive content
  if (company.tagline) parts.push(company.tagline);

  // Categories
  if (Array.isArray(company.industries)) {
    parts.push(...company.industries);
  } else if (company.industries && typeof company.industries === "string") {
    parts.push(company.industries);
  }

  if (Array.isArray(company.categories)) {
    parts.push(...company.categories);
  } else if (company.categories && typeof company.categories === "string") {
    parts.push(company.categories);
  }

  // Keywords
  if (Array.isArray(company.product_keywords)) {
    parts.push(...company.product_keywords);
  } else if (company.product_keywords && typeof company.product_keywords === "string") {
    parts.push(company.product_keywords);
  }

  if (Array.isArray(company.keywords)) {
    parts.push(...company.keywords);
  } else if (company.keywords && typeof company.keywords === "string") {
    parts.push(company.keywords);
  }

  // Join all parts
  const joined = parts.filter((p) => p && typeof p === "string").join(" ");

  // Normalize the text
  const search_text_norm = normalizeQuery(joined);

  // Create compact form (with word boundary padding for norm)
  // The word boundary padding (spaces) is done at storage time
  const search_text_norm_with_boundaries = search_text_norm ? ` ${search_text_norm} ` : "";
  const search_text_compact = search_text_norm.replace(/\s+/g, "");

  return {
    search_text_norm: search_text_norm_with_boundaries,
    search_text_compact,
  };
}

/**
 * Patch a company record with computed search fields
 * Modifies the company object in place
 */
function patchCompanyWithSearchText(company) {
  if (!company || typeof company !== "object") return company;
  
  const { search_text_norm, search_text_compact } = computeSearchText(company);
  company.search_text_norm = search_text_norm;
  company.search_text_compact = search_text_compact;
  
  return company;
}

module.exports = {
  computeSearchText,
  patchCompanyWithSearchText,
  normalizeSearchContent,
};
