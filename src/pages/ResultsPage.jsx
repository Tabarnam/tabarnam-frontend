// src/pages/ResultsPage.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Helmet } from "react-helmet-async";
import { useSearchParams, useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { geocode, resolveLocation } from "@/lib/google";
import { calculateDistance, usesMiles } from "@/lib/distance";
import SearchCard from "@/components/home/SearchCard";
import ExpandableCompanyRow from "@/components/results/ExpandableCompanyRow";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { searchCompanies, getSearchCount } from "@/lib/searchCompanies";
import { getCountries, getCountryCentroid } from "@/lib/location";
import { API_BASE } from "@/lib/api";
import { getQQScore } from "@/lib/stars/qqRating";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import ShareButton from "@/components/ShareButton";

const PAGE_SIZE = 50;

/** Skeleton placeholder that mirrors the collapsed ExpandableCompanyRow grid */
function SkeletonRow() {
  return (
    <div className="grid grid-cols-6 lg:grid-cols-5 gap-x-3 gap-y-2 border border-border rounded-lg p-2 bg-card">
      {/* Col 1: company info */}
      <div className="col-span-4 lg:col-span-1 space-y-2">
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-1/2" />
        <div className="flex gap-2 mt-2">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-20" />
        </div>
      </div>
      {/* Col 2: logo placeholder */}
      <div className="col-span-2 lg:col-span-1">
        <Skeleton className="w-full h-28 rounded" />
      </div>
      {/* Cols 3-5: manu / hq / qq */}
      {[0, 1, 2].map((i) => (
        <div key={i} className="col-span-2 lg:col-span-1 space-y-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
      {/* Keywords row */}
      <div className="col-span-6 lg:col-span-5 mt-2 border-t pt-2">
        <Skeleton className="h-3 w-16 mb-2" />
        <div className="flex flex-wrap gap-2">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-4 w-16 rounded-sm" />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Numbered page bar: < Previous  [1]  2  3  …  Next > */
function Pagination({ currentPage, hasMore, totalPages, onPageChange, disabled }) {
  // Treat totalPages as known only when it's a positive number AND the current
  // page actually fits inside it. A `totalPages=1` left over from an earlier
  // page-1 search while the user has navigated to page 2 is *stale*, not
  // authoritative — fall back to the unknown-total render in that case so we
  // don't show a contradictory "Page 2 of 1".
  const knownTotal = Number.isFinite(totalPages) && totalPages > 0 && currentPage <= totalPages;

  // Hide the control entirely only when we're certain there's just one page.
  if (currentPage <= 1 && !hasMore && knownTotal && totalPages === 1) return null;
  if (currentPage <= 1 && !hasMore && totalPages == null && !knownTotal) return null;

  // Build the page-number window. With a known total, surface 1, current±1,
  // and totalPages with ellipses. With an unknown total, only show the active
  // page — no fabricated "1, 2" buttons that don't reflect reality. Next is
  // gated on hasMore in that case so the user can still walk forward.
  let pages;
  if (knownTotal) {
    const set = new Set([1, currentPage - 1, currentPage, currentPage + 1, totalPages]);
    pages = [...set].filter((n) => n >= 1 && n <= totalPages).sort((a, b) => a - b);
  } else {
    pages = [currentPage];
  }

  const items = [];
  for (let i = 0; i < pages.length; i++) {
    if (i > 0 && pages[i] - pages[i - 1] > 1) items.push(null);
    items.push(pages[i]);
  }

  const nextDisabled =
    disabled ||
    (knownTotal ? currentPage >= totalPages : !hasMore);

  const btn = "inline-flex items-center justify-center min-w-[36px] h-9 px-3 text-sm rounded transition-colors select-none";

  return (
    <nav aria-label="Pagination" className="mt-6 flex justify-center">
      <ul className="inline-flex items-center gap-1 border border-border rounded-lg px-2 py-1.5 bg-card">
        <li>
          <button
            type="button"
            disabled={disabled || currentPage <= 1}
            onClick={() => onPageChange(currentPage - 1)}
            className={cn(btn, "gap-1 text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-40 disabled:pointer-events-none")}
          >
            <ChevronLeft size={16} /> Previous
          </button>
        </li>
        {items.map((page, idx) =>
          page === null ? (
            <li key={`e${idx}`} className="px-1 text-muted-foreground select-none">…</li>
          ) : (
            <li key={page}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => page !== currentPage && onPageChange(page)}
                className={cn(
                  btn,
                  page === currentPage
                    ? "border border-foreground font-semibold text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent"
                )}
                aria-current={page === currentPage ? "page" : undefined}
              >
                {page}
              </button>
            </li>
          )
        )}
        <li>
          <button
            type="button"
            disabled={nextDisabled}
            onClick={() => onPageChange(currentPage + 1)}
            className={cn(btn, "gap-1 text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-40 disabled:pointer-events-none")}
          >
            Next <ChevronRight size={16} />
          </button>
        </li>
      </ul>
    </nav>
  );
}

// Countries that use miles (for distance unit inference)
const milesCountries = new Set([
  "US","GB","LR","AG","BS","BB","BZ","VG","KY","DM","FK","GD","GU","MS","MP","KN",
  "LC","VC","WS","TC","VI","AI","GI","IM","JE","GG","SH","AS","PR"
]);

// Resolve a 2-letter ISO code (e.g. "GB") to its full name ("United Kingdom")
// for better geocoding accuracy. Falls back to the code if lookup fails.
let _countryNameCache = null;
async function resolveCountryName(code) {
  if (!code || code.length !== 2) return code;
  try {
    if (!_countryNameCache) {
      const list = await getCountries();
      _countryNameCache = new Map(list.map(c => [c.code, c.name]));
    }
    return _countryNameCache.get(code.toUpperCase()) || code;
  } catch { return code; }
}

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
  const pageParam = Math.max(1, Math.floor(Number(searchParams.get("page")) || 1));
  const amazonParam = searchParams.get("amazon") === "1";
  const hqCountryParam = searchParams.get("hqCountry") || "";
  const mfgCountryParam = searchParams.get("mfgCountry") || "";
  const debugScores = searchParams.get("debug") === "scores";

  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [totalPages, setTotalPages] = useState(null);

  // Tracks the search-key (query + filters, page-independent) we last fetched
  // a count for. Page navigation within the same key reuses the existing
  // totalPages instead of resetting it to null and re-fetching — that flicker
  // was the source of "Page 2 of 1" / "Page 3 for golf" (no total) bugs.
  const lastCountedKeyRef = useRef(null);

  // Search history for back/forward navigation
  const [searchHistory, setSearchHistory] = useState(() => {
    try {
      const stored = sessionStorage.getItem("tabarnam_search_history");
      return stored ? JSON.parse(stored) : [];
    } catch { return []; }
  });
  const [historyIndex, setHistoryIndex] = useState(() => {
    try {
      const stored = sessionStorage.getItem("tabarnam_search_history_index");
      return stored != null ? Number(stored) : -1;
    } catch { return -1; }
  });
  const navigatingHistoryRef = useRef(false);
  const poppingStateRef = useRef(false);
  const [userLoc, setUserLoc] = useState(null);
  const [unit, setUnit] = useState("mi");
  const [userCountryCode, setUserCountryCode] = useState("");
  const [sortBy, setSortBy] = useState(null);

  // Detect browser back/forward to avoid corrupting internal search history
  useEffect(() => {
    const handler = () => { poppingStateRef.current = true; };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  // Load a single company's reviews
  async function fetchReviewsForCompany(c) {
    try {
      const companyId = c.company_id || c.id;
      if (!companyId) return { ...c, _reviews: [] };

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

      return { ...c, _reviews: reviews };
    } catch {
      return { ...c, _reviews: [] };
    }
  }

  // Load reviews in background batches, updating state progressively
  async function loadReviewsDeferred(companies) {
    const BATCH = 5;
    for (let i = 0; i < companies.length; i += BATCH) {
      const batch = companies.slice(i, i + BATCH);
      const enriched = await Promise.all(batch.map(fetchReviewsForCompany));
      setResults((prev) => {
        const map = new Map(enriched.map((c) => [c.company_id || c.id, c]));
        return prev.map((p) => map.get(p.company_id || p.id) || p);
      });
    }
  }

  // Skip-flag: when handleInlineSearch fires doSearch directly, skip the URL-watching effect
  const skipUrlEffectRef = useRef(false);

  // Resolve a center location (from lat/lng or geocoding) and run the search
  useEffect(() => {
    if (skipUrlEffectRef.current) {
      skipUrlEffectRef.current = false;
      return;
    }
    let cancelled = false;

    (async () => {
      let loc = null;
      // Captures structured codes from geocoding so we can pass "TX" to the
      // API even though the URL still says state=texas.
      const resolvedFromGeo = { country: "", state: "", city: "" };
      try {
        if (latParam && lngParam && !Number.isNaN(Number(latParam)) && !Number.isNaN(Number(lngParam))) {
          const latN = Number(latParam), lngN = Number(lngParam);
          // Ignore the San Dimas sentinel even when carried in the URL — a
          // shared/bookmarked link from before the geocode fix would otherwise
          // bypass our re-geocoding and silently use the bad center.
          const isSentinel = Math.abs(latN - 34.0983) < 0.01 && Math.abs(lngN - (-117.8076)) < 0.01;
          if (!isSentinel) loc = { lat: latN, lng: lngN };
        }
        if (!loc && (cityParam || stateParam || countryParam)) {
          let resolvedCC = "";

          // Use the shared resolver: Places + geocode → structured codes.
          if (cityParam || stateParam) {
            const r = await resolveLocation({ city: cityParam, state: stateParam, country: countryParam });
            if (r.lat && r.lng) {
              loc = { lat: r.lat, lng: r.lng };
              resolvedCC = r.countryCode || "";
            }
            // Promote whatever structured codes the geocoder gave us so the API
            // gets "TX" not "texas". Falls back to the raw URL params if
            // nothing was resolved.
            if (r.countryCode) resolvedFromGeo.country = r.countryCode;
            if (r.stateCode) resolvedFromGeo.state = r.stateCode;
            if (r.city) resolvedFromGeo.city = r.city;
          }

          // Country-only searches (no city/state): use country centroid as the
          // user's specified region. Faking proximity for unresolved city/state
          // would produce misleading distances, so we don't centroid those.
          if (!loc && countryParam && !cityParam && !stateParam) {
            const centroid = getCountryCentroid(countryParam);
            if (centroid) {
              loc = centroid;
              resolvedCC = countryParam;
            }
          }

          if (resolvedCC) { setUnit(milesCountries.has(resolvedCC) ? "mi" : "km"); setUserCountryCode(resolvedCC); }
        }
        // No location filters at all → use device IP location (best guess for "near me")
        if (!loc && !cityParam && !stateParam && !countryParam) {
          const r = await geocode({ ipLookup: true });
          const ipLoc = r?.best?.location;
          const ipLat = Number(ipLoc?.lat), ipLng = Number(ipLoc?.lng);
          if (Number.isFinite(ipLat) && Number.isFinite(ipLng) &&
              !(Math.abs(ipLat - 34.0983) < 0.01 && Math.abs(ipLng - (-117.8076)) < 0.01)) {
            loc = { lat: ipLat, lng: ipLng };
            const cc = r?.best?.components?.find(c => c.types?.includes("country"))?.short_name;
            if (cc) { setUnit(milesCountries.has(cc) ? "mi" : "km"); setUserCountryCode(cc); }
          }
        }
      } catch {
        // ignore geocode errors
      }
      // Always reset userLoc to whatever this search resolved to (or null).
      // Without this, a failed resolution in a follow-up search would inherit
      // the previous search's center — e.g. typing "tx" after an Edinburgh
      // search would silently rank companies by distance from Edinburgh,
      // putting Vermont (3060 mi from EDI) at the top of a Texas search.
      if (!cancelled) setUserLoc(loc ? { lat: loc.lat, lng: loc.lng } : null);

      setSortBy(null);

      const hasCoordParam = !!(latParam && lngParam && !Number.isNaN(Number(latParam)) && !Number.isNaN(Number(lngParam)));
      const hasLocationFilter = !!(cityParam || stateParam || countryParam || hasCoordParam);
      const isLocationOnly = !qParam && hasLocationFilter;
      if (!cancelled && (qParam || hasLocationFilter)) {
        // Seed search history on initial load / URL-driven navigation (skip on browser back/forward)
        if (!poppingStateRef.current) {
          pushSearchHistory({ q: qParam, sort: sortParam, country: countryParam, state: stateParam, city: cityParam });
        }
        poppingStateRef.current = false;
        // Location-only: load 2 pages eagerly, then lazy-load on scroll
        const initialTake = isLocationOnly && pageParam === 1 ? PAGE_SIZE * 2 : PAGE_SIZE;
        await doSearch({
          q: qParam,
          sort: sortParam,
          country: resolvedFromGeo.country || countryParam,
          state: resolvedFromGeo.state || stateParam,
          city: resolvedFromGeo.city || cityParam,
          amazon: amazonParam,
          hqCountry: hqCountryParam,
          mfgCountry: mfgCountryParam,
          take: initialTake,
          skip: (pageParam - 1) * PAGE_SIZE,
          location: loc,
        });
      } else if (!cancelled) {
        setResults([]);
        setStatus("Please enter a search term, choose a location, or enter a postal/ZIP code.");
        setHasMore(false);
      }
    })();

    return () => { cancelled = true; };
  }, [qParam, sortParam, countryParam, stateParam, cityParam, latParam, lngParam, pageParam, amazonParam, hqCountryParam, mfgCountryParam]);

  // Called by the top search bar
  async function handleInlineSearch(params) {
    const q = (params.q ?? "").toString();
    const sort = (params.sort ?? "stars").toString();
    const country = (params.country ?? "").toString();
    const state = (params.state ?? "").toString();
    const city = (params.city ?? "").toString();
    const amazon = params.amazon === "1" || params.amazon === true;
    const hqCountry = (params.hqCountry ?? "").toString();
    const mfgCountry = (params.mfgCountry ?? "").toString();
    // SearchCard no longer passes lat/lng (we don't expose raw coords in
    // URLs anymore, and re-resolving on this side guarantees the URL
    // mirrors only what the user typed). Resolution from city/country
    // happens below via resolveLocation.

    // Update URL for shareability (don’t include empty keys to keep it tidy)
    const next = new URLSearchParams();
    if (q) next.set("q", q);
    if (sort) next.set("sort", sort);
    if (country) next.set("country", country);
    if (state) next.set("state", state);
    if (city) next.set("city", city);
    if (amazon) next.set("amazon", "1");
    if (hqCountry) next.set("hqCountry", hqCountry);
    if (mfgCountry) next.set("mfgCountry", mfgCountry);
    // Reset to page 1 on new search
    next.delete("page");
    skipUrlEffectRef.current = true;
    setSearchParams(next);

    // Resolve typed location if present
    let searchLocation = null;
    try {
      if (!searchLocation && (city || state || country)) {
        let resolvedCC = "";

        // Shared resolver: Places + geocode → structured (lat, lng, codes).
        if (city || state) {
          const r = await resolveLocation({ city, state, country });
          if (r.lat && r.lng) {
            searchLocation = { lat: r.lat, lng: r.lng };
            resolvedCC = r.countryCode || "";
          }
        }

        // Country-only fallback: centroid is acceptable when user didn't specify city/state
        if (!searchLocation && country && !city && !state) {
          const centroid = getCountryCentroid(country);
          if (centroid) {
            searchLocation = centroid;
            resolvedCC = country;
          }
        }

        if (searchLocation) {
          setUserLoc({ lat: searchLocation.lat, lng: searchLocation.lng });
          if (resolvedCC) { setUnit(milesCountries.has(resolvedCC) ? "mi" : "km"); setUserCountryCode(resolvedCC); }
        } else {
          // Clear stale userLoc — the user typed a location that didn't
          // resolve, so we should NOT keep the previous search's center
          // (e.g. an IP-derived 91750 point) and silently rank distances
          // from there. Better to show no proximity than wrong proximity.
          setUserLoc(null);
        }
      } else {
        // No geo filters — reset to user's IP-based or default location.
        // Without this, stale userLoc from a previous country filter persists.
        setUserLoc(null);
        try {
          const r = await geocode({ ipLookup: true });
          const loc = r?.best?.location;
          if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
            searchLocation = loc;
            setUserLoc({ lat: loc.lat, lng: loc.lng });
            const cc = r?.best?.components?.find(c => c.types?.includes("country"))?.short_name;
            if (cc) { setUnit(milesCountries.has(cc) ? "mi" : "km"); setUserCountryCode(cc); }
          }
        } catch { /* will use fallback in doSearch */ }
      }
    } catch {
      // Last-resort centroid only when user didn't specify city/state.
      if (country && !city && !state) {
        const centroid = getCountryCentroid(country);
        if (centroid) {
          searchLocation = centroid;
          setUserLoc({ lat: centroid.lat, lng: centroid.lng });
          setUnit(milesCountries.has(country) ? "mi" : "km");
          setUserCountryCode(country);
        }
      }
    }

    setSortBy(null);

    // Track in search history (skip if this was triggered by back/forward navigation)
    if (!navigatingHistoryRef.current) {
      pushSearchHistory({ q, sort, country, state, city });
    }
    navigatingHistoryRef.current = false;

    const isLocationOnlyInline = !q && !!(city || state || country);
    const inlineTake = isLocationOnlyInline ? PAGE_SIZE * 2 : PAGE_SIZE;
    await doSearch({ q, sort, country, state, city, amazon, hqCountry, mfgCountry, take: inlineTake, skip: 0, location: searchLocation });
  }

  // Lightweight auto-search: fetches results without updating URL (avoids input interruption)
  function handleAutoSearch({ q, sort, country, state, city, amazon, hqCountry, mfgCountry }) {
    if (!q && !country && !state && !city) return;
    doSearch({ q, sort, country, state, city, amazon, hqCountry, mfgCountry, take: PAGE_SIZE, skip: 0 });
  }

  // Track the current search generation so stale responses are ignored
  const searchGenRef = useRef(0);

  async function doSearch({ q, sort, country, state, city, amazon, hqCountry, mfgCountry, take = PAGE_SIZE, skip = 0, location, append = false }) {
    setLoading(true);

    // The "search key" identifies a query + filter combination independently
    // of which page is being viewed. Used so page navigation within the same
    // query reuses the totalPages already computed for that query.
    const searchKey = JSON.stringify({
      q: q || "",
      sort: sort || "",
      country: country || "",
      state: state || "",
      city: city || "",
      amazon: !!amazon,
      hqCountry: hqCountry || "",
      mfgCountry: mfgCountry || "",
    });
    const isNewSearchKey = searchKey !== lastCountedKeyRef.current;

    if (!append) {
      // Clear the previous search's results immediately so a new search starts
      // on a blank canvas. Without this, if the new search later throws (e.g.
      // validation rejects "state=91750-only" because the postal stripped to
      // empty location filters) the old items linger on screen next to the
      // error banner — the user sees Waterford and Floyd under
      // "Please enter a search term…" because nothing cleared the old rows.
      setStatus("");
      setResults([]);
      setHasMore(false);
      // Only invalidate totalPages when the QUERY/FILTERS change — not on
      // page navigation. Walking pages 1 → 2 → 3 within the same query keeps
      // the previously-computed total visible the whole time.
      if (isNewSearchKey) setTotalPages(null);
    }
    const gen = append ? searchGenRef.current : ++searchGenRef.current;
    try {
      // The caller (URL effect / handleInlineSearch) is the authority on this
      // search's center. If they passed `location` explicitly — including
      // null when geocoding failed — trust it. Falling back to `userLoc`
      // would silently use the previous search's center (e.g. an IP-derived
      // "near me" point) instead of saying "we couldn't resolve this query",
      // which is exactly the bug the user reported with 91750-area distances
      // showing up under a kilts+Edinburgh search.
      const effectiveLocation = location !== undefined ? location : userLoc;

      // Every search is proximity-based. ALL location inputs (city, state,
      // country) are hints that feed the geocoder upstream to derive lat/lng
      // — they never act as strict filters that exclude rows. The result
      // set is shaped only by the search term, the sort, and proximity.
      // Country was the last strict filter and the user pointed out it
      // limits results in smaller nations with less production: searching
      // country=Slovenia would empty the result set instead of surfacing
      // nearby companies. Same fix applies to country=US in a US-narrow
      // database — the user wants ranking to inform the user, not silent
      // exclusion. If geocoding failed entirely AND the user typed no
      // search term, validation in searchCompanies will surface a helpful
      // error rather than returning misleading data.
      const cityFilter = "";
      const stateFilter = "";
      const countryFilter = "";

      const commonOpts = { q, sort, country: countryFilter, state: stateFilter, city: cityFilter, amazon, hqCountry, mfgCountry, take, skip, lat: effectiveLocation?.lat, lng: effectiveLocation?.lng };

      // Fire quick (Pass 1 only) and full search in parallel
      const quickPromise = q ? searchCompanies({ ...commonOpts, quick: true }).catch(() => null) : null;
      const fullPromise = searchCompanies(commonOpts);

      // Count request runs in parallel with the page fetch, not after it, so
      // first paint of the page indicator can include "Page 1 of N" instead
      // of flashing "Page 1" then updating to "Page 1 of N" once the count
      // lands. Only re-fire when the search key actually changes — page
      // navigation within the same query reuses the cached totalPages.
      //
      // IMPORTANT: country/state/city are intentionally passed as empty
      // strings so the count operates over the same filter scope as the
      // paginated request (see commonOpts above, where cityFilter /
      // stateFilter / countryFilter are all ""). Location is a ranking
      // signal only — it shapes results via lat/lng, never excludes rows.
      // Sending the URL's strict location filters to the count would shrink
      // totalCount to "companies whose stored city matches the URL city",
      // producing contradictions like "Page 1 of 1" while the paginated
      // request reports hasMore=true. hqCountry / mfgCountry are exempt
      // because the user explicitly opted into them as strict filters.
      if (!append && isNewSearchKey && q) {
        lastCountedKeyRef.current = searchKey;
        getSearchCount({
          q,
          sort,
          country: "",
          state: "",
          city: "",
          amazon,
          hqCountry,
          mfgCountry,
          take: PAGE_SIZE,
          lat: effectiveLocation?.lat,
          lng: effectiveLocation?.lng,
        })
          .then((r) => {
            // Stale check — if the user has navigated to a new query, ignore
            // a count from the old one.
            if (gen !== searchGenRef.current) return;
            if (r && Number.isFinite(r.totalPages)) setTotalPages(r.totalPages);
          })
          .catch(() => {});
      }

      // Show quick results as soon as they arrive
      if (quickPromise) {
        const quickResult = await quickPromise;
        if (gen === searchGenRef.current && quickResult?.items?.length > 0) {
          const quickWithDist = quickResult.items.map((c) => normalizeStars(attachDistances(c, effectiveLocation, unit)));
          setResults(quickWithDist);
          loadReviewsDeferred(quickWithDist);
          setHasMore(quickResult.hasMore === true);
          setStatus("");
          setLoading(false);
        }
      }

      // Wait for full results and replace
      let searchResult = await fullPromise;

      // Stale check: if a newer search was started, discard these results
      if (gen !== searchGenRef.current) return;

      // If no results on page 1, try alternative query forms (fallback retry)
      if (searchResult.items?.length === 0 && !skip && q) {
        const alternatives = generateQueryAlternatives(q);
        for (const altQuery of alternatives) {
          if (altQuery !== q) {
            const altResult = await searchCompanies({
              q: altQuery,
              sort,
              country,
              state,
              city,
              amazon,
              hqCountry,
              mfgCountry,
              take,
              skip,
              lat: effectiveLocation?.lat,
              lng: effectiveLocation?.lng,
            });
            if (altResult.items?.length > 0) {
              searchResult = altResult;
              break;
            }
          }
        }
      }

      // Stale check again after alternatives
      if (gen !== searchGenRef.current) return;

      const { items = [], hasMore: apiHasMore, meta } = searchResult;
      const distanced = items.map((c) => normalizeStars(attachDistances(c, effectiveLocation, unit)));

      // Pure raw distance for proximity sorts. sort=manu ranks by nearest
      // manufacturing distance; sort=hq ranks by nearest HQ distance. Same
      // comparator, just a different distance field. Stars / recent /
      // relevance sorts keep API order.
      const withDistances = (sort === "manu" || sort === "hq")
        ? distanced.slice().sort((a, b) => {
            const distA = sort === "manu" ? (a._nearestManuDist ?? Infinity) : (a._hqDist ?? Infinity);
            const distB = sort === "manu" ? (b._nearestManuDist ?? Infinity) : (b._hqDist ?? Infinity);
            return distA - distB;
          })
        : distanced;

      // Append on infinite scroll, replace on a fresh search
      if (append) {
        setResults((prev) => {
          const existingIds = new Set(prev.map((p) => p.company_id || p.id));
          const fresh = withDistances.filter((c) => !existingIds.has(c.company_id || c.id));
          return [...prev, ...fresh];
        });
      } else {
        setResults(withDistances);
      }
      loadReviewsDeferred(withDistances);
      setHasMore(apiHasMore === true);

      // Cheap totalPages shortcut — when this page came back with no further
      // results AND we're on the first page, we know the total without an
      // extra count request. Skip the parallel count entirely in that case.
      if (!apiHasMore && skip === 0) {
        setTotalPages(1);
        lastCountedKeyRef.current = searchKey;
      }

      if (meta?.usingStubData) {
        if (withDistances.length === 0) {
          setStatus("⚠️ Search API unavailable and no sample companies matched your search.");
        } else {
          setStatus(`⚠️ Search API unavailable – showing ${withDistances.length} sample companies.`);
        }
      } else if (withDistances.length === 0) {
        setStatus("No companies found matching your criteria.");
      } else if (meta?.error) {
        setStatus(`⚠️ ${meta.error}`);
      } else {
        setStatus("");
      }
    } catch (e) {
      if (gen === searchGenRef.current) {
        setStatus(`❌ ${e?.message || "Search failed"}`);
      }
    } finally {
      if (gen === searchGenRef.current) {
        setLoading(false);
      }
    }
  }

  // Location-only mode: hide numbered pagination, lazy-load via scroll instead
  const isLocationOnly = !qParam && !!(cityParam || stateParam || countryParam || (latParam && lngParam));

  const loadMoreRef = useRef(null);
  const loadingMoreRef = useRef(false);

  async function loadMore() {
    if (loadingMoreRef.current || !hasMore || loading) return;
    loadingMoreRef.current = true;
    try {
      await doSearch({
        q: qParam,
        sort: sortParam,
        country: countryParam,
        state: stateParam,
        city: cityParam,
        amazon: amazonParam,
        hqCountry: hqCountryParam,
        mfgCountry: mfgCountryParam,
        take: PAGE_SIZE,
        skip: results.length,
        location: userLoc,
        append: true,
      });
    } finally {
      loadingMoreRef.current = false;
    }
  }

  useEffect(() => {
    if (!isLocationOnly) return;
    const sentinel = loadMoreRef.current;
    if (!sentinel) return;
    const obs = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (entry?.isIntersecting && hasMore && !loading) {
        loadMore();
      }
    }, { rootMargin: "200px" });
    obs.observe(sentinel);
    return () => obs.disconnect();
  }, [isLocationOnly, hasMore, loading, results.length]);

  // Client-side sort: null = relevance (original API order), otherwise by chosen column
  const sorted = useMemo(() => {
    if (!sortBy) return results;

    const arr = [...results];
    arr.sort((a, b) => {
      let primary;
      if (sortBy === "stars") {
        primary = (getStarScore(b) ?? -Infinity) - (getStarScore(a) ?? -Infinity);
      } else if (sortBy === "manu") {
        primary = (a._nearestManuDist ?? Infinity) - (b._nearestManuDist ?? Infinity);
      } else {
        primary = (a._hqDist ?? Infinity) - (b._hqDist ?? Infinity);
      }
      if (primary !== 0) return primary;

      // Tiebreaker: relevance score
      const aRel = a._relevanceScore ?? a._nameMatchScore ?? 0;
      const bRel = b._relevanceScore ?? b._nameMatchScore ?? 0;
      return bRel - aRel;
    });
    return arr;
  }, [results, sortBy]);

  const rightColsOrder = useMemo(() => {
    if (sortBy === "stars") return ["stars", "manu", "hq"];
    if (sortBy === "hq") return ["hq", "manu", "stars"];
    if (sortBy === "manu") return ["manu", "hq", "stars"];
    return ["stars", "manu", "hq"]; // default column order for relevance
  }, [sortBy]);

  const headerClassFor = (key) =>
    `p-2 select-none cursor-pointer border-l ${
      sortBy === key
        ? "bg-amber-100 text-amber-900 font-semibold border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700"
        : "bg-muted text-foreground"
    }`;
  const cellClassFor = (key) => `p-2 ${sortBy === key ? "bg-amber-50 dark:bg-amber-900/20 text-foreground" : ""}`;

  const clickSort = (key) => {
    if (key === "manu") setSortBy("manu");
    else if (key === "hq") setSortBy("hq");
    else setSortBy("stars");
  };

  function handleKeywordSearch(keyword) {
    const next = new URLSearchParams(searchParams);
    next.set("q", keyword);
    next.delete("page");
    setSearchParams(next);
  }

  function goToPage(page) {
    const next = new URLSearchParams(searchParams);
    if (page <= 1) next.delete("page");
    else next.set("page", String(page));
    setSearchParams(next, { replace: true });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // Persist search history to sessionStorage
  useEffect(() => {
    try {
      sessionStorage.setItem("tabarnam_search_history", JSON.stringify(searchHistory));
      sessionStorage.setItem("tabarnam_search_history_index", String(historyIndex));
    } catch { /* ignore */ }
  }, [searchHistory, historyIndex]);

  function pushSearchHistory(entry) {
    setSearchHistory((prev) => {
      // If we navigated back then search again, truncate forward history
      const base = historyIndex >= 0 ? prev.slice(0, historyIndex + 1) : prev;
      // Don't push duplicate of current entry
      if (base.length > 0 && base[base.length - 1].q === entry.q) return base;
      const next = [...base, entry];
      setHistoryIndex(next.length - 1);
      return next;
    });
  }

  function navigateHistory(index) {
    if (index < 0 || index >= searchHistory.length) return;
    const entry = searchHistory[index];
    setHistoryIndex(index);
    navigatingHistoryRef.current = true;
    skipUrlEffectRef.current = true;

    // Update URL
    const next = new URLSearchParams();
    if (entry.q) next.set("q", entry.q);
    if (entry.sort) next.set("sort", entry.sort);
    if (entry.country) next.set("country", entry.country);
    if (entry.state) next.set("state", entry.state);
    if (entry.city) next.set("city", entry.city);
    next.delete("page");
    setSearchParams(next, { replace: true });

    doSearch({ q: entry.q, sort: entry.sort, country: entry.country, state: entry.state, city: entry.city, take: PAGE_SIZE, skip: 0 });
  }

  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < searchHistory.length - 1;

  const SORT_LABELS = { manu: "Nearest Manufacturing", hq: "Nearest Headquarters", stars: "Highest Rated" };

  function removeFilter(key) {
    const next = new URLSearchParams(searchParams);
    if (key === "sort") {
      next.set("sort", "stars");
    } else {
      next.delete(key);
    }
    setSearchParams(next);
  }

  const activeFilters = useMemo(() => {
    const chips = [];
    if (countryParam) chips.push({ key: "country", label: countryParam });
    if (stateParam) chips.push({ key: "state", label: stateParam });
    if (cityParam) chips.push({ key: "city", label: cityParam });
    if (sortParam && sortParam !== "stars") chips.push({ key: "sort", label: `Sort: ${SORT_LABELS[sortParam] || sortParam}` });
    return chips;
  }, [countryParam, stateParam, cityParam, sortParam]);

  const languageSelector = (
    <select
      className="h-11 text-sm border border-input rounded-md px-3 bg-background text-foreground font-medium hover:border-muted-foreground transition-colors"
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
          onAutoSearch={handleAutoSearch}
          filtersRightSlot={results.length > 0 ? languageSelector : null}
          containerClassName="max-w-none"
          searchHistory={searchHistory}
          historyIndex={historyIndex}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          onGoBack={() => navigateHistory(historyIndex - 1)}
          onGoForward={() => navigateHistory(historyIndex + 1)}
          onGoToIndex={navigateHistory}
          userCountryCode={userCountryCode}
        />
      </div>

      {/* Filter chips */}
      {activeFilters.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3 px-1">
          {activeFilters.map(({ key, label }) => (
            <span
              key={key}
              className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-primary/10 text-primary border border-primary/20"
            >
              {label}
              <button
                type="button"
                onClick={() => removeFilter(key)}
                className="hover:text-foreground transition-colors"
                aria-label={`Remove ${label} filter`}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="text-sm mb-3">
        {status && (
          <div className={`px-4 py-2 rounded ${
            status.includes("❌") ? "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300" :
            status.includes("⚠️") ? "bg-yellow-50 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300" :
            status.includes("Found") ? "bg-primary/10 text-primary dark:bg-primary/15 dark:text-primary" :
            "text-foreground"
          }`}>
            {status}
          </div>
        )}
      </div>

      {/* Column Headers + page info — same grid as ExpandableCompanyRow */}
      {results.length > 0 && (
        <div className="grid grid-cols-6 lg:grid-cols-5 gap-x-3 mb-4 px-2 items-center">
          <div className="col-span-6 lg:col-span-2 text-sm text-muted-foreground flex items-center gap-1">
            {qParam && (
              <>
                <span>
                  {/* Only show "of N" when the total is known AND the current
                      page fits inside it. A stale totalPages from an earlier
                      page-1 fetch must not appear next to a higher pageParam,
                      otherwise we render contradictions like "Page 2 of 1". */}
                  {Number.isFinite(totalPages) && totalPages > 0 && pageParam <= totalPages
                    ? <>Page {pageParam} of {totalPages} for </>
                    : hasMore || pageParam > 1
                      ? <>Page {pageParam} for </>
                      : <>Results for </>
                  }
                  <span className="font-medium text-foreground">"{qParam}"</span>
                </span>
                <ShareButton
                  title={`Search results for "${qParam}" on Tabarnam`}
                  text={`Search results for "${qParam}" on Tabarnam`}
                  url={window.location.href}
                  label="Share these search results"
                  dialogTitle="Share search results"
                  className="w-8 h-8 min-w-[32px] min-h-[32px]"
                />
              </>
            )}
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
                className={cn(
                  "font-semibold rounded transition-colors text-[15px] px-2.5 py-1.5 border",
                  isSelected
                    ? "bg-tabarnam-blue text-gray-800 dark:text-gray-900 border-tabarnam-blue"
                    : "bg-transparent text-tabarnam-blue-bold border-tabarnam-blue-bold"
                )}
                data-tour-step={colKey === "stars" ? "sort-header-qq" : undefined}
              >
                {colLabel}
              </button>
            );

            return (
              <div key={colKey} className="col-span-2 lg:col-span-1 flex items-center gap-1">
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
        {loading && sorted.length === 0 ? (
          <div className="space-y-0">
            {Array.from({ length: 5 }).map((_, i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        ) : sorted.length > 0 ? (
          <div className="space-y-0">
            {sorted.map((company) => (
              <ExpandableCompanyRow
                key={company.id || company.company_name}
                company={company}
                sortBy={sortBy}
                unit={unit}
                onKeywordSearch={handleKeywordSearch}
                rightColsOrder={rightColsOrder}
                debugScores={debugScores}
              />
            ))}
          </div>
        ) : (
          <div className="p-8 text-center">
            <div className="text-muted-foreground">
              <p className="text-lg font-medium mb-1">No companies found</p>
              <p className="text-sm">Try adjusting your search terms or filters</p>
            </div>
          </div>
        )}
      </div>

      {isLocationOnly ? (
        <div ref={loadMoreRef} className="py-6 text-center text-sm text-muted-foreground">
          {hasMore ? (loading ? "Loading more…" : "Scroll for more") : (results.length > 0 ? "End of results" : null)}
        </div>
      ) : (
        (hasMore || pageParam > 1 || (totalPages && totalPages > 1)) && (
          <Pagination
            currentPage={pageParam}
            hasMore={hasMore}
            totalPages={totalPages}
            onPageChange={goToPage}
            disabled={loading}
          />
        )
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

/** Deduplicate HQ location entries by city|region|country key or address string. */
function deduplicateHqList(list) {
  if (!Array.isArray(list) || list.length <= 1) return list;
  const seen = new Set();
  return list.filter((h) => {
    if (!h) return false;
    const city = String(h?.city || "").trim().toLowerCase();
    const region = String(h?.region || h?.state || h?.state_code || "").trim().toLowerCase();
    const country = String(h?.country || h?.country_code || "").trim().toLowerCase();
    let key = "";
    if (city || country) key = [city, region, country].filter(Boolean).join("|");
    else key = String(h?.address || h?.formatted || h?.full_address || h?.location || "").trim().toLowerCase();
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function attachDistances(c, userLoc, unit) {
  const out = { ...c, _hqDist: null, _nearestManuDist: null, _manuDists: [], _hqDists: [] };

  const user = getLatLng(userLoc);
  if (!user) return out;

  // HQ - prefer headquarters_locations, with legacy fallback to headquarters, then fall back to hq_lat/hq_lng
  let hqList = [];
  if (Array.isArray(c.headquarters_locations) && c.headquarters_locations.length > 0) {
    hqList = deduplicateHqList(c.headquarters_locations);
  } else if (Array.isArray(c.headquarters) && c.headquarters.length > 0) {
    hqList = deduplicateHqList(c.headquarters);
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
