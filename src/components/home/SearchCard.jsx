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
import { placesAutocomplete, placeDetails } from '@/lib/google';
import { cn } from '@/lib/utils';

const SORTS = [
  { value: 'manu',  label: 'Nearest manufacturing' },
  { value: 'hq',    label: 'Nearest headquarters' },
  { value: 'stars', label: 'Highest rated' },
];

function toQs(o){ return new URLSearchParams(Object.entries(o).filter(([,v]) => v !== undefined && v !== '' && v !== null)).toString(); }

const PLACEHOLDERS = [
  "Search by product, keyword, company\u2026",
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

  // Hydrate from URL
  useEffect(() => {
    const p = new URLSearchParams(search);
    if (p.has('q')) {
      const urlQ = p.get('q') || '';
      setQ(urlQ);
      lastSearchedQRef.current = urlQ.trim();
    }
    if (p.has('country')) setCountry(p.get('country') || '');
    if (p.has('state')) setStateCode(p.get('state') || '');
    if (p.has('city')) setCity(p.get('city') || '');
    if (p.has('sort')) setSortBy(p.get('sort') || 'stars');
    setAmazonOnly(p.get('amazon') === '1');
    setHqInCountry(p.has('hqCountry'));
    setMfgInCountry(p.has('mfgCountry'));
  }, [search]);

  useEffect(() => {
    const t = setTimeout(async () => {
      const s = q.trim();
      if (s.length < 2) {
        setSuggestions([]);
        setOpenSuggest(false);
        return;
      }
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

  // Search-as-you-type: fires lightweight auto-search (no URL update) while typing,
  // then updates the URL after 3 seconds of inactivity for shareability.
  useEffect(() => {
    if (debounceSearchRef.current) {
      clearTimeout(debounceSearchRef.current);
      debounceSearchRef.current = null;
    }
    if (debounceUrlRef.current) {
      clearTimeout(debounceUrlRef.current);
      debounceUrlRef.current = null;
    }

    const trimmed = q.trim();
    const hasLocationFilter = !!(country || stateCode || city);
    if (trimmed.length < 2 && !hasLocationFilter) return;

    // Skip if this query was already searched (initial hydration or after a submit)
    if (trimmed === lastSearchedQRef.current) return;

    debounceSearchRef.current = setTimeout(() => {
      lastSearchedQRef.current = trimmed;
      // Use lightweight auto-search if available (skips URL update), else fall back to full submit
      if (onAutoSearch) {
        onAutoSearch({ q: trimmed, sort: sortBy, country, state: stateCode, city, amazon: amazonOnly, hqCountry: hqInCountry ? userCountryCode : '', mfgCountry: mfgInCountry ? userCountryCode : '' });
      } else {
        handleSubmitRef.current();
      }
    }, 400);

    // Delayed URL update: sync URL 3s after last keystroke for shareability
    if (onAutoSearch) {
      debounceUrlRef.current = setTimeout(() => {
        const params = { q: trimmed, sort: sortBy, country, state: stateCode, city, amazon: amazonOnly, hqCountry: hqInCountry ? userCountryCode : '', mfgCountry: mfgInCountry ? userCountryCode : '' };
        if (onSubmitParams) {
          // Full submit updates URL + history
          lastSearchedQRef.current = trimmed;
          handleSubmitRef.current();
        }
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

  // Re-search when any filter checkbox toggles (immediate submit, no debounce)
  const filterInitRef = useRef(true);
  useEffect(() => {
    if (filterInitRef.current) { filterInitRef.current = false; return; }
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
      handleSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setCountrySearch('');
    }
  };

  const handleSubmit = async (overrideQ) => {
    // Cancel any pending auto-search and URL update debounces
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

    const params = { q: extracted, sort: sortBy, country: resolvedCountry, state: stateCode, city, amazon: amazonOnly ? '1' : '', hqCountry: hqInCountry ? userCountryCode : '', mfgCountry: mfgInCountry ? userCountryCode : '' };
    if (onSubmitParams) onSubmitParams(params);
    else nav(`/results?${toQs(params)}`);
  };
  handleSubmitRef.current = handleSubmit;

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
      <div className={cn("grid grid-cols-1 gap-3 mb-3", searchHistory.length > 0 ? "md:grid-cols-[auto_1fr_auto]" : "md:grid-cols-[1fr_auto]")}>
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
            onFocus={handleInputFocus}
            onBlur={() => { setTimeout(() => setShowRecent(false), 200); }}
            placeholder={q ? "" : PLACEHOLDERS[placeholderIdx]}
            className="pl-10 pr-9 h-11 bg-background border-input text-foreground"
            autoComplete="off"
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
                      onClick={()=>{ setQ(val); if (onSubmitParams) handleSubmit(val); }}
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
              />
              {city && (
                <button
                  type="button"
                  onClick={()=>{ setCity(''); cityInputRef.current?.focus(); if (q.trim().length >= 2 || country || stateCode) setTimeout(() => handleSubmitRef.current(), 0); }}
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
