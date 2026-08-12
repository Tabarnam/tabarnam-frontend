/**
 * Company-id sets by country, derived from the pins index.
 *
 * The country filters used to match by scanning location STRINGS for country
 * tokens ("italy", "italia", "it"). That is both lossy and false-positive
 * prone — the codebase already carries a fix for "Milwaukee" matching "uk" —
 * and it only ever saw whichever candidates the retrieval pass happened to
 * return. The pins index resolves every company's countries once, at build
 * time, with the full address-tail logic in _countryResolve.js, so filtering
 * becomes an O(1) set membership test against the WHOLE catalog.
 */

const { getPins } = require("./_pinsIndex");

// Rebuilt only when the pins payload changes (generated_at is its identity).
let _cache = { generatedAt: null, mfgByCC: null, hqByCC: null };

function buildSets(payload) {
  const mfgByCC = new Map();
  const hqByCC = new Map();
  const add = (map, cc, id) => {
    if (!cc) return;
    let set = map.get(cc);
    if (!set) {
      set = new Set();
      map.set(cc, set);
    }
    set.add(id);
  };
  for (const row of Array.isArray(payload?.companies) ? payload.companies : []) {
    if (!Array.isArray(row) || row.length < 9) continue;
    const id = String(row[0] || "");
    if (!id) continue;
    add(hqByCC, row[7], id);
    for (const cc of Array.isArray(row[8]) ? row[8] : []) add(mfgByCC, cc, id);
  }
  return { mfgByCC, hqByCC };
}

/**
 * @returns {Promise<{mfg: (cc:string)=>Set<string>|null, hq: (cc:string)=>Set<string>|null}|null>}
 */
async function getCountrySets(container) {
  const pins = await getPins(container);
  const payload = pins?.payload;
  if (!payload) return null;
  if (_cache.generatedAt !== payload.generated_at) {
    const { mfgByCC, hqByCC } = buildSets(payload);
    _cache = { generatedAt: payload.generated_at, mfgByCC, hqByCC };
  }
  const norm = (cc) => String(cc || "").trim().toUpperCase();
  return {
    mfg: (cc) => _cache.mfgByCC.get(norm(cc)) || null,
    hq: (cc) => _cache.hqByCC.get(norm(cc)) || null,
  };
}

module.exports = { getCountrySets };
