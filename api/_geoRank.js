/**
 * True nearest-company ranking over the pins index.
 *
 * Why this exists: a location search with no query had no geographic query at
 * all. Retrieval was `SELECT TOP 500 ... ORDER BY c._ts DESC` — the 500 most
 * recently UPDATED companies — re-ranked by distance afterwards. So the search
 * answered "which of the 500 most recently touched records is nearest?" A
 * search centred on San Dimas returned zero of the 19 companies actually in
 * San Dimas, while surfacing manufacturers in Corning NY and Hartford WI
 * (measured on production, 2026-08-12).
 *
 * The pins index already holds every company's coordinates, so ranking the
 * WHOLE catalog by real distance is a millisecond of arithmetic over ~13.7k
 * entries. The caller then hydrates only the page it needs.
 */

const EARTH_RADIUS_KM = 6371;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in km. */
function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Rank every mappable company by distance from a point.
 *
 * @param {object} payload - the pins index payload (v4 entry shape)
 * @param {{lat:number,lng:number}} origin
 * @param {"manu"|"hq"} mode - which locations count toward the distance
 * @returns {Array<{id: string, km: number}>} sorted nearest-first
 */
function rankByDistance(payload, origin, mode = "manu") {
  const rows = Array.isArray(payload?.companies) ? payload.companies : [];
  const lat = Number(origin?.lat);
  const lng = Number(origin?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];

  const ranked = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 7) continue;
    const [id, , , , hqLat, hqLng, mfg] = row;
    if (!id) continue;

    let best = Infinity;
    // HQ counts in both modes: a company whose HQ is here is genuinely near,
    // and in manu mode many companies have no separate manufacturing pin.
    if (Number.isFinite(hqLat) && Number.isFinite(hqLng)) {
      best = Math.min(best, haversineKm(lat, lng, hqLat, hqLng));
    }
    if (mode !== "hq" && Array.isArray(mfg)) {
      for (const p of mfg) {
        const pLat = Number(p?.[0]);
        const pLng = Number(p?.[1]);
        if (!Number.isFinite(pLat) || !Number.isFinite(pLng)) continue;
        best = Math.min(best, haversineKm(lat, lng, pLat, pLng));
      }
    }
    if (best === Infinity) continue;
    ranked.push({ id: String(id), km: best });
  }

  ranked.sort((a, b) => a.km - b.km || a.id.localeCompare(b.id));
  return ranked;
}

module.exports = { rankByDistance, haversineKm };
