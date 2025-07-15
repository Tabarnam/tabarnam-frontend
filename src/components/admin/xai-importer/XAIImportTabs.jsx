
import React from 'react';
import { Button } from '@/components/ui/button';
import { List, Package, MapPin } from 'lucide-react';

const TABS = [
    { id: 'company_list', label: 'Company List', icon: List },
    { id: 'product_keyword', label: 'Product Keyword', icon: Package },
    { id: 'location_search', label: 'Location Search', icon: MapPin }
];

const XAIImportTabs = ({ queryType, setQueryType }) => (
    <div className="bg-slate-800 p-4 rounded-lg mb-8">
        <div className="flex justify-center gap-2">
            {TABS.map(item => (
                <Button key={item.id} variant={queryType === item.id ? 'secondary' : 'ghost'} onClick={() => setQueryType(item.id)} className="flex-1">
                    <item.icon className="mr-2 h-4 w-4" />
                    {item.label}
                </Button>
            ))}
        </div>
    </div>
);

export default XAIImportTabs;
