
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';
import XAIImportHeader from '@/components/admin/xai-importer/XAIImportHeader';
import XAIImportTabs from '@/components/admin/xai-importer/XAIImportTabs';
import XAIImportInputs from '@/components/admin/xai-importer/XAIImportInputs';
import XAIImportControls from '@/components/admin/xai-importer/XAIImportControls';
import XAIImportQueue from '@/components/admin/xai-importer/XAIImportQueue';
import { useXAIImporter } from '@/hooks/useXAIImporter';

const XAIBulkImportPage = () => {
    const {
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
    } = useXAIImporter();

    return (
        <div className="min-h-screen bg-slate-900 text-white p-4 sm:p-6 lg:p-8">
            <div className="max-w-screen-xl mx-auto">
                <header className="flex items-center justify-between mb-8">
                    <div className="flex items-center gap-4">
                        <Link to="/admin">
                            <Button variant="outline" size="icon" className="text-white border-white/20 hover:bg-white/10">
                                <ArrowLeft className="h-4 w-4" />
                            </Button>
                        </Link>
                        <XAIImportHeader />
                    </div>
                </header>

                <XAIImportTabs queryType={queryType} setQueryType={setQueryType} />

                <div className="mb-8">
                    <XAIImportInputs
                        queryType={queryType}
                        isLoading={isLoading}
                        setIsLoading={setIsLoading}
                        setEntries={setEntries}
                        manualInput={manualInput}
                        setManualInput={setManualInput}
                        discoveryQuery={discoveryQuery}
                        setDiscoveryQuery={setDiscoveryQuery}
                    />
                </div>

                <XAIImportControls
                    queryType={queryType}
                    entries={entries}
                    discoveryQuery={discoveryQuery}
                    isProcessing={isProcessing}
                    forceOverwrite={forceOverwrite}
                    setForceOverwrite={setForceOverwrite}
                    dryRun={dryRun}
                    setDryRun={setDryRun}
                    onImport={handleBulkImport}
                />

                {(queryType === 'company_list' || entries.length > 0) && (
                    <XAIImportQueue entries={entries} onRetry={handleRetry} />
                )}
            </div>
        </div>
    );
};

export default XAIBulkImportPage;
