// src/components/home/SearchCard.jsx
import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Search, MapPin, ListFilter, Loader2, X, Clock, ChevronLeft, ChevronRight, ChevronDown, Check } from 'lucide-react';
import { useSearchCache } from '@/hooks/useSearchCache';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
// Select removed — sort/filter now uses Popover with radio buttons + checkbox
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { getCountries, resolveCountryText } from '@/lib/location';
import { getSuggestions, getRefinements, getCitySuggestions, getStateSuggestions } from '@/lib/searchCompanies';
import { extractSearchTermFromUrl } from '@/lib/queryNormalizer';
import { placesAutocomplete, placeDetails, resolveLocation, topCityForState, geocode } from '@/lib/google';
import { cn } from '@/lib/utils';

// When the user submits with all three location fields empty we auto-detect
// their location so distances aren't "unavailable" everywhere. We populate
// the visible form inputs with what we picked so the user can see exactly
// what proximity center is being used and change it if they wanted somewhere
// else — same UX principle behind the state→top-city autopopulate
// (commit 1c12f1ef): defaults must be visible, not silent.
//
// Full location chain (no browser geolocation prompt at any step):
//   1) Whatever the user typed in city / state / country. Detection below
//      ONLY runs when all three fields are empty (the `noLocationProvided`
//      check in handleSubmit), so any user-entered value is honored as-is.
//   2) IP address via ipapi.co (called from the browser so it sees the
//      user's actual IP, not the Azure datacenter's).
//   3) geolocation-db.com as a backup — different DB from ipapi, runs only
//      when ipapi failed or returned no usable fields. We tried ipwho.is
//      first but it 403s "CORS is not supported on the Free plan" from the
//      browser. geolocation-db is CORS-enabled and free.
//   4) San Dimas, CA, US — final fallback so the form is never empty and
//      distances always compute. The user can edit any field to override.
async function fetchIpapi() {
  try {
    const r = await fetch("https://ipapi.co/json/");
    if (!r.ok) return null;
    const data = await r.json();
    const out = {
      countryCode: data?.country_code || data?.country || "",
      stateCode: data?.region_code || "",
      city: data?.city || "",
    };
    return (out.countryCode || out.stateCode || out.city) ? out : null;
  } catch { return null; }
}

async function fetchGeolocationDb() {
  try {
    const r = await fetch("https://geolocation-db.com/json/");
    if (!r.ok) return null;
    const data = await r.json();
    // geolocation-db returns "Not found" strings for unknown fields — filter
    // those out so we don't end up with city: "Not found" in the form.
    const clean = (v) => (typeof v === "string" && v.trim() && v !== "Not found") ? v.trim() : "";
    const out = {
      countryCode: clean(data?.country_code),
      stateCode: clean(data?.state),
      city: clean(data?.city),
    };
    return (out.countryCode || out.stateCode || out.city) ? out : null;
  } catch { return null; }
}

const SAN_DIMAS_FALLBACK = {
  countryCode: "US",
  stateCode: "CA",
  city: "San Dimas",
};

async function detectUserLocation() {
  return (await fetchIpapi()) || (await fetchGeolocationDb()) || SAN_DIMAS_FALLBACK;
}

const SORTS = [
  { value: 'manu',  label: 'Nearest manufacturing' },
  { value: 'hq',    label: 'Nearest headquarters' },
  { value: 'stars', label: 'Highest rated' },
];

function toQs(o){ return new URLSearchParams(Object.entries(o).filter(([,v]) => v !== undefined && v !== '' && v !== null)).toString(); }

const PLACEHOLDERS = [
  "Search by product, company\u2026",
  'Try "organic soap"',
  'Try "ceramic mugs"',
  'Try "robes"',
  'Try "bamboo toothbrush"',
  'Try "stainless steel bottles"',
];

// Amazon-style: Keywords/Industries first (completions), then Companies
const SUGGEST_TYPE_ORDER = ["Keyword", "Industry", "Company"];

export default function SearchCard({
  onSubmitParams,
  filtersRightSlot = null,
  containerClassName = "",
  autoFocus = false,
  searchHistory = [],
  historyIndex = -1,
  canGoBack = false,
  canGoForward = false,
  onGoBack,
  onGoForward,
  onGoToIndex,
  onAutoSearch,
  userCountryCode = "",
}) {
  const nav = useNavigate();
  const { search } = useLocation();
  const { getCachedSearches, addSearchToCache } = useSearchCache();

  const [q, setQ] = useState('');
  const [country, setCountry] = useState('');
  const [stateCode, setStateCode] = useState('');
  const [city, setCity] = useState('');
  const [sortBy, setSortBy] = useState('stars'); // default
  const [amazonOnly, setAmazonOnly] = useState(false);
  const [hqInCountry, setHqInCountry] = useState(false);
  const [mfgInCountry, setMfgInCountry] = useState(false);
  const [sortFilterOpen, setSortFilterOpen] = useState(false);

  const [countries, setCountries] = useState([]);

  const [suggestions, setSuggestions] = useState([]);
  const [openSuggest, setOpenSuggest] = useState(false);
  const [loading, setLoading] = useState(false);

  // Recent searches (Feature E)
  const [recentSearches, setRecentSearches] = useState([]);
  const [showRecent, setShowRecent] = useState(false);

  // Search history dropdown
  const [showHistoryDropdown, setShowHistoryDropdown] = useState(false);
  const historyDropdownRef = useRef(null);

  // Close history dropdown on outside click
  useEffect(() => {
    if (!showHistoryDropdown) return;
    const handler = (e) => {
      if (historyDropdownRef.current && !historyDropdownRef.current.contains(e.target)) {
        setShowHistoryDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showHistoryDropdown]);

  // Rotating placeholder (Feature W)
  const [placeholderIdx, setPlaceholderIdx] = useState(0);

  const [citySuggestions, setCitySuggestions] = useState([]);
  const [openCitySuggest, setOpenCitySuggest] = useState(false);
  const [stateSuggestions, setStateSuggestions] = useState([]);
  const [openStateSuggest, setOpenStateSuggest] = useState(false);
  const [countrySearch, setCountrySearch] = useState('');

  const inputRef = useRef(null);
  const cityInputRef = useRef(null);
  const stateInputRef = useRef(null);
  const handleSubmitRef = useRef(null);
  const debounceSearchRef = useRef(null);
  const debounceUrlRef = useRef(null);
  const lastSearchedQRef = useRef('');
  // One-shot guard: when true, skip the topCityForState autofill on the next
  // submit so an explicit X-clear of the city field isn't immediately undone
  // by the state→top-city helper. Reset after the submit and on city onChange.
  const cityClearedByUserRef = useRef(false);

  useEffect(() => {
    if (!autoFocus) return;

    const t = setTimeout(() => {
      inputRef.current?.focus();
    }, 0);

    return () => clearTimeout(t);
  }, [autoFocus]);

  // Rotating placeholder (Feature W) — pause when user is typing
  useEffect(() => {
    if (q.length > 0) return;
    const iv = setInterval(() => {
      setPlaceholderIdx((prev) => (prev + 1) % PLACEHOLDERS.length);
    }, 4000);
    return () => clearInterval(iv);
  }, [q]);

  useEffect(() => {
    getCountries().then(setCountries);
  }, []);

  // Hydrate from URL — the form must mirror the URL exactly. Always write
  // every field (defaulting to empty when the param is absent) so that
  // navigating from /results?q=water&city=91750 to /results?q=water clears
  // the now-stale city. Previous version used `if (p.has(field)) setField(...)`
  // which left out-of-URL fields holding their old value, producing the
  // bug where city=91750 persisted in the form after the URL had dropped it.
  useEffect(() => {
    const p = new URLSearchParams(search);
    const urlQ = p.get('q') || '';
    setQ(urlQ);
    lastSearchedQRef.current = urlQ.trim();
    setCountry(p.get('country') || '');
    setStateCode(p.get('state') || '');
    setCity(p.get('city') || '');
    setSortBy(p.get('sort') || 'stars');
    setAmazonOnly(p.get('amazon') === '1');
    setHqInCountry(p.has('hqCountry'));
    setMfgInCountry(p.has('mfgCountry'));
  }, [search]);

  const inputFocusedRef = useRef(false);

  useEffect(() => {
    const t = setTimeout(async () => {
      const s = q.trim();
      if (s.length < 2) {
        setSuggestions([]);
        setOpenSuggest(false);
        return;
      }
      // Don't show suggestions if query matches what was already searched
      // (e.g., on page load from URL, or after submitting a search)
      if (s === lastSearchedQRef.current) {
        setSuggestions([]);
        return;
      }
      // Don't show suggestions if input isn't focused
      if (!inputFocusedRef.current) return;
      // Hide recent searches once user starts typing enough for API suggestions
      setShowRecent(false);

      try {
        // Fetch both company suggestions and keyword/industry refinements
        const [companySuggestions, refinementSuggestions] = await Promise.all([
          getSuggestions(s, 8),
          getRefinements(s, country, stateCode, city, 12),
        ]);

        // Amazon-style: keyword/industry completions first, then company matches
        const merged = [];
        // Add keyword/industry refinements first (these are the "completions")
        for (const ref of refinementSuggestions) {
          if (merged.length >= 10) break;
          merged.push(ref);
        }
        // Then add company name matches
        for (const co of companySuggestions) {
          if (merged.length >= 12) break;
          const isDuplicate = merged.some((m) => m.value.toLowerCase() === co.value.toLowerCase());
          if (!isDuplicate) merged.push(co);
        }

        setSuggestions(merged.slice(0, 12));
        setOpenSuggest(merged.length > 0);
      } catch (e) {
        console.warn("Failed to load suggestions:", e?.message);
        setSuggestions([]);
        setOpenSuggest(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [q, country, stateCode, city]);

  // Search-as-you-type with two debounce tiers (RESULTS PAGE ONLY):
  //   1000 ms after last keystroke → silent auto-search of partial text
  //                                  (re-fetch results, do NOT touch URL)
  //   3000 ms after last keystroke → commit the input value to the URL
  //                                  (search becomes shareable / persisted)
  // The wider 1 s search debounce lets users finish a word before any fetch
  // fires. A deliberate submit (Enter / Search-click / pick) cancels both
  // pending timers via the cleanup block in handleSubmit.
  //
  // Both tiers are gated on `onAutoSearch` being passed by the parent — i.e.
  // we're inside the results page. On the HOME page there is no
  // onAutoSearch, so typing does NOT trigger any submit. The user needs to
  // click Search (or hit Enter) to launch a search. Without this gate,
  // typing on the home page would hit the 1 s timer, fall into
  // handleSubmit, run IP detection, and navigate to /results before the
  // user had a chance to fill in their own city / state / country.
  useEffect(() => {
    if (debounceSearchRef.current) {
      clearTimeout(debounceSearchRef.current);
      debounceSearchRef.current = null;
    }
    if (debounceUrlRef.current) {
      clearTimeout(debounceUrlRef.current);
      debounceUrlRef.current = null;
    }

    if (!onAutoSearch) return;

    const trimmed = q.trim();
    const hasLocationFilter = !!(country || stateCode || city);
    if (trimmed.length < 2 && !hasLocationFilter) return;

    // Skip if this query was already searched (initial hydration / after submit)
    if (trimmed === lastSearchedQRef.current) return;

    debounceSearchRef.current = setTimeout(() => {
      lastSearchedQRef.current = trimmed;
      onAutoSearch({ q: trimmed, sort: sortBy, country, state: stateCode, city, amazon: amazonOnly, hqCountry: hqInCountry ? userCountryCode : '', mfgCountry: mfgInCountry ? userCountryCode : '' });
    }, 1000);

    // Delayed URL commit: sync the URL 3 s after last keystroke so the
    // search becomes shareable / bookmarkable without firing on every brief
    // typing pause. Only the inline (results-page) path needs this; the
    // home-page path already updated URL via the auto-search above.
    if (onAutoSearch && onSubmitParams) {
      debounceUrlRef.current = setTimeout(() => {
        lastSearchedQRef.current = trimmed;
        handleSubmitRef.current();
      }, 3000);
    }

    return () => {
      if (debounceSearchRef.current) {
        clearTimeout(debounceSearchRef.current);
        debounceSearchRef.current = null;
      }
      if (debounceUrlRef.current) {
        clearTimeout(debounceUrlRef.current);
        debounceUrlRef.current = null;
      }
    };
  }, [q]);

  // Re-search when any filter checkbox toggles (immediate submit, no debounce).
  // Same gating as the typing debounce: results page only. On the home page
  // toggling a filter must NOT silently launch a search before the user has
  // entered a query / location and clicked Search.
  const filterInitRef = useRef(true);
  useEffect(() => {
    if (filterInitRef.current) { filterInitRef.current = false; return; }
    if (!onAutoSearch) return;
    const trimmed = q.trim();
    if (trimmed.length < 2 && !country && !stateCode && !city) return;
    handleSubmitRef.current();
  }, [amazonOnly, hqInCountry, mfgInCountry]);

  // Check if input might be a postal code and auto-fill country
  useEffect(() => {
    const c = city.trim();

    // Check if it looks like a postal code (for common patterns)
    const postalCodePattern = /^\d{5}(-\d{4})?$|^[A-Z]\d[A-Z] \d[A-Z]\d$|^\d{5}$|^[A-Z]{1,2}\d{1,2}[A-Z]? ?\d[A-Z]{2}$|^\d{4}$|^[A-Z0-9]{3,8}$/i;
    const looksLikePostalCode = postalCodePattern.test(c) && c.length >= 3;

    if (looksLikePostalCode && !country) {
      // Try to get place details for this postal code to extract country
      const t = setTimeout(async () => {
        try {
          const suggestions = await placesAutocomplete({ input: c, country: '' });
          if (suggestions.length > 0) {
            const details = await placeDetails({ placeId: suggestions[0].placeId });
            if (details && details.countryCode && !country) {
              setCountry(details.countryCode);
            }
          }
        } catch (e) {
          console.warn("Failed to detect country from postal code:", e?.message);
        }
      }, 500);
      return () => clearTimeout(t);
    }
  }, [city, country]);

  useEffect(() => {
    const c = city.trim();
    if (c.length < 1) {
      setCitySuggestions([]);
      setOpenCitySuggest(false);
      return;
    }

    const t = setTimeout(async () => {
      try {
        const suggestions = await getCitySuggestions(c, country);
        setCitySuggestions(suggestions);
        // Auto-open the popover if suggestions are found
        setOpenCitySuggest(suggestions.length > 0);
      } catch (e) {
        console.warn("Failed to load city suggestions:", e?.message);
        setCitySuggestions([]);
        setOpenCitySuggest(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [city, country]);

  useEffect(() => {
    const s = stateCode.trim();
    if (s.length < 1) {
      setStateSuggestions([]);
      setOpenStateSuggest(false);
      return;
    }

    const t = setTimeout(async () => {
      try {
        const suggestions = await getStateSuggestions(s, country);
        setStateSuggestions(suggestions);
        // Auto-open the popover if suggestions are found
        setOpenStateSuggest(suggestions.length > 0);
      } catch (e) {
        console.warn("Failed to load state suggestions:", e?.message);
        setStateSuggestions([]);
        setOpenStateSuggest(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [stateCode, country]);

  const handleCitySelect = (cityName) => {
    setCity(cityName);
    setCitySuggestions([]);
    setOpenCitySuggest(false);
    // Trigger search with new geo filter
    if (q.trim().length >= 2 || country || stateCode || cityName) setTimeout(() => handleSubmitRef.current(), 0);
  };

  const handleStateSelect = (stateName) => {
    setStateCode(stateName);
    setStateSuggestions([]);
    setOpenStateSuggest(false);
    // Trigger search with new geo filter
    if (q.trim().length >= 2 || country || stateName || city) setTimeout(() => handleSubmitRef.current(), 0);
  };

  const selectedCountryName = country ? countries.find(c => c.code === country)?.name || '' : '';

  const onKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      setSuggestions([]);
      handleSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setSuggestions([]);
      setShowRecent(false);
      setCountrySearch('');
      inputRef.current?.blur();
    }
  };

  const handleSubmit = async (overrideQ) => {
    // Cancel any pending auto-search and URL-update debounces — a deliberate
    // submit (Enter / Search button / suggestion pick) supersedes them.
    if (debounceSearchRef.current) {
      clearTimeout(debounceSearchRef.current);
      debounceSearchRef.current = null;
    }
    if (debounceUrlRef.current) {
      clearTimeout(debounceUrlRef.current);
      debounceUrlRef.current = null;
    }


    // Read from the DOM ref to handle paste + immediate Enter (React state may be stale)
    const rawQ = (overrideQ !== undefined ? String(overrideQ) : (inputRef.current?.value ?? q)).trim();
    // If the user pasted a URL, extract the brand name so search works
    const extracted = extractSearchTermFromUrl(rawQ);
    if (extracted !== rawQ) setQ(extracted); // update input so user sees what was searched
    else if (rawQ !== q) setQ(rawQ); // sync React state with DOM (paste + Enter race)

    lastSearchedQRef.current = extracted;

    // Save to recent searches (Feature E)
    if (extracted) addSearchToCache({ term: extracted });

    // Close recent/suggestions dropdowns
    setShowRecent(false);
    setRecentSearches([]);
    setSuggestions([]);

    setLoading(true);
    try {
      // Resolve free-text country input to ISO code if not already resolved
      let resolvedCountry = country;
      if (!country && countrySearch.trim()) {
        const match = await resolveCountryText(countrySearch.trim());
        if (match) {
          resolvedCountry = match.code;
          setCountry(match.code);
          setCountrySearch('');
        }
      }

      // Resolve the location to derive a country code if the user didn't
      // provide one (e.g. they typed only "edinburgh" — Places will tell us
      // it's in GB). Beyond that we deliberately do NOT write resolved
      // values back into the URL: keeping URL = exactly what the user typed
      // produces clean, shareable links and avoids the second-pass-resolution
      // bug where the URL effect would re-resolve "Edinburgh, Scotland, GB"
      // and Google would rank "Scotland" higher than the city, snapping the
      // proximity center to Scotland's centroid (57.74, -4.69) instead of
      // Edinburgh (55.95, -3.18). The URL effect / handleInlineSearch will
      // re-derive coords from city/country at search time.
      if (!resolvedCountry && (city || stateCode)) {
        const resolved = await resolveLocation({
          city: (city || '').trim(),
          state: (stateCode || '').trim(),
          country: resolvedCountry,
        });
        if (resolved.countryCode) {
          resolvedCountry = resolved.countryCode;
          setCountry(resolved.countryCode);
        }
      }

      // No location at all → auto-detect from device/IP and populate the
      // visible form so the user sees what proximity center is being used.
      // Without this, no-location searches have no center and every result
      // shows "Distance unavailable". The detection only runs when ALL three
      // fields are empty so it never hijacks an intentional search.
      let effectiveCountry = resolvedCountry;
      let effectiveStateCode = stateCode;
      let effectiveCity = city;
      const noLocationProvided =
        !effectiveCity.trim() && !effectiveStateCode.trim() && !effectiveCountry.trim();
      if (noLocationProvided) {
        const detected = await detectUserLocation();
        if (detected) {
          if (detected.countryCode) {
            effectiveCountry = detected.countryCode;
            setCountry(detected.countryCode);
          }
          if (detected.stateCode) {
            effectiveStateCode = detected.stateCode;
            setStateCode(detected.stateCode);
          }
          if (detected.city) {
            effectiveCity = detected.city;
            setCity(detected.city);
          }
        }
      }

      // State-only inputs (e.g. "maine" with no city) get a default city
      // picked from the largest metro in that state. Without this, the
      // proximity center falls back to the geographic centroid of the
      // state's polygon — which for Maine sits in northern Piscataquis
      // County, putting border-adjacent NH companies *closer* to "Maine"
      // than Maine companies on the populated coast. We populate the
      // visible city input so the user sees what we chose and can change
      // it if they wanted a different anchor city.
      if (!cityClearedByUserRef.current && !effectiveCity.trim() && effectiveStateCode.trim()) {
        const topCity = topCityForState(effectiveStateCode.trim(), effectiveCountry);
        if (topCity) {
          effectiveCity = topCity;
          setCity(topCity);
        }
      }
      cityClearedByUserRef.current = false;

      const params = {
        q: extracted,
        sort: sortBy,
        country: effectiveCountry,
        state: effectiveStateCode,
        city: effectiveCity,
        amazon: amazonOnly ? '1' : '',
        hqCountry: hqInCountry ? userCountryCode : '',
        mfgCountry: mfgInCountry ? userCountryCode : '',
      };
      if (onSubmitParams) onSubmitParams(params);
      else nav(`/results?${toQs(params)}`);
    } finally {
      setLoading(false);
    }
  };
  handleSubmitRef.current = handleSubmit;

  // Reset every form field and route home so the user starts from a clean
  // slate. Necessary because the URL is the source of truth for the form
  // (URL hydration effect at the top), so simply clearing the inputs in
  // place doesn't help when the URL still carries `?country=US&sort=manu`
  // — those would re-hydrate on the next render. Routing to "/" wipes the
  // URL params, the hydration effect then writes empty values into every
  // field, and we explicitly reset the React-only state (sort default,
  // checkboxes, country search text, etc.) here too in case we're already
  // on "/".
  const handleClear = () => {
    setQ('');
    setCity('');
    setStateCode('');
    setCountry('');
    setCountrySearch('');
    setSortBy('stars');
    setAmazonOnly(false);
    setHqInCountry(false);
    setMfgInCountry(false);
    setSuggestions([]);
    setShowRecent(false);
    cityClearedByUserRef.current = false;
    lastSearchedQRef.current = '';
    nav('/');
  };

  // Show recent searches when input focused and empty (Feature E)
  const handleInputFocus = () => {
    if (q.trim().length < 2) {
      const cached = getCachedSearches();
      if (cached.length > 0) {
        setRecentSearches(cached);
        setShowRecent(true);
      }
    }
  };

  const clearRecentSearches = () => {
    try { localStorage.removeItem('tabarnam_recent_searches'); } catch { /* ignore */ }
    setRecentSearches([]);
    setShowRecent(false);
  };

  return (
    <div
      className={cn(
        "w-full bg-card border border-border rounded-2xl p-5 md:p-6 shadow",
        containerClassName || "max-w-5xl"
      )}
    >
      {/* Row 1: Search field and button spanning full width */}
      <div className={cn("grid grid-cols-1 gap-3 mb-3", searchHistory.length > 0 ? "md:grid-cols-[auto_1fr_auto_auto]" : "md:grid-cols-[1fr_auto_auto]")}>
        {/* Back / dropdown / forward nav */}
        {searchHistory.length > 0 && (
          <div className="hidden md:flex items-center gap-0.5 relative" ref={historyDropdownRef}>
            <button
              type="button"
              disabled={!canGoBack}
              onClick={onGoBack}
              className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-30 disabled:pointer-events-none transition-colors"
              aria-label="Previous search"
            >
              <ChevronLeft size={20} />
            </button>
            <button
              type="button"
              onClick={() => setShowHistoryDropdown((v) => !v)}
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              aria-label="Search history"
            >
              <ChevronDown size={16} />
            </button>
            <button
              type="button"
              disabled={!canGoForward}
              onClick={onGoForward}
              className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-30 disabled:pointer-events-none transition-colors"
              aria-label="Next search"
            >
              <ChevronRight size={20} />
            </button>
            {/* History dropdown */}
            {showHistoryDropdown && (
              <div className="absolute top-full left-0 mt-1 z-50 min-w-[200px] bg-popover border border-border rounded-md shadow-lg py-1">
                <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider border-b border-border flex items-center gap-1.5">
                  <Clock size={12} />
                  Search History
                </div>
                {[...searchHistory].reverse().map((entry, revIdx) => {
                  const realIdx = searchHistory.length - 1 - revIdx;
                  const isCurrent = realIdx === historyIndex;
                  return (
                    <button
                      key={`hist-${realIdx}`}
                      type="button"
                      className={cn(
                        "w-full text-left px-3 py-1.5 text-sm hover:bg-accent flex items-center gap-2 transition-colors",
                        isCurrent ? "bg-accent font-medium text-foreground" : "text-popover-foreground"
                      )}
                      onClick={() => { setShowHistoryDropdown(false); if (onGoToIndex) onGoToIndex(realIdx); }}
                    >
                      {isCurrent && <span className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" />}
                      <span className={isCurrent ? "" : "ml-[14px]"}>{entry.q}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground z-10" size={18} />
          {q && (
            <button
              type="button"
              onClick={()=>{ setQ(''); inputRef.current?.focus(); }}
              className="absolute right-3.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground z-10"
              aria-label="Clear query"
            >
              <X size={16} />
            </button>
          )}
          <Input
            ref={inputRef}
            autoFocus={autoFocus}
            value={q}
            onChange={(e)=>setQ(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={(e) => { inputFocusedRef.current = true; handleInputFocus(e); }}
            onBlur={() => { inputFocusedRef.current = false; setTimeout(() => { setShowRecent(false); setSuggestions([]); }, 200); }}
            placeholder={q ? "" : PLACEHOLDERS[placeholderIdx]}
            className="pl-10 pr-9 h-11 bg-background border-input text-foreground"
            autoComplete="off"
            data-tour-step="search-input"
          />
          {/* Amazon-style flat suggestion dropdown */}
          {suggestions.length > 0 && (
            <div className="absolute left-0 right-0 top-full z-50 mt-1 rounded-md border border-border bg-popover shadow-md max-h-80 overflow-y-auto">
              {(() => {
                const qLower = q.trim().toLowerCase();
                // Sort: Keywords/Industries first (completions), then Companies
                const sorted = [...suggestions].sort((a, b) => {
                  const ai = SUGGEST_TYPE_ORDER.indexOf(a.type);
                  const bi = SUGGEST_TYPE_ORDER.indexOf(b.type);
                  return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
                });
                return sorted.map((s, i) => {
                  const val = s.value;
                  const valLower = val.toLowerCase();
                  const isCompany = s.type === "Company";

                  // Highlight: typed prefix in normal weight, completion in bold
                  let prefixEnd = 0;
                  if (valLower.startsWith(qLower)) {
                    prefixEnd = qLower.length;
                  } else {
                    const idx = valLower.indexOf(qLower);
                    if (idx >= 0) prefixEnd = idx + qLower.length;
                  }

                  return (
                    <button
                      key={`${val}-${i}`}
                      className="w-full text-left px-3 py-2 text-sm text-popover-foreground hover:bg-accent flex items-center gap-2.5 border-b border-border/30 last:border-b-0"
                      onMouseDown={(e)=>e.preventDefault()}
                      onClick={()=>{ setSuggestions([]); setQ(val); handleSubmit(val); }}
                    >
                      <Search size={14} className="text-muted-foreground flex-shrink-0" />
                      <span className="flex-1 truncate">
                        {prefixEnd > 0 ? (
                          <>
                            <span className="font-normal">{val.slice(0, prefixEnd)}</span>
                            <span className="font-semibold">{val.slice(prefixEnd)}</span>
                          </>
                        ) : (
                          <span className="font-semibold">{val}</span>
                        )}
                      </span>
                      {isCompany && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground flex-shrink-0 uppercase tracking-wider">company</span>
                      )}
                    </button>
                  );
                });
              })()}
            </div>
          )}
          {/* Recent searches dropdown (Feature E) */}
          {showRecent && recentSearches.length > 0 && suggestions.length === 0 && q.trim().length < 2 && (
            <div className="absolute left-0 right-0 top-full z-50 mt-1 rounded-md border border-border bg-popover shadow-md">
              <div className="px-4 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider bg-muted/50 border-b border-border flex items-center gap-1.5">
                <Clock size={12} />
                Recent Searches
              </div>
              {recentSearches.map((rs, i) => (
                <button
                  key={`recent-${rs.term}-${i}`}
                  className="w-full text-left px-4 py-2 text-sm text-popover-foreground hover:bg-accent flex items-center gap-2"
                  onMouseDown={(e)=>e.preventDefault()}
                  onClick={()=>{ setQ(rs.term); handleSubmit(rs.term); }}
                >
                  <Clock size={14} className="text-muted-foreground flex-shrink-0" />
                  <span>{rs.term}</span>
                </button>
              ))}
              <button
                className="w-full text-center px-4 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent border-t border-border transition-colors"
                onMouseDown={(e)=>e.preventDefault()}
                onClick={clearRecentSearches}
              >
                Clear recent searches
              </button>
            </div>
          )}
        </div>

        <Button
          onClick={() => handleSubmit()}
          disabled={loading}
          className="h-11 bg-tabarnam-blue text-slate-900 font-bold hover:bg-tabarnam-blue/80 transition-colors"
        >
          {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Search className="h-5 w-5" />}
          <span className="ml-2">Search</span>
        </Button>

        <Button
          onClick={handleClear}
          variant="ghost"
          className="h-11 px-3 text-sm text-muted-foreground hover:text-foreground hover:bg-accent"
          aria-label="Clear search and filters"
        >
          Clear
        </Button>
      </div>

      {/* Row 2: Sort/Filter, City/Postal Code, State/Province, Country */}
      <div
        className={filtersRightSlot
          ? "grid grid-cols-1 md:grid-cols-[auto_1fr_1fr_1fr_auto] gap-3"
          : "grid grid-cols-1 md:grid-cols-[auto_1fr_1fr_1fr] gap-3"}
      >
        {/* Sort & Filter popover */}
        <Popover open={sortFilterOpen} onOpenChange={setSortFilterOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex items-center h-11 px-3 rounded-md border border-input bg-background text-foreground text-sm hover:bg-accent transition-colors"
              data-tour-step="filter-trigger"
            >
              <ListFilter className="text-muted-foreground mr-2 shrink-0" size={18} />
              <span>{SORTS.find(s => s.value === sortBy)?.label || 'Sort Results'}</span>
              {(amazonOnly || hqInCountry || mfgInCountry) && <span className="ml-1.5 w-2 h-2 rounded-full bg-[#3F97A2] shrink-0" />}
              <ChevronDown className="ml-2 h-4 w-4 text-muted-foreground shrink-0" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" sideOffset={4} className="w-56 p-1">
            {SORTS.map(s => (
              <button
                key={s.value}
                type="button"
                className={cn(
                  "flex items-center w-full px-3 py-2 text-sm rounded-sm hover:bg-accent transition-colors text-left",
                  sortBy === s.value && "font-medium"
                )}
                onClick={() => { setSortBy(s.value); setSortFilterOpen(false); }}
              >
                {sortBy === s.value
                  ? <Check className="mr-2 h-4 w-4 text-foreground shrink-0" />
                  : <span className="mr-2 w-4 shrink-0" />}
                {s.label}
              </button>
            ))}
            <div className="my-1 border-t border-border" />
            <button
              type="button"
              className="flex items-center w-full px-3 py-2 text-sm rounded-sm hover:bg-accent transition-colors text-left"
              onClick={() => { setMfgInCountry(!mfgInCountry); setSortFilterOpen(false); }}
            >
              <span className={cn(
                "mr-2 flex items-center justify-center w-4 h-4 rounded-sm border shrink-0",
                mfgInCountry ? "bg-[#3F97A2] border-[#3F97A2]" : "border-muted-foreground/40"
              )}>
                {mfgInCountry && <Check className="h-3 w-3 text-white" />}
              </span>
              In country manufacturing
            </button>
            <button
              type="button"
              className="flex items-center w-full px-3 py-2 text-sm rounded-sm hover:bg-accent transition-colors text-left"
              onClick={() => { setHqInCountry(!hqInCountry); setSortFilterOpen(false); }}
            >
              <span className={cn(
                "mr-2 flex items-center justify-center w-4 h-4 rounded-sm border shrink-0",
                hqInCountry ? "bg-[#3F97A2] border-[#3F97A2]" : "border-muted-foreground/40"
              )}>
                {hqInCountry && <Check className="h-3 w-3 text-white" />}
              </span>
              In country headquarters
            </button>
            <button
              type="button"
              className="flex items-center w-full px-3 py-2 text-sm rounded-sm hover:bg-accent transition-colors text-left"
              onClick={() => { setAmazonOnly(!amazonOnly); setSortFilterOpen(false); }}
            >
              <span className={cn(
                "mr-2 flex items-center justify-center w-4 h-4 rounded-sm border shrink-0",
                amazonOnly ? "bg-[#3F97A2] border-[#3F97A2]" : "border-muted-foreground/40"
              )}>
                {amazonOnly && <Check className="h-3 w-3 text-white" />}
              </span>
              Amazon link
            </button>
          </PopoverContent>
        </Popover>

        <Popover open={openCitySuggest && citySuggestions.length > 0}>
          <PopoverTrigger asChild>
            <div className="relative">
              <MapPin className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground z-10" size={18} />
              <Input
                ref={cityInputRef}
                value={city}
                onChange={(e)=>{
                  if (e.target.value) cityClearedByUserRef.current = false;
                  setCity(e.target.value);
                  if (e.target.value.trim().length > 0) {
                    setOpenCitySuggest(true);
                  }
                }}
                onFocus={() => {
                  if (city.trim().length > 0) {
                    setOpenCitySuggest(true);
                  }
                }}
                onKeyDown={onKeyDown}
                placeholder="City / Postal Code"
                className="pl-10 pr-9 h-11 bg-background border-input text-foreground"
                autoComplete="off"
                data-tour-step="location-input"
              />
              {city && (
                <button
                  type="button"
                  onClick={()=>{ cityClearedByUserRef.current = true; setCity(''); cityInputRef.current?.focus(); if (q.trim().length >= 2 || country || stateCode) setTimeout(() => handleSubmitRef.current(), 0); }}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground z-10"
                  aria-label="Clear city"
                >
                  <X size={16} />
                </button>
              )}
            </div>
          </PopoverTrigger>
          <PopoverContent
            className="w-[var(--radix-popover-trigger-width)] p-0 bg-popover border-border mt-1 max-h-72 overflow-y-auto"
            align="start"
            onOpenAutoFocus={(e)=>e.preventDefault()}
          >
            {citySuggestions.length > 0 ? (
              citySuggestions.map((s, i) => (
                <button
                  key={`${s.value}-${i}`}
                  className="w-full text-left px-4 py-2 text-sm text-popover-foreground hover:bg-accent border-b border-border last:border-b-0"
                  onMouseDown={(e)=>e.preventDefault()}
                  onClick={() => handleCitySelect(s.value)}
                >
                  {s.value}
                </button>
              ))
            ) : (
              <div className="px-4 py-2 text-sm text-muted-foreground">No cities found</div>
            )}
          </PopoverContent>
        </Popover>

        <Popover open={openStateSuggest && stateSuggestions.length > 0}>
          <PopoverTrigger asChild>
            <div className="relative">
              <MapPin className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground z-10" size={18} />
              <Input
                ref={stateInputRef}
                value={stateCode}
                onChange={(e)=>{
                  setStateCode(e.target.value);
                  if (e.target.value.trim().length > 0) {
                    setOpenStateSuggest(true);
                  }
                }}
                onFocus={() => {
                  if (stateCode.trim().length > 0) {
                    setOpenStateSuggest(true);
                  }
                }}
                onKeyDown={onKeyDown}
                placeholder="State / Province"
                className="pl-10 pr-9 h-11 bg-background border-input text-foreground"
                autoComplete="off"
              />
              {stateCode && (
                <button
                  type="button"
                  onClick={()=>{ setStateCode(''); stateInputRef.current?.focus(); if (q.trim().length >= 2 || country || city) setTimeout(() => handleSubmitRef.current(), 0); }}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground z-10"
                  aria-label="Clear state"
                >
                  <X size={16} />
                </button>
              )}
            </div>
          </PopoverTrigger>
          <PopoverContent
            className="w-[var(--radix-popover-trigger-width)] p-0 bg-popover border-border mt-1 max-h-72 overflow-y-auto"
            align="start"
            onOpenAutoFocus={(e)=>e.preventDefault()}
          >
            {stateSuggestions.length > 0 ? (
              stateSuggestions.map((s, i) => (
                <button
                  key={`${s.value}-${i}`}
                  className="w-full text-left px-4 py-2 text-sm text-popover-foreground hover:bg-accent border-b border-border last:border-b-0"
                  onMouseDown={(e)=>e.preventDefault()}
                  onClick={() => handleStateSelect(s.value)}
                >
                  {s.value}
                </button>
              ))
            ) : (
              <div className="px-4 py-2 text-sm text-muted-foreground">No states found</div>
            )}
          </PopoverContent>
        </Popover>

        {/* Country — free-text input, resolved on submit/blur */}
        <div className="relative">
          <MapPin className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground z-10" size={18} />
          <Input
            value={countrySearch || (country ? selectedCountryName : '')}
            onChange={(e) => {
              setCountrySearch(e.target.value);
              // Clear the resolved code while the user is editing
              if (country) setCountry('');
            }}
            onBlur={async () => {
              const text = countrySearch.trim();
              if (!text) return;
              const match = await resolveCountryText(text);
              if (match) {
                setCountry(match.code);
                setCountrySearch('');
                if (q.trim().length >= 2 || stateCode || city || match.code) setTimeout(() => handleSubmitRef.current(), 0);
              }
            }}
            onKeyDown={onKeyDown}
            placeholder="Country"
            className="pl-10 pr-9 h-11 bg-background border-input text-foreground"
            autoComplete="off"
          />
          {(country || countrySearch) && (
            <button
              type="button"
              onClick={() => {
                setCountrySearch('');
                setCountry('');
                if (q.trim().length >= 2 || stateCode || city) setTimeout(() => handleSubmitRef.current(), 0);
              }}
              className="absolute right-3.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground z-10"
              aria-label="Clear country"
            >
              <X size={16} />
            </button>
          )}
        </div>

        {/* Sort/Filter dropdown moved to first position in grid */}

        {filtersRightSlot && (
          <div className="flex items-center md:justify-end">
            {filtersRightSlot}
          </div>
        )}
      </div>
    </div>
  );
}
