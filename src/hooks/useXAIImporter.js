import { useState, useCallback } from 'react';
import { useToast } from '@/components/ui/use-toast';
import { supabase } from '@/lib/customSupabaseClient';
import { getFunctionHeaders } from '@/lib/supabaseFunctionUtils';
import { logError } from '@/lib/errorLogger';
import { fetchCompanyLogo } from '@/lib/logo';

export const useXAIImporter = () => {
  const [queryType, setQueryType] = useState('company_list');
  const [entries, setEntries] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [dryRun, setDryRun] = useState(true);
  const [forceOverwrite, setForceOverwrite] = useState(false);
  const [manualInput, setManualInput] = useState('');
  const [discoveryQuery, setDiscoveryQuery] = useState('');
  const { toast } = useToast();

  const updateEntryStatus = useCallback((id, status, log, company = null) => {
    setEntries(prev => prev.map(entry => {
      if (entry.id !== id) return entry;
      const updated = { ...entry, status, log };
      if (company) {
        updated.company_name = company.name || entry.company_name;
        updated.url = company.website_url || entry.url;
        if (company.logo_url) updated.logo_url = company.logo_url;
      }
      return updated;
    }));
  }, []);

  // ------- Logo enrichment helpers -----------------------------------------
  const logoMemo = new Map();
  const extractHost = (u) => {
    if (!u) return null;
    try {
      const url = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`);
      return url.hostname;
    } catch { return null; }
  };
  const getLogoForCompany = async (company) => {
    try {
      const homepage = company?.website_url || company?.url;
      const host = extractHost(homepage);
      if (!host) return null;
      if (logoMemo.has(host)) return logoMemo.get(host);
      const logo = await fetchCompanyLogo({ domain: host });
      logoMemo.set(host, logo || null);
      return logo || null;
    } catch { return null; }
  };
  const pMap = async (items, mapper, concurrency = 4) => {
    const ret = [];
    let i = 0;
    const workers = new Array(concurrency).fill(0).map(async () => {
      while (i < items.length) {
        const idx = i++;
        ret[idx] = await mapper(items[idx], idx);
      }
    });
    await Promise.all(workers);
    return ret;
  };
  // -------------------------------------------------------------------------

  // ------- Persist logs + logo_url to Cosmos via Function ------------------
  const persistImportResults = async (arr) => {
    try {
      // small batches to keep payload tidy
      const chunks = [];
      const size = 20;
      for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));

      await Promise.all(chunks.map(async (chunk) => {
        await fetch("/api/save-import-log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ results: chunk })
        });
      }));
    } catch (e) {
      logError({ type: 'Bulk Import', message: `save-import-log failed: ${e.message}` });
    }
  };
  // -------------------------------------------------------------------------

  const handleBulkImport = async () => {
    setIsProcessing(true);
    toast({
      title: '🚀 Starting Task...',
      description: `Mode: ${queryType === 'company_list' ? 'Bulk Import' : 'Discovery'}. This might take a while.`,
    });

    let body;
    if (queryType === 'company_list') {
      const pendingEntries = entries.filter(e => e.status === 'Pending' || e.status === 'Error');
      if (pendingEntries.length === 0) {
        toast({ title: 'Queue Empty', description: 'No pending or failed entries to process.' });
        setIsProcessing(false);
        return;
      }
      body = { queryType, entries: pendingEntries, dryRun, forceOverwrite };
    } else {
      body = { queryType, query: discoveryQuery, dryRun, forceOverwrite };
    }

    try {
      const headers = await getFunctionHeaders();
      const { data, error } = await supabase.functions.invoke('xai-bulk-importer', {
        body,
        headers,
      });

      if (error) throw new Error(`Edge function invocation failed: ${error.message}`);
      if (data?.error) throw new Error(`Task Failed: ${data.error}`);
      if (!data || !Array.isArray(data.results)) {
        toast({ variant: 'destructive', title: 'Invalid Response', description: 'Unexpected response shape.' });
        logError({ type: 'Bulk Import', message: `Invalid response: ${JSON.stringify(data)}` });
        return;
      }

      // Enrich with logos, then persist logs+logos
      const enriched = await pMap(data.results, async (result) => {
        if (result?.status === 'Success' && result.company && !result.company.logo_url) {
          const logo = await getLogoForCompany(result.company);
          if (logo) result.company.logo_url = logo;
        }
        return result;
      }, 4);

      await persistImportResults(enriched);

      if (queryType === 'company_list') {
        enriched.forEach(r => updateEntryStatus(r.id, r.status, r.log, r.company));
        const successCount = enriched.filter(r => r.status === 'Success').length;
        const errorCount = enriched.filter(r => r.status === 'Error').length;
        const skippedCount = enriched.filter(r => r.status === 'Skipped').length;
        toast({
          title: 'Bulk Import Complete',
          description: `${successCount} imported, ${errorCount} failed, ${skippedCount} skipped. ${dryRun ? '(Dry Run)' : ''}`
        });
      } else {
        const r = enriched[0];
        const finalMessage = r.status === 'Success'
          ? `Discovery successful. ${dryRun ? '(Dry Run)' : 'Company data was saved.'}`
          : `Discovery failed: ${r.log?.find(l => l.status === 'error')?.message || 'Unknown reason.'}`;
        toast({
          variant: r.status === 'Success' ? 'default' : 'destructive',
          title: 'Discovery Task Finished',
          description: finalMessage
        });
        if (r.status !== 'Error') {
          const newEntry = {
            id: r.id || `discovery-${Date.now()}`,
            company_name: r.company?.name || discoveryQuery,
            url: r.company?.website_url || '',
            logo_url: r.company?.logo_url || null,
            status: r.status,
            log: r.log
          };
          setEntries(prev => [newEntry, ...prev]);
        }
      }
    } catch (e) {
      toast({ variant: 'destructive', title: 'Task Failed', description: e.message });
      logError({ type: 'Bulk Import', message: `Bulk import failed: ${e.message}` });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleRetry = async (entryId) => {
    const entryToRetry = entries.find(e => e.id === entryId);
    if (!entryToRetry) return;

    updateEntryStatus(entryId, 'Pending', null);
    toast({ title: 'Retrying...', description: `Re-processing entry for ${entryToRetry.company_name || entryToRetry.url}` });

    try {
      const headers = await getFunctionHeaders();
      const body = {
        queryType: 'company_list',
        entries: [{ ...entryToRetry, status: 'Pending' }],
        dryRun,
        forceOverwrite
      };

      const { data, error } = await supabase.functions.invoke('xai-bulk-importer', {
        body,
        headers,
      });

      if (error) throw new Error(`Edge function invocation failed: ${error.message}`);
      if (data?.error) throw new Error(`Function returned an error: ${data.error}`);

      const [result] = data.results || [];
      if (result?.status === 'Success' && result.company && !result.company.logo_url) {
        const logo = await getLogoForCompany(result.company);
        if (logo) result.company.logo_url = logo;
      }

      await persistImportResults([result]);
      updateEntryStatus(result.id, result.status, result.log, result.company);
      toast({ title: 'Retry Processed', description: `Status for ${result.company?.name || 'entry'} is now ${result.status}.` });
    } catch (e) {
      updateEntryStatus(entryId, 'Error', [{ status: 'error', message: `Function invocation failed: ${e.message}` }]);
      logError({ type: 'Bulk Import', message: `Retry failed for ${entryToRetry.company_name || entryToRetry.url}: ${e.message}` });
    }
  };

  return {
    queryType, setQueryType,
    entries, setEntries,
    isLoading, setIsLoading,
    isProcessing,
    dryRun, setDryRun,
    forceOverwrite, setForceOverwrite,
    manualInput, setManualInput,
    discoveryQuery, setDiscoveryQuery,
    handleBulkImport,
    handleRetry,
  };
};
