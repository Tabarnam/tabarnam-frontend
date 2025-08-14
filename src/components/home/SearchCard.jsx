import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { MapPin, Search, ListFilter, Loader2, Building, Globe, Star, Factory } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import useUserLocation from '@/hooks/useUserLocation';
import { supabase } from '@/lib/customSupabaseClient';
import { useToast } from '@/components/ui/use-toast';
import { useSearchCache } from '@/hooks/useSearchCache';

// A simple debounce hook
const useDebounce = (value, delay) => {
    const [debouncedValue, setDebouncedValue] = useState(value);
    useEffect(() => {
        const handler = setTimeout(() => {
            setDebouncedValue(value);
        }, delay);
        return () => {
            clearTimeout(handler);
        };
    }, [value, delay]);
    return debouncedValue;
};


const SearchCard = ({ onSearch, isLoading }) => {
    const [country, setCountry] = useState(undefined);
    const [state, setState] = useState(undefined);
    const [city, setCity] = useState('');
    const [sortBy, setSortBy] = useState('manufacturing_location_distance');
    const [searchTerm, setSearchTerm] = useState('');
    const [suggestions, setSuggestions] = useState([]);
    const [isSuggestionsOpen, setIsSuggestionsOpen] = useState(false);
    const [hasSearched, setHasSearched] = useState(false);

    const { location, error: locationError } = useUserLocation();
    const { toast } = useToast();
    const { addSearchToCache } = useSearchCache();
    const searchInputRef = useRef(null);
    const popoverAnchorRef = useRef(null);

    const debouncedSearchTerm = useDebounce(searchTerm, 300);

    useEffect(() => {
        if (location && !city) {
            // This would be a good place for reverse geocoding
            // For now, we don't pre-fill anything based on user's location
        }
         if (locationError && !hasSearched) {
            // Only show toast if user hasn't tried to search yet.
            // Avoid spamming on every render.
         }
    }, [location, locationError, city, hasSearched, toast]);
    
    useEffect(() => {
        if (debouncedSearchTerm.length > 2) {
            fetchSuggestions(debouncedSearchTerm);
        } else {
            setSuggestions([]);
        }
    }, [debouncedSearchTerm]);

    const fetchSuggestions = async (query) => {
        const { data, error } = await supabase.functions.invoke('autocomplete-search', {
            body: { query },
        });

        if (error) {
            console.error('Autocomplete error:', error);
            setSuggestions([]);
            return;
        }
        setSuggestions(data);
        if (data.length > 0) {
            setIsSuggestionsOpen(true);
        }
    };
    
    const handleSubmit = (e) => {
        e.preventDefault();
        setHasSearched(true);
        
        let searchLocation = {};
        let finalCity = city;

        // Prioritize browser-detected location
        if (location) {
            searchLocation = { lat: location.latitude, lon: location.longitude, country: location.country };
        } 
        
        // Fallback to San Dimas if no location is available at all
        if (!city && !state && !country && !location) {
            finalCity = 'San Dimas';
            setState('CA');
            setCountry('US');
            searchLocation = { lat: 34.0983, lon: -117.8076, country: 'US' };
             toast({
                title: "No Location Provided",
                description: "Using default location: San Dimas, CA.",
            });
        }
        
        const searchParams = {
            term: searchTerm,
            sortBy,
            country: country,
            state: state,
            city: city,
            ...searchLocation,
        };

        addSearchToCache(searchParams);
        onSearch(searchParams);
        setIsSuggestionsOpen(false);
    };
    
    const handleSuggestionClick = (suggestion) => {
        setSearchTerm(suggestion.value);
        setSuggestions([]);
        setIsSuggestionsOpen(false);
    };


    return (
        <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
            className="w-full max-w-4xl bg-white border border-gray-200 rounded-2xl p-6 md:p-8 shadow-lg transform scale-100"
        >
            <form onSubmit={handleSubmit} className="search-bar">
                {/* This div structure is for desktop grid layout. On mobile, it's ignored due to `display: contents`. */}
                <div className="search-bar-row grid grid-cols-1 md:grid-cols-3 gap-4">
                    {/* Country */}
                    <Select value={country} onValueChange={setCountry} aria-label="Select Country">
                        <SelectTrigger className="bg-gray-50 border-gray-300 text-gray-900 text-base py-6" aria-label="Country Dropdown">
                             <MapPin className="text-gray-400 mr-2" size={18} />
                            <SelectValue placeholder="Country" />
                        </SelectTrigger>
                        <SelectContent className="bg-white border-gray-300 text-gray-900">
                            <SelectItem value="US">United States</SelectItem>
                            <SelectItem value="CA">Canada</SelectItem>
                            <SelectItem value="GB">United Kingdom</SelectItem>
                            <SelectItem value="AU">Australia</SelectItem>
                        </SelectContent>
                    </Select>

                    {/* State */}
                     <Select value={state} onValueChange={setState} aria-label="Select State or Province">
                        <SelectTrigger className="bg-gray-50 border-gray-300 text-gray-900 text-base py-6" aria-label="State or Province Dropdown">
                             <MapPin className="text-gray-400 mr-2" size={18} />
                            <SelectValue placeholder="State / Province" />
                        </SelectTrigger>
                        <SelectContent className="bg-white border-gray-300 text-gray-900">
                                <SelectItem value="CA">California</SelectItem>
                                <SelectItem value="TX">Texas</SelectItem>
                                <SelectItem value="FL">Florida</SelectItem>
                                <SelectItem value="NY">New York</SelectItem>
                        </SelectContent>
                    </Select>

                    {/* City / Postal */}
                    <div className="relative">
                        <MapPin className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
                        <Input
                            placeholder="City / Postal Code"
                            aria-label="City or Postal Code Input"
                            value={city}
                            onChange={(e) => setCity(e.target.value)}
                            className="pl-10 bg-gray-50 border-gray-300 text-gray-900 text-base h-full py-3"
                        />
                    </div>
                </div>

                {/* This div structure is for desktop grid layout. On mobile, it's ignored due to `display: contents`. */}
                <div className="search-bar-row grid grid-cols-1 md:grid-cols-[1.2fr_2fr_auto] gap-4">
                    {/* Sort By */}
                    <Select value={sortBy} onValueChange={setSortBy} aria-label="Sort by option">
                        <SelectTrigger className="bg-gray-50 border-gray-300 text-gray-900 text-base py-6 whitespace-nowrap" aria-label="Sort by Dropdown">
                             <ListFilter className="text-gray-400 mr-2" size={18} />
                            <SelectValue placeholder="Sort By..." />
                        </SelectTrigger>
                        <SelectContent className="bg-white border-gray-300 text-gray-900">
                            <SelectItem value="manufacturing_location_distance">Nearest Manufacturing</SelectItem>
                            <SelectItem value="headquarters_location_distance">Nearest Headquarters</SelectItem>
                            <SelectItem value="rating">Highest Rated</SelectItem>
                        </SelectContent>
                    </Select>

                    {/* Search Input */}
                    <Popover open={isSuggestionsOpen} onOpenChange={setIsSuggestionsOpen}>
                        <div className="relative w-full" ref={popoverAnchorRef}>
                            <Search 
                                className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 z-10 cursor-pointer" 
                                size={20}
                                onClick={() => searchInputRef.current?.focus()}
                            />
                            <Input
                                ref={searchInputRef}
                                placeholder="Search by product, keyword, or company..."
                                aria-label="Search by product, keyword, or website"
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                onFocus={() => { if (suggestions.length > 0) setIsSuggestionsOpen(true); }}
                                className="text-lg bg-gray-50 border-gray-300 text-gray-900 w-full h-full py-3 pl-12"
                                autoComplete="off"
                            />
                        </div>
                        <PopoverContent 
                            className="w-[var(--radix-popover-trigger-width)] p-0 bg-white border-gray-300" 
                            align="start"
                            anchor={popoverAnchorRef.current}
                            style={{ width: popoverAnchorRef.current ? `${popoverAnchorRef.current.offsetWidth}px` : 'auto' }}
                        >
                        {suggestions.map((s, i) => (
                            <div key={i}
                                onClick={() => handleSuggestionClick(s)}
                                className="px-4 py-2 text-sm text-gray-800 hover:bg-gray-100 cursor-pointer flex items-center justify-between"
                            >
                                <span>{s.value}</span>
                                <span className="text-xs text-gray-500 bg-gray-200 px-1.5 py-0.5 rounded-sm">{s.type}</span>
                            </div>
                        ))}
                        </PopoverContent>
                    </Popover>

                    <Button type="submit" size="lg" disabled={isLoading} className="text-base py-6 bg-tabarnam-blue text-slate-900 font-bold hover:bg-tabarnam-blue/80 transition-colors disabled:bg-tabarnam-blue/50 disabled:cursor-wait" aria-label="Submit Search">
                        {isLoading ? (
                            <Loader2 className="h-6 w-6 animate-spin" />
                        ) : (
                            <Search className="h-6 w-6" />
                        )}
                         <span className="md:hidden">Search</span>
                         <span className="hidden md:inline ml-2">Search</span>
                    </Button>
                </div>
            </form>
        </motion.div>
    );
};

export default SearchCard;