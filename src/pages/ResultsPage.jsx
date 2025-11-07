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

      {/* Results Table */}
      <div className="border rounded-lg overflow-hidden mb-4 bg-white">
        {sorted.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gradient-to-r from-gray-50 to-gray-100">
                  <th className="p-4 text-left font-semibold text-gray-900">Company</th>
                  <th className="p-4 text-left font-semibold text-gray-900 hidden sm:table-cell">Industries</th>
                  <th className="p-4 text-left font-semibold text-gray-900 hidden md:table-cell">Keywords</th>
                  <th className="p-4 text-left font-semibold text-gray-900 hidden lg:table-cell">Links</th>
                  {rightColsOrder.map((key) => (
                    <th
                      key={key}
                      className={`p-4 text-left font-semibold cursor-pointer transition-colors ${
                        sortBy === key
                          ? "bg-amber-50 text-amber-900"
                          : "text-gray-900 hover:bg-gray-50"
                      }`}
                      onClick={() => clickSort(key)}
                      title={`Sort by ${labelFor(key)}`}
                    >
                      <div className="flex items-center gap-1">
                        {labelFor(key)}
                        {sortBy === key && <span className="text-amber-600">▾</span>}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((c, i) => (
                  <tr key={(c.id || c.company_name || "row") + "-" + i} className="border-b hover:bg-gray-50 transition-colors">
                    {/* NAME + social + reviews */}
                    <td className="p-4">
                      <div className="font-semibold text-gray-900">{c.company_name || "—"}</div>
                      {c.company_tagline && <div className="text-xs text-gray-500 mt-1">{c.company_tagline}</div>}
                      <div className="mt-2">
                        <SocialBadges links={c.social} className="mt-1" brandColors variant="solid" />
                        <ReviewsWidget companyName={c.company_name} />
                      </div>
                    </td>

                    {/* Industries */}
                    <td className="p-4 hidden sm:table-cell">
                      <div className="text-gray-700">
                        {Array.isArray(c.industries) ? c.industries.join(", ") : (c.industries || "—")}
                      </div>
                    </td>

                    {/* Keywords */}
                    <td className="p-4 hidden md:table-cell">
                      <div className="text-gray-600 text-xs">
                        {String(c.product_keywords || "")
                          .split(",")
                          .map(s => s.trim())
                          .filter(Boolean)
                          .slice(0, 5)
                          .map((kw, idx) => (
                            <span key={idx} className="inline-block bg-gray-200 text-gray-700 px-2 py-1 rounded mr-1 mb-1">
                              {kw}
                            </span>
                          ))}
                      </div>
                    </td>

                    {/* Links */}
                    <td className="p-4 hidden lg:table-cell">
                      <div className="space-y-1">
                        {c.url && (
                          <a href={c.url} target="_blank" rel="noreferrer" className="block text-blue-600 hover:underline text-xs truncate">
                            Website
                          </a>
                        )}
                        {c.amazon_url && (
                          <a href={c.amazon_url} target="_blank" rel="noreferrer" className="block text-blue-600 hover:underline text-xs truncate">
                            Amazon
                          </a>
                        )}
                      </div>
                    </td>

                    {/* Dynamic right-most trio: location + distance or stars */}
                    {rightColsOrder.map((key) => (
                      <td key={key} className={`p-4 ${sortBy === key ? "bg-amber-50" : ""}`}>
                        {key === "manu" && (
                          <div className="text-sm">
                            <div className="font-medium text-gray-900">{nearestManufacturingLocation(c) || "—"}</div>
                            <div className="text-xs text-gray-500">{formatDist(c._nearestManuDist, unit)}</div>
                          </div>
                        )}
                        {key === "hq" && (
                          <div className="text-sm">
                            <div className="font-medium text-gray-900">{formatHQ(c) || "—"}</div>
                            <div className="text-xs text-gray-500">{formatDist(c._hqDist, unit)}</div>
                          </div>
                        )}
                        {key === "stars" && (
                          <div className="text-lg font-semibold text-amber-600">{renderStars(getStarScore(c))}</div>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
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
function nearestManufacturingLocation(c) {
  const list = Array.isArray(c.manufacturing_geocodes) ? c.manufacturing_geocodes : [];
  if (!list.length) return null;
  const first = list
    .filter(m => isNum(m.lat) && isNum(m.lng))
    .sort((a, b) => (a.dist ?? Infinity) - (b.dist ?? Infinity))[0];
  if (!first) return null;
  return first.formatted_address || cityStateCountry(first) || "Manufacturing";
}
function formatHQ(c) {
  if (!c.headquarters_location) return null;
  return c.headquarters_location;
}
function cityStateCountry(obj) {
  const parts = [obj.city, obj.state, obj.country].filter(Boolean);
  return parts.join(", ");
}
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
