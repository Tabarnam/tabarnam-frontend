/**
 * Country attribution for location entries — powers the pins index's
 * hqCC/mfgCCs fields (and through them the /made-in pages' whole-catalog
 * counts, which the search API cannot provide: its mfgCountry filter is a
 * JS post-filter over a 500-doc recency pool).
 *
 * Measured reality on production docs (2026-08-11): `country_code` is never
 * set, `country` is present on <10% of geocode entries, and the trailing
 * comma-segment of `formatted`/`geocode_formatted_address` is the reliable
 * signal ("Brea, CA, USA" → "USA"; state-centroid entries are a bare
 * subdivision name: "Oregon"). Resolution order therefore:
 *   1. structured `country_code` (future-proofing)
 *   2. `country` field via the name map
 *   3. trailing segment of each address-ish field: country name →
 *      subdivision name (US states etc.) → validated 2-letter code
 */

// Country display names + common aliases → ISO 3166-1 alpha-2.
// Keys are lowercased, punctuation-stripped (see normalizeText).
const COUNTRY_NAME_TO_ISO = {
  "usa": "US", "united states": "US", "united states of america": "US", "us": "US", "america": "US",
  "canada": "CA",
  "mexico": "MX", "méxico": "MX",
  "united kingdom": "GB", "uk": "GB", "great britain": "GB", "england": "GB", "scotland": "GB", "wales": "GB", "northern ireland": "GB",
  "ireland": "IE",
  "france": "FR",
  "germany": "DE", "deutschland": "DE",
  "italy": "IT", "italia": "IT",
  "spain": "ES", "españa": "ES", "espana": "ES",
  "portugal": "PT",
  "netherlands": "NL", "the netherlands": "NL", "holland": "NL",
  "belgium": "BE",
  "switzerland": "CH",
  "austria": "AT",
  "sweden": "SE",
  "norway": "NO",
  "denmark": "DK",
  "finland": "FI",
  "iceland": "IS",
  "poland": "PL",
  "czech republic": "CZ", "czechia": "CZ",
  "slovakia": "SK",
  "hungary": "HU",
  "romania": "RO",
  "bulgaria": "BG",
  "greece": "GR",
  "croatia": "HR",
  "slovenia": "SI",
  "serbia": "RS",
  "ukraine": "UA",
  "estonia": "EE", "latvia": "LV", "lithuania": "LT",
  "turkey": "TR", "türkiye": "TR", "turkiye": "TR",
  "russia": "RU", "russian federation": "RU",
  "china": "CN", "people's republic of china": "CN", "peoples republic of china": "CN", "prc": "CN",
  "hong kong": "HK",
  "taiwan": "TW",
  "japan": "JP",
  "south korea": "KR", "korea": "KR", "republic of korea": "KR",
  "india": "IN",
  "pakistan": "PK",
  "bangladesh": "BD",
  "sri lanka": "LK",
  "nepal": "NP",
  "vietnam": "VN", "viet nam": "VN",
  "thailand": "TH",
  "indonesia": "ID",
  "malaysia": "MY",
  "philippines": "PH", "the philippines": "PH",
  "singapore": "SG",
  "cambodia": "KH",
  "myanmar": "MM", "burma": "MM",
  "australia": "AU",
  "new zealand": "NZ",
  "brazil": "BR", "brasil": "BR",
  "argentina": "AR",
  "chile": "CL",
  "colombia": "CO",
  "peru": "PE", "perú": "PE",
  "ecuador": "EC",
  "uruguay": "UY",
  "bolivia": "BO",
  "venezuela": "VE",
  "guatemala": "GT", "costa rica": "CR", "panama": "PA", "honduras": "HN", "nicaragua": "NI", "el salvador": "SV",
  "dominican republic": "DO", "jamaica": "JM", "haiti": "HT", "cuba": "CU", "trinidad and tobago": "TT",
  "south africa": "ZA",
  "egypt": "EG",
  "morocco": "MA",
  "tunisia": "TN",
  "algeria": "DZ",
  "kenya": "KE",
  "ethiopia": "ET",
  "ghana": "GH",
  "nigeria": "NG",
  "tanzania": "TZ",
  "uganda": "UG",
  "rwanda": "RW",
  "madagascar": "MG",
  "israel": "IL",
  "united arab emirates": "AE", "uae": "AE", "dubai": "AE",
  "saudi arabia": "SA",
  "qatar": "QA", "kuwait": "KW", "bahrain": "BH", "oman": "OM",
  "jordan": "JO", "lebanon": "LB",
  "georgia country": "GE", // bare "Georgia" resolves to the US state below
  "armenia": "AM", "azerbaijan": "AZ",
  "kazakhstan": "KZ", "uzbekistan": "UZ", "kyrgyzstan": "KG", "mongolia": "MN",
  "fiji": "FJ",
  "luxembourg": "LU", "malta": "MT", "cyprus": "CY", "monaco": "MC", "liechtenstein": "LI", "andorra": "AD",
  "bosnia and herzegovina": "BA", "north macedonia": "MK", "albania": "AL", "montenegro": "ME", "moldova": "MD", "belarus": "BY",
};

