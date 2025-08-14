// List of countries and territories that officially or primarily use miles.
const MILES_TERRITORIES = new Set([
    'US', // United States
    'GB', // United Kingdom
    'LR', // Liberia
    // Supported Territories
    'AI', // Anguilla
    'AG', // Antigua and Barbuda
    'BS', // Bahamas
    'BB', // Barbados
    'BZ', // Belize
    'VG', // British Virgin Islands
    'KY', // Cayman Islands
    'DM', // Dominica
    'FK', // Falkland Islands
    'GI', // Gibraltar
    'GD', // Grenada
    'GG', // Guernsey
    'GU', // Guam
    'IM', // Isle of Man
    'JE', // Jersey
    'MS', // Montserrat
    'MP', // Northern Mariana Islands
    'PR', // Puerto Rico
    'SH', // Saint Helena, Ascension and Tristan da Cunha
    'KN', // Saint Kitts and Nevis
    'LC', // Saint Lucia
    'VC', // Saint Vincent and the Grenadines
    'WS', // Samoa
    'AS', // American Samoa
    'TC', // Turks and Caicos Islands
    'VI',  // United States Virgin Islands
]);


/**
 * Calculates the distance between two points on Earth using the Haversine formula.
 * @param {number} lat1 Latitude of the first point
 * @param {number} lon1 Longitude of the first point
 * @param {number} lat2 Latitude of the second point
 * @param {number} lon2 Longitude of the second point
 * @returns {number} The distance in kilometers.
 */
export function calculateDistance(lat1, lon1, lat2, lon2) {
    if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) {
        return Infinity;
    }
    const R = 6371; // Radius of the Earth in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Distance in km
}

/**
 * Formats the distance, converting to miles if the country uses them.
 * @param {number} distanceInKm The distance in kilometers.
 * @param {string} countryCode The ISO 3166-1 alpha-2 country code of the location.
 * @returns {string} The formatted distance string, or an empty string if not applicable.
 */
export function formatDistance(distanceInKm, countryCode) {
    if (distanceInKm === Infinity || distanceInKm == null) {
        return "";
    }

    const countryUsesMiles = MILES_TERRITORIES.has(countryCode?.toUpperCase());

    if (countryUsesMiles) {
        const distanceInMiles = distanceInKm * 0.621371;
        return `${Math.round(distanceInMiles)} miles`;
    }

    // Per instructions, do not show km for other countries yet.
    return "";
}