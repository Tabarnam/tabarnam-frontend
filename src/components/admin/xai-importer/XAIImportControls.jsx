
import React from 'react';
import { Button } from '@/components/ui/button';
import { Loader2, Wand2 } from 'lucide-react';

const XAIImportControls = ({ queryType, entries, discoveryQuery, isProcessing, forceOverwrite, setForceOverwrite, dryRun, setDryRun, onImport }) => (
    <div className="flex justify-between items-center mb-4">
        <h2 className="text-2xl font-bold">
            {queryType === 'company_list' ? `Import Queue (${entries.length})` : 'Discovery Settings'}
        </h2>
        <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
                <input type="checkbox" id="forceOverwrite" checked={forceOverwrite} onChange={(e) => setForceOverwrite(e.target.checked)} className="h-4 w-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500" />
                <label htmlFor="forceOverwrite" className="text-sm">Force Overwrite</label>
            </div>
            <div className="flex items-center gap-2">
                <input type="checkbox" id="dryRun" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} className="h-4 w-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500" />
                <label htmlFor="dryRun" className="text-sm">Dry Run Mode</label>
            </div>
            <Button onClick={onImport} disabled={isProcessing || (queryType !== 'company_list' && !discoveryQuery) || (queryType === 'company_list' && entries.length === 0)}>
                {isProcessing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wand2 className="mr-2 h-4 w-4" />}
                {queryType === 'company_list' ? 'Run Bulk Import' : 'Start Discovery'}
            </Button>
        </div>
    </div>
);

export default XAIImportControls;
