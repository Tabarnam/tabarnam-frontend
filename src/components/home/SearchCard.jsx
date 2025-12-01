// src/components/home/SearchCard.jsx
import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Search, MapPin, ListFilter, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent } from '@/components/ui/popover';
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
  const [openCountrySuggest, setOpenCountrySuggest] = useState(false);

  const inputRef = useRef(null);
  const cityInputRef = useRef(null);
  const countryInputRef = useRef(null);

  useEffect(() => { getCountries().then(setCountries); }, []);
  useEffect(() => {
    setStateCode(''); setSubdivs([]);
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
        // Try to extract country code from address components
        const countryCode = details.components?.find(c => c.types?.includes('country'))?.short_name || '';
        const stateCode = details.components?.find(c => c.types?.includes('administrative_area_level_1'))?.short_name || '';

        if (countryCode) setCountry(countryCode);
        if (stateCode) setStateCode(stateCode);
      }
      setCitySuggestions([]);
      setOpenCitySuggest(false);
    } catch (e) {
      console.warn("Failed to get place details:", e?.message);
    }
  };

  const filteredCountries = countries.filter(c =>
    countrySearch.trim() === '' || c.name.toLowerCase().includes(countrySearch.toLowerCase()) || c.code.toLowerCase().includes(countrySearch.toLowerCase())
  );

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
        <div className="relative">
          <MapPin className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
          <Input
            ref={cityInputRef}
            value={city}
            onChange={(e)=>setCity(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="City / Postal Code"
            className="pl-10 h-11 bg-gray-50 border-gray-300 text-gray-900"
          />
          {citySuggestions.length > 0 && (
            <Popover open={openCitySuggest}>
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
          )}
        </div>

        <div className="relative">
          <MapPin className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
          <Select value={stateCode} onValueChange={setStateCode}>
            <SelectTrigger className="pl-10 h-11 bg-gray-50 border-gray-300 text-gray-900">
              <SelectValue placeholder="State / Province" />
            </SelectTrigger>
            <SelectContent className="max-h-72 overflow-auto">
              {subdivs.map(s => <SelectItem key={s.code} value={s.code}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div className="relative">
          <MapPin className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
          <Input
            ref={countryInputRef}
            value={countrySearch || (country ? countries.find(c => c.code === country)?.name || '' : '')}
            onChange={(e)=>{ setCountrySearch(e.target.value); setOpenCountrySuggest(true); }}
            onFocus={()=>setOpenCountrySuggest(true)}
            onKeyDown={onKeyDown}
            placeholder="Country"
            className="pl-10 h-11 bg-gray-50 border-gray-300 text-gray-900"
          />
          {openCountrySuggest && filteredCountries.length > 0 && (
            <Popover open={openCountrySuggest}>
              <PopoverContent
                className="w-[var(--radix-popover-trigger-width)] p-0 bg-white border-gray-300 mt-1"
                align="start"
                onOpenAutoFocus={(e)=>e.preventDefault()}
              >
                {filteredCountries.slice(0, 15).map((c, i) => (
                  <button
                    key={`${c.code}-${i}`}
                    className="w-full text-left px-4 py-2 text-sm text-gray-800 hover:bg-gray-100"
                    onMouseDown={(e)=>e.preventDefault()}
                    onClick={()=>{ setCountry(c.code); setCountrySearch(''); setOpenCountrySuggest(false); }}
                  >
                    {c.name}
                  </button>
                ))}
              </PopoverContent>
            </Popover>
          )}
        </div>

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
