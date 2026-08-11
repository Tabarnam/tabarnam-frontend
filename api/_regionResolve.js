/**
 * Subdivision (state / province / territory) attribution for location
 * entries — the state-level counterpart to _countryResolve.js. Powers the
 * /made-in/usa/:state pages via the pins index.
 *
 * Returns ISO 3166-2 style codes ("US-CA", "CA-ON", "AU-VIC"). Measured on
 * production docs: ~94% of US manufacturing entries carry a resolvable state
 * in the formatted address, rising to ~97% once full state names with ZIPs
 * are handled; the remainder are genuinely country-level ("USA" alone) and
 * correctly resolve to null — they count toward the country, not a state.
 *
 * Address shapes seen in the wild:
 *   "Brea, CA, USA"                    → US-CA   (2-letter code segment)
 *   "Santa Maria, California 93454, USA" → US-CA (full name + ZIP)
 *   "Oregon"                           → US-OR   (state-centroid geocode)
 *   "Tanunda, South Australia, Australia" → AU-SA
 *   "USA"                              → null    (country-level only)
 */

const { resolveLocationCountry } = require("./_countryResolve");

// Full subdivision name → code, per country.
const SUBDIVISIONS = {
  US: {
    alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
    colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
    hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
    kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
    massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO",
    montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
    "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH",
    oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
    "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
    virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
    // Federal district + inhabited territories (all "Made in USA" for
    // labeling purposes, so they belong under the USA umbrella).
    "district of columbia": "DC", "washington dc": "DC", "washington d c": "DC",
    "puerto rico": "PR", guam: "GU", "u s virgin islands": "VI", "us virgin islands": "VI",
    "virgin islands": "VI", "american samoa": "AS", "northern mariana islands": "MP",
  },
  CA: {
    ontario: "ON", quebec: "QC", québec: "QC", "british columbia": "BC", alberta: "AB",
    manitoba: "MB", saskatchewan: "SK", "nova scotia": "NS", "new brunswick": "NB",
    "newfoundland and labrador": "NL", "prince edward island": "PE", yukon: "YT",
    "northwest territories": "NT", nunavut: "NU",
  },
  AU: {
    "new south wales": "NSW", victoria: "VIC", queensland: "QLD",
    "western australia": "WA", "south australia": "SA", tasmania: "TAS",
    "australian capital territory": "ACT", "northern territory": "NT",
  },
};

// Valid short codes per country (for "City, ST, USA" segments).
const CODES = {};
for (const [cc, table] of Object.entries(SUBDIVISIONS)) {
  CODES[cc] = new Set(Object.values(table));
}

function normalizeSegment(raw) {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[.,]/g, " ")
    // Strip trailing postal codes: "California 93454", "Ontario K1A 0B1"
    .replace(/\s+\d[\d-]*$/, "")
    .replace(/\s+[a-z]\d[a-z]\s*\d[a-z]\d$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Resolve a single free-text segment within a known country. */
function resolveSegmentRegion(segment, cc) {
  const table = SUBDIVISIONS[cc];
  if (!table) return null;
  const text = normalizeSegment(segment);
  if (!text) return null;
  if (table[text]) return table[text];
  const upper = text.toUpperCase().replace(/\s+/g, "");
  if (CODES[cc].has(upper)) return upper;
  return null;
}

/**
 * Resolve a location entry (geocode / headquarters object, or a string) to an
 * ISO 3166-2 style region code, or null when only the country is known.
 * @param {object|string} entry
 * @param {string} [knownCC] - country already resolved for this entry
 */
function resolveLocationRegion(entry, knownCC) {
  if (entry == null) return null;
  const cc = knownCC || resolveLocationCountry(entry);
  if (!cc || !SUBDIVISIONS[cc]) return null;

  // Structured fields win when present.
  if (typeof entry === "object") {
    for (const field of [entry.state_code, entry.stateCode, entry.region_code, entry.state, entry.region]) {
      const code = resolveSegmentRegion(field, cc);
      if (code) return `${cc}-${code}`;
    }
  }

  const addresses =
    typeof entry === "string"
      ? [entry]
      : [entry.formatted, entry.geocode_formatted_address, entry.full_address, entry.address, entry.location];

  for (const addr of addresses) {
    if (typeof addr !== "string" || !addr) continue;
    const parts = addr.split(",").map((p) => p.trim()).filter(Boolean);
    // Scan from the end (skipping the country tail) — the subdivision is
    // typically the segment immediately before the country.
    for (let i = parts.length - 1; i >= 0; i--) {
      const code = resolveSegmentRegion(parts[i], cc);
      if (code) return `${cc}-${code}`;
    }
  }
  return null;
}

module.exports = { resolveLocationRegion, SUBDIVISIONS };
