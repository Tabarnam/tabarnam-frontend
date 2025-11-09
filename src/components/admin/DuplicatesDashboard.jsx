import React, { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/components/ui/use-toast';
// Supabase removed
import { Loader2, RefreshCw, AlertTriangle, CheckCircle, Combine } from 'lucide-react';
import { Button } from '@/components/ui/button';

const DuplicatesDashboard = () => {
    const [duplicates, setDuplicates] = useState([]);
    const [loading, setLoading] = useState(false);
    const { toast } = useToast();

    const findDuplicates = useCallback(async () => {
        setLoading(true);
        try {
            const { data, error } = await supabase.rpc('find_company_duplicates_rpc');
            if (error) throw error;
            
            if (data && data.length > 0) {
                const enrichedDuplicates = await Promise.all(data.map(async (group) => {
                    const { data: companies, error: companiesError } = await supabase
                        .from('companies')
                        .select('id, name, website_url, created_at')
                        .in('id', group.company_ids);
                    if (companiesError) return { ...group, companies: [] };
                    return { ...group, companies };
                }));
                setDuplicates(enrichedDuplicates);
            } else {
                setDuplicates([]);
            }

        } catch (error) {
            toast({ variant: 'destructive', title: 'Failed to find duplicates', description: error.message });
        } finally {
            setLoading(false);
        }
    }, [toast]);

    const handleMerge = async (masterId, duplicateIds) => {
        try {
            const { error } = await supabase.rpc('merge_company_duplicates_rpc', {
                master_company_id: masterId,
                duplicate_company_ids: duplicateIds,
            });

            if (error) throw error;
            toast({ title: "Merge Successful", description: "Companies have been merged." });
            findDuplicates();
        } catch (error) {
            toast({ variant: 'destructive', title: 'Merge Failed', description: error.message });
        }
    };

    return (
        <div className="p-4 bg-slate-900/50 rounded-lg">
            <div className="flex justify-between items-center mb-4">
                <h3 className="text-xl font-bold text-white">Company Duplicates</h3>
                <Button onClick={findDuplicates} disabled={loading}>
                    {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                    Find Duplicates
                </Button>
            </div>
            
            {loading ? (
                 <div className="flex justify-center items-center h-64"><Loader2 className="w-8 h-8 animate-spin" /></div>
            ) : duplicates.length > 0 ? (
                <div className="space-y-4">
                    {duplicates.map((group, index) => (
                        <div key={index} className="bg-slate-800/50 p-4 rounded-lg">
                            <h4 className="font-bold text-lg text-amber-400 mb-2">Duplicate Group: "{group.normalized_name}"</h4>
                            <div className="space-y-2">
                                {group.companies.map(company => (
                                    <div key={company.id} className="flex justify-between items-center p-2 bg-slate-700/50 rounded">
                                        <div>
                                            <p className="font-semibold">{company.name}</p>
                                            <p className="text-xs text-gray-400">{company.website_url || 'No URL'} - Created: {new Date(company.created_at).toLocaleDateString()}</p>
                                        </div>
                                        <Button size="sm" variant="outline" onClick={() => handleMerge(company.id, group.company_ids.filter(id => id !== company.id))}>
                                            <Combine size={16} className="mr-2" />
                                            Set as Master & Merge
                                        </Button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            ) : (
                <div className="text-center py-12">
                    <CheckCircle className="mx-auto h-12 w-12 text-green-500" />
                    <h3 className="mt-2 text-sm font-medium text-white">No Duplicates Found</h3>
                    <p className="mt-1 text-sm text-gray-400">Click the button above to scan for potential duplicates.</p>
                </div>
            )}
        </div>
    );
};

export default DuplicatesDashboard;
