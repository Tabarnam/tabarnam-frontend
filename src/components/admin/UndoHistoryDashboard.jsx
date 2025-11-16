import React, { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/components/ui/use-toast';
import { Loader2, Undo2, CheckCircle, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';

const UndoHistoryDashboard = () => {
    const [history, setHistory] = useState([]);
    const [loading, setLoading] = useState(true);
    const { toast } = useToast();

    const fetchHistory = useCallback(async () => {
        setLoading(true);
        try {
            const res = await apiFetch('/admin/undo-history');
            const data = await res.json().catch(() => null);
            if (res.ok && data && Array.isArray(data.items)) {
                setHistory(data.items);
            } else {
                toast({
                    variant: 'destructive',
                    title: 'Failed to fetch action history',
                    description: data?.error || 'Unable to load history from server.',
                });
            }
        } catch (error) {
            toast({
                variant: 'destructive',
                title: 'Failed to fetch action history',
                description: error?.message || 'Network error while loading history.',
            });
        } finally {
            setLoading(false);
        }
    }, [toast]);

    useEffect(() => {
        fetchHistory();
    }, [fetchHistory]);

    const handleUndo = async (action) => {
        if (action.is_undone) {
            toast({ title: 'Action already undone.' });
            return;
        }

        try {
            const res = await apiFetch('/admin/undo-history', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action_ids: [action.id] }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || data?.error) {
                throw new Error(data?.error || 'Failed to undo action');
            }
            toast({
                title: 'Action undone',
                description: 'The change has been reverted.',
            });
            fetchHistory();
        } catch (error) {
            toast({
                variant: 'destructive',
                title: 'Undo Failed',
                description: error?.message || 'Unable to undo action.',
            });
        }
    };

    if (loading) {
        return <div className="flex justify-center items-center h-64"><Loader2 className="w-8 h-8 animate-spin" /></div>;
    }

    return (
        <div className="p-4 bg-slate-900/50 rounded-lg">
            <h3 className="text-xl font-bold text-white mb-4">Action History</h3>
            <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-white/10">
                    <thead>
                        <tr>
                            <th className="p-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Description</th>
                            <th className="p-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Action</th>
                            <th className="p-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Date</th>
                            <th className="p-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Status</th>
                            <th className="p-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider"></th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-white/10">
                        {history.map(action => (
                            <tr key={action.id}>
                                <td className="p-3 max-w-md truncate" title={action.description}>{action.description}</td>
                                <td className="p-3 whitespace-nowrap"><span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-blue-800 text-blue-100">{action.action_type}</span></td>
                                <td className="p-3 whitespace-nowrap text-sm text-gray-400">{new Date(action.created_at).toLocaleString()}</td>
                                <td className="p-3 whitespace-nowrap">{action.is_undone ? <span className="text-gray-500">Undone</span> : <span className="text-green-400">Active</span>}</td>
                                <td className="p-3 text-right">
                                    <Button variant="ghost" size="sm" onClick={() => handleUndo(action)} disabled={action.is_undone}>
                                        <Undo2 className="mr-2 h-4 w-4" /> Undo
                                    </Button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {history.length === 0 && (
                <div className="text-center py-12">
                    <Clock className="mx-auto h-12 w-12 text-gray-500" />
                    <h3 className="mt-2 text-sm font-medium text-white">No Recent Actions</h3>
                    <p className="mt-1 text-sm text-gray-400">Perform an action in the admin panel to see it here.</p>
                </div>
            )}
        </div>
    );
};

export default UndoHistoryDashboard;
