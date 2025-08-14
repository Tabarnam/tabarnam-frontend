
    import React, { useState, useEffect, useRef } from 'react';
    import { motion } from 'framer-motion';
    import { Search, MapPin, ListFilter, Loader2 } from 'lucide-react';
    import { Input } from '@/components/ui/input';
    import { Button } from '@/components/ui/button';
    import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
    import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
    import { supabase } from '@/lib/customSupabaseClient';

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

    const ResultsSearch = ({ onSearch, initialParams, isLoading }) => {
        const [searchTerm, setSearchTerm] = useState(initialParams.term || '');
        const [location, setLocation] = useState('');
        const [sortBy, setSortBy] = useState(initialParams.sortBy || 'relevance_score');
        
        const [suggestions, setSuggestions] = useState([]);
        const [isSuggestionsOpen, setIsSuggestionsOpen] = useState(false);
        const debouncedSearchTerm = useDebounce(searchTerm, 300);
        const inputRef = useRef(null);

        useEffect(() => {
            if (debouncedSearchTerm.length > 2) {
                fetchSuggestions(debouncedSearchTerm);
            } else {
                setSuggestions([]);
                setIsSuggestionsOpen(false);
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
            setSuggestions(data || []);
            if (data && data.length > 0) {
                setIsSuggestionsOpen(true);
            } else {
                setIsSuggestionsOpen(false);
            }
        };

        const handleSuggestionClick = (suggestion) => {
            setSearchTerm(suggestion.value);
            setSuggestions([]);
            setIsSuggestionsOpen(false);
        };
    
        const handleSubmit = (e) => {
            e.preventDefault();
            onSearch({ term: searchTerm, location, sortBy });
            setIsSuggestionsOpen(false);
            inputRef.current?.blur();
        };

        return (
            <motion.div 
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, ease: "easeOut" }}
                className="bg-white/80 backdrop-blur-lg border border-gray-200 rounded-xl p-3 mb-6 shadow-md"
            >
                <form onSubmit={handleSubmit} className="flex items-center gap-2 md:gap-4 flex-wrap">
                    {/* Search Input */}
                    <Popover open={isSuggestionsOpen} onOpenChange={setIsSuggestionsOpen}>
                        <PopoverTrigger asChild>
                            <div className="relative flex-grow min-w-[200px] md:min-w-[300px]">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
                                <Input
                                    ref={inputRef}
                                    placeholder="Search by product, keyword, company..."
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                    onFocus={() => {
                                        if (suggestions.length > 0) setIsSuggestionsOpen(true);
                                    }}
                                    className="pl-10 h-11 bg-gray-50 border-gray-300 text-gray-900 text-base"
                                    autoComplete="off"
                                />
                            </div>
                        </PopoverTrigger>
                        <PopoverContent 
                            className="w-[var(--radix-popover-trigger-width)] p-0 bg-white border-gray-300" 
                            align="start"
                            onOpenAutoFocus={(e) => e.preventDefault()}
                        >
                            {suggestions.map((s, i) => (
                                <div key={i}
                                    onMouseDown={(e) => {
                                        e.preventDefault();
                                        handleSuggestionClick(s);
                                    }}
                                    className="px-4 py-2 text-sm text-gray-800 hover:bg-gray-100 cursor-pointer flex items-center justify-between"
                                >
                                    <span>{s.value}</span>
                                    <span className="text-xs text-gray-500 bg-gray-200 px-1.5 py-0.5 rounded-sm">{s.type}</span>
                                </div>
                            ))}
                        </PopoverContent>
                    </Popover>

                    {/* Location Input */}
                    <div className="relative flex-grow">
                         <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
                        <Input
                            placeholder="City, State or Postal Code"
                            value={location}
                            onChange={(e) => setLocation(e.target.value)}
                            className="pl-10 h-11 bg-gray-50 border-gray-300 text-gray-900"
                        />
                    </div>

                    {/* Sort By */}
                    <Select value={sortBy} onValueChange={setSortBy}>
                        <SelectTrigger className="bg-gray-50 border-gray-300 text-gray-900 h-11 whitespace-nowrap w-auto">
                            <ListFilter className="text-gray-400 mr-2" size={18} />
                            <SelectValue placeholder="Sort By..." />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="relevance_score">Relevance</SelectItem>
                            <SelectItem value="manufacturing_location_distance">Nearest Manufacturing</SelectItem>
                            <SelectItem value="headquarters_location_distance">Nearest Headquarters</SelectItem>
                            <SelectItem value="rating">Highest Rated</SelectItem>
                        </SelectContent>
                    </Select>
                    
                    <Button type="submit" size="lg" disabled={isLoading} className="h-11 bg-tabarnam-blue text-slate-900 font-bold hover:bg-tabarnam-blue/80 transition-colors">
                        {isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Search className="h-5 w-5" />}
                    </Button>
                </form>
            </motion.div>
        );
    };

    export default ResultsSearch;
  