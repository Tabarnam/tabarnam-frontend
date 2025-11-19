// Distance calculation and formatting utilities

// Countries that use miles instead of kilometers
const MILES_COUNTRIES = new Set([
  "US", "GB", "LR",
  "AG", "BS", "BB", "BZ", "VG", "KY", "DM", "FK", "GD", "GU", "MS", "MP", "KN",
  "LC", "VC", "WS", "TC", "VI", "AI", "GI", "IM", "JE", "GG", "SH", "AS", "PR"
]);

/**
 * Calculate distance between two points using Haversine formula
 * @param {number} lat1 - Latitude of first point
 * @param {number} lon1 - Longitude of first point
 * @param {number} lat2 - Latitude of second point
 * @param {number} lon2 - Longitude of second point
 * @returns {number} Distance in kilometers
 */
export function calculateDistance(lat1, lon1, lat2, lon2) {
  if (!isFinite(lat1) || !isFinite(lon1) || !isFinite(lat2) || !isFinite(lon2)) {
    return null;
  }

  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371; // Earth's radius in km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = 
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Convert kilometers to miles if needed based on country
 * @param {number} km - Distance in kilometers
 * @param {string} countryCode - ISO country code (e.g., 'US', 'GB')
 * @returns {number} Distance in appropriate unit (miles or km)
 */
export function convertDistanceUnit(km, countryCode) {
  if (!isFinite(km)) return null;
  const usesMiles = MILES_COUNTRIES.has(String(countryCode).toUpperCase());
  return usesMiles ? km * 0.621371 : km;
}

/**
 * Format distance for display
 * @param {number} distance - Distance value
 * @param {string} countryCode - ISO country code for unit selection
 * @returns {string} Formatted distance string (e.g., "2.3 mi" or "3.7 km")
 */
export function formatDistance(distance, countryCode) {
  if (!isFinite(distance)) return "—";
  
  const usesMiles = MILES_COUNTRIES.has(String(countryCode).toUpperCase());
  const unit = usesMiles ? "mi" : "km";
  const converted = usesMiles ? distance * 0.621371 : distance;
  
  return `${converted.toFixed(1)} ${unit}`;
}

/**
 * Determine if a country uses miles
 * @param {string} countryCode - ISO country code
 * @returns {boolean} True if country uses miles
 */
export function usesMiles(countryCode) {
  return MILES_COUNTRIES.has(String(countryCode).toUpperCase());
}

export default {
  calculateDistance,
  convertDistanceUnit,
  formatDistance,
  usesMiles,
};
