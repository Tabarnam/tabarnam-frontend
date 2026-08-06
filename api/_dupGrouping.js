// Single source of truth for what counts as a duplicate company.
//
// A duplicate = two docs that share BOTH a normalized_domain AND a company name.
// Domain alone is NOT enough: distinct sibling brands legitimately share a
// corporate domain (mccormick.com → Frank's RedHot / Lawry's / French's), and
// unrelated companies share a marketplace domain (amazon.com / etsy.com
// storefronts). In every such case the NAMES differ, so keying on domain+name
// treats only true repeats (same company imported twice) as duplicates.
//
// Both the admin read path (deduplicateByDomainAdmin) and the merge endpoint
// (admin-cleanup-seed-fallback-dups) use this so their definitions can't drift.

// Marketplace / shared-storefront domains: many unrelated companies point their
// "website" at these, so the domain is never a company identity. Never grouped.
const MARKETPLACE_DOMAINS = new Set([
  "amazon.com",
  "etsy.com",
  "ebay.com",
  "walmart.com",
  "aliexpress.com",
  "alibaba.com",
  "faire.com",
]);

function normalizeDomain(value) {
  return String(value || "").trim().toLowerCase();
}

function isMarketplaceDomain(domain) {
  return MARKETPLACE_DOMAINS.has(normalizeDomain(domain));
}

// Normalize a company name to alphanumerics only (lowercased). Strips spacing
// and punctuation so real spelling variants of ONE brand match ("SnackWorks" ==
// "Snack Works", "Lawry's" == "Lawrys") while genuinely different sibling brands
// stay distinct ("Frank's RedHot" → "franksredhot" ≠ "Lawry's" → "lawrys").
function normalizeCompanyNameKey(doc) {
  return String(doc?.company_name || doc?.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Group key for duplicate detection, or `null` when the doc must NEVER be
 * grouped as a duplicate:
 *   - it has a parent_company_id (a declared sub-brand),
 *   - its domain is empty / "unknown",
 *   - its domain is a marketplace domain, or
 *   - it has no usable company name.
 * Otherwise returns "<domain>||<normalizedName>" — two docs are duplicates iff
 * they produce the same non-null key.
 */
function dupGroupKey(doc) {
  if (String(doc?.parent_company_id || "").trim()) return null;
  const domain = normalizeDomain(doc?.normalized_domain);
  if (!domain || domain === "unknown") return null;
  if (isMarketplaceDomain(domain)) return null;
  const name = normalizeCompanyNameKey(doc);
  if (!name) return null;
  return `${domain}||${name}`;
}

module.exports = {
  MARKETPLACE_DOMAINS,
  isMarketplaceDomain,
  normalizeCompanyNameKey,
  dupGroupKey,
};
