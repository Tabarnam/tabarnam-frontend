import React, { useState, useMemo, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { MapPin, Factory, Star, ChevronsRight, ChevronsLeft } from 'lucide-react';
import CompanyRow from './CompanyRow';
import { calculateDistance } from '@/lib/location';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import MultiToggle from '@/components/ui/multi-toggle';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';

const SortableHeader = ({ children, column, sortConfig, setSortConfig }) => {
    const isSorted = sortConfig.key === column;

    const handleClick = () => {
        const direction = (column === 'star_rating') ? 'descending' : 'ascending';
        setSortConfig({ key: column, direction });
    };

    return (
        <th 
            onClick={handleClick} 
            className={cn(
                "p-4 text-left text-sm font-semibold text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors first:rounded-tl-lg last:rounded-tr-lg", 
                { "bg-tabarnam-blue text-gray-700": isSorted }
            )}
        >
            <div className="flex items-center gap-2">
                {children}
                {isSorted && <MapPin size={16} className="text-gray-600" />}
            </div>
        </th>
    );
};

const ResultsTable = ({ companies, userLocation, onKeywordSearch, language, viewTranslated }) => {
    const [sortConfig, setSortConfig] = useState({ key: 'relevance_score', direction: 'descending' });
    const [expandedRows, setExpandedRows] = useState(new Set());
    const [currentPage, setCurrentPage] = useState(1);
    const itemsPerPage = 50;

    const handleToggleRow = (id) => {
        const newSet = new Set(expandedRows);
        if (newSet.has(id)) {
            newSet.delete(id);
        } else {
            newSet.add(id);
        }
        setExpandedRows(newSet);
    };

    const sortedCompanies = useMemo(() => {
        let sortableItems = [...companies];
        if (sortConfig.key) {
            sortableItems.sort((a, b) => {
                let aValue, bValue;

                const getHqDist = (comp) => {
                    const hq = comp.headquarters?.[0];
                    return hq && userLocation ? calculateDistance(userLocation.latitude, userLocation.longitude, hq.latitude, hq.longitude) : Infinity;
                };

                const getMfgDist = (comp) => {
                    const mfg = comp.manufacturing_sites || [];
                    return mfg.length > 0 && userLocation ? Math.min(...mfg.map(loc => calculateDistance(userLocation.latitude, userLocation.longitude, loc.latitude, loc.longitude))) : Infinity;
                };

                if (sortConfig.key === 'hq_distance') {
                    aValue = getHqDist(a);
                    bValue = getHqDist(b);
                } else if (sortConfig.key === 'mfg_distance') {
                    aValue = getMfgDist(a);
                    bValue = getMfgDist(b);
                } else if (sortConfig.key === 'star_rating') {
                    aValue = a.star_rating ?? -1;
                    bValue = b.star_rating ?? -1;
                } else { // relevance_score
                    aValue = a.relevance_score ?? -1;
                    bValue = b.relevance_score ?? -1;
                }

                if (aValue < bValue) return sortConfig.direction === 'ascending' ? -1 : 1;
                if (aValue > bValue) return sortConfig.direction === 'ascending' ? 1 : -1;
                
                // Tie-breaker: distance
                const distA = Math.min(getHqDist(a), getMfgDist(a));
                const distB = Math.min(getHqDist(b), getMfgDist(b));
                if (distA < distB) return -1;
                if (distA > distB) return 1;

                return 0;
            });
        }
        return sortableItems;
    }, [companies, sortConfig, userLocation]);

    useEffect(() => {
        setCurrentPage(1);
    }, [companies, sortConfig]);

    const paginatedCompanies = useMemo(() => {
        const indexOfLastItem = currentPage * itemsPerPage;
        const indexOfFirstItem = indexOfLastItem - itemsPerPage;
        return sortedCompanies.slice(indexOfFirstItem, indexOfLastItem);
    }, [sortedCompanies, currentPage]);

    const totalPages = Math.ceil(sortedCompanies.length / itemsPerPage);

    const headerOrder = useMemo(() => {
        const base = ['hq_distance', 'mfg_distance', 'star_rating'];
        const sortedKey = sortConfig.key;
        if (base.includes(sortedKey)) {
            return [sortedKey, ...base.filter(k => k !== sortedKey)];
        }
        return base;
    }, [sortConfig.key]);

    const headers = {
        'company': <th className="p-4 text-left text-sm font-semibold text-gray-500 uppercase tracking-wider w-[50%] rounded-tl-lg">Company</th>,
        'hq_distance': <SortableHeader column="hq_distance" sortConfig={sortConfig} setSortConfig={setSortConfig}><div className="flex items-center gap-1">Home/HQ</div></SortableHeader>,
        'mfg_distance': <SortableHeader column="mfg_distance" sortConfig={sortConfig} setSortConfig={setSortConfig}><div className="flex items-center gap-1">Manufacturing</div></SortableHeader>,
        'star_rating': <SortableHeader column="star_rating" sortConfig={sortConfig} setSortConfig={setSortConfig}><div className="flex items-center gap-1">Stars</div></SortableHeader>,
    };
    
    const sortOptions = [
        { value: 'hq_distance', label: 'HQ', icon: <MapPin size={16} /> },
        { value: 'mfg_distance', label: 'Mfg', icon: <Factory size={16} /> },
        { value: 'star_rating', label: 'Stars', icon: <Star size={16} /> },
    ];

    if (companies.length === 0) {
        return null; // Handled in ResultsPage
    }

    return (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
            {/* Mobile Floating Header */}
            <div className="md:hidden sticky top-4 z-10 p-2">
                <MultiToggle
                    options={sortOptions}
                    selected={sortConfig.key}
                    onSelect={(value) => setSortConfig({ key: value, direction: value === 'star_rating' ? 'descending' : 'ascending' })}
                />
            </div>

            {/* Desktop Table */}
            <div className="hidden md:block overflow-x-auto">
                <table className="min-w-full table-fixed">
                    <thead>
                        <tr className="border-b border-gray-200 bg-gray-50/50 grid grid-cols-[minmax(0,_2fr)_minmax(0,_1fr)_minmax(0,_1fr)_max-content] gap-6 px-4">
                            {/* Define column widths in the header */}
                            <th className="p-4 text-left text-sm font-semibold text-gray-500 uppercase tracking-wider">Company</th>
                            <th className="p-4 text-left text-sm font-semibold text-gray-500 uppercase tracking-wider">Home/HQ</th>
                            <th className="p-4 text-left text-sm font-semibold text-gray-500 uppercase tracking-wider">Manufacturing</th>
                            <th className="p-4 text-left text-sm font-semibold text-gray-500 uppercase tracking-wider w-32 text-right">Stars</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                        <AnimatePresence>
                            {paginatedCompanies.map((company, index) => (
                                <CompanyRow
                                    key={company.id}
                                    company={company}
                                    index={index}
                                    userLocation={userLocation}
                                    isExpanded={expandedRows.has(company.id)}
                                    onToggle={() => handleToggleRow(company.id)}
                                    onKeywordSearch={onKeywordSearch}
                                    language={language}
                                    viewTranslated={viewTranslated}
                                />
                            ))}
                        </AnimatePresence>
                    </tbody>
                </table>
            </div>

            {/* Mobile List */}
            <div className="md:hidden divide-y divide-gray-200">
                <AnimatePresence>
                    {paginatedCompanies.map((company, index) => (
                        <CompanyRow
                            key={company.id}
                            company={company}
                            index={index}
                            userLocation={userLocation}
                            isExpanded={expandedRows.has(company.id)}
                            onToggle={() => handleToggleRow(company.id)}
                            onKeywordSearch={onKeywordSearch}
                            language={language}
                            viewTranslated={viewTranslated}
                        />
                    ))}
                </AnimatePresence>
            </div>

            {totalPages > 1 && (
                <div className="flex justify-between items-center p-4 border-t border-gray-200">
                    <span className="text-sm text-gray-500">
                        Page {currentPage} of {totalPages}
                    </span>
                    <div className="flex gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                            disabled={currentPage === 1}
                        >
                            <ChevronsLeft className="h-4 w-4 mr-1 md:mr-0" /> <span className="hidden md:inline">Previous</span>
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
                            disabled={currentPage === totalPages}
                        >
                            <span className="hidden md:inline">Next</span> <ChevronsRight className="h-4 w-4 ml-1 md:ml-0" />
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
};

export default ResultsTable;