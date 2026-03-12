// src/components/home/SearchCard.jsx
import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Search, MapPin, ListFilter, Loader2, X, Clock, ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react';
import { useSearchCache } from '@/hooks/useSearchCache';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { getCountries } from '@/lib/location';
import { getSuggestions, getRefinements, getCitySuggestions, getStateSuggestions } from '@/lib/searchCompanies';
import { extractSearchTermFromUrl } from '@/lib/queryNormalizer';
import { placesAutocomplete, placeDetails } from '@/lib/google';
import { cn } from '@/lib/utils';

const SORTS = [
  { value: 'manu',  label: 'Nearest Manufacturing' },
  { value: 'hq',    label: 'Nearest Headquarters' },
  { value: 'stars', label: 'Highest Rated' },
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

const SUGGESTION_GROUP_ORDER = ["Company", "Keyword", "Industry"];
const GROUP_HEADERS = {
  Company: "\uD83C\uDFE2 Companies",
  Keyword: "\uD83C\uDFF7\uFE0F Keywords",
  Industry: "\uD83C\uDFED Industries",
};
const BADGE_COLORS = {
  Company: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  Keyword: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  Industry: "bg-primary/15 text-primary dark:bg-primary/20 dark:text-primary",
};

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
}) {
  const nav = useNavigate();
  const { search } = useLocation();
  const { getCachedSearches, addSearchToCache } = useSearchCache();

  const [q, setQ] = useState('');
  const [country, setCountry] = useState('');
  const [stateCode, setStateCode] = useState('');
  const [city, setCity] = useState('');
  const [sortBy, setSortBy] = useState('stars'); // default

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
  const [openCountryDropdown, setOpenCountryDropdown] = useState(false);

  const inputRef = useRef(null);
  const cityInputRef = useRef(null);
  const stateInputRef = useRef(null);
  const handleSubmitRef = useRef(null);
  const debounceSearchRef = useRef(null);
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

        // Merge: limit to 12 total, prioritize companies first, then keywords/industries
        const merged = [...companySuggestions];
        for (const ref of refinementSuggestions) {
          if (merged.length >= 12) break;
          // Avoid duplicates
          const isDuplicate = merged.some((m) => m.value.toLowerCase() === ref.value.toLowerCase());
          if (!isDuplicate) {
            merged.push(ref);
          }
        }

        setSuggestions(merged.slice(0, 12));
        setOpenSuggest(merged.length > 0);
      } catch (e) {
        console.warn("Failed to load suggestions:", e?.message);
        setSuggestions([]);
        setOpenSuggest(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q, country, stateCode, city]);

  // Search-as-you-type: works on both home page and results page
  useEffect(() => {
    if (debounceSearchRef.current) {
      clearTimeout(debounceSearchRef.current);
      debounceSearchRef.current = null;
    }

    const trimmed = q.trim();
    if (trimmed.length < 2) return;

    // Skip if this query was already searched (initial hydration or after a submit)
    if (trimmed === lastSearchedQRef.current) return;

    debounceSearchRef.current = setTimeout(() => {
      lastSearchedQRef.current = trimmed;
      handleSubmitRef.current();
    }, 400);

    return () => {
      if (debounceSearchRef.current) {
        clearTimeout(debounceSearchRef.current);
        debounceSearchRef.current = null;
      }
    };
  }, [q]);

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
  };

  const handleStateSelect = (stateName) => {
    setStateCode(stateName);
    setStateSuggestions([]);
    setOpenStateSuggest(false);
  };

  const filteredCountries = countries
    .filter(c =>
      countrySearch.trim() === '' || c.name.toLowerCase().includes(countrySearch.toLowerCase()) || c.code.toLowerCase().includes(countrySearch.toLowerCase())
    )
    .sort((a, b) => {
      // Put US at the top
      if (a.code === 'US') return -1;
      if (b.code === 'US') return 1;
      return a.name.localeCompare(b.name);
    });

  const selectedCountryName = country ? countries.find(c => c.code === country)?.name || '' : '';

  const onKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpenCountryDropdown(false);
      setCountrySearch('');
    }
  };

  const handleSubmit = (overrideQ) => {
    // Cancel any pending auto-search debounce
    if (debounceSearchRef.current) {
      clearTimeout(debounceSearchRef.current);
      debounceSearchRef.current = null;
    }

    const rawQ = (overrideQ !== undefined ? overrideQ : q).trim();
    // If the user pasted a URL, extract the brand name so search works
    const extracted = extractSearchTermFromUrl(rawQ);
    if (extracted !== rawQ) setQ(extracted); // update input so user sees what was searched
    else if (overrideQ !== undefined) setQ(overrideQ); // sync input for suggestion clicks

    lastSearchedQRef.current = extracted;

    // Save to recent searches (Feature E)
    if (extracted) addSearchToCache({ term: extracted });

    // Close recent/suggestions dropdowns
    setShowRecent(false);
    setRecentSearches([]);

    const params = { q: extracted, sort: sortBy, country, state: stateCode, city };
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
          {/* Grouped suggestions (Feature D) */}
          <Popover open={suggestions.length > 0}>
            <PopoverContent
              className="w-[var(--radix-popover-trigger-width)] p-0 bg-popover border-border mt-1 max-h-80 overflow-y-auto"
              align="start"
              onOpenAutoFocus={(e)=>e.preventDefault()}
            >
              {(() => {
                // Group suggestions by type
                const grouped = {};
                for (const s of suggestions) {
                  (grouped[s.type] ??= []).push(s);
                }
                return SUGGESTION_GROUP_ORDER.map((type) => {
                  const items = grouped[type];
                  if (!items?.length) return null;
                  return (
                    <div key={type}>
                      <div className="px-4 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider bg-muted/50 border-b border-border">
                        {GROUP_HEADERS[type] || type}
                      </div>
                      {items.map((s, i) => {
                        const badgeClass = BADGE_COLORS[s.type] || "bg-muted text-foreground";
                        return (
                          <button
                            key={`${s.value}-${i}`}
                            className="w-full text-left px-4 py-2 text-sm text-popover-foreground hover:bg-accent flex items-center justify-between"
                            onMouseDown={(e)=>e.preventDefault()}
                            onClick={()=>{ setQ(s.value); if (onSubmitParams) handleSubmit(s.value); }}
                          >
                            <span>{s.value}</span>
                            <span className={`text-xs px-1.5 py-0.5 rounded-sm font-medium ${badgeClass}`}>{s.type}</span>
                          </button>
                        );
                      })}
                    </div>
                  );
                });
              })()}
            </PopoverContent>
          </Popover>
          {/* Recent searches dropdown (Feature E) */}
          <Popover open={showRecent && recentSearches.length > 0 && suggestions.length === 0 && q.trim().length < 2}>
            <PopoverContent
              className="w-[var(--radix-popover-trigger-width)] p-0 bg-popover border-border mt-1"
              align="start"
              onOpenAutoFocus={(e)=>e.preventDefault()}
            >
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
            </PopoverContent>
          </Popover>
        </div>

        <Button
          onClick={handleSubmit}
          disabled={loading}
          className="h-11 bg-tabarnam-blue text-slate-900 font-bold hover:bg-tabarnam-blue/80 transition-colors"
        >
          {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Search className="h-5 w-5" />}
          <span className="ml-2">Search</span>
        </Button>
      </div>

      {/* Row 2: City/Postal Code, State/Province, Country, Sort Results */}
      <div
        className={filtersRightSlot
          ? "grid grid-cols-1 md:grid-cols-[1fr_1fr_1fr_1fr_auto] gap-3"
          : "grid grid-cols-1 md:grid-cols-4 gap-3"}
      >
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
                  onClick={()=>{ setCity(''); cityInputRef.current?.focus(); }}
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
                  onClick={()=>{ setStateCode(''); stateInputRef.current?.focus(); }}
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

        <Popover open={openCountryDropdown} onOpenChange={setOpenCountryDropdown}>
          <PopoverTrigger asChild>
            <div className="relative">
              <MapPin className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground z-10" size={18} />
              <Input
                value={countrySearch === '' && country ? selectedCountryName : countrySearch}
                onChange={(e) => {
                  setCountrySearch(e.target.value);
                  if (e.target.value.trim().length > 0) {
                    setOpenCountryDropdown(true);
                  }
                }}
                onFocus={() => setOpenCountryDropdown(true)}
                onKeyDown={onKeyDown}
                placeholder="Country"
                className="pl-10 pr-9 h-11 bg-background border-input text-foreground"
                autoComplete="off"
              />
              {(country || countrySearch) && (
                <button
                  type="button"
                  onClick={() => {
                    if (countrySearch) {
                      setCountrySearch('');
                    } else {
                      setCountry('');
                    }
                  }}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground z-10"
                  aria-label="Clear country"
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
            {filteredCountries.length > 0 ? (
              filteredCountries.slice(0, 50).map((c) => (
                <button
                  key={c.code}
                  className="w-full text-left px-4 py-2 text-sm text-popover-foreground hover:bg-accent border-b border-border last:border-b-0"
                  onMouseDown={(e)=>e.preventDefault()}
                  onClick={() => {
                    setCountry(c.code);
                    setCountrySearch('');
                    setOpenCountryDropdown(false);
                  }}
                >
                  {c.code === 'US' && <span className="font-semibold">{c.name}</span>}
                  {c.code !== 'US' && <span>{c.name}</span>}
                </button>
              ))
            ) : (
              <div className="px-4 py-2 text-sm text-muted-foreground">No countries found</div>
            )}
          </PopoverContent>
        </Popover>

        <Select value={sortBy} onValueChange={setSortBy}>
          <SelectTrigger className="h-11 bg-background border-input text-foreground">
            <ListFilter className="text-muted-foreground mr-2" size={18} />
            <span className="text-foreground">Sort Results</span>
          </SelectTrigger>
          <SelectContent>
            {SORTS.map(s => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
          </SelectContent>
        </Select>

        {filtersRightSlot && (
          <div className="flex items-center md:justify-end">
            {filtersRightSlot}
          </div>
        )}
      </div>
    </div>
  );
}