// Subdivision names that appear as a bare trailing segment (state-centroid
// geocodes) → parent country.
const SUBDIVISION_TO_ISO = {};
const US_STATES = [
  "alabama","alaska","arizona","arkansas","california","colorado","connecticut","delaware","florida","georgia",
  "hawaii","idaho","illinois","indiana","iowa","kansas","kentucky","louisiana","maine","maryland",
  "massachusetts","michigan","minnesota","mississippi","missouri","montana","nebraska","nevada","new hampshire","new jersey",
  "new mexico","new york","north carolina","north dakota","ohio","oklahoma","oregon","pennsylvania","rhode island","south carolina",
  "south dakota","tennessee","texas","utah","vermont","virginia","washington","west virginia","wisconsin","wyoming",
  "district of columbia","washington dc", "puerto rico",
];
for (const s of US_STATES) SUBDIVISION_TO_ISO[s] = "US";
const CA_PROVINCES = [
  "ontario","quebec","québec","british columbia","alberta","manitoba","saskatchewan","nova scotia",
  "new brunswick","newfoundland and labrador","prince edward island","yukon","northwest territories","nunavut",
];
for (const s of CA_PROVINCES) SUBDIVISION_TO_ISO[s] = "CA";
const AU_STATES = [
  "new south wales","victoria","queensland","western australia","south australia","tasmania",
  "australian capital territory","northern territory",
];
for (const s of AU_STATES) SUBDIVISION_TO_ISO[s] = "AU";

// Valid 2-letter codes for bare-code tails ("Milan, IT"). Derived from the
// name map's values so an accidental tail like "St" can't slip through.
const KNOWN_ISO = new Set(Object.values(COUNTRY_NAME_TO_ISO));

function normalizeText(raw) {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[.]/g, "")
    .replace(/\s+/g, " ");
}

/** Resolve a single free-text value (a country field or an address tail). */
function resolveTextCountry(raw) {
  const text = normalizeText(raw);
  if (!text) return null;
  if (COUNTRY_NAME_TO_ISO[text]) return COUNTRY_NAME_TO_ISO[text];
  if (SUBDIVISION_TO_ISO[text]) return SUBDIVISION_TO_ISO[text];
  if (/^[a-z]{2}$/.test(text)) {
    const code = text.toUpperCase();
    if (KNOWN_ISO.has(code)) return code;
  }
  return null;
}

/** Resolve a location entry (geocode / headquarters object, or a string). */
function resolveLocationCountry(entry) {
  if (entry == null) return null;
  if (typeof entry === "string") {
    return resolveTextCountry(entry.split(",").pop());
  }
  const cc = String(entry.country_code || entry.countryCode || "").trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(cc)) return cc;
  const byName = resolveTextCountry(entry.country);
  if (byName) return byName;
  for (const field of [
    entry.formatted,
    entry.geocode_formatted_address,
    entry.full_address,
    entry.address,
    entry.location,
  ]) {
    if (typeof field !== "string" || !field) continue;
    const resolved = resolveTextCountry(field.split(",").pop());
    if (resolved) return resolved;
  }
  return null;
}

module.exports = { resolveTextCountry, resolveLocationCountry, COUNTRY_NAME_TO_ISO, SUBDIVISION_TO_ISO };
