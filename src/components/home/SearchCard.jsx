// src/components/home/SearchCard.jsx
import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Search, MapPin, ListFilter, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { getCountries, getSubdivisions } from '@/lib/location';
import { getSuggestions, getRefinements } from '@/lib/searchCompanies';
import { placesAutocomplete, placeDetails } from '@/lib/google';

const SORTS = [
  { value: 'manu',  label: 'Nearest Manufacturing' },
  { value: 'hq',    label: 'Nearest Headquarters' },
  { value: 'stars', label: 'Highest Rated' },
];

function toQs(o){ return new URLSearchParams(Object.entries(o).filter(([,v]) => v !== undefined && v !== '' && v !== null)).toString(); }

export default function SearchCard({ onSubmitParams }) {
  const nav = useNavigate();
  const { search } = useLocation();

  const [q, setQ] = useState('');
  const [country, setCountry] = useState('');
  const [stateCode, setStateCode] = useState('');
  const [city, setCity] = useState('');
  const [sortBy, setSortBy] = useState('manu'); // default

  const [countries, setCountries] = useState([]);
  const [subdivs, setSubdivs] = useState([]);

  const [suggestions, setSuggestions] = useState([]);
  const [openSuggest, setOpenSuggest] = useState(false);
  const [loading, setLoading] = useState(false);

  const [citySuggestions, setCitySuggestions] = useState([]);
  const [openCitySuggest, setOpenCitySuggest] = useState(false);
  const [countrySearch, setCountrySearch] = useState('');
  const [openCountryDropdown, setOpenCountryDropdown] = useState(false);
  const [stateSearch, setStateSearch] = useState('');
  const [openStateSuggest, setOpenStateSuggest] = useState(false);

  const inputRef = useRef(null);
  const cityInputRef = useRef(null);
  const stateInputRef = useRef(null);

  useEffect(() => { getCountries().then(setCountries); }, []);

  useEffect(() => {
    setStateCode('');
    setStateSearch('');
    setSubdivs([]);
    if (country) getSubdivisions(country).then(setSubdivs);
  }, [country]);

  // Hydrate from URL
  useEffect(() => {
    const p = new URLSearchParams(search);
    if (p.has('q')) setQ(p.get('q') || '');
    if (p.has('country')) setCountry(p.get('country') || '');
    if (p.has('state')) setStateCode(p.get('state') || '');
    if (p.has('city')) setCity(p.get('city') || '');
    if (p.has('sort')) setSortBy(p.get('sort') || 'manu');
  }, [search]);

  useEffect(() => {
    const t = setTimeout(async () => {
      const s = q.trim();
      if (s.length < 2) { setSuggestions([]); setOpenSuggest(false); return; }
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

  useEffect(() => {
    const t = setTimeout(async () => {
      const c = city.trim();
      if (c.length < 2) { setCitySuggestions([]); setOpenCitySuggest(false); return; }
      try {
        const suggestions = await placesAutocomplete({ input: c, country });
        setCitySuggestions(suggestions);
        setOpenCitySuggest(suggestions.length > 0);
      } catch (e) {
        console.warn("Failed to load city suggestions:", e?.message);
        setCitySuggestions([]);
        setOpenCitySuggest(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [city, country]);

  const handleCitySelect = async (placeId) => {
    try {
      const details = await placeDetails({ placeId });
      if (details) {
        // Use the already-extracted countryCode and stateCode from placeDetails
        if (details.countryCode) setCountry(details.countryCode);
        if (details.stateCode) setStateCode(details.stateCode);
      }
      setCitySuggestions([]);
      setOpenCitySuggest(false);
    } catch (e) {
      console.warn("Failed to get place details:", e?.message);
    }
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

  const filteredStates = subdivs.filter(s =>
    stateSearch.trim() === '' || s.name.toLowerCase().includes(stateSearch.toLowerCase()) || s.code.toLowerCase().includes(stateSearch.toLowerCase())
  );

  const selectedCountryName = country ? countries.find(c => c.code === country)?.name || '' : '';

  const onKeyDown = (e) => { if (e.key === 'Enter') { e.preventDefault(); handleSubmit(); } };

  const handleSubmit = () => {
    const params = { q: q.trim(), sort: sortBy, country, state: stateCode, city };
    if (onSubmitParams) onSubmitParams(params);
    else nav(`/results?${toQs(params)}`);
  };

  return (
    <div className="w-full max-w-5xl bg-white border border-gray-200 rounded-2xl p-5 md:p-6 shadow">
      {/* Row 1: Search field and button spanning full width */}
      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 mb-3">
        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 z-10" size={18} />
          {q && (
            <button
              type="button"
              onClick={()=>{ setQ(''); inputRef.current?.focus(); }}
              className="absolute right-3.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 z-10"
              aria-label="Clear query"
            >
              <X size={16} />
            </button>
          )}
          <Input
            ref={inputRef}
            value={q}
            onChange={(e)=>setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search by product, keyword, company…"
            className="pl-10 pr-9 h-11 bg-gray-50 border-gray-300 text-gray-900"
            autoComplete="off"
          />
          {/* lightweight suggestions */}
          <Popover open={suggestions.length > 0}>
            <PopoverContent
              className="w-[var(--radix-popover-trigger-width)] p-0 bg-white border-gray-300 mt-1"
              align="start"
              onOpenAutoFocus={(e)=>e.preventDefault()}
            >
              {suggestions.map((s, i) => {
                const badgeColors = {
                  Company: "bg-blue-100 text-blue-700",
                  Keyword: "bg-purple-100 text-purple-700",
                  Industry: "bg-green-100 text-green-700",
                };
                const badgeClass = badgeColors[s.type] || "bg-gray-200 text-gray-700";
                return (
                  <button
                    key={`${s.value}-${i}`}
                    className="w-full text-left px-4 py-2 text-sm text-gray-800 hover:bg-gray-100 flex items-center justify-between"
                    onMouseDown={(e)=>e.preventDefault()}
                    onClick={()=>{ setQ(s.value); }}
                  >
                    <span>{s.value}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded-sm font-medium ${badgeClass}`}>{s.type}</span>
                  </button>
                );
              })}
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
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <Popover open={openCitySuggest && citySuggestions.length > 0}>
          <PopoverTrigger asChild>
            <div className="relative">
              <MapPin className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 z-10" size={18} />
              <Input
                ref={cityInputRef}
                value={city}
                onChange={(e)=>setCity(e.target.value)}
                onFocus={() => city.trim().length >= 2 && setOpenCitySuggest(true)}
                onKeyDown={onKeyDown}
                placeholder="City / Postal Code"
                className="pl-10 h-11 bg-gray-50 border-gray-300 text-gray-900"
                autoComplete="off"
              />
            </div>
          </PopoverTrigger>
          <PopoverContent
            className="w-[var(--radix-popover-trigger-width)] p-0 bg-white border-gray-300 mt-1"
            align="start"
            onOpenAutoFocus={(e)=>e.preventDefault()}
          >
            {citySuggestions.map((s, i) => (
              <button
                key={`${s.placeId}-${i}`}
                className="w-full text-left px-4 py-2 text-sm text-gray-800 hover:bg-gray-100 flex flex-col"
                onMouseDown={(e)=>e.preventDefault()}
                onClick={()=>{ setCity(s.mainText); handleCitySelect(s.placeId); }}
              >
                <span className="font-medium">{s.mainText}</span>
                {s.secondaryText && <span className="text-xs text-gray-600">{s.secondaryText}</span>}
              </button>
            ))}
          </PopoverContent>
        </Popover>

        <Popover open={openStateSuggest && filteredStates.length > 0}>
          <PopoverTrigger asChild>
            <div className="relative">
              <MapPin className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 z-10" size={18} />
              <Input
                ref={stateInputRef}
                value={stateSearch || (stateCode ? subdivs.find(s => s.code === stateCode)?.name || '' : '')}
                onChange={(e)=>{ setStateSearch(e.target.value); setOpenStateSuggest(true); }}
                onFocus={() => setOpenStateSuggest(true)}
                onKeyDown={onKeyDown}
                placeholder="State / Province"
                className="pl-10 h-11 bg-gray-50 border-gray-300 text-gray-900"
                autoComplete="off"
              />
            </div>
          </PopoverTrigger>
          <PopoverContent
            className="w-[var(--radix-popover-trigger-width)] p-0 bg-white border-gray-300 mt-1"
            align="start"
            onOpenAutoFocus={(e)=>e.preventDefault()}
          >
            {filteredStates.slice(0, 12).map((s, i) => (
              <button
                key={`${s.code}-${i}`}
                className="w-full text-left px-4 py-2 text-sm text-gray-800 hover:bg-gray-100 flex flex-col"
                onMouseDown={(e)=>e.preventDefault()}
                onClick={()=>{ setStateCode(s.code); setStateSearch(''); setOpenStateSuggest(false); }}
              >
                <span className="font-medium">{s.name}</span>
                <span className="text-xs text-gray-600">{s.code}</span>
              </button>
            ))}
          </PopoverContent>
        </Popover>

        <Popover open={openCountryDropdown}>
          <PopoverTrigger asChild>
            <div className="relative">
              <MapPin className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 z-10" size={18} />
              <Input
                value={countrySearch === '' && country ? selectedCountryName : countrySearch}
                onChange={(e) => setCountrySearch(e.target.value)}
                onFocus={() => setOpenCountryDropdown(true)}
                onBlur={() => setTimeout(() => setOpenCountryDropdown(false), 200)}
                onKeyDown={onKeyDown}
                placeholder="Country"
                className="pl-10 h-11 bg-gray-50 border-gray-300 text-gray-900"
                autoComplete="off"
              />
            </div>
          </PopoverTrigger>
          <PopoverContent
            className="w-[var(--radix-popover-trigger-width)] p-0 bg-white border-gray-300 mt-1 max-h-72 overflow-y-auto"
            align="start"
            onOpenAutoFocus={(e)=>e.preventDefault()}
          >
            {filteredCountries.length > 0 ? (
              filteredCountries.slice(0, 50).map((c) => (
                <button
                  key={c.code}
                  className="w-full text-left px-4 py-2 text-sm text-gray-800 hover:bg-gray-100 border-b border-gray-100 last:border-b-0"
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
              <div className="px-4 py-2 text-sm text-gray-500">No countries found</div>
            )}
          </PopoverContent>
        </Popover>

        <Select value={sortBy} onValueChange={setSortBy}>
          <SelectTrigger className="h-11 bg-gray-50 border-gray-300 text-gray-900">
            <ListFilter className="text-gray-400 mr-2" size={18} />
            <span className="text-gray-900">Sort Results</span>
          </SelectTrigger>
          <SelectContent>
            {SORTS.map(s => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
