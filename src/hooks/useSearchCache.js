
import { useState, useCallback, useEffect } from 'react';

const LOCATION_CACHE_KEY = 'tabarnam_user_location';
const SEARCH_CACHE_KEY = 'tabarnam_recent_searches';
const MAX_CACHED_SEARCHES = 5;

export const useSearchCache = () => {
    // Session cache for location
    const getCachedLocation = () => {
        try {
            const item = sessionStorage.getItem(LOCATION_CACHE_KEY);
            return item ? JSON.parse(item) : null;
        } catch (error) {
            console.error('Error reading location from sessionStorage', error);
            return null;
        }
    };

    const setCachedLocation = (location) => {
        try {
            sessionStorage.setItem(LOCATION_CACHE_KEY, JSON.stringify(location));
        } catch (error) {
            console.error('Error saving location to sessionStorage', error);
        }
    };

    // Local storage cache for recent searches
    const getCachedSearches = () => {
        try {
            const item = localStorage.getItem(SEARCH_CACHE_KEY);
            return item ? JSON.parse(item) : [];
        } catch (error) {
            console.error('Error reading searches from localStorage', error);
            return [];
        }
    };

    const addSearchToCache = (searchParams) => {
        try {
            const recentSearches = getCachedSearches();
            // Avoid duplicates by removing existing entry
            const filteredSearches = recentSearches.filter(s => s.term !== searchParams.term);
            const updatedSearches = [searchParams, ...filteredSearches].slice(0, MAX_CACHED_SEARCHES);
            localStorage.setItem(SEARCH_CACHE_KEY, JSON.stringify(updatedSearches));
        } catch (error) {
            console.error('Error saving search to localStorage', error);
        }
    };

    return { getCachedLocation, setCachedLocation, getCachedSearches, addSearchToCache };
};
