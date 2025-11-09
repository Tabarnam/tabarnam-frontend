import React, { useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useToast } from '@/components/ui/use-toast';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Loader2, Wand2 } from 'lucide-react';
import { logError } from '@/lib/errorLogger';
// Supabase removed

const XAIImportModal = ({ isOpen, onClose, onSuccess }) => {
    const { toast } = useToast();
    const [query, setQuery] = useState('');
    const [isImporting, setIsImporting] = useState(false);

    const handleImport = async () => {
        if (!query.trim()) {
            toast({ variant: 'destructive', title: 'Query is empty', description: 'Please enter a query to import companies.' });
            return;
        }
        setIsImporting(true);

        try {
            const headers = await getFunctionHeaders();
            const body = {
                queryType: 'product_keyword',
                query: query,
                dryRun: false, 
                forceOverwrite: false,
            };

            // Supabase removed - using Azure Functions instead
            console.log('XAI import stub - Supabase removed');
            const data = { error: 'XAI import functionality disabled - Supabase removed.' };

            if (error) {
                throw new Error(`Edge function invocation failed: ${error.message}`);
            }

            if (data.error) {
                throw new Error(`Import process failed: ${data.error}`);
            }

            const result = data.results?.[0];
            if (!result) {
                throw new Error("Invalid response from the import function.");
            }

            if (result.status === 'Success' && result.company) {
                 const companyName = result.company.name || "the company";
                toast({
                    title: "Import Complete",
                    description: `Successfully imported "${companyName}".`
                });
                onSuccess();
                onClose();
            } else if (result.status === 'Skipped') {
                toast({
                    title: "Import Skipped",
                    description: `Company "${result.company.name}" already exists. Use bulk import with 'Force Overwrite' to update.`
                });
                onClose();
            }
            else {
                const failureReason = result?.log?.find(l => l.status === 'error')?.message || 'The AI could not find a relevant company or the data failed validation.';
                throw new Error(failureReason);
            }

        } catch (error) {
            toast({ variant: 'destructive', title: 'Import Failed', description: error.message });
            await logError({
                type: 'xAI Import',
                field_name: 'xAI Modal',
                message: `xAI import failed for query "${query}": ${error.message}`,
            });
        } finally {
            setIsImporting(false);
        }
    };

    return (
        <AnimatePresence>
            {isOpen && (
                <Dialog open={isOpen} onOpenChange={onClose}>
                    <DialogContent className="bg-slate-900 border-purple-500 text-white sm:max-w-[500px]">
                        <DialogHeader>
                            <DialogTitle className="text-2xl text-purple-400 flex items-center gap-2">
                                <Wand2 /> Import from xAI
                            </DialogTitle>
                            <DialogDescription className="text-gray-400">
                                Enter a natural language query to find and import a single company. For example, "light switch manufacturers in the USA".
                            </DialogDescription>
                        </DialogHeader>
                        
                        <div className="py-4">
                            <label htmlFor="xai-query" className="form-label">Query</label>
                            <textarea
                                id="xai-query"
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder="e.g., sustainable clothing brands in California"
                                className="form-input"
                                rows="3"
                            />
                        </div>

                        <DialogFooter>
                            <Button type="button" variant="outline" onClick={onClose} className="text-white border-white/20 hover:bg-white/10">Cancel</Button>
                            <Button onClick={handleImport} disabled={isImporting} className="bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 text-white">
                                {isImporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wand2 className="mr-2 h-4 w-4" />}
                                {isImporting ? 'Importing...' : 'Start Import'}
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            )}
        </AnimatePresence>
    );
};

export default XAIImportModal;
