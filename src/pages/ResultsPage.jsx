
    import React, { useState, useEffect, useCallback, useRef } from 'react';
    import { useSearchParams, useNavigate } from 'react-router-dom';
    import { Helmet } from 'react-helmet';
    import { motion, AnimatePresence } from 'framer-motion';
    import { supabase } from '@/lib/customSupabaseClient';
    import { useToast } from '@/components/ui/use-toast';
    import { Loader2, BrainCircuit, ArrowLeft, Globe, Languages } from 'lucide-react';
    import { Button } from '@/components/ui/button';
    import ResultsTable from '@/components/results/ResultsTable';
    import { logError } from '@/lib/errorLogger';
    import useBrowserLanguage from '@/hooks/useBrowserLanguage';
    import { Switch } from '@/components/ui/switch';
    import { Label } from '@/components/ui/label';
    import ResultsSearch from '@/components/results/ResultsSearch';
    import useUserLocation from '@/hooks/useUserLocation';

    const ResultsPage = () => {
        const { toast } = useToast();
        const [searchParams, setSearchParams] = useSearchParams();
        const navigate = useNavigate();
        const browserLanguage = useBrowserLanguage();

        const [searchTerm, setSearchTerm] = useState(searchParams.get('term') || '');
        const [sortBy, setSortBy] = useState(searchParams.get('sortBy') || 'relevance_score');
        const [loading, setLoading] = useState(true);
        const [deepSearchLoading, setDeepSearchLoading] = useState(false);
        const [companies, setCompanies] = useState([]);
        const [viewTranslated, setViewTranslated] = useState(false);
        
        const { location: browserLocation, error: locationError } = useUserLocation();
        
        const initialUserLocation = useRef({
            latitude: searchParams.get('lat') ? parseFloat(searchParams.get('lat')) : null,
            longitude: searchParams.get('lon') ? parseFloat(searchParams.get('lon')) : null,
        });

        const searchCache = useRef(new Map());

        const handleSearch = useCallback(async (params, forceRefresh = false) => {
            const { term, sortBy: sortOption } = params;

            setLoading(true);

            // Use detected browser location if available and no specific location was part of the initial search
            let locationToUse = initialUserLocation.current.latitude ? initialUserLocation.current : null;
            if (!locationToUse && browserLocation) {
                 locationToUse = { latitude: browserLocation.latitude, longitude: browserLocation.longitude };
            }

            const cacheKey = `${term?.toLowerCase()}-${locationToUse?.latitude}-${locationToUse?.longitude}-${sortOption}`;
            if (searchCache.current.has(cacheKey) && !forceRefresh) {
                setCompanies(searchCache.current.get(cacheKey));
                setLoading(false);
                return;
            }

            try {
                // If a location query is typed, we need to geocode it first
                // For now, we'll just pass text, but a real implementation would call a geocoder
                
                const { data, error } = await supabase.rpc('advanced_company_search', {
                    p_search_term: term,
                    p_user_lat: locationToUse?.latitude,
                    p_user_lon: locationToUse?.longitude,
                    p_sort_by: sortOption
                });

                if (error) throw error;
                
                const formattedData = (data || []).map(c => ({
                    ...c,
                    id: c.id,
                    name: c.name,
                    tagline: c.tagline,
                    about: c.about,
                    website_url: c.website_url,
                    logo_url: c.logo_url,
                    star_rating: c.star_rating,
                    star_explanation: c.star_explanation,
                    notes: c.notes,
                    industries: c.industries || [],
                    product_keywords: c.product_keywords || [],
                    headquarters: c.headquarters ? (Array.isArray(c.headquarters) ? c.headquarters : [c.headquarters]) : [],
                    manufacturing_sites: c.manufacturing_sites || [],
                    relevance_score: Number(c.relevance_score),
                    min_distance_km: c.min_distance_km,
                }));

                searchCache.current.set(cacheKey, formattedData);
                setCompanies(formattedData);
                
                supabase.functions.invoke('log-search-analytics', {
                    body: { query: term, location: locationToUse ? `${locationToUse.latitude}, ${locationToUse.longitude}` : 'N/A', companies: formattedData }
                }).catch(err => console.error("Analytics logging failed:", err));

            } catch (error) {
                toast({ variant: "destructive", title: "Search Failed", description: "Could not perform search. Please try again." });
                logError({ type: 'Search', field_name: 'advanced_company_search', message: error.message });
            } finally {
                setLoading(false);
            }
        }, [toast, browserLocation, initialUserLocation]);
        
        useEffect(() => {
            handleSearch({ term: searchTerm, sortBy: sortBy });
        }, [searchTerm, sortBy, handleSearch]);

        const handleNewSearch = (newParams) => {
            const { term, sortBy } = newParams;
            const currentParams = new URLSearchParams(searchParams);
            currentParams.set('term', term);
            currentParams.set('sortBy', sortBy);
            
            // We don't have location geocoding yet, so we'll keep the original lat/lon
            
            setSearchParams(currentParams);
            setSearchTerm(term);
            setSortBy(sortBy);
        };

        const handleKeywordClick = (keyword) => {
            const newParams = new URLSearchParams(searchParams);
            newParams.set('term', keyword);
            setSearchParams(newParams);
            setSearchTerm(keyword);
            window.scrollTo({ top: 0, behavior: 'smooth' });
        };

        const handleDeepSearch = async () => {
            setDeepSearchLoading(true);
            toast({
                title: "🚀 Deep Search Initiated",
                description: "Using xAI to find new companies. This may take a moment...",
            });
            
            const locationForAnalytics = initialUserLocation.current.latitude ? initialUserLocation.current : browserLocation;

            supabase.functions.invoke('log-search-analytics', {
                body: { query: searchTerm, location: locationForAnalytics ? `${locationForAnalytics.latitude}, ${locationForAnalytics.longitude}` : 'Default (San Dimas, CA)', isDeepSearch: true }
            }).catch(err => console.error("Deep search analytics logging failed:", err));

            try {
                const { data, error } = await supabase.functions.invoke('deep-search-xai', {
                    body: { searchTerm },
                });

                if (error) throw new Error(error.message);
                if (data.error) throw new Error(data.error);

                toast({
                    title: "✅ Deep Search Complete!",
                    description: `Found and added ${data.new_companies || 0} new companies. Refreshing results...`,
                });
                handleSearch({ term: searchTerm, sortBy }, true);

            } catch (error) {
                toast({ variant: "destructive", title: "Deep Search Failed", description: error.message || "Could not fetch new results from xAI." });
                logError({ type: 'xAI Deep Search', message: error.message });
            } finally {
                setDeepSearchLoading(false);
            }
        };

        const handleBackToSearch = () => {
            navigate('/');
        };

        const showTranslationToggle = browserLanguage && browserLanguage !== 'en' && companies.length > 0;
        const finalUserLocation = initialUserLocation.current.latitude ? initialUserLocation.current : browserLocation;

        return (
            <>
                <Helmet>
                    <title>Search Results for "{searchTerm}" | Tabarnam</title>
                    <meta name="description" content={`Search results for ${searchTerm} on Tabarnam.`} />
                </Helmet>
                <div className="min-h-screen bg-gray-50 p-4 sm:p-6 md:p-8">
                    <div className="max-w-7xl mx-auto">
                        <header className="flex items-center justify-between mb-4">
                            <motion.div whileHover={{ scale: 1.05 }} transition={{type: "spring", stiffness: 300}} className="inline-block">
                                <a href="/"><img src="https://storage.googleapis.com/hostinger-horizons-assets-prod/7a52e996-8cb5-4576-916e-e398d620ccbb/b264cc6fba83562cdb682e19318806ef.png" alt="Tabarnam Logo" className="h-10 md:h-12" /></a>
                            </motion.div>
                            <Button variant="ghost" onClick={handleBackToSearch} className="text-gray-500 hover:text-gray-900 hover:bg-gray-100">
                                <ArrowLeft className="mr-2 h-4 w-4" />
                                Start New Search
                            </Button>
                        </header>

                        <ResultsSearch 
                            onSearch={handleNewSearch} 
                            initialParams={{ term: searchTerm, sortBy: sortBy }}
                            isLoading={loading}
                        />
                        
                        <AnimatePresence>
                        {showTranslationToggle && (
                            <motion.div 
                                initial={{ opacity: 0, y: -10 }} 
                                animate={{ opacity: 1, y: 0 }} 
                                exit={{ opacity: 0, y: -10 }}
                                className="flex items-center justify-end space-x-2 mb-4 p-3 bg-white rounded-lg border"
                            >
                                <Languages className="w-5 h-5 text-gray-600" />
                                <Label htmlFor="translation-switch" className="text-sm text-gray-700 font-medium">
                                    View in {new Intl.DisplayNames(['en'], { type: 'language' }).of(browserLanguage)}
                                </Label>
                                <Switch id="translation-switch" checked={viewTranslated} onCheckedChange={setViewTranslated} />
                            </motion.div>
                        )}
                        </AnimatePresence>

                        {loading ? (
                            <div className="flex justify-center items-center py-20"><Loader2 className="w-16 h-16 text-gray-400 animate-spin" /></div>
                        ) : (
                        companies.length > 0 
                        ? <ResultsTable companies={companies} userLocation={finalUserLocation} onKeywordSearch={handleKeywordClick} language={browserLanguage} viewTranslated={viewTranslated} />
                        : <div className="text-center py-20 bg-white rounded-2xl mt-8 border">
                                <h2 className="text-2xl font-bold text-gray-800 mb-2">No Results Found</h2>
                                <p className="text-gray-500 mb-6">Try a different search term or broaden your criteria.</p>
                                <Button onClick={handleDeepSearch} disabled={deepSearchLoading} variant="outline" size="lg" className="text-gray-700 border-gray-300 hover:bg-gray-100 bg-white">
                                    {deepSearchLoading ? <Loader2 className="mr-2 animate-spin" /> : <BrainCircuit className="mr-2" />}
                                    {deepSearchLoading ? 'Searching...' : 'Deep Search with xAI'}
                                </Button>
                            </div>
                        )}

                        {!loading && companies.length > 0 && companies.length < 20 && (
                            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="text-center mt-8">
                                <Button onClick={handleDeepSearch} disabled={deepSearchLoading} variant="outline" size="lg" className="text-gray-700 border-gray-300 hover:bg-gray-100 bg-white">
                                    {deepSearchLoading ? <Loader2 className="mr-2 animate-spin" /> : <BrainCircuit className="mr-2" />}
                                    {deepSearchLoading ? 'Searching...' : 'Deep Search with xAI'}
                                </Button>
                            </motion.div>
                        )}
                        
                        <AnimatePresence>
                        {viewTranslated && (
                            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-center mt-4">
                                <p className="text-xs text-gray-500 italic flex items-center justify-center gap-1.5"><Globe size={12}/> Translated from English</p>
                            </motion.div>
                        )}
                        </AnimatePresence>
                    </div>
                </div>
            </>
        );
    };

    export default ResultsPage;
  