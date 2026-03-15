// src/pages/ResultsPage.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Helmet } from "react-helmet-async";
import { useSearchParams, useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { geocode } from "@/lib/google";
import { calculateDistance, usesMiles } from "@/lib/distance";
import SearchCard from "@/components/home/SearchCard";
import ExpandableCompanyRow from "@/components/results/ExpandableCompanyRow";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { searchCompanies, getSearchCount } from "@/lib/searchCompanies";
import { API_BASE } from "@/lib/api";
import { getQQScore } from "@/lib/stars/qqRating";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import ShareButton from "@/components/ShareButton";

const PAGE_SIZE = 50;

/** Skeleton placeholder that mirrors the collapsed ExpandableCompanyRow grid */
function SkeletonRow() {
  return (
    <div className="grid grid-cols-6 lg:grid-cols-5 gap-x-3 gap-y-2 border border-border rounded-lg p-2 bg-card mb-3">
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
  if (currentPage <= 1 && !hasMore && !totalPages) return null;

  // If we know the total, use it; otherwise fall back to hasMore-based guessing
  const lastPage = totalPages || (hasMore ? currentPage + 1 : currentPage);
  const pages = [];
  const add = (n) => { if (n >= 1 && n <= lastPage && !pages.includes(n)) pages.push(n); };
  add(1);
  add(currentPage - 1);
  add(currentPage);
  add(currentPage + 1);
  if (lastPage > 1) add(lastPage);
  pages.sort((a, b) => a - b);

  // Insert ellipsis markers (represented as null)
  const items = [];
  for (let i = 0; i < pages.length; i++) {
    if (i > 0 && pages[i] - pages[i - 1] > 1) items.push(null);
    items.push(pages[i]);
  }

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
            disabled={disabled || (!hasMore && (!totalPages || currentPage >= totalPages))}
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
  const [userLoc, setUserLoc] = useState(null);
  const [unit, setUnit] = useState("mi");
  const [userCountryCode, setUserCountryCode] = useState("");
  const [sortBy, setSortBy] = useState(null);

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
      try {
        if (latParam && lngParam && !Number.isNaN(Number(latParam)) && !Number.isNaN(Number(lngParam))) {
          loc = { lat: Number(latParam), lng: Number(lngParam) };
        } else if (cityParam || stateParam || countryParam) {
          const addr = [cityParam, stateParam, countryParam].filter(Boolean).join(", ");
          const r = await geocode({ address: addr });
          loc = r?.best?.location || null;
          const cc = r?.best?.components?.find(c => c.types?.includes("country"))?.short_name;
          if (cc) { setUnit(milesCountries.has(cc) ? "mi" : "km"); setUserCountryCode(cc); }
        } else {
          const r = await geocode({ ipLookup: true });
          loc = r?.best?.location || { lat: 34.0983, lng: -117.8076 };
          const cc = r?.best?.components?.find(c => c.types?.includes("country"))?.short_name;
          if (cc) { setUnit(milesCountries.has(cc) ? "mi" : "km"); setUserCountryCode(cc); }
        }
      } catch {
        // ignore geocode errors
      }
      if (!cancelled && loc) setUserLoc({ lat: loc.lat, lng: loc.lng });

      setSortBy(null);

      if (!cancelled && qParam) {
        // Seed search history on initial load / URL-driven navigation
        pushSearchHistory({ q: qParam, sort: sortParam, country: countryParam, state: stateParam, city: cityParam });
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
          skip: (pageParam - 1) * PAGE_SIZE,
          location: loc,
        });
      } else if (!cancelled) {
        setResults([]);
        setStatus("");
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
          if (cc) { setUnit(milesCountries.has(cc) ? "mi" : "km"); setUserCountryCode(cc); }
        }
      }
    } catch {
      // ignore
    }

    setSortBy(null);

    // Track in search history (skip if this was triggered by back/forward navigation)
    if (!navigatingHistoryRef.current) {
      pushSearchHistory({ q, sort, country, state, city });
    }
    navigatingHistoryRef.current = false;

    await doSearch({ q, sort, country, state, city, amazon, hqCountry, mfgCountry, take: PAGE_SIZE, skip: 0, location: searchLocation });
  }

  // Lightweight auto-search: fetches results without updating URL (avoids input interruption)
  function handleAutoSearch({ q, sort, country, state, city, amazon, hqCountry, mfgCountry }) {
    if (!q) return;
    doSearch({ q, sort, country, state, city, amazon, hqCountry, mfgCountry, take: PAGE_SIZE, skip: 0 });
  }

  async function doSearch({ q, sort, country, state, city, amazon, hqCountry, mfgCountry, take = PAGE_SIZE, skip = 0, location = null }) {
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
        amazon,
        hqCountry,
        mfgCountry,
        take,
        skip,
        lat: effectiveLocation?.lat,
        lng: effectiveLocation?.lng,
      });

      // If no results on page 1, try alternative query forms (fallback retry)
      if (searchResult.items?.length === 0 && !skip) {
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

      const { items = [], hasMore: apiHasMore, meta } = searchResult;
      const withDistances = items.map((c) => normalizeStars(attachDistances(c, effectiveLocation, unit)));
      const withReviews = await loadReviews(withDistances);

      setResults(withReviews);
      setHasMore(apiHasMore === true);

      // If everything fit on one page (no hasMore), we know the total already
      if (!apiHasMore && skip === 0) {
        setTotalPages(1);
      } else {
        // Fire background count request (doesn't block UI)
        setTotalPages(null);
        getSearchCount({ q, sort, country, state, city, amazon, hqCountry, mfgCountry, take: PAGE_SIZE, lat: effectiveLocation?.lat, lng: effectiveLocation?.lng })
          .then((r) => { if (r) setTotalPages(r.totalPages); })
          .catch(() => {});
      }

      if (meta?.usingStubData) {
        if (withReviews.length === 0) {
          setStatus("⚠️ Search API unavailable and no sample companies matched your search.");
        } else {
          setStatus(`⚠️ Search API unavailable – showing ${withReviews.length} sample companies.`);
        }
      } else if (withReviews.length === 0) {
        setStatus("No companies found matching your criteria.");
      } else if (meta?.error) {
        setStatus(`⚠️ ${meta.error}`);
      } else {
        setStatus("");
      }
    } catch (e) {
      setStatus(`❌ ${e?.message || "Search failed"}`);
    } finally {
      setLoading(false);
    }
  }

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
    setSearchParams(next, { replace: true });
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
    setSearchParams(next, { replace: true });
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
                  {totalPages != null
                    ? <>Page {pageParam} of {totalPages} for </>
                    : hasMore || pageParam > 1
                      ? <>Page {pageParam} for </>
                      : <>Results for </>
                  }
                  <span className="font-medium text-foreground">"{qParam}"</span>
                </span>
                <ShareButton
                  title={`Search results for "${qParam}" on Tabarnam`}
                  text={`Found results for "${qParam}" on Tabarnam`}
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

      {(hasMore || pageParam > 1 || (totalPages && totalPages > 1)) && (
        <Pagination
          currentPage={pageParam}
          hasMore={hasMore}
          totalPages={totalPages}
          onPageChange={goToPage}
          disabled={loading}
        />
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
