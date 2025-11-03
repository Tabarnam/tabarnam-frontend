// src/pages/ResultsPage.jsx
import { xaiImport } from "@/lib/api/xaiImport";
import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { geocode } from "@/lib/google";
import SocialBadges from "@/components/SocialBadges";
import ReviewsWidget from "@/components/ReviewsWidget";
import SearchCard from "@/components/home/SearchCard";
import { searchCompanies } from "@/lib/searchCompanies";

// Countries that use miles (for distance unit inference)
const milesCountries = new Set([
  "US","GB","LR","AG","BS","BB","BZ","VG","KY","DM","FK","GD","GU","MS","MP","KN",
  "LC","VC","WS","TC","VI","AI","GI","IM","JE","GG","SH","AS","PR"
]);

export default function ResultsPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const qParam = (searchParams.get("q") ?? "").toString();
  const sortParam = (searchParams.get("sort") ?? "manu").toString(); // for server sort
  const countryParam = (searchParams.get("country") ?? "").toString();
  const stateParam = (searchParams.get("state") ?? "").toString();
  const cityParam = (searchParams.get("city") ?? "").toString();
  const latParam = (searchParams.get("lat") ?? "").toString();
  const lngParam = (searchParams.get("lng") ?? "").toString();

  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");

  // Location + units
  const [userLoc, setUserLoc] = useState(null); // {lat,lng}
  const [unit, setUnit] = useState("mi");

  // Secondary, client-side sort of visible columns
  const [sortBy, setSortBy] = useState("manu"); // "manu" | "hq" | "stars"

  // Resolve a center location (from lat/lng or geocoding) and run the search
  useEffect(() => {
    let cancelled = false;

    (async () => {
      // infer location
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
          // server does IP lookup when ipLookup:true
          const r = await geocode({ ipLookup: true });
          loc = r?.best?.location || { lat: 34.0983, lng: -117.8076 }; // harmless fallback
          const cc = r?.best?.components?.find(c => c.types?.includes("country"))?.short_name;
          if (cc) setUnit(milesCountries.has(cc) ? "mi" : "km");
        }
      } catch {
        // ignore geocode errors; we can still search
      }
      if (!cancelled && loc) setUserLoc({ lat: loc.lat, lng: loc.lng });

      // normalize secondary sort selector
      setSortBy(sortParam === "hq" || sortParam === "stars" ? sortParam : "manu");

      // run search
      if (!cancelled && qParam) {
        await doSearch({
          q: qParam,
          sort: sortParam,        // server sort: "recent" | "name" | "manu"
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
    // Re-run whenever URL params change
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
      const enriched = items.map((c) => normalizeStars(attachDistances(c, userLoc, unit)));
      setResults(enriched);

      if (meta?.error) {
        setStatus(`⚠️ Search API unavailable - showing 0 results. Error: ${meta.error}`);
      } else if (count === 0) {
        setStatus("No companies found matching your criteria.");
      } else {
        setStatus(`Found ${typeof count === "number" ? count : enriched.length} companies`);
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

      <div className="text-sm text-gray-700 mb-3">{status}</div>

      {/* Results Table */}
      <div className="overflow-auto border rounded mb-4">
        <table className="min-w-full text-sm">
          <thead className="text-left">
            <tr>
              <th className="p-2 bg-gray-100">Company</th>
              <th className="p-2 bg-gray-100">Industries</th>
              <th className="p-2 bg-gray-100">Keywords</th>
              <th className="p-2 bg-gray-100">Website</th>
              <th className="p-2 bg-gray-100">Amazon</th>
              {rightColsOrder.map((key) => (
                <th
                  key={key}
                  className={headerClassFor(key)}
                  onClick={() => clickSort(key)}
                  aria-sort={sortBy === key ? (key === "stars" ? "descending" : "ascending") : "none"}
                  title={`Sort by ${labelFor(key)}`}
                >
                  {labelFor(key)} {sortBy === key ? "▾" : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((c, i) => (
              <tr key={(c.id || c.company_name || "row") + "-" + i} className="border-t">
                {/* NAME + social + reviews */}
                <td className="p-2">
                  <div className="font-medium">{c.company_name || "—"}</div>
                  <div className="text-gray-600">{c.company_tagline || ""}</div>
                  <SocialBadges links={c.social} className="mt-1" brandColors variant="solid" />
                  <div className="mt-2"><ReviewsWidget companyName={c.company_name} /></div>
                </td>

                {/* Industries */}
                <td className="p-2">
                  {Array.isArray(c.industries) ? c.industries.join(", ") : (c.industries || "—")}
                </td>

                {/* Keywords */}
                <td className="p-2">
                  {String(c.product_keywords || "")
                    .split(",")
                    .map(s => s.trim())
                    .filter(Boolean)
                    .slice(0, 8)
                    .join(", ")}
                </td>

                {/* Website */}
                <td className="p-2">
                  {c.url ? (
                    <a href={c.url} target="_blank" rel="noreferrer" className="text-blue-600 underline">
                      {c.url}
                    </a>
                  ) : "—"}
                </td>

                {/* Amazon */}
                <td className="p-2">
                  {c.amazon_url ? (
                    <a href={c.amazon_url} target="_blank" rel="noreferrer" className="text-blue-600 underline">
                      Amazon
                    </a>
                  ) : "—"}
                </td>

                {/* Dynamic right-most trio: location + distance or stars */}
                {rightColsOrder.map((key) => (
                  <td key={key} className={cellClassFor(key)}>
                    {key === "manu" && (
                      <>
                        {nearestManufacturingLocation(c) || "—"}
                        <div className="text-xs text-gray-500">{formatDist(c._nearestManuDist, unit)}</div>
                      </>
                    )}
                    {key === "hq" && (
                      <>
                        {formatHQ(c) || "—"}
                        <div className="text-xs text-gray-500">{formatDist(c._hqDist, unit)}</div>
                      </>
                    )}
                    {key === "stars" && <>{renderStars(getStarScore(c))}</>}
                  </td>
                ))}
              </tr>
            ))}
            {!sorted.length && !loading && (
              <tr><td className="p-4 text-gray-500" colSpan={10}>No results yet.</td></tr>
            )}
          </tbody>
        </table>
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
