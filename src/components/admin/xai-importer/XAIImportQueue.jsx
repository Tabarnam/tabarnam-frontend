
import React from 'react';
import { Button } from '@/components/ui/button';
import { RotateCcw, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/ui/use-toast';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const XAIImportQueue = ({ entries, onRetry }) => {
    const { toast } = useToast();

    return (
        <div className="bg-white/5 p-4 rounded-lg overflow-x-auto">
            <table className="min-w-full">
                <thead>
                    <tr>
                        <th className="p-3 text-left text-xs font-medium text-gray-400 uppercase">Company Name</th>
                        <th className="p-3 text-left text-xs font-medium text-gray-400 uppercase">URL</th>
                        <th className="p-3 text-left text-xs font-medium text-gray-400 uppercase">Status</th>
                        <th className="p-3 text-right text-xs font-medium text-gray-400 uppercase">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    {entries.map(entry => (
                        <tr key={entry.id} className="border-b border-white/10">
                            <td className="p-3 text-sm">{entry.company_name || 'N/A'}</td>
                            <td className="p-3 text-sm">{entry.url || 'N/A'}</td>
                            <td className="p-3 text-sm">
                                <span className={cn(`px-2 py-1 rounded-full text-xs font-semibold`,
                                    entry.status === 'Pending' && 'bg-yellow-500/20 text-yellow-300',
                                    entry.status === 'Success' && 'bg-green-500/20 text-green-300',
                                    entry.status === 'Error' && 'bg-red-500/20 text-red-300',
                                    entry.status === 'Skipped' && 'bg-blue-500/20 text-blue-300'
                                )}>{entry.status}</span>
                            </td>
                            <td className="p-3 text-right flex items-center justify-end gap-1">
                                {entry.status === 'Error' && (
                                    <Button onClick={() => onRetry(entry.id)} variant="ghost" size="sm" title="Retry">
                                        <RotateCcw className="h-4 w-4" />
                                    </Button>
                                )}
                                {entry.log && (
                                    <TooltipProvider>
                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => toast({ duration: 20000, title: `Log for ${entry.company_name || entry.url}`, description: <pre className="mt-2 w-[340px] rounded-md bg-slate-950 p-4"><code className="text-white">{JSON.stringify(entry.log, null, 2)}</code></pre> })}>
                                                    <Info className="h-4 w-4" />
                                                </Button>
                                            </TooltipTrigger>
                                            <TooltipContent>
                                                <p>View Log</p>
                                            </TooltipContent>
                                        </Tooltip>
                                    </TooltipProvider>
                                )}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};

export default XAIImportQueue;
