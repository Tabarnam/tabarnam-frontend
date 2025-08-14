
import { useState, useCallback } from 'react';
import { useToast } from '@/components/ui/use-toast';
import { supabase } from '@/lib/customSupabaseClient';
import { getFunctionHeaders } from '@/lib/supabaseFunctionUtils';
import { logError } from '@/lib/errorLogger';

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
            if (entry.id === id) {
                const updatedEntry = { ...entry, status, log };
                if (company) {
                    updatedEntry.company_name = company.name || entry.company_name;
                    updatedEntry.url = company.website_url || entry.url;
                }
                return updatedEntry;
            }
            return entry;
        }));
    }, []);

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
                body: body,
                headers: headers,
            });

            if (error) throw new Error(`Edge function invocation failed: ${error.message}`);
            if (data.error) throw new Error(`Task Failed: ${data.error}`);

            if (data && data.results) {
                if (queryType === 'company_list') {
                    data.results.forEach(result => updateEntryStatus(result.id, result.status, result.log, result.company));
                    const successCount = data.results.filter(r => r.status === 'Success').length;
                    const errorCount = data.results.filter(r => r.status === 'Error').length;
                    const skippedCount = data.results.filter(r => r.status === 'Skipped').length;
                    toast({
                        title: 'Bulk Import Complete',
                        description: `${successCount} imported, ${errorCount} failed, ${skippedCount} skipped. ${dryRun ? '(Dry Run)' : ''}`
                    });
                } else {
                    const result = data.results[0];
                    const finalMessage = result.status === 'Success' 
                        ? `Discovery successful. ${dryRun ? '(Dry Run)' : 'Company data was saved.'}` 
                        : `Discovery failed: ${result.log?.find(l => l.status === 'error')?.message || 'Unknown reason.'}`;
                    toast({
                        variant: result.status === 'Success' ? 'default' : 'destructive',
                        title: 'Discovery Task Finished',
                        description: finalMessage
                    });
                    if (result.status !== 'Error') {
                        const newEntry = {
                            id: result.id || `discovery-${Date.now()}`,
                            company_name: result.company?.name || discoveryQuery,
                            url: result.company?.website_url || '',
                            status: result.status,
                            log: result.log
                        };
                        setEntries(prev => [newEntry, ...prev]);
                    }
                }
            } else {
                 toast({ variant: 'destructive', title: 'Invalid Response', description: 'The server response was not in the expected format.' });
                 logError({ type: 'Bulk Import', message: `Invalid response from edge function: ${JSON.stringify(data)}` });
            }
        } catch(error) {
            toast({ variant: 'destructive', title: 'Task Failed', description: error.message });
            logError({ type: 'Bulk Import', message: `Bulk import function failed: ${error.message}` });
        } finally {
            setIsProcessing(false);
        }
    };
    
    const handleRetry = async (entryId) => {
        const entryToRetry = entries.find(e => e.id === entryId);
        if (!entryToRetry) return;

        updateEntryStatus(entryId, 'Pending', null);
        toast({ title: 'Retrying...', description: `Re-processing entry for ${entryToRetry.company_name || entryToRetry.url}`});

        try {
            const headers = await getFunctionHeaders();
            const body = {
                queryType: 'company_list',
                entries: [{...entryToRetry, status: 'Pending'}],
                dryRun,
                forceOverwrite
            };

            const { data, error } = await supabase.functions.invoke('xai-bulk-importer', {
                body: body,
                headers: headers,
            });

            if (error) throw new Error(`Edge function invocation failed: ${error.message}`);
            if (data.error) throw new Error(`Function returned an error: ${data.error}`);
            
            const result = data.results[0];
            updateEntryStatus(result.id, result.status, result.log, result.company);
            toast({ title: 'Retry Processed', description: `Status for ${result.company?.name || 'entry'} is now ${result.status}.`});
        } catch (error) {
             updateEntryStatus(entryId, 'Error', [{ status: 'error', message: `Function invocation failed: ${error.message}` }]);
             logError({ type: 'Bulk Import', message: `Retry failed for ${entryToRetry.company_name || entryToRetry.url}: ${error.message}` });
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
