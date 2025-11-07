// src/pages/ResultsPage.jsx
import { xaiImport } from "@/lib/api/xaiImport";
import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { geocode } from "@/lib/google";
import SearchCard from "@/components/home/SearchCard";
import ExpandableCompanyRow from "@/components/results/ExpandableCompanyRow";
import { searchCompanies } from "@/lib/searchCompanies";
import { API_BASE } from "@/lib/api";

// Countries that use miles (for distance unit inference)
const milesCountries = new Set([
  "US","GB","LR","AG","BS","BB","BZ","VG","KY","DM","FK","GD","GU","MS","MP","KN",
  "LC","VC","WS","TC","VI","AI","GI","IM","JE","GG","SH","AS","PR"
]);

export default function ResultsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const qParam = (searchParams.get("q") ?? "").toString();
  const sortParam = (searchParams.get("sort") ?? "manu").toString();
  const countryParam = (searchParams.get("country") ?? "").toString();
  const stateParam = (searchParams.get("state") ?? "").toString();
  const cityParam = (searchParams.get("city") ?? "").toString();
  const latParam = (searchParams.get("lat") ?? "").toString();
  const lngParam = (searchParams.get("lng") ?? "").toString();

  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [userLoc, setUserLoc] = useState(null);
  const [unit, setUnit] = useState("mi");
  const [sortBy, setSortBy] = useState("manu");

  // Load reviews for companies
  async function loadReviews(companies) {
    const enriched = await Promise.all(
      companies.map(async (c) => {
        try {
          const r = await fetch(`${API_BASE}/get-reviews?company=${encodeURIComponent(c.company_name)}`);
          const data = await r.json().catch(() => ({ reviews: [] }));
          return {
            ...c,
            _reviews: Array.isArray(data.reviews) ? data.reviews : [],
          };
        } catch {
          return { ...c, _reviews: [] };
        }
      })
    );
    return enriched;
  }

  // Resolve a center location (from lat/lng or geocoding) and run the search
  useEffect(() => {
    let cancelled = false;

    (async () => {
      let loc = null;
      try {
        if (latParam && lngParam && !Number.isNaN(Number(latParam)) && !Number.isNaN(Number(lngParam))) {
          loc = { lat: Number(latParam), lng: Number(lngParam) };
        } else if (cityParam || stateParam || countryParam) {
          const addr = [cityParam, stateParam, countryParam].filter(Boolean).join(", ");
          const r = await geocode({ address: addr });
          loc = r?.best?.location || null;
          const cc = r?.best?.components?.find(c => c.types?.includes("country"))?.short_name;
          if (cc) setUnit(milesCountries.has(cc) ? "mi" : "km");
        } else {
          const r = await geocode({ ipLookup: true });
          loc = r?.best?.location || { lat: 34.0983, lng: -117.8076 };
          const cc = r?.best?.components?.find(c => c.types?.includes("country"))?.short_name;
          if (cc) setUnit(milesCountries.has(cc) ? "mi" : "km");
        }
      } catch {
        // ignore geocode errors
      }
      if (!cancelled && loc) setUserLoc({ lat: loc.lat, lng: loc.lng });

      setSortBy(sortParam === "hq" || sortParam === "stars" ? sortParam : "manu");

      if (!cancelled && qParam) {
        await doSearch({
          q: qParam,
          sort: sortParam,
          country: countryParam,
          state: stateParam,
          city: cityParam,
          take: 50,
        });
      } else if (!cancelled) {
        setResults([]);
        setStatus("");
      }
    })();

    return () => { cancelled = true; };
  }, [qParam, sortParam, countryParam, stateParam, cityParam, latParam, lngParam]);

  // Called by the top search bar
  async function handleInlineSearch(params) {
    const q = (params.q ?? "").toString();
    const sort = (params.sort ?? "manu").toString();
    const country = (params.country ?? "").toString();
    const state = (params.state ?? "").toString();
    const city = (params.city ?? "").toString();

    // Update URL for shareability (don’t include empty keys to keep it tidy)
    const next = new URLSearchParams();
    if (q) next.set("q", q);
    if (sort) next.set("sort", sort);
    if (country) next.set("country", country);
    if (state) next.set("state", state);
    if (city) next.set("city", city);
    setSearchParams(next, { replace: true });

    // Resolve typed location if present
    try {
      if (city || state || country) {
        const r = await geocode({ address: [city, state, country].filter(Boolean).join(", ") });
        const loc = r?.best?.location;
        if (loc) {
          setUserLoc({ lat: loc.lat, lng: loc.lng });
          const cc = r?.best?.components?.find(c => c.types?.includes("country"))?.short_name;
          if (cc) setUnit(milesCountries.has(cc) ? "mi" : "km");
        }
      }
    } catch {
      // ignore
    }

    setSortBy(sort === "hq" || sort === "stars" ? sort : "manu");
    await doSearch({ q, sort, country, state, city, take: 50 });
  }

  async function doSearch({ q, sort, country, state, city, take = 50 }) {
    setLoading(true);
    setStatus("Searching…");
    try {
      const { items = [], count, meta } = await searchCompanies({ q, sort, country, state, city, take });
      const withDistances = items.map((c) => normalizeStars(attachDistances(c, userLoc, unit)));
      const withReviews = await loadReviews(withDistances);
      setResults(withReviews);

      if (meta?.error) {
        setStatus(`⚠️ Search API unavailable - showing 0 results. Error: ${meta.error}`);
      } else if (count === 0) {
        setStatus("No companies found matching your criteria.");
      } else {
        setStatus(`Found ${typeof count === "number" ? count : withReviews.length} companies`);
      }
    } catch (e) {
      setStatus(`❌ ${e?.message || "Search failed"}`);
    } finally {
      setLoading(false);
    }
  }

  // Secondary sort (client-side)
  const sorted = useMemo(() => {
    const arr = [...results];
    if (sortBy === "stars") {
      arr.sort((a, b) => (getStarScore(b) ?? -Infinity) - (getStarScore(a) ?? -Infinity));
    } else if (sortBy === "manu") {
      arr.sort((a, b) => (a._nearestManuDist ?? Infinity) - (b._nearestManuDist ?? Infinity));
    } else {
      arr.sort((a, b) => (a._hqDist ?? Infinity) - (b._hqDist ?? Infinity));
    }
    return arr;
  }, [results, sortBy]);

  const rightColsOrder = useMemo(() => {
    if (sortBy === "stars") return ["stars", "manu", "hq"];
    if (sortBy === "hq") return ["hq", "manu", "stars"];
    return ["manu", "hq", "stars"];
  }, [sortBy]);

  const headerClassFor = (key) =>
    `p-2 select-none cursor-pointer border-l ${
      sortBy === key
        ? "bg-amber-100 text-amber-900 font-semibold border-amber-200"
        : "bg-gray-100 text-gray-800"
    }`;
  const cellClassFor = (key) => `p-2 ${sortBy === key ? "bg-amber-50 text-gray-900" : ""}`;

  const clickSort = (key) => {
    if (key === "manu") setSortBy("manu");
    else if (key === "hq") setSortBy("hq");
    else setSortBy("stars");
  };

  function handleKeywordSearch(keyword) {
    const next = new URLSearchParams(searchParams);
    next.set("q", keyword);
    setSearchParams(next, { replace: true });
  }

  return (
    <div className="px-4 pb-10 max-w-6xl mx-auto">
      {/* Two-row search under the site header */}
      <div className="mt-6 mb-4">
        <SearchCard onSubmitParams={handleInlineSearch} />
      </div>

      {/* --- XAI Import Debug (dev-only; safe to remove later) --- */}
      {import.meta.env.DEV && (
        <div className="p-3 mb-4 border rounded">
          <div className="text-sm mb-2">XAI Import Debug</div>
          <button
            className="px-3 py-2 rounded text-black"
            style={{ background: "#B1DDE3" }}
            onClick={async () => {
              try {
                setStatus("Running XAI import…");
                const resp = await xaiImport({
                  queryType: "product_keyword",
                  query: qParam || "candles",
                  limit: 10,
                  center: userLoc || undefined
                });
                const enriched = (resp.companies || []).map((c) =>
                  normalizeStars(attachDistances(c, userLoc, unit))
                );
                setResults(enriched);
                setStatus(`XAI import returned ${enriched.length} companies`);
              } catch (e) {
                setStatus(`❌ ${e?.message || "XAI import failed"}`);
              }
            }}
          >
            Run Import (XAI)
          </button>
        </div>
      )}

      <div className="text-sm mb-3">
        {status && (
          <div className={`px-4 py-2 rounded ${
            status.includes("❌") ? "bg-red-50 text-red-700" :
            status.includes("⚠️") ? "bg-yellow-50 text-yellow-700" :
            status.includes("Found") ? "bg-green-50 text-green-700" :
            "text-gray-700"
          }`}>
            {status}
          </div>
        )}
      </div>

      {/* Dig Deep Button */}
      {results.length < 50 && results.length > 0 && (
        <div className="mb-4 flex justify-center">
          <button
            className="text-xs px-3 py-1.5 border border-gray-300 rounded hover:bg-gray-50 text-gray-700 font-medium transition-colors"
            title="Refine your search and we'll go find more companies but it will take a minute."
            disabled={loading}
          >
            Dig Deeper
          </button>
        </div>
      )}

      {/* Translation Toggle */}
      {results.length > 0 && (
        <div className="mb-4 flex justify-end">
          <select className="text-xs border border-gray-300 rounded px-2 py-1.5 bg-white text-gray-700 font-medium hover:border-gray-400 transition-colors" defaultValue="en">
            <option value="en">English</option>
            <option value="es">Español</option>
            <option value="fr">Français</option>
            <option value="de">Deutsch</option>
            <option value="zh">中文</option>
            <option value="ja">日本語</option>
          </select>
        </div>
      )}

      {/* Results List */}
      <div className="mb-4">
        {sorted.length > 0 ? (
          <div className="space-y-0">
            {sorted.map((company) => (
              <ExpandableCompanyRow
                key={company.id || company.company_name}
                company={company}
                sortBy={sortBy}
                unit={unit}
                onKeywordSearch={handleKeywordSearch}
                rightColsOrder={rightColsOrder}
              />
            ))}
          </div>
        ) : (
          <div className="p-8 text-center">
            {loading ? (
              <div className="flex items-center justify-center gap-2">
                <div className="animate-spin text-tabarnam-blue">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                </div>
                <span className="text-gray-600">Searching…</span>
              </div>
            ) : (
              <div className="text-gray-500">
                <p className="text-lg font-medium mb-1">No companies found</p>
                <p className="text-sm">Try adjusting your search terms or filters</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- helpers ---------- */
function attachDistances(c, userLoc, unit) {
  const out = { ...c, _hqDist: null, _nearestManuDist: null, _manuDists: [] };

  // HQ
  if (userLoc && isNum(c.hq_lat) && isNum(c.hq_lng)) {
    const km = haversine(userLoc.lat, userLoc.lng, c.hq_lat, c.hq_lng);
    out._hqDist = unit === "mi" ? km * 0.621371 : km;
  }

  // Manufacturing
  if (userLoc && Array.isArray(c.manufacturing_geocodes) && c.manufacturing_geocodes.length) {
    const dists = c.manufacturing_geocodes
      .filter(m => isNum(m.lat) && isNum(m.lng))
      .map(m => {
        const km = haversine(userLoc.lat, userLoc.lng, m.lat, m.lng);
        const d = unit === "mi" ? km * 0.621371 : km;
        return { ...m, dist: d };
      })
      .sort((a, b) => a.dist - b.dist);
    out._manuDists = dists;
    out._nearestManuDist = dists.length ? dists[0].dist : null;
  }
  return out;
}
function normalizeStars(c) {
  if (isNum(c.star_score)) return c;
  if (isNum(c.star_rating)) return { ...c, star_score: clamp(c.star_rating, 0, 5) };
  if (isNum(c.confidence_score)) return { ...c, star_score: clamp(c.confidence_score * 5, 0, 5) };
  return { ...c, star_score: null };
}
function getStarScore(c) {
  return isNum(c.star_score) ? c.star_score
    : isNum(c.star_rating) ? clamp(c.star_rating, 0, 5)
    : isNum(c.confidence_score) ? clamp(c.confidence_score * 5, 0, 5)
    : null;
}
function renderStars(score) { if (!isNum(score)) return "—"; return `${score.toFixed(1)}★`; }
function labelFor(key) { if (key === "manu") return "Manufacturing"; if (key === "hq") return "HQ"; return "Stars"; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function formatDist(d, unit) { return typeof d === "number" ? `${d.toFixed(1)} ${unit}` : "—"; }
function haversine(lat1, lon1, lat2, lon2) {
  const toRad = d => (d*Math.PI)/180, R=6371;
  const dLat = toRad(lat2-lat1), dLon = toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}
function isNum(v){ return Number.isFinite(v); }
