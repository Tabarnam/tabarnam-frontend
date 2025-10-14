// src/lib/google.js
// Client helpers for /google/* via API_BASE

import { API_BASE } from "@/lib/api";

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

  const r = await fetch(`${API_BASE}/google/geocode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, lat, lng, ipLookup })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || r.statusText || "geocode failed");
  _set(key, data);
  return data;
}

// Pass-through stub kept for compatibility
export async function translate({ text, target = "en" }) {
  const r = await fetch(`${API_BASE}/google/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, target })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || r.statusText || "translate failed");
  return data;
}
