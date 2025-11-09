import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useToast } from '@/components/ui/use-toast';
// Supabase removed
import { Loader2, AlertTriangle, RefreshCw, Trash2, CheckCircle, Filter, X, Link, Bot } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const ErrorsDashboard = () => {
    const [allErrors, setAllErrors] = useState([]);
    const [loading, setLoading] = useState(true);
    const [bulkLoading, setBulkLoading] = useState(false);
    const [selectedErrors, setSelectedErrors] = useState(new Set());
    const [filterType, setFilterType] = useState('all');
    const { toast } = useToast();

    const fetchErrors = useCallback(async () => {
        setLoading(true);
        try {
            const { data, error } = await supabase
                .from('errors')
                .select('*, company:companies(name)')
                .order('created_at', { ascending: false });

            if (error) throw error;
            setAllErrors(data || []);
        } catch (error) {
            toast({
                variant: 'destructive',
                title: 'Failed to fetch errors',
                description: error.message,
            });
        } finally {
            setLoading(false);
        }
    }, [toast]);

    useEffect(() => {
        fetchErrors();
    }, [fetchErrors]);

    const filteredErrors = useMemo(() => {
        if (filterType === 'all') return allErrors;
        return allErrors.filter(e => e.type === filterType);
    }, [allErrors, filterType]);

    const errorTypes = useMemo(() => ['all', ...Array.from(new Set(allErrors.map(e => e.type)))], [allErrors]);

    const handleSelection = (errorId) => {
        const newSelection = new Set(selectedErrors);
        if (newSelection.has(errorId)) newSelection.delete(errorId);
        else newSelection.add(errorId);
        setSelectedErrors(newSelection);
    };

    const handleResolve = async (errorId) => {
        try {
            const { error } = await supabase.from('errors').update({ resolved: true }).eq('id', errorId);
            if (error) throw error;
            toast({ title: 'Success', description: 'Error marked as resolved.' });
            fetchErrors();
        } catch (error) {
            toast({ variant: 'destructive', title: 'Action failed', description: error.message });
        }
    };

    const handleDelete = async (errorId) => {
        try {
            const { error } = await supabase.from('errors').delete().eq('id', errorId);
            if (error) throw error;
            toast({ title: 'Success', description: 'Error deleted.' });
            fetchErrors();
        } catch (error) {
            toast({ variant: 'destructive', title: 'Action failed', description: error.message });
        }
    };

    const handleBulkReprocess = async () => {
        setBulkLoading(true);
        const selectedErrorObjects = allErrors.filter(e => selectedErrors.has(e.id));
        const geoErrors = selectedErrorObjects.filter(e => e.type === 'Geolocation').map(e => e.id);
        const urlErrors = selectedErrorObjects.filter(e => e.type === 'Invalid URL').map(e => e.id);
        const xaiErrors = selectedErrorObjects.filter(e => e.type === 'xAI Import').map(e => e.id);

        let processedCount = 0;
        let failedCount = 0;

        if (geoErrors.length > 0) {
            const { data, error } = await supabase.rpc('reprocess_geolocation_errors', { p_error_ids: geoErrors });
            if (error) {
                toast({ variant: 'destructive', title: 'Geolocation reprocess failed', description: error.message });
                failedCount += geoErrors.length;
            } else {
                const successCount = data.filter(d => d.status === 'Success').length;
                processedCount += successCount;
                failedCount += data.length - successCount;
                toast({ title: 'Geolocation Reprocess Complete', description: `${successCount} succeeded, ${data.length - successCount} failed or skipped.` });
            }
        }
        
        if (urlErrors.length > 0 || xaiErrors.length > 0) {
            toast({ title: "🚧 Feature In Progress", description: "URL and xAI reprocessing isn't implemented yet." });
        }

        if (processedCount > 0 || failedCount > 0) {
            fetchErrors();
        }
        setSelectedErrors(new Set());
        setBulkLoading(false);
    };

    if (loading) {
        return <div className="flex justify-center items-center h-64"><Loader2 className="w-8 h-8 animate-spin" /></div>;
    }

    return (
        <div className="p-4 bg-slate-900/50 rounded-lg">
             <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-4 gap-4">
                <h3 className="text-xl font-bold text-white">Error Logs ({filteredErrors.length})</h3>
                <div className="flex items-center gap-2 flex-wrap">
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="outline" className="w-[160px] justify-between">
                                <Filter className="mr-2 h-4 w-4" /> {filterType === 'all' ? 'Filter by Type' : filterType}
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent className="w-[160px] bg-slate-800 border-purple-500 text-white">
                            <DropdownMenuLabel>Filter by Type</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuRadioGroup value={filterType} onValueChange={setFilterType}>
                                {errorTypes.map(type => (
                                    <DropdownMenuRadioItem key={type} value={type}>{type}</DropdownMenuRadioItem>
                                ))}
                            </DropdownMenuRadioGroup>
                        </DropdownMenuContent>
                    </DropdownMenu>
                    <Button variant="outline" size="sm" onClick={handleBulkReprocess} disabled={selectedErrors.size === 0 || bulkLoading}>
                        {bulkLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />} Reprocess Selected
                    </Button>
                </div>
            </div>
            <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-white/10">
                    <thead className="bg-slate-800/50">
                        <tr>
                            <th className="p-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Status</th>
                            <th className="p-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Type</th>
                            <th className="p-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Message</th>
                            <th className="p-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Company</th>
                            <th className="p-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Date</th>
                            <th className="p-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-white/10">
                        {filteredErrors.map(error => (
                            <tr key={error.id} className={error.resolved ? 'bg-green-900/10' : ''}>
                                <td className="p-3 whitespace-nowrap">
                                    {error.resolved 
                                        ? <span className="text-green-400 flex items-center gap-2"><CheckCircle size={16}/> Resolved</span> 
                                        : <span className="text-yellow-400 flex items-center gap-2"><AlertTriangle size={16}/> Pending</span>
                                    }
                                </td>
                                <td className="p-3 whitespace-nowrap"><span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-red-800 text-red-100">{error.type}</span></td>
                                <td className="p-3 max-w-sm truncate" title={error.message}>{error.message}</td>
                                <td className="p-3 whitespace-nowrap text-sm text-gray-300">{error.company?.name || 'N/A'}</td>
                                <td className="p-3 whitespace-nowrap text-sm text-gray-400">{new Date(error.created_at).toLocaleString()}</td>
                                <td className="p-3 whitespace-nowrap">
                                    <div className="flex gap-1">
                                        {!error.resolved && (
                                            <Button variant="ghost" size="sm" className="text-green-400 hover:bg-green-500/20 hover:text-green-300" onClick={() => handleResolve(error.id)}>Resolve</Button>
                                        )}
                                        <AlertDialog>
                                            <AlertDialogTrigger asChild>
                                                <Button variant="ghost" size="sm" className="text-red-400 hover:bg-red-500/20 hover:text-red-300">Remove</Button>
                                            </AlertDialogTrigger>
                                            <AlertDialogContent className="bg-slate-900 border-purple-500 text-white">
                                                <AlertDialogHeader>
                                                    <AlertDialogTitle>Are you sure?</AlertDialogTitle>
                                                    <AlertDialogDescription className="text-gray-400">This will permanently delete the error log. This action cannot be undone.</AlertDialogDescription>
                                                </AlertDialogHeader>
                                                <AlertDialogFooter>
                                                    <AlertDialogCancel className="border-gray-600 hover:bg-gray-700">Cancel</AlertDialogCancel>
                                                    <AlertDialogAction onClick={() => handleDelete(error.id)} className="bg-red-600 hover:bg-red-700">Delete</AlertDialogAction>
                                                </AlertDialogFooter>
                                            </AlertDialogContent>
                                        </AlertDialog>
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
             {filteredErrors.length === 0 && (
                <div className="text-center py-12">
                    <CheckCircle className="mx-auto h-12 w-12 text-green-500" />
                    <h3 className="mt-2 text-sm font-medium text-white">No Errors</h3>
                    <p className="mt-1 text-sm text-gray-400">{filterType === 'all' ? 'Everything is running smoothly!' : `No errors of type "${filterType}" found.`}</p>
                </div>
            )}
        </div>
    );
};

export default ErrorsDashboard;
