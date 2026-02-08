// src/pages/ResultsPage.jsx
import React, { useEffect, useMemo, useState } from "react";
import { Helmet } from "react-helmet-async";
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
  const sortParam = (searchParams.get("sort") ?? "stars").toString();
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
  const [sortBy, setSortBy] = useState("stars");

  // Load reviews for companies
  async function loadReviews(companies) {
    const enriched = await Promise.all(
      companies.map(async (c) => {
        try {
          const companyId = c.company_id || c.id;
          if (!companyId) {
            return { ...c, _reviews: [] };
          }

          const qs = `company_id=${encodeURIComponent(companyId)}`;
          const r = await fetch(`${API_BASE}/get-reviews?${qs}`);
          const data = await r.json().catch(() => ({ items: [], reviews: [] }));

          const storedCuratedVisible =
            data?.meta && typeof data.meta.company_curated_visible_count === "number"
              ? data.meta.company_curated_visible_count
              : data?.meta && typeof data.meta.company_curated_count === "number"
                ? data.meta.company_curated_count
                : null;

          if (
            storedCuratedVisible != null &&
            storedCuratedVisible > 1 &&
            typeof data.count === "number" &&
            data.count < storedCuratedVisible
          ) {
            console.warn("[ResultsPage] Reviews regression: fewer reviews returned than stored", {
              company_id: companyId,
              company_name: c.company_name,
              returned: data.count,
              stored_curated_visible: storedCuratedVisible,
              stored_curated_total: data?.meta?.company_curated_count,
              company_record_id: data?.meta?.company_record_id,
            });
          }

          const reviews = Array.isArray(data?.items)
            ? data.items
            : Array.isArray(data?.reviews)
              ? data.reviews
              : [];

          if (reviews.length > 0) {
            console.log("[ResultsPage] loadReviews: loaded", reviews.length, "reviews for", companyId);
          }

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

      setSortBy(sortParam === "hq" || sortParam === "manu" ? sortParam : "stars");

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
    const sort = (params.sort ?? "stars").toString();
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

    setSortBy(sort === "hq" || sort === "manu" ? sort : "stars");
    await doSearch({ q, sort, country, state, city, take: 50, skip: 0, append: false, location: searchLocation });
  }

  async function doSearch({ q, sort, country, state, city, take = 50, skip = 0, append = false, location = null }) {
    setLoading(true);
    setStatus("Searching…");
    try {
      const fallbackLocation = { lat: 34.0983, lng: -117.8076 };
      const effectiveLocation = location || userLoc || fallbackLocation;

      if (!userLoc && effectiveLocation) {
        setUserLoc({ lat: effectiveLocation.lat, lng: effectiveLocation.lng });
      }

      let searchResult = await searchCompanies({
        q,
        sort,
        country,
        state,
        city,
        take,
        skip,
        lat: effectiveLocation?.lat,
        lng: effectiveLocation?.lng,
      });

      // If no results, try alternative query forms (fallback retry)
      if (!append && searchResult.items?.length === 0 && !skip) {
        const alternatives = generateQueryAlternatives(q);
        for (const altQuery of alternatives) {
          if (altQuery !== q) {  // Don't retry the same query
            const altResult = await searchCompanies({
              q: altQuery,
              sort,
              country,
              state,
              city,
              take,
              skip,
              lat: effectiveLocation?.lat,
              lng: effectiveLocation?.lng,
            });
            if (altResult.items?.length > 0) {
              searchResult = altResult;
              break;  // Use first successful alternative
            }
          }
        }
      }

      const { items = [], meta } = searchResult;
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
  // Primary key: name-match relevance (exact name hits first), then by chosen metric
  const sorted = useMemo(() => {
    const arr = [...results];
    arr.sort((a, b) => {
      const aName = a._nameMatchScore ?? 0;
      const bName = b._nameMatchScore ?? 0;
      if (aName !== bName) return bName - aName;

      if (sortBy === "stars") {
        return (getStarScore(b) ?? -Infinity) - (getStarScore(a) ?? -Infinity);
      } else if (sortBy === "manu") {
        return (a._nearestManuDist ?? Infinity) - (b._nearestManuDist ?? Infinity);
      } else {
        return (a._hqDist ?? Infinity) - (b._hqDist ?? Infinity);
      }
    });
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

  const pageTitle = qParam
    ? `${qParam} – Results on Tabarnam`
    : "Search Results – Tabarnam";
  const pageDescription = qParam
    ? `Discover companies matching "${qParam}" on Tabarnam – transparent product origins.`
    : "Discover products with transparent origins on Tabarnam.";

  return (
    <div className="px-1 pb-10 max-w-6xl mx-auto">
      <Helmet>
        <title>{pageTitle}</title>
        <meta property="og:title" content={pageTitle} />
        <meta property="og:description" content={pageDescription} />
        <meta property="og:url" content={window.location.href} />
        <meta property="og:image" content="/tabarnam.png" />
        <meta property="og:type" content="website" />
      </Helmet>
      {/* Two-row search under the site header */}
      <div className="mt-6 mb-4">
        <SearchCard
          onSubmitParams={handleInlineSearch}
          filtersRightSlot={results.length > 0 ? languageSelector : null}
          containerClassName="max-w-none"
        />
      </div>


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

      {/* Column Headers — uses same grid as ExpandableCompanyRow so labels align */}
      {results.length > 0 && (
        <div className="grid grid-cols-6 lg:grid-cols-5 gap-x-3 mb-4 px-2 items-center">
          <div className="col-span-6 lg:col-span-2 font-semibold flex items-center gap-1" style={{ color: "#649BA0", fontSize: "15px" }}>
            Sort Results:
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
              <div key={colKey} className="col-span-2 lg:col-span-1 flex items-center gap-1">
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

/**
 * Generate alternative query forms for fallback search retry
 * E.g., "bodywash" → ["body wash"], "body-wash" → ["body wash"]
 */
function generateQueryAlternatives(query) {
  const alternatives = [query];  // Start with original

  if (!query || typeof query !== "string") return alternatives;

  const q = query.toLowerCase().trim();

  // Map of known compound words without spaces to their spaced versions
  const knownCompounds = {
    "bodywash": "body wash",
    "hairwash": "hair wash",
    "haircare": "hair care",
    "skincare": "skin care",
    "facewash": "face wash",
    "facecare": "face care",
    "eyecare": "eye care",
    "eyewash": "eye wash",
    "handwash": "hand wash",
    "lipcare": "lip care",
  };

  // If exact match in known compounds, add that
  if (knownCompounds[q]) {
    alternatives.push(knownCompounds[q]);
  }

  // Try adding/removing spaces around hyphens and underscores
  if (q.includes("-")) {
    alternatives.push(q.replace(/-/g, " "));
  }
  if (q.includes("_")) {
    alternatives.push(q.replace(/_/g, " "));
  }

  // Try collapsing spaces to no spaces
  if (q.includes(" ")) {
    const collapsed = q.replace(/\s+/g, "");
    alternatives.push(collapsed);
  }

  // For words without spaces, try common splits (4/5 chars, 5/6 chars, etc.)
  if (!q.includes(" ") && q.length > 6) {
    // Try splitting at common lengths (body|wash is 4|4, hair|care is 4|4)
    for (let i = 3; i <= Math.min(6, q.length - 2); i++) {
      const split = q.slice(0, i) + " " + q.slice(i);
      alternatives.push(split);
    }
  }

  // Return unique alternatives only
  return [...new Set(alternatives)];
}

function attachDistances(c, userLoc, unit) {
  const out = { ...c, _hqDist: null, _nearestManuDist: null, _manuDists: [], _hqDists: [] };

  const user = getLatLng(userLoc);
  if (!user) return out;

  // HQ - prefer headquarters_locations, with legacy fallback to headquarters, then fall back to hq_lat/hq_lng
  let hqList = [];
  if (Array.isArray(c.headquarters_locations) && c.headquarters_locations.length > 0) {
    hqList = c.headquarters_locations;
  } else if (Array.isArray(c.headquarters) && c.headquarters.length > 0) {
    hqList = c.headquarters;
  }

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
