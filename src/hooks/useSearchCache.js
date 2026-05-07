
import { useState, useCallback, useEffect } from 'react';

const LOCATION_CACHE_KEY = 'tabarnam_user_location';
const SEARCH_CACHE_KEY = 'tabarnam_recent_searches';
// Raised from 5 to 200 so users can scroll back through their full search
// history. Each entry is small (~50-100 bytes once serialized), so 200
// entries cost ~20 KB of localStorage — well under the typical 5-10 MB cap.
const MAX_CACHED_SEARCHES = 200;

// Backward-compatibility helper: older entries were stored without a
// timestamp (just `{ term }`). For grouping the dropdown by Today / Yesterday /
// Last week / Older we need every entry to have a `ts`. Entries missing a
// timestamp are treated as "Older" — we don't fabricate one, so the order
// stays correct.
const normaliseEntry = (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const term = typeof raw.term === 'string' ? raw.term.trim() : '';
    if (!term) return null;
    const ts = Number.isFinite(raw.ts) ? raw.ts : null;
    return { ...raw, term, ts };
};

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
            const parsed = item ? JSON.parse(item) : [];
            if (!Array.isArray(parsed)) return [];
            return parsed.map(normaliseEntry).filter(Boolean);
        } catch (error) {
            console.error('Error reading searches from localStorage', error);
            return [];
        }
    };

    const addSearchToCache = (searchParams) => {
        try {
            const term = typeof searchParams?.term === 'string' ? searchParams.term.trim() : '';
            if (!term) return;
            const recentSearches = getCachedSearches();
            // Avoid duplicates by removing prior entries with the same term
            // (case-insensitive so "grits" doesn't appear twice as "grits"
            // and "Grits").
            const lower = term.toLowerCase();
            const filteredSearches = recentSearches.filter((s) => s.term.toLowerCase() !== lower);
            const entry = { ...searchParams, term, ts: Date.now() };
            const updatedSearches = [entry, ...filteredSearches].slice(0, MAX_CACHED_SEARCHES);
            localStorage.setItem(SEARCH_CACHE_KEY, JSON.stringify(updatedSearches));
        } catch (error) {
            console.error('Error saving search to localStorage', error);
        }
    };

    const removeSearchFromCache = (term) => {
        try {
            if (!term) return;
            const lower = String(term).toLowerCase();
            const filtered = getCachedSearches().filter((s) => s.term.toLowerCase() !== lower);
            localStorage.setItem(SEARCH_CACHE_KEY, JSON.stringify(filtered));
        } catch (error) {
            console.error('Error removing search from localStorage', error);
        }
    };

    const clearSearchCache = () => {
        try {
            localStorage.removeItem(SEARCH_CACHE_KEY);
        } catch (error) {
            console.error('Error clearing search cache', error);
        }
    };

    return {
        getCachedLocation,
        setCachedLocation,
        getCachedSearches,
        addSearchToCache,
        removeSearchFromCache,
        clearSearchCache,
    };
};
