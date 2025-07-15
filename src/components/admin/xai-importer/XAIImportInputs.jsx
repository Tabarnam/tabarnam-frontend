
import React, { useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import Papa from 'papaparse';
import { useToast } from '@/components/ui/use-toast';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { UploadCloud } from 'lucide-react';
import { cn } from '@/lib/utils';

const XAIImportInputs = ({ queryType, isLoading, setIsLoading, setEntries, manualInput, setManualInput, discoveryQuery, setDiscoveryQuery }) => {
    const { toast } = useToast();

    const onDrop = useCallback((acceptedFiles) => {
        setIsLoading(true);
        const file = acceptedFiles[0];
        Papa.parse(file, {
            header: true,
            skipEmptyLines: true,
            complete: (results) => {
                const parsedEntries = results.data.map((row, index) => ({
                    id: `${Date.now()}-${index}`,
                    company_name: row.company_name || '',
                    url: row.url || '',
                    status: 'Pending',
                    log: null
                }));
                setEntries(parsedEntries);
                setIsLoading(false);
            },
            error: (error) => {
                toast({ variant: 'destructive', title: 'CSV Parse Error', description: error.message });
                setIsLoading(false);
            }
        });
    }, [toast, setIsLoading, setEntries]);

    const handleManualSubmit = () => {
        const lines = manualInput.split('\n').filter(line => line.trim() !== '');
        const parsedEntries = lines.map((line, index) => {
            const isUrl = line.startsWith('http://') || line.startsWith('https://');
            return {
                id: `${Date.now()}-manual-${index}`,
                company_name: isUrl ? '' : line.trim(),
                url: isUrl ? line.trim() : '',
                status: 'Pending',
                log: null
            };
        });
        setEntries(parsedEntries);
        setManualInput('');
    };

    const { getRootProps, getInputProps, isDragActive } = useDropzone({
        onDrop,
        accept: { 'text/csv': ['.csv'] },
        multiple: false,
        disabled: queryType !== 'company_list'
    });

    switch (queryType) {
        case 'product_keyword':
            return (
                <div className="bg-slate-800/50 p-6 rounded-lg">
                    <h3 className="text-lg font-semibold mb-2">Product/Keyword Discovery</h3>
                    <Input
                        placeholder="Enter product or category, e.g., 'natural deodorant'"
                        className="bg-slate-800 border-gray-600 text-white"
                        value={discoveryQuery}
                        onChange={(e) => setDiscoveryQuery(e.target.value)}
                    />
                    <p className="text-xs text-gray-400 mt-2">xAI will search for a single prominent manufacturer of this product.</p>
                </div>
            );
        case 'location_search':
            return (
                <div className="bg-slate-800/50 p-6 rounded-lg">
                    <h3 className="text-lg font-semibold mb-2">Location-Based Discovery</h3>
                    <Input
                        placeholder="Enter City, State or Postal Code, e.g., 'San Dimas, CA'"
                        className="bg-slate-800 border-gray-600 text-white"
                        value={discoveryQuery}
                        onChange={(e) => setDiscoveryQuery(e.target.value)}
                    />
                    <p className="text-xs text-gray-400 mt-2">xAI will search for a single prominent company in this location.</p>
                </div>
            );
        case 'company_list':
        default:
            return (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    <div
                        {...getRootProps()}
                        className={cn(`p-8 border-2 border-dashed rounded-lg flex flex-col items-center justify-center transition-colors cursor-pointer`,
                        isDragActive ? 'border-purple-500 bg-purple-900/20' : 'border-gray-600 hover:border-purple-500')}
                    >
                        <input {...getInputProps()} />
                        <UploadCloud className="w-12 h-12 text-gray-400 mb-4" />
                        {isLoading ? (
                            <p className="text-lg text-white">Parsing CSV...</p>
                        ) : isDragActive ? (
                            <p className="text-lg text-purple-300">Drop the CSV file here...</p>
                        ) : (
                            <p className="text-lg text-white">Drag & drop a .csv file here, or click to select</p>
                        )}
                        <p className="text-sm text-gray-500 mt-2">Headers: company_name, url (optional)</p>
                    </div>

                    <div className="flex flex-col">
                        <Textarea
                            placeholder="Or paste company names or URLs, one per line..."
                            className="bg-slate-800 border-gray-600 text-white flex-grow mb-4"
                            rows={8}
                            value={manualInput}
                            onChange={(e) => setManualInput(e.target.value)}
                        />
                        <Button onClick={handleManualSubmit} className="self-end">Submit Manual Entries</Button>
                    </div>
                </div>
            );
    }
};

export default XAIImportInputs;
