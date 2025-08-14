import React, { useState, useEffect } from 'react';
import { supabase } from '@/lib/customSupabaseClient';
import { useToast } from '@/components/ui/use-toast';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Loader2, PlusCircle, MinusCircle } from 'lucide-react';
import MultiSelectChip from './form-elements/MultiSelectChip';
import KeywordInput from './form-elements/KeywordInput';
import { logError } from '@/lib/errorLogger';

const BulkEditModal = ({ isOpen, onClose, onSuccess, companies }) => {
    const { toast } = useToast();
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Industries
    const [allIndustries, setAllIndustries] = useState([]);
    const [industriesToAdd, setIndustriesToAdd] = useState([]);
    const [industriesToRemove, setIndustriesToRemove] = useState([]);
    
    // Keywords
    const [allKeywords, setAllKeywords] = useState([]);
    const [keywordsToAdd, setKeywordsToAdd] = useState([]);
    const [keywordsToRemove, setKeywordsToRemove] = useState([]);
    const [newKeyword, setNewKeyword] = useState('');
    
    const companyCount = companies.length;

    useEffect(() => {
        const fetchDropdownData = async () => {
            const { data: industriesData } = await supabase.from('industries').select('id, name');
            setAllIndustries(industriesData || []);
            
            const { data: keywordsData } = await supabase.from('product_keywords').select('id, keyword');
            setAllKeywords(keywordsData || []);
        };
        
        if (isOpen) {
            fetchDropdownData();
            // Reset state on open
            setIndustriesToAdd([]);
            setIndustriesToRemove([]);
            setKeywordsToAdd([]);
            setKeywordsToRemove([]);
        }
    }, [isOpen]);
    
    const handleKeywordAdd = async () => {
        if (newKeyword.trim() === '') return;
        let { data: existing } = await supabase.from('product_keywords').select('id').ilike('keyword', newKeyword.trim()).single();

        if (!existing) {
            const { data, error } = await supabase.from('product_keywords').insert({ keyword: newKeyword.trim() }).select().single();
            if (error) { toast({ variant: "destructive", title: "Error", description: error.message }); return; }
            existing = data;
            setAllKeywords(prev => [...prev, existing]);
        }
        
        if (!keywordsToAdd.includes(existing.id)) {
            setKeywordsToAdd(prev => [...prev, existing.id]);
        }
        setNewKeyword('');
    };

    const handleSubmit = async () => {
        setIsSubmitting(true);
        const companyIds = companies.map(c => c.id);

        try {
            const { error } = await supabase.rpc('bulk_edit_companies', {
                p_company_ids: companyIds,
                p_industries_to_add: industriesToAdd,
                p_industries_to_remove: industriesToRemove,
                p_keywords_to_add: keywordsToAdd,
                p_keywords_to_remove: keywordsToRemove
            });

            if (error) throw error;

            toast({ title: "Bulk Edit Successful", description: `Updated ${companyCount} companies.` });
            onSuccess();

        } catch (error) {
            toast({ variant: "destructive", title: "Bulk Edit Failed", description: error.message });
            logError({ type: 'Bulk Edit', message: error.message });
        } finally {
            setIsSubmitting(false);
        }
    };


    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="bg-slate-900 border-purple-500 text-white sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle className="text-2xl text-purple-400">Bulk Edit {companyCount} Companies</DialogTitle>
                    <DialogDescription className="text-gray-400">
                        Add or remove industries and keywords for the selected companies. Changes are final.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-6 py-4">
                    <div>
                        <h3 className="form-label font-semibold mb-2 flex items-center gap-2"><PlusCircle className="text-green-500" />Add to all selected</h3>
                        <div className="space-y-4 p-4 rounded-lg bg-slate-800/50">
                            <MultiSelectChip label="Industries to Add" options={allIndustries} selected={industriesToAdd} setSelected={setIndustriesToAdd} displayField="name" />
                             <KeywordInput label="Keywords to Add" options={allKeywords} selected={keywordsToAdd} setSelected={setKeywordsToAdd} newKeyword={newKeyword} setNewKeyword={setNewKeyword} onAdd={handleKeywordAdd} />
                        </div>
                    </div>
                     <div>
                        <h3 className="form-label font-semibold mb-2 flex items-center gap-2"><MinusCircle className="text-red-500" />Remove from all selected</h3>
                         <div className="space-y-4 p-4 rounded-lg bg-slate-800/50">
                            <MultiSelectChip label="Industries to Remove" options={allIndustries} selected={industriesToRemove} setSelected={setIndustriesToRemove} displayField="name" />
                            <MultiSelectChip label="Keywords to Remove" options={allKeywords} selected={keywordsToRemove} setSelected={setKeywordsToRemove} displayField="keyword" />
                        </div>
                    </div>
                </div>

                <DialogFooter>
                    <Button type="button" variant="outline" onClick={onClose} className="text-white border-white/20 hover:bg-white/10">Cancel</Button>
                    <Button onClick={handleSubmit} disabled={isSubmitting} className="bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white">
                        {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Apply Changes
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

export default BulkEditModal;