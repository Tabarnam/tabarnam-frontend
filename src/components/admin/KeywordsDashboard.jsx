import React, { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/components/ui/use-toast';
// Supabase removed
import { Loader2, Plus, Trash2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const KeywordsDashboard = () => {
    const [synonyms, setSynonyms] = useState([]);
    const [loading, setLoading] = useState(true);
    const [newTerm, setNewTerm] = useState('');
    const [newSynonyms, setNewSynonyms] = useState('');
    const { toast } = useToast();

    const fetchSynonyms = useCallback(async () => {
        setLoading(true);
        try {
            // Supabase removed - functionality disabled
            console.log('Fetch synonyms stub - Supabase removed');
            setSynonyms([]);
        } catch (error) {
            toast({ variant: 'destructive', title: 'Failed to fetch keywords', description: 'Keywords dashboard disabled - Supabase removed.' });
        } finally {
            setLoading(false);
        }
    }, [toast]);

    useEffect(() => {
        fetchSynonyms();
    }, [fetchSynonyms]);

    const handleUpdate = async (id, term, synonymStr) => {
        const synonymArray = synonymStr.split(',').map(s => s.trim()).filter(Boolean);
        try {
            // Supabase removed - functionality disabled
            console.log('Update synonym stub - Supabase removed');
            toast({ title: 'Success', description: `Keyword update disabled - Supabase removed.` });
        } catch (error) {
            toast({ variant: 'destructive', title: 'Update failed', description: error.message });
        }
    };

    const handleAdd = async () => {
        if (!newTerm.trim()) {
            toast({ variant: 'destructive', title: 'Term is required' });
            return;
        }
        const synonymArray = newSynonyms.split(',').map(s => s.trim()).filter(Boolean);
        try {
            // Supabase removed - functionality disabled
            console.log('Add keyword stub - Supabase removed');
            toast({ title: 'Success', description: 'Keyword addition disabled - Supabase removed.' });
            setNewTerm('');
            setNewSynonyms('');
        } catch (error) {
            toast({ variant: 'destructive', title: 'Failed to add keyword', description: error.message });
        }
    };

    const handleDelete = async (id) => {
        try {
            // Supabase removed - functionality disabled
            console.log('Delete keyword stub - Supabase removed');
            toast({ title: 'Success', description: 'Keyword deletion disabled - Supabase removed.' });
        } catch (error) {
            toast({ variant: 'destructive', title: 'Failed to delete keyword', description: error.message });
        }
    };

    const handleSynonymChange = (id, value) => {
        setSynonyms(prev => prev.map(s => s.id === id ? { ...s, synonyms: value } : s));
    };
    
    const handleTermChange = (id, value) => {
        setSynonyms(prev => prev.map(s => s.id === id ? { ...s, term: value } : s));
    };

    if (loading) {
        return <div className="flex justify-center items-center h-64"><Loader2 className="w-8 h-8 animate-spin" /></div>;
    }

    return (
        <div className="p-4 bg-slate-900/50 rounded-lg">
            <h3 className="text-xl font-bold text-white mb-4">Manage Keywords & Synonyms</h3>
            <div className="overflow-x-auto">
                <table className="min-w-full">
                    <thead className="bg-slate-800/50">
                        <tr>
                            <th className="p-3 text-left text-xs font-medium text-gray-400 uppercase">Term</th>
                            <th className="p-3 text-left text-xs font-medium text-gray-400 uppercase">Synonyms (comma-separated)</th>
                            <th className="p-3 text-right text-xs font-medium text-gray-400 uppercase">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-white/10">
                        {synonyms.map(s => (
                            <tr key={s.id}>
                                <td className="p-2"><Input value={s.term} onChange={(e) => handleTermChange(s.id, e.target.value)} className="bg-slate-800 border-gray-600" /></td>
                                <td className="p-2"><Input value={s.synonyms} onChange={(e) => handleSynonymChange(s.id, e.target.value)} className="bg-slate-800 border-gray-600" /></td>
                                <td className="p-2 text-right">
                                    <Button size="sm" variant="ghost" className="mr-2" onClick={() => handleUpdate(s.id, s.term, s.synonyms)}><Save size={16} /></Button>
                                    <Button size="sm" variant="destructive" onClick={() => handleDelete(s.id)}><Trash2 size={16} /></Button>
                                </td>
                            </tr>
                        ))}
                         <tr>
                            <td className="p-2"><Input placeholder="New term" value={newTerm} onChange={e => setNewTerm(e.target.value)} className="bg-slate-800 border-gray-600" /></td>
                            <td className="p-2"><Input placeholder="synonym1, synonym2" value={newSynonyms} onChange={e => setNewSynonyms(e.target.value)} className="bg-slate-800 border-gray-600" /></td>
                            <td className="p-2 text-right">
                                <Button size="sm" onClick={handleAdd}><Plus size={16} className="mr-1" /> Add</Button>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    );
};

export default KeywordsDashboard;
