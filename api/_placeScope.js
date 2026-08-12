/**
 * Place-scoped company sets, derived from the pins index.
 *
 * A location search used to report a catalog-wide number: searching San Dimas
 * said "13,739 closest results", because every company in the catalog has SOME
 * distance from San Dimas. That answers a question nobody asked. What a user
 * wants first is how many companies are actually IN the place they named, and
 * only then what else is close by.
 *
 * This module answers the first half — exact membership, from the labels and
 * ISO region codes the pins index already carries. The second half (the nearby
 * band) is distance work and lives in _geoRank.js.
 *
 * Membership is deliberately strict. A company counts as "in San Dimas" only
 * when its address says San Dimas. About 39% of manufacturing pins are
 * country-centroid only ("China", "USA") and carry no city at all; those can
 * never satisfy a city scope, so they fall through to the nearby band instead.
 * That is the right failure: an unlabelled company gets demoted to "nearby",
 * never mislabelled as being somewhere it might not be.
 */

const { getPins } = require("./_pinsIndex");

// Rebuilt only when the pins payload changes (generated_at is its identity).
let _cache = { generatedAt: null, sets: null };

/**
 * Fold a pin's place label down to a comparable city key.
 *
 * Labels arrive in whatever shape the geocoder's formatted address had:
 * "Los Angeles, CA", "Milan, Metropolitan City of Milan",
 * "36100 Vicenza, Province of Vicenza", "41012 Carpi MO, Italy". The city is
 * reliably the first comma-separated segment; the rest is administrative
 * tail. A label with NO comma is a bare country or region ("China", "USA") —
 * not a city, so it keys to null and never matches a city scope.
 */
function normalizeCityKey(label) {
  const raw = String(label || "").trim();
  if (!raw) return null;
  const comma = raw.indexOf(",");
  if (comma === -1) return null; // country/region-level label, not a city

  let city = raw.slice(0, comma).trim();
  if (!city) return null;

  // Leading postal code, the continental-European convention:
  // "36100 Vicenza" -> "Vicenza", "41012 Carpi MO" -> "Carpi MO".
  const hadLeadingPostal = /^\d[\d-]{2,}\s+/.test(city);
  if (hadLeadingPostal) city = city.replace(/^\d[\d-]{2,}\s+/, "").trim();

  // Only strip a trailing province abbreviation when a leading postal code
  // established that this IS the "CAP City PROV" format ("Carpi MO" -> Carpi).
  // Unconditionally dropping a trailing two-letter token would mangle real
  // names like "Lake Forest CA" differently from "Washington DC".
  if (hadLeadingPostal) city = city.replace(/\s+[A-Z]{2}$/, "").trim();

  // Trailing postal fragments ("Italy Cross" is fine, "B4V 0P6" is not).
  city = city.replace(/\s+[A-Z0-9]{2,4}\s*\d[A-Z0-9]{2}$/i, "").trim();

  const folded = city
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics: Zurich stays Zurich
    .replace(/[.'’]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  return folded || null;
}

function addTo(map, key, id) {
  if (!key || !id) return;
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(id);
}

function buildSets(payload) {
  const cityMfg = new Map();
  const cityHq = new Map();
  const regionMfg = new Map();
  const regionHq = new Map();

  for (const row of Array.isArray(payload?.companies) ? payload.companies : []) {
    if (!Array.isArray(row) || row.length < 7) continue;
    const id = String(row[0] || "");
    if (!id) continue;

    // Manufacturing: every pin carries its own cc / region / label, so a
    // company with plants in three countries lands in three scopes.
    for (const pin of Array.isArray(row[6]) ? row[6] : []) {
      if (!Array.isArray(pin)) continue;
      const [, , lowPrecision, cc, region, label] = pin;
      // A country-centroid pin is not evidence of being in any city.
      if (!lowPrecision) {
        const norm = normalizeCityKey(label);
        if (norm) addTo(cityMfg, `${String(cc || "??").toUpperCase()}|${norm}`, id);
      }
      if (region) addTo(regionMfg, String(region).toUpperCase(), id);
    }

    // Headquarters: one label, one region, on the row itself.
    const hqNorm = normalizeCityKey(row[11]);
    if (hqNorm) addTo(cityHq, `${String(row[7] || "??").toUpperCase()}|${hqNorm}`, id);
    if (row[9]) addTo(regionHq, String(row[9]).toUpperCase(), id);
  }

  return { cityMfg, cityHq, regionMfg, regionHq };
}

/**
 * Resolve the most specific scope the caller gave us.
 *
 * City beats region: someone who typed "San Dimas" is asking
 * about San Dimas, not California. When a city resolves to nothing at all we
 * fall back to the broader scope rather than claiming zero — a city we have no
 * labels for is a gap in our data, not an empty town.
 *
 * @param {{city?:string, region?:string, country?:string}} want
 * @param {object} sets - from buildSets
 * @param {"manu"|"hq"} mode
 * @returns {{level:"city"|"region", key:string, ids:Set<string>}|null}
 */
function resolveScope(want, sets, mode = "manu") {
  if (!sets) return null;
  const cityMap = mode === "hq" ? sets.cityHq : sets.cityMfg;
  const regionMap = mode === "hq" ? sets.regionHq : sets.regionMfg;

  const country = String(want?.country || "").trim().toUpperCase();

  const cityName = String(want?.city || "").trim();
  if (cityName) {
    const norm = normalizeCityKey(`${cityName},`);
    if (norm) {
      const exact = cityMap.get(`${country || "??"}|${norm}`);
      if (exact && exact.size > 0) {
        return { level: "city", key: cityName, ids: exact };
      }
      // No country in hand: accept a single unambiguous city match across
      // countries, but never merge homonyms — two Springfields are not one
      // place and silently unioning them would inflate the count.
      if (!country) {
        const hits = [];
        for (const [key, set] of cityMap) {
          if (key.endsWith(`|${norm}`)) hits.push(set);
        }
        if (hits.length === 1) return { level: "city", key: cityName, ids: hits[0] };
      }
    }
  }

  const region = String(want?.region || "").trim().toUpperCase();
  if (region) {
    const set = regionMap.get(region);
    if (set && set.size > 0) return { level: "region", key: region, ids: set };
  }

  // No country level here on purpose. Country membership assembled from city
  // labels would miss every country-centroid pin — the ones labelled just
  // "China" — and quietly under-report. Country scope belongs to
  // _countryIndex.js, which resolves it from each pin's own country code.
  return null;
}

/**
 * @returns {Promise<object|null>} the scope sets, or null when the index is cold
 */
async function getScopeSets(container) {
  const pins = await getPins(container);
  const payload = pins?.payload;
  if (!payload) return null;
  if (_cache.generatedAt !== payload.generated_at) {
    _cache = { generatedAt: payload.generated_at, sets: buildSets(payload) };
  }
  return _cache.sets;
}

module.exports = { getScopeSets, resolveScope, buildSets, normalizeCityKey };
