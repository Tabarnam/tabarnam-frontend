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

const KM_PER_MI = 1.609344;

// Bands are round numbers in the user's own unit, because the radius gets
// printed back to them ("145 more within 25 mi"). Picking bands in km and
// converting would surface "within 16 mi", which reads like a measurement
// rather than a choice.
const NEARBY_BANDS = [10, 25, 50, 100, 250];
const NEARBY_MIN = 25;

/**
 * Choose the tightest radius that still shows a useful number of neighbours.
 *
 * A fixed radius is wrong in both directions: 50 miles around Los Angeles is
 * noise, and 50 miles around a village in Piedmont is barely anything. So walk
 * outward through round numbers and stop as soon as the band holds enough
 * companies — dense metros stay tight, sparse regions reach further. If even
 * the widest band is thin, that IS the answer; return it and let the UI say so.
 *
 * @param {Array<{id:string, km:number}>} ranked - nearest-first, from rankByDistance
 * @param {Set<string>} excludeIds - companies already counted as in-scope
 * @param {{unit?:"mi"|"km", minCount?:number}} opts
 * @returns {{ids: string[], radius: number, unit: "mi"|"km"}}
 */
function pickNearbyBand(ranked, excludeIds, opts = {}) {
  const unit = opts.unit === "km" ? "km" : "mi";
  const minCount = Number.isFinite(opts.minCount) ? opts.minCount : NEARBY_MIN;
  const toKm = (v) => (unit === "km" ? v : v * KM_PER_MI);

  const candidates = [];
  for (const r of Array.isArray(ranked) ? ranked : []) {
    if (excludeIds && excludeIds.has(r.id)) continue;
    candidates.push(r);
  }

  let chosen = NEARBY_BANDS[NEARBY_BANDS.length - 1];
  for (const band of NEARBY_BANDS) {
    const limit = toKm(band);
    // ranked is sorted, so the first entry past the limit ends the band.
    let count = 0;
    for (const c of candidates) {
      if (c.km > limit) break;
      count++;
    }
    if (count >= minCount) {
      chosen = band;
      break;
    }
  }

  const limitKm = toKm(chosen);
  const ids = [];
  for (const c of candidates) {
    if (c.km > limitKm) break;
    ids.push(c.id);
  }
  return { ids, radius: chosen, unit };
}

module.exports = { rankByDistance, haversineKm, pickNearbyBand, NEARBY_BANDS };
