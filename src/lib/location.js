// src/lib/location.js
// Country/subdivision helpers + distance utilities

// ----- Minimal inline seeds so the UI isn't empty before the JSONs load -----
const INLINE = {
  countries: [
    { code: 'US', name: 'United States' },
    { code: 'CA', name: 'Canada' },
    { code: 'GB', name: 'United Kingdom' },
    { code: 'AU', name: 'Australia' }
  ],
  subdivisions: {
    US: [
      { code: 'AL', name: 'Alabama' }, { code: 'AK', name: 'Alaska' }, { code: 'AZ', name: 'Arizona' },
      { code: 'AR', name: 'Arkansas' }, { code: 'CA', name: 'California' }, { code: 'CO', name: 'Colorado' },
      { code: 'CT', name: 'Connecticut' }, { code: 'DE', name: 'Delaware' }, { code: 'FL', name: 'Florida' },
      { code: 'GA', name: 'Georgia' }, { code: 'HI', name: 'Hawaii' }, { code: 'ID', name: 'Idaho' },
      { code: 'IL', name: 'Illinois' }, { code: 'IN', name: 'Indiana' }, { code: 'IA', name: 'Iowa' },
      { code: 'KS', name: 'Kansas' }, { code: 'KY', name: 'Kentucky' }, { code: 'LA', name: 'Louisiana' },
      { code: 'ME', name: 'Maine' }, { code: 'MD', name: 'Maryland' }, { code: 'MA', name: 'Massachusetts' },
      { code: 'MI', name: 'Michigan' }, { code: 'MN', name: 'Minnesota' }, { code: 'MS', name: 'Mississippi' },
      { code: 'MO', name: 'Missouri' }, { code: 'MT', name: 'Montana' }, { code: 'NE', name: 'Nebraska' },
      { code: 'NV', name: 'Nevada' }, { code: 'NH', name: 'New Hampshire' }, { code: 'NJ', name: 'New Jersey' },
      { code: 'NM', name: 'New Mexico' }, { code: 'NY', name: 'New York' }, { code: 'NC', name: 'North Carolina' },
      { code: 'ND', name: 'North Dakota' }, { code: 'OH', name: 'Ohio' }, { code: 'OK', name: 'Oklahoma' },
      { code: 'OR', name: 'Oregon' }, { code: 'PA', name: 'Pennsylvania' }, { code: 'RI', name: 'Rhode Island' },
      { code: 'SC', name: 'South Carolina' }, { code: 'SD', name: 'South Dakota' }, { code: 'TN', name: 'Tennessee' },
      { code: 'TX', name: 'Texas' }, { code: 'UT', name: 'Utah' }, { code: 'VT', name: 'Vermont' },
      { code: 'VA', name: 'Virginia' }, { code: 'WA', name: 'Washington' }, { code: 'WV', name: 'West Virginia' },
      { code: 'WI', name: 'Wisconsin' }, { code: 'WY', name: 'Wyoming' }
    ],
    CA: [
      { code: 'AB', name: 'Alberta' }, { code: 'BC', name: 'British Columbia' }, { code: 'MB', name: 'Manitoba' },
      { code: 'NB', name: 'New Brunswick' }, { code: 'NL', name: 'Newfoundland and Labrador' },
      { code: 'NS', name: 'Nova Scotia' }, { code: 'NT', name: 'Northwest Territories' },
      { code: 'NU', name: 'Nunavut' }, { code: 'ON', name: 'Ontario' }, { code: 'PE', name: 'Prince Edward Island' },
      { code: 'QC', name: 'Quebec' }, { code: 'SK', name: 'Saskatchewan' }, { code: 'YT', name: 'Yukon' }
    ]
  }
};

// cache
const memo = new Map();

export async function loadCountries() {
  if (memo.has('countries')) return memo.get('countries');
  try {
    const res = await fetch('/geo/countries.json');
    if (res.ok) {
      const list = await res.json();
      memo.set('countries', list);
      return list;
    }
  } catch {}
  memo.set('countries', INLINE.countries);
  return INLINE.countries;
}

export async function loadSubdivisions(countryCode) {
  if (!countryCode) return [];
  if (memo.has(`sub:${countryCode}`)) return memo.get(`sub:${countryCode}`);

  // Inline quick paths
  if (INLINE.subdivisions[countryCode]) {
    memo.set(`sub:${countryCode}`, INLINE.subdivisions[countryCode]);
    return INLINE.subdivisions[countryCode];
  }

  // Lazy load from /public/geo/<country>.json
  try {
    const res = await fetch(`/geo/${countryCode}.json`);
    if (res.ok) {
      const list = await res.json();
      memo.set(`sub:${countryCode}`, list);
      return list;
    }
  } catch {}
  memo.set(`sub:${countryCode}`, []);
  return [];
}

// ----- Distance helpers used by results table/components -----
export function calculateDistance(lat1, lon1, lat2, lon2) {
  const toRad = d => (d * Math.PI) / 180;
  const R = 6371; // km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const km = 2 * R * Math.asin(Math.sqrt(a));
  return km;
}

export function formatDistance(km, countryCode = "US") {
  if (!Number.isFinite(km)) return "";
  const useMiles = new Set(["US","GB","LR"]).has(countryCode);
  const val = useMiles ? km * 0.621371 : km;
  const unit = useMiles ? "mi" : "km";
  return `${val.toFixed(1)} ${unit}`;
}
