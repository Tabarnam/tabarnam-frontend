/**
 * _stateCenters.js
 *
 * US state and Canadian province geographic center coordinates.
 * Used as fallback when a location only specifies a state/province.
 */

// US State geographic centers (approximate)
const US_STATE_CENTERS = {
  "AL": { lat: 32.3182, lng: -86.9023, name: "Alabama" },
  "AK": { lat: 64.0685, lng: -152.2782, name: "Alaska" },
  "AZ": { lat: 34.0489, lng: -111.0937, name: "Arizona" },
  "AR": { lat: 34.7465, lng: -92.2896, name: "Arkansas" },
  "CA": { lat: 36.7783, lng: -119.4179, name: "California" },
  "CO": { lat: 39.5501, lng: -105.7821, name: "Colorado" },
  "CT": { lat: 41.6032, lng: -73.0877, name: "Connecticut" },
  "DE": { lat: 38.9108, lng: -75.5277, name: "Delaware" },
  "FL": { lat: 27.6648, lng: -81.5158, name: "Florida" },
  "GA": { lat: 32.1574, lng: -82.9071, name: "Georgia" },
  "HI": { lat: 19.8968, lng: -155.5828, name: "Hawaii" },
  "ID": { lat: 44.0682, lng: -114.7420, name: "Idaho" },
  "IL": { lat: 40.6331, lng: -89.3985, name: "Illinois" },
  "IN": { lat: 40.2672, lng: -86.1349, name: "Indiana" },
  "IA": { lat: 41.8780, lng: -93.0977, name: "Iowa" },
  "KS": { lat: 39.0119, lng: -98.4842, name: "Kansas" },
  "KY": { lat: 37.8393, lng: -84.2700, name: "Kentucky" },
  "LA": { lat: 30.9843, lng: -91.9623, name: "Louisiana" },
  "ME": { lat: 45.2538, lng: -69.4455, name: "Maine" },
  "MD": { lat: 39.0458, lng: -76.6413, name: "Maryland" },
  "MA": { lat: 42.4072, lng: -71.3824, name: "Massachusetts" },
  "MI": { lat: 44.3148, lng: -85.6024, name: "Michigan" },
  "MN": { lat: 46.7296, lng: -94.6859, name: "Minnesota" },
  "MS": { lat: 32.3547, lng: -89.3985, name: "Mississippi" },
  "MO": { lat: 37.9643, lng: -91.8318, name: "Missouri" },
  "MT": { lat: 46.8797, lng: -110.3626, name: "Montana" },
  "NE": { lat: 41.4925, lng: -99.9018, name: "Nebraska" },
  "NV": { lat: 38.8026, lng: -116.4194, name: "Nevada" },
  "NH": { lat: 43.1939, lng: -71.5724, name: "New Hampshire" },
  "NJ": { lat: 40.0583, lng: -74.4057, name: "New Jersey" },
  "NM": { lat: 34.5199, lng: -105.8701, name: "New Mexico" },
  "NY": { lat: 43.2994, lng: -74.2179, name: "New York" },
  "NC": { lat: 35.7596, lng: -79.0193, name: "North Carolina" },
  "ND": { lat: 47.5515, lng: -101.0020, name: "North Dakota" },
  "OH": { lat: 40.4173, lng: -82.9071, name: "Ohio" },
  "OK": { lat: 35.0078, lng: -97.0929, name: "Oklahoma" },
  "OR": { lat: 43.8041, lng: -120.5542, name: "Oregon" },
  "PA": { lat: 41.2033, lng: -77.1945, name: "Pennsylvania" },
  "RI": { lat: 41.5801, lng: -71.4774, name: "Rhode Island" },
  "SC": { lat: 33.8361, lng: -81.1637, name: "South Carolina" },
  "SD": { lat: 43.9695, lng: -99.9018, name: "South Dakota" },
  "TN": { lat: 35.5175, lng: -86.5804, name: "Tennessee" },
  "TX": { lat: 31.9686, lng: -99.9018, name: "Texas" },
  "UT": { lat: 39.3210, lng: -111.0937, name: "Utah" },
  "VT": { lat: 44.5588, lng: -72.5778, name: "Vermont" },
  "VA": { lat: 37.4316, lng: -78.6569, name: "Virginia" },
  "WA": { lat: 47.7511, lng: -120.7401, name: "Washington" },
  "WV": { lat: 38.5976, lng: -80.4549, name: "West Virginia" },
  "WI": { lat: 43.7844, lng: -88.7879, name: "Wisconsin" },
  "WY": { lat: 43.0759, lng: -107.2903, name: "Wyoming" },
  "DC": { lat: 38.9072, lng: -77.0369, name: "District of Columbia" },
  "PR": { lat: 18.2208, lng: -66.5901, name: "Puerto Rico" },
};

// Canadian province centers
const CA_PROVINCE_CENTERS = {
  "AB": { lat: 53.9333, lng: -116.5765, name: "Alberta" },
  "BC": { lat: 53.7267, lng: -127.6476, name: "British Columbia" },
  "MB": { lat: 53.7609, lng: -98.8139, name: "Manitoba" },
  "NB": { lat: 46.4989, lng: -66.1591, name: "New Brunswick" },
  "NL": { lat: 53.1355, lng: -57.6604, name: "Newfoundland and Labrador" },
  "NS": { lat: 44.6820, lng: -63.7443, name: "Nova Scotia" },
  "NT": { lat: 64.8255, lng: -124.8457, name: "Northwest Territories" },
  "NU": { lat: 70.2998, lng: -83.1076, name: "Nunavut" },
  "ON": { lat: 51.2538, lng: -85.3232, name: "Ontario" },
  "PE": { lat: 46.5107, lng: -63.4168, name: "Prince Edward Island" },
  "QC": { lat: 52.9399, lng: -73.5491, name: "Quebec" },
  "SK": { lat: 52.9399, lng: -106.4509, name: "Saskatchewan" },
  "YT": { lat: 64.2823, lng: -135.0000, name: "Yukon" },
};

// Known country aliases for disambiguation in composite "state, country" strings
const US_COUNTRY_ALIASES = new Set([
  "US", "USA", "UNITED STATES", "UNITED STATES OF AMERICA", "U.S.", "U.S.A.",
]);

const CA_COUNTRY_ALIASES = new Set([
  "CA", "CAN", "CANADA",
]);

function isKnownUSCountryAlias(s) {
  return US_COUNTRY_ALIASES.has(s);
}

function isKnownCACountryAlias(s) {
  return CA_COUNTRY_ALIASES.has(s);
}

// State name to code mapping (includes common variations)
const STATE_NAME_TO_CODE = {
  // US States
  "ALABAMA": "AL",
  "ALASKA": "AK",
  "ARIZONA": "AZ",
  "ARKANSAS": "AR",
  "CALIFORNIA": "CA",
  "COLORADO": "CO",
  "CONNECTICUT": "CT",
  "DELAWARE": "DE",
  "FLORIDA": "FL",
  "GEORGIA": "GA",
  "HAWAII": "HI",
  "IDAHO": "ID",
  "ILLINOIS": "IL",
  "INDIANA": "IN",
  "IOWA": "IA",
  "KANSAS": "KS",
  "KENTUCKY": "KY",
  "LOUISIANA": "LA",
  "MAINE": "ME",
  "MARYLAND": "MD",
  "MASSACHUSETTS": "MA",
  "MICHIGAN": "MI",
  "MINNESOTA": "MN",
  "MISSISSIPPI": "MS",
  "MISSOURI": "MO",
  "MONTANA": "MT",
  "NEBRASKA": "NE",
  "NEVADA": "NV",
  "NEW HAMPSHIRE": "NH",
  "NEW JERSEY": "NJ",
  "NEW MEXICO": "NM",
  "NEW YORK": "NY",
  "NORTH CAROLINA": "NC",
  "NORTH DAKOTA": "ND",
  "OHIO": "OH",
  "OKLAHOMA": "OK",
  "OREGON": "OR",
  "PENNSYLVANIA": "PA",
  "RHODE ISLAND": "RI",
  "SOUTH CAROLINA": "SC",
  "SOUTH DAKOTA": "SD",
  "TENNESSEE": "TN",
  "TEXAS": "TX",
  "UTAH": "UT",
  "VERMONT": "VT",
  "VIRGINIA": "VA",
  "WASHINGTON": "WA",
  "WEST VIRGINIA": "WV",
  "WISCONSIN": "WI",
  "WYOMING": "WY",
  "DISTRICT OF COLUMBIA": "DC",
  "WASHINGTON DC": "DC",
  "WASHINGTON D.C.": "DC",
  "D.C.": "DC",
  "PUERTO RICO": "PR",

  // Canadian Provinces
  "ALBERTA": "AB",
  "BRITISH COLUMBIA": "BC",
  "MANITOBA": "MB",
  "NEW BRUNSWICK": "NB",
  "NEWFOUNDLAND": "NL",
  "NEWFOUNDLAND AND LABRADOR": "NL",
  "NOVA SCOTIA": "NS",
  "NORTHWEST TERRITORIES": "NT",
  "NUNAVUT": "NU",
  "ONTARIO": "ON",
  "PRINCE EDWARD ISLAND": "PE",
  "PEI": "PE",
  "QUEBEC": "QC",
  "SASKATCHEWAN": "SK",
  "YUKON": "YT",
  "YUKON TERRITORY": "YT",
};

/**
 * Try to get geographic center coordinates for a state/province
 *
 * @param {string} address - State name or code (e.g., "NC", "North Carolina", "Ontario")
 * @returns {Object|null} - {lat, lng, name, geocode_source} or null
 */
function tryGetStateCenterCoords(address) {
  if (!address || typeof address !== "string") return null;

  const normalized = address.trim().toUpperCase();
  if (!normalized) return null;

  // Try direct code match for US states
  if (US_STATE_CENTERS[normalized]) {
    return {
      ...US_STATE_CENTERS[normalized],
      geocode_source: "state_center",
      geocode_precision: "administrative_area_level_1",
    };
  }

  // Try direct code match for Canadian provinces
  if (CA_PROVINCE_CENTERS[normalized]) {
    return {
      ...CA_PROVINCE_CENTERS[normalized],
      geocode_source: "province_center",
      geocode_precision: "administrative_area_level_1",
    };
  }

  // Try name match
  const code = STATE_NAME_TO_CODE[normalized];
  if (code) {
    if (US_STATE_CENTERS[code]) {
      return {
        ...US_STATE_CENTERS[code],
        geocode_source: "state_center",
        geocode_precision: "administrative_area_level_1",
      };
    }
    if (CA_PROVINCE_CENTERS[code]) {
      return {
        ...CA_PROVINCE_CENTERS[code],
        geocode_source: "province_center",
        geocode_precision: "administrative_area_level_1",
      };
    }
  }

  // Try parsing composite "state, country" strings (e.g., "UT, USA", "Ontario, Canada")
  const commaIndex = normalized.indexOf(",");
  if (commaIndex > 0) {
    const parts = normalized.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length === 2) {
      const statePart = parts[0];
      const countryPart = parts[1];

      if (isKnownUSCountryAlias(countryPart)) {
        if (US_STATE_CENTERS[statePart]) {
          return {
            ...US_STATE_CENTERS[statePart],
            geocode_source: "state_center",
            geocode_precision: "administrative_area_level_1",
          };
        }
        const usCode = STATE_NAME_TO_CODE[statePart];
        if (usCode && US_STATE_CENTERS[usCode]) {
          return {
            ...US_STATE_CENTERS[usCode],
            geocode_source: "state_center",
            geocode_precision: "administrative_area_level_1",
          };
        }
      }

      if (isKnownCACountryAlias(countryPart)) {
        if (CA_PROVINCE_CENTERS[statePart]) {
          return {
            ...CA_PROVINCE_CENTERS[statePart],
            geocode_source: "province_center",
            geocode_precision: "administrative_area_level_1",
          };
        }
        const caCode = STATE_NAME_TO_CODE[statePart];
        if (caCode && CA_PROVINCE_CENTERS[caCode]) {
          return {
            ...CA_PROVINCE_CENTERS[caCode],
            geocode_source: "province_center",
            geocode_precision: "administrative_area_level_1",
          };
        }
      }
    }
  }

  return null;
}

/**
 * Check if a location string appears to be just a state/province name or code
 *
 * @param {string} address - Location string to check
 * @returns {boolean} - true if it appears to be a state/province only
 */
function isStateOnlyLocation(address) {
  if (!address || typeof address !== "string") return false;

  const normalized = address.trim().toUpperCase();
  if (!normalized) return false;

  // Check if it matches a state code
  if (US_STATE_CENTERS[normalized] || CA_PROVINCE_CENTERS[normalized]) {
    return true;
  }

  // Check if it matches a state name
  if (STATE_NAME_TO_CODE[normalized]) {
    return true;
  }

  return false;
}

module.exports = {
  US_STATE_CENTERS,
  CA_PROVINCE_CENTERS,
  STATE_NAME_TO_CODE,
  tryGetStateCenterCoords,
  isStateOnlyLocation,
  isKnownUSCountryAlias,
  isKnownCACountryAlias,
};
