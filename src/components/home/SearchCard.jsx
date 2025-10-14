// src/components/home/SearchCard.jsx
import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Search, MapPin, ListFilter, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent } from '@/components/ui/popover';
import { getCountries, getSubdivisions } from '@/lib/location';
import { getSuggestions } from '@/lib/searchCompanies';

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

  const inputRef = useRef(null);

  useEffect(() => { loadCountries().then(setCountries); }, []);
  useEffect(() => {
    setStateCode(''); setSubdivs([]);
    if (country) loadSubdivisions(country).then(setSubdivs);
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
      const list = await getSuggestions(s, 8);
      setSuggestions(list);
      setOpenSuggest(list.length > 0);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const onKeyDown = (e) => { if (e.key === 'Enter') { e.preventDefault(); handleSubmit(); } };

  const handleSubmit = () => {
    const params = { q: q.trim(), sort: sortBy, country, state: stateCode, city };
    if (onSubmitParams) onSubmitParams(params);
    else nav(`/results?${toQs(params)}`);
  };

  return (
    <div className="w-full max-w-5xl bg-white border border-gray-200 rounded-2xl p-5 md:p-6 shadow">
      {/* Row 1 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
        <div className="relative">
          <MapPin className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
          <Input
            value={city}
            onChange={(e)=>setCity(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="City / Postal Code"
            className="pl-10 h-11 bg-gray-50 border-gray-300 text-gray-900"
          />
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
          <Select value={country} onValueChange={setCountry}>
            <SelectTrigger className="pl-10 h-11 bg-gray-50 border-gray-300 text-gray-900">
              <SelectValue placeholder="Country" />
            </SelectTrigger>
            <SelectContent className="max-h-72 overflow-auto">
              {countries.map(c => <SelectItem key={c.code} value={c.code}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Row 2 */}
      <div className="grid grid-cols-1 md:grid-cols-[260px_1fr_auto] gap-3">
        <Select value={sortBy} onValueChange={setSortBy}>
          <SelectTrigger className="h-11 bg-gray-50 border-gray-300 text-gray-900">
            <ListFilter className="text-gray-400 mr-2" size={18} />
            <SelectValue placeholder="Sort Options" />
          </SelectTrigger>
          <SelectContent>
            {SORTS.map(s => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
          </SelectContent>
        </Select>

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
              {suggestions.map((s, i) => (
                <button
                  key={`${s.value}-${i}`}
                  className="w-full text-left px-4 py-2 text-sm text-gray-800 hover:bg-gray-100 flex items-center justify-between"
                  onMouseDown={(e)=>e.preventDefault()}
                  onClick={()=>{ setQ(s.value); }}
                >
                  <span>{s.value}</span>
                  <span className="text-xs text-gray-500 bg-gray-200 px-1.5 py-0.5 rounded-sm">{s.type}</span>
                </button>
              ))}
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
    </div>
  );
}
