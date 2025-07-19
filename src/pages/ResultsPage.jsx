import React, {
  useState,
  useEffect,
  useCallback
} from 'react';
import { useLocation } from 'react-router-dom';
import { Helmet } from 'react-helmet';
import { motion } from 'framer-motion';

import { supabase } from '@/lib/customSupabaseClient';
import { useToast } from '@/components/ui/use-toast';
import {
  Loader2,
  BrainCircuit,
  Languages
} from 'lucide-react';

import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import ResultsSearch from '@/components/results/ResultsSearch';
import ResultsTable from '@/components/results/ResultsTable';
import logError from '@/lib/errorLogger';
import useBrowserLanguage from '@/hooks/useBrowserLanguage';
import useUserGeolocation from '@/hooks/useUserLocation';

const ResultsPage = () => {
  const location = useLocation();
  const queryParams = new URLSearchParams(location.search);

  const searchTermInitial = queryParams.get('term') || '';
  const sortByInitial = queryParams.get('sortBy') || 'relevance_score';

  const toast = useToast();
  const browserLang = useBrowserLanguage();
  const userLocation = useUserGeolocation();

  const [searchTerm, setSearchTerm] = useState(searchTermInitial);
  const [sortBy, setSortBy] = useState(sortByInitial);
  const [loading, setLoading] = useState(true);
  const [companies, setCompanies] = useState([]);
  const [viewTranslated, setViewTranslated] = useState(false);

  const fetchCompanies = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('companies')
        .select('*')
        .ilike('product_keywords', `%${searchTerm}%`)
        .order(sortBy, { ascending: false })
        .limit(50);

      if (error) throw error;
      setCompanies(data);
    } catch (err) {
      logError(err);
      toast({
        title: 'Error fetching companies',
        description: err.message,
        variant: 'destructive'
      });
    } finally {
      setLoading(false);
    }
  }, [searchTerm, sortBy, toast]);

  useEffect(() => {
    fetchCompanies();
  }, [fetchCompanies]);

  return (
    <>
      <Helmet>
        <title>Search Results – Tabarnam</title>
      </Helmet>

      <motion.main
        className="min-h-screen bg-background"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        <div className="container py-10 px-4">
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-2xl font-semibold">Search Results</h1>
            <div className="flex items-center gap-3">
              <Label htmlFor="translate">Translate</Label>
              <Switch
                id="translate"
                checked={viewTranslated}
                onCheckedChange={setViewTranslated}
              />
              <Languages size={18} />
            </div>
          </div>

          <ResultsSearch
            searchTerm={searchTerm}
            setSearchTerm={setSearchTerm}
            sortBy={sortBy}
            setSortBy={setSortBy}
            onSearch={fetchCompanies}
            userLocation={userLocation}
          />

          {loading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="animate-spin w-6 h-6 text-muted-foreground" />
            </div>
          ) : companies.length === 0 ? (
            <div className="text-center py-20 text-muted-foreground">
              <BrainCircuit className="mx-auto mb-4 w-8 h-8" />
              <p>No companies matched your search.</p>
            </div>
          ) : (
            <ResultsTable
              companies={companies}
              viewTranslated={viewTranslated}
              userLocation={userLocation}
              browserLanguage={browserLang}
            />
          )}
        </div>
      </motion.main>
    </>
  );
};

export default ResultsPage;
