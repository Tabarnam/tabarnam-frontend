// URL vocabulary for the /made-in tree — the single source of truth for every
// slug the app links to and every URL the sitemap advertises.
//
// Deliberately dependency-free (no imports, no `@/` alias, no browser globals)
// so scripts/generate-sitemap.mjs can import it directly under Node. If the
// slug rules lived only in madeIn.js — which pulls in the pins client and the
// location library — the generator would need its own copy, and a copy is a
// sitemap full of URLs that 301 or 404 the moment someone edits one side.

// SEO-friendly slug overrides where the kebab-cased ISO name isn't the term
// people search for. Everything else: kebab-case of the countries.json name.
export const SLUG_OVERRIDES = {
  US: "usa",
  GB: "uk",
  KR: "south-korea",
  RU: "russia",
  TW: "taiwan",
  VN: "vietnam",
  CZ: "czech-republic",
};

// H1/display overrides where the formal ISO name reads poorly on a page.
export const NAME_OVERRIDES = {
  KR: "South Korea",
  TW: "Taiwan",
  VN: "Vietnam",
  CZ: "Czech Republic",
  RU: "Russia",
};

// Legacy/alias slugs that should still resolve (canonical points elsewhere).
// These are intentionally NOT emitted into the sitemap: they redirect.
export const SLUG_ALIASES = {
  "united-states": "usa",
  "united-states-of-america": "usa",
  "america": "usa",
  "united-kingdom": "uk",
  "great-britain": "uk",
  "korea": "south-korea",
  "czechia": "czech-republic",
};

// Compact display forms for verbose ISO names. Lives here with the other
// naming rules so the server-side /made-in renderer resolves the same H1 and
// <title> text the React page does; location.js re-exports it for the rest of
// the app.
const COUNTRY_DISPLAY_MAP = {
  "UNITED STATES": "USA",
  "UNITED STATES OF AMERICA": "USA",
  "UNITED KINGDOM": "UK",
  "UNITED KINGDOM OF GREAT BRITAIN AND NORTHERN IRELAND": "UK",
  "PEOPLE'S REPUBLIC OF CHINA": "China",
};

/**
 * Normalize verbose country names to compact display forms.
 * "United States" → "USA", "United Kingdom" → "UK", etc.
 */
export function normalizeCountryDisplay(name) {
  if (!name || typeof name !== "string") return name;
  const n = name.trim();
  return COUNTRY_DISPLAY_MAP[n.toUpperCase()] || n;
}

/** The H1/<title> name for a country page. */
export function countryDisplayName(cc, name) {
  return NAME_OVERRIDES[String(cc || "").toUpperCase()] || normalizeCountryDisplay(name);
}

export function kebab(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Canonical /made-in slug for an ISO country code + its countries.json name. */
export function countrySlug(cc, name) {
  return SLUG_OVERRIDES[String(cc || "").toUpperCase()] || kebab(name);
}

// US states, DC, and inhabited territories. Slug = kebab of the name; these
// are the only subdivisions with published pages today (the resolver also
// emits CA-/AU- codes, which aggregate fine but have no page yet).
export const US_REGIONS = [
  ["US-AL", "Alabama"], ["US-AK", "Alaska"], ["US-AZ", "Arizona"], ["US-AR", "Arkansas"],
  ["US-CA", "California"], ["US-CO", "Colorado"], ["US-CT", "Connecticut"], ["US-DE", "Delaware"],
  ["US-FL", "Florida"], ["US-GA", "Georgia"], ["US-HI", "Hawaii"], ["US-ID", "Idaho"],
  ["US-IL", "Illinois"], ["US-IN", "Indiana"], ["US-IA", "Iowa"], ["US-KS", "Kansas"],
  ["US-KY", "Kentucky"], ["US-LA", "Louisiana"], ["US-ME", "Maine"], ["US-MD", "Maryland"],
  ["US-MA", "Massachusetts"], ["US-MI", "Michigan"], ["US-MN", "Minnesota"], ["US-MS", "Mississippi"],
  ["US-MO", "Missouri"], ["US-MT", "Montana"], ["US-NE", "Nebraska"], ["US-NV", "Nevada"],
  ["US-NH", "New Hampshire"], ["US-NJ", "New Jersey"], ["US-NM", "New Mexico"], ["US-NY", "New York"],
  ["US-NC", "North Carolina"], ["US-ND", "North Dakota"], ["US-OH", "Ohio"], ["US-OK", "Oklahoma"],
  ["US-OR", "Oregon"], ["US-PA", "Pennsylvania"], ["US-RI", "Rhode Island"], ["US-SC", "South Carolina"],
  ["US-SD", "South Dakota"], ["US-TN", "Tennessee"], ["US-TX", "Texas"], ["US-UT", "Utah"],
  ["US-VT", "Vermont"], ["US-VA", "Virginia"], ["US-WA", "Washington"], ["US-WV", "West Virginia"],
  ["US-WI", "Wisconsin"], ["US-WY", "Wyoming"],
  ["US-DC", "District of Columbia"],
  ["US-PR", "Puerto Rico"], ["US-GU", "Guam"], ["US-VI", "U.S. Virgin Islands"],
  ["US-AS", "American Samoa"], ["US-MP", "Northern Mariana Islands"],
];

export const REGION_SLUG_OVERRIDES = {
  "US-DC": "washington-dc",
  "US-VI": "us-virgin-islands",
};

/** Canonical /made-in/usa/<slug> segment for an ISO 3166-2 code + its name. */
export function regionSlug(code, name) {
  return REGION_SLUG_OVERRIDES[code] || kebab(name);
}
