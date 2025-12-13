// src/pages/ResultsPage.jsx
import { xaiImport } from "@/lib/api/xaiImport";
import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import PinIcon from "@/assets/tabarnam-pin.jpg";
import { geocode } from "@/lib/google";
import { calculateDistance, usesMiles } from "@/lib/distance";
import SearchCard from "@/components/home/SearchCard";
import ExpandableCompanyRow from "@/components/results/ExpandableCompanyRow";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { searchCompanies } from "@/lib/searchCompanies";
import { API_BASE } from "@/lib/api";
import { getQQScore } from "@/lib/stars/qqRating";

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
  const [totalCount, setTotalCount] = useState(null);
  const [userLoc, setUserLoc] = useState(null);
  const [unit, setUnit] = useState("mi");
  const [sortBy, setSortBy] = useState("manu");

  // Load reviews for companies
  async function loadReviews(companies) {
    const enriched = await Promise.all(
      companies.map(async (c) => {
        try {
          const companyId = c.id || c.company_id;
          const qs = companyId
            ? `company_id=${encodeURIComponent(companyId)}`
            : `company=${encodeURIComponent(c.company_name)}`;
          const r = await fetch(`${API_BASE}/get-reviews?${qs}`);
          const data = await r.json().catch(() => ({ items: [], reviews: [] }));

          if (
            data?.meta &&
            typeof data.meta.company_curated_count === "number" &&
            data.meta.company_curated_count > 1 &&
            typeof data.count === "number" &&
            data.count < data.meta.company_curated_count
          ) {
            console.warn("[ResultsPage] Reviews regression: fewer reviews returned than stored", {
              company_id: companyId,
              company_name: c.company_name,
              returned: data.count,
              stored_curated: data.meta.company_curated_count,
              company_record_id: data.meta.company_record_id,
            });
          }

          const reviews = Array.isArray(data?.items)
            ? data.items
            : Array.isArray(data?.reviews)
              ? data.reviews
              : [];
          return {
            ...c,
            _reviews: reviews,
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
          skip: 0,
          append: false,
          location: loc,
        });
      } else if (!cancelled) {
        setResults([]);
        setStatus("");
        setTotalCount(null);
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
    let searchLocation = null;
    try {
      if (city || state || country) {
        const r = await geocode({ address: [city, state, country].filter(Boolean).join(", ") });
        const loc = r?.best?.location;
        if (loc) {
          searchLocation = loc;
          setUserLoc({ lat: loc.lat, lng: loc.lng });
          const cc = r?.best?.components?.find(c => c.types?.includes("country"))?.short_name;
          if (cc) setUnit(milesCountries.has(cc) ? "mi" : "km");
        }
      }
    } catch {
      // ignore
    }

    setSortBy(sort === "hq" || sort === "stars" ? sort : "manu");
    await doSearch({ q, sort, country, state, city, take: 50, skip: 0, append: false, location: searchLocation });
  }

  async function doSearch({ q, sort, country, state, city, take = 50, skip = 0, append = false, location = null }) {
    setLoading(true);
    setStatus("Searching…");
    try {
      const { items = [], meta } = await searchCompanies({ q, sort, country, state, city, take, skip });
      const effectiveLocation = location || userLoc;
      const withDistances = items.map((c) => normalizeStars(attachDistances(c, effectiveLocation, unit)));
      const withReviews = await loadReviews(withDistances);

      const pageCount = withReviews.length;
      const newTotal = append ? results.length + pageCount : pageCount;

      setResults((prev) => (append ? [...prev, ...withReviews] : withReviews));
      setTotalCount(newTotal);

      if (meta?.usingStubData) {
        if (newTotal === 0) {
          setStatus("⚠️ Search API unavailable and no sample companies matched your search.");
        } else {
          setStatus(`⚠️ Search API unavailable – showing ${newTotal} sample companies.`);
        }
      } else if (!append && newTotal === 0) {
        setStatus("No companies found matching your criteria.");
      } else if (meta?.error) {
        setStatus(`⚠️ ${meta.error}`);
      } else {
        setStatus(`Found ${newTotal} companies`);
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

  const languageSelector = (
    <select
      className="h-11 text-sm border border-gray-300 rounded-md px-3 bg-gray-50 text-gray-900 font-medium hover:border-gray-400 transition-colors"
      defaultValue="en"
      aria-label="Language"
    >
      <option value="en">English</option>
      <option value="es">Español</option>
      <option value="fr">Français</option>
      <option value="de">Deutsch</option>
      <option value="zh">中文</option>
      <option value="ja">日本語</option>
    </select>
  );

  return (
    <div className="px-1 pb-10 max-w-6xl mx-auto">
      {/* Two-row search under the site header */}
      <div className="mt-6 mb-4">
        <SearchCard
          onSubmitParams={handleInlineSearch}
          filtersRightSlot={results.length > 0 ? languageSelector : null}
        />
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

      {/* Column Headers */}
      {results.length > 0 && (
        <div className="grid grid-cols-12 lg:grid-cols-[minmax(0,_2fr)_minmax(0,_2fr)_minmax(0,_2.6667fr)_minmax(0,_2.6667fr)_minmax(0,_2.6667fr)] gap-3 mb-4">
          <div className="col-span-4 lg:col-span-1"></div>
          <div className="col-span-2 lg:col-span-1">
            <div className="text-right font-semibold" style={{ color: "#649BA0", fontSize: "15px" }}>Sort Results:</div>
          </div>
          {rightColsOrder.map((colKey, idx) => {
            const colLabel =
              colKey === "manu" ? "Manufacturing" :
              colKey === "hq" ? "Home/HQ" :
              "QQ";
            const isSelected = sortBy === colKey;

            const button = (
              <button
                onClick={() => clickSort(colKey)}
                className="font-semibold rounded transition-colors"
                style={{
                  fontSize: "15px",
                  padding: "6.25px 10px",
                  backgroundColor: isSelected ? "#B1DDE3" : "transparent",
                  color: isSelected ? "#374151" : "#649BA0",
                  border: `1px solid ${isSelected ? "#B1DDE3" : "#649BA0"}`
                }}
              >
                {colLabel}
              </button>
            );

            return (
              <div key={colKey} className="col-span-2 lg:col-span-1 text-center">
                <div className="flex items-center justify-center gap-1">
                  {idx === 0 && (
                    <img
                      src={PinIcon}
                      alt="location"
                      style={{ width: "1.1em", height: "1.1em" }}
                    />
                  )}

                  {colKey === "stars" ? (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>{button}</TooltipTrigger>
                        <TooltipContent className="max-w-[280px] text-xs">
                          <p className="m-0">Quantity & Quality of info on a company, not a score.</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  ) : (
                    button
                  )}
                </div>
              </div>
            );
          })}
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

      {totalCount != null && results.length > 0 && results.length < totalCount && (
        <div className="mt-2 flex justify-center">
          <button
            type="button"
            className="text-xs px-4 py-2 border border-gray-300 rounded hover:bg-gray-50 text-gray-700 font-medium transition-colors disabled:opacity-60"
            disabled={loading}
            onClick={() =>
              doSearch({
                q: qParam,
                sort: sortParam,
                country: countryParam,
                state: stateParam,
                city: cityParam,
                take: 50,
                skip: results.length,
                append: true,
              })
            }
          >
            Load more results
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------- helpers ---------- */
function attachDistances(c, userLoc, unit) {
  const out = { ...c, _hqDist: null, _nearestManuDist: null, _manuDists: [], _hqDists: [] };

  const user = getLatLng(userLoc);
  if (!user) return out;

  // HQ - try headquarters array first, then fall back to hq_lat/hq_lng
  const hqList = Array.isArray(c.headquarters) ? c.headquarters : [];

  if (hqList.length > 0) {
    const dists = hqList
      .map((h) => {
        const coords = getLatLng(h);
        if (!coords) return null;
        const km = calculateDistance(user.lat, user.lng, coords.lat, coords.lng);
        if (!Number.isFinite(km)) return null;
        const d = unit === "mi" ? km * 0.621371 : km;

        const formatted =
          (typeof h?.formatted === "string" && h.formatted.trim()) ||
          (typeof h?.full_address === "string" && h.full_address.trim()) ||
          (typeof h?.address === "string" && h.address.trim()) ||
          (typeof h?.location === "string" && h.location.trim()) ||
          (typeof c?.headquarters_location === "string" && c.headquarters_location.trim()) ||
          undefined;

        return { ...h, lat: coords.lat, lng: coords.lng, dist: d, formatted };
      })
      .filter(Boolean)
      .sort((a, b) => a.dist - b.dist);

    out._hqDists = dists;
    out._hqDist = dists.length ? dists[0].dist : null;
  } else {
    const hqLat = toFiniteNumber(c.hq_lat);
    const hqLng = toFiniteNumber(c.hq_lng);
    if (hqLat != null && hqLng != null) {
      const km = calculateDistance(user.lat, user.lng, hqLat, hqLng);
      if (Number.isFinite(km)) {
        const d = unit === "mi" ? km * 0.621371 : km;
        out._hqDist = d;
        const formatted =
          (typeof c?.headquarters_location === "string" && c.headquarters_location.trim()) ||
          undefined;
        out._hqDists = [{ lat: hqLat, lng: hqLng, dist: d, formatted, geocode_status: "ok" }];
      }
    }
  }

  // Manufacturing
  const manuGeoListRaw = Array.isArray(c.manufacturing_geocodes) && c.manufacturing_geocodes.length
    ? c.manufacturing_geocodes
    : Array.isArray(c.manufacturing_locations)
      ? c.manufacturing_locations
      : [];

  if (Array.isArray(manuGeoListRaw) && manuGeoListRaw.length) {
    const dists = manuGeoListRaw
      .map((m, idx) => {
        const coords = getLatLng(m);
        if (!coords) return null;
        const km = calculateDistance(user.lat, user.lng, coords.lat, coords.lng);
        if (!Number.isFinite(km)) return null;
        const d = unit === "mi" ? km * 0.621371 : km;

        const fallbackLoc = Array.isArray(c.manufacturing_locations) ? c.manufacturing_locations[idx] : null;
        const fallbackLabel =
          typeof fallbackLoc === "string"
            ? fallbackLoc.trim()
            : fallbackLoc && typeof fallbackLoc === "object"
              ? (
                  (typeof fallbackLoc.formatted === "string" && fallbackLoc.formatted.trim()) ||
                  (typeof fallbackLoc.full_address === "string" && fallbackLoc.full_address.trim()) ||
                  (typeof fallbackLoc.address === "string" && fallbackLoc.address.trim()) ||
                  ""
                )
              : "";

        const formatted =
          (typeof m?.formatted === "string" && m.formatted.trim()) ||
          (typeof m?.full_address === "string" && m.full_address.trim()) ||
          (typeof m?.address === "string" && m.address.trim()) ||
          (typeof m?.location === "string" && m.location.trim()) ||
          (fallbackLabel || undefined);

        return { ...m, lat: coords.lat, lng: coords.lng, dist: d, formatted };
      })
      .filter(Boolean)
      .sort((a, b) => a.dist - b.dist);

    out._manuDists = dists;
    out._nearestManuDist = dists.length ? dists[0].dist : null;
  }

  return out;
}
function normalizeStars(c) {
  const starScore = toFiniteNumber(c.star_score);
  if (starScore != null) return { ...c, star_score: clamp(starScore, 0, 5) };

  const starRating = toFiniteNumber(c.star_rating);
  if (starRating != null) return { ...c, star_score: clamp(starRating, 0, 5) };

  const stars = toFiniteNumber(c.stars);
  if (stars != null) return { ...c, star_score: clamp(stars, 0, 5) };

  const confidence = toFiniteNumber(c.confidence_score);
  if (confidence != null) return { ...c, star_score: clamp(confidence * 5, 0, 5) };

  return { ...c, star_score: null };
}
function getStarScore(c) {
  const score = getQQScore(c);
  return Number.isFinite(score) ? score : null;
}
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function toFiniteNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function getLatLng(obj) {
  if (!obj || typeof obj !== "object") return null;

  // supports {lat,lng}, {latitude,longitude}, and common variants
  const lat = toFiniteNumber(obj.lat ?? obj.latitude);
  const lng = toFiniteNumber(obj.lng ?? obj.lon ?? obj.longitude);

  if (lat != null && lng != null) return { lat, lng };

  // supports {location:{lat,lng}}
  if (obj.location && typeof obj.location === "object") {
    const locLat = toFiniteNumber(obj.location.lat ?? obj.location.latitude);
    const locLng = toFiniteNumber(obj.location.lng ?? obj.location.lon ?? obj.location.longitude);
    if (locLat != null && locLng != null) return { lat: locLat, lng: locLng };
  }

  return null;
}
