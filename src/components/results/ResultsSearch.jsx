// src/components/results/ResultsSearch.jsx
import React, { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { Search, MapPin, ListFilter, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const ResultsSearch = ({ onSearch, initialParams = {}, isLoading }) => {
  const [searchTerm, setSearchTerm] = useState(initialParams.term || "");
  const [location, setLocation] = useState(initialParams.location || "");
  const [sortBy, setSortBy] = useState(initialParams.sortBy || "manu");
  const inputRef = useRef(null);

  useEffect(() => {
    if (initialParams.term !== undefined) setSearchTerm(initialParams.term);
    if (initialParams.location !== undefined) setLocation(initialParams.location);
    if (initialParams.sortBy !== undefined) setSortBy(initialParams.sortBy);
  }, [initialParams.term, initialParams.location, initialParams.sortBy]);

  const handleSubmit = (e) => {
    e.preventDefault();
    onSearch({ term: searchTerm, location, sortBy });
    inputRef.current?.blur();
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="bg-white/80 backdrop-blur-lg border border-gray-200 rounded-xl p-3 mb-6 shadow-md"
    >
      <form onSubmit={handleSubmit} className="flex items-center gap-2 md:gap-4 flex-wrap">
        {/* Search Input */}
        <div className="relative flex-grow min-w-[220px] md:min-w-[320px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
          <Input
            ref={inputRef}
            placeholder="Search by product, keyword, company..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10 h-11 bg-gray-50 border-gray-300 text-gray-900 text-base"
            autoComplete="off"
          />
        </div>

        {/* Location Input */}
        <div className="relative flex-grow min-w-[200px]">
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
            <SelectItem value="manu">Nearest Manufacturing</SelectItem>
            <SelectItem value="hq">Nearest Headquarters</SelectItem>
            <SelectItem value="stars">Highest Rated</SelectItem>
          </SelectContent>
        </Select>

        <Button
          type="submit"
          size="lg"
          disabled={isLoading}
          className="h-11 bg-tabarnam-blue text-slate-900 font-bold hover:bg-tabarnam-blue/80 transition-colors"
        >
          {isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Search className="h-5 w-5" />}
        </Button>
      </form>
    </motion.div>
  );
};

export default ResultsSearch;
