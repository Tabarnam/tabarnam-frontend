// Client helpers for /api/google/* with tiny LRU caches

const GEO_TTL = 10 * 60 * 1000; // 10m
const GEO_MAX = 200;
const _geoCache = new Map();
const _now = () => Date.now();
const _get = (k) => {
  const v = _geoCache.get(k);
  if (!v) return null;
  if (_now() - v.t > GEO_TTL) { _geoCache.delete(k); return null; }
  return v.d;
};
const _set = (k, d) => {
  if (_geoCache.size >= GEO_MAX) _geoCache.delete(_geoCache.keys().next().value);
  _geoCache.set(k, { t: _now(), d });
};

export async function geocode({ address, lat, lng, ipLookup = true } = {}) {
  const key = JSON.stringify({ address, lat, lng, ipLookup });
  const hit = _get(key);
  if (hit) return hit;

  const r = await fetch("/api/google/geocode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, lat, lng, ipLookup })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error || r.statusText);
  _set(key, data);
  return data;
}

// pass-through stub (kept because some pages import translate)
export async function translate({ text, target = "en" }) {
  const r = await fetch("/api/google/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, target })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error || r.statusText);
  return data;
}
