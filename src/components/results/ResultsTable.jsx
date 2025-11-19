import React, { useState, useMemo, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { MapPin, Factory, Star } from 'lucide-react';
import CompanyRow from './CompanyRow';
import { calculateDistance } from '@/lib/location';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import MultiToggle from '@/components/ui/multi-toggle';
import { isAdmin as getIsAdmin } from '@/lib/auth';

function SortedPin() {
  return (
    <span className="inline-block ml-2 align-middle" title="sorted by this column" aria-label="sorted by this column">
      <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: 'rgb(101,188,200)' }} />
    </span>
  );
}

const ResultsTable = ({ companies, userLocation, onKeywordSearch, language, viewTranslated }) => {
  const [sortConfig, setSortConfig] = useState({ key: 'relevance_score', direction: 'descending' });
  const [expandedRows, setExpandedRows] = useState(new Set());
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 50;
  const isAdmin = getIsAdmin();

  const handleToggleRow = (id) => {
    const newSet = new Set(expandedRows);
    if (newSet.has(id)) newSet.delete(id); else newSet.add(id);
    setExpandedRows(newSet);
  };

  const withDerivedDistances = useMemo(() => {
    return companies.map((comp) => {
      const hq = comp.headquarters?.[0];
      const mfg = comp.manufacturing_sites || [];
      const hqDist = (hq && userLocation)
        ? calculateDistance(userLocation.latitude, userLocation.longitude, hq.latitude, hq.longitude)
        : Infinity;
      const mfgDist = (mfg.length > 0 && userLocation)
        ? Math.min(...mfg.map(loc => calculateDistance(userLocation.latitude, userLocation.longitude, loc.latitude, loc.longitude)))
        : Infinity;
      return { ...comp, _hqDist: hqDist, _mfgDist: mfgDist };
    });
  }, [companies, userLocation]);

  const sortedCompanies = useMemo(() => {
    const items = [...withDerivedDistances];
    if (!sortConfig.key) return items;

    items.sort((a, b) => {
      let aValue, bValue;
      if (sortConfig.key === 'hq_distance') { aValue = a._hqDist; bValue = b._hqDist; }
      else if (sortConfig.key === 'mfg_distance') { aValue = a._mfgDist; bValue = b._mfgDist; }
      else if (sortConfig.key === 'star_rating') { aValue = a.star_rating ?? -1; bValue = b.star_rating ?? -1; }
      else { aValue = a.relevance_score ?? -1; bValue = b.relevance_score ?? -1; }

      if (aValue < bValue) return sortConfig.direction === 'ascending' ? -1 : 1;
      if (aValue > bValue) return sortConfig.direction === 'ascending' ? 1 : -1;

      if (a._hqDist < b._hqDist) return -1;
      if (a._hqDist > b._hqDist) return 1;
      if (a._mfgDist < b._mfgDist) return -1;
      if (a._mfgDist > b._mfgDist) return 1;

      return 0;
    });

    return items;
  }, [withDerivedDistances, sortConfig]);

  useEffect(() => { setCurrentPage(1); }, [companies, sortConfig]);

  const paginatedCompanies = useMemo(() => {
    const indexOfLastItem = currentPage * itemsPerPage;
    const indexOfFirstItem = indexOfLastItem - itemsPerPage;
    return sortedCompanies.slice(indexOfFirstItem, indexOfLastItem);
  }, [sortedCompanies, currentPage]);

  const totalPages = Math.ceil(sortedCompanies.length / itemsPerPage);

  const sortKey = sortConfig.key;
  let dynamicOrder = ['star_rating', 'hq_distance', 'mfg_distance'];
  if (sortKey === 'star_rating') dynamicOrder = ['star_rating', 'hq_distance', 'mfg_distance'];
  else if (sortKey === 'hq_distance') dynamicOrder = ['hq_distance', 'mfg_distance', 'star_rating'];
  else if (sortKey === 'mfg_distance') dynamicOrder = ['mfg_distance', 'hq_distance', 'star_rating'];

  const headerLabel = { star_rating: 'Stars', hq_distance: 'Home', mfg_distance: 'Manufacturing' };
  const headerIcon  = { star_rating: <Star size={16} />, hq_distance: <MapPin size={16} />, mfg_distance: <Factory size={16} /> };

  const handleHeaderClick = (column) => {
    const direction = (column === 'star_rating') ? 'descending' : 'ascending';
    setSortConfig({ key: column, direction });
  };

  if (companies.length === 0) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
      <div className="md:hidden sticky top-4 z-10 p-2">
        <MultiToggle
          options={[
            { value: 'hq_distance', label: 'HQ', icon: <MapPin size={16} /> },
            { value: 'mfg_distance', label: 'Mfg', icon: <Factory size={16} /> },
            { value: 'star_rating', label: 'Stars', icon: <Star size={16} /> },
          ]}
          selected={sortKey}
          onSelect={(value) => setSortConfig({ key: value, direction: value === 'star_rating' ? 'descending' : 'ascending' })}
        />
      </div>

      <div className="hidden md:block overflow-x-auto">
        <table className="min-w-full table-fixed">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50/50 grid grid-cols-[minmax(0,_2fr)_96px_minmax(0,_1fr)_minmax(0,_1fr)_minmax(0,_1fr)] gap-6 px-4">
              <th className="p-4 text-left text-sm font-semibold text-gray-500 uppercase tracking-wider">Company</th>
              <th className="p-4 text-left text-sm font-semibold text-gray-500 uppercase tracking-wider">Logo</th>
              {dynamicOrder.map((col) => (
                <th
                  key={col}
                  onClick={() => handleHeaderClick(col)}
                  className="p-4 text-left text-sm font-semibold uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors rounded-md text-gray-600"
                >
                  <div className="flex items-center gap-2">
                    {headerIcon[col]}
                    <span>{headerLabel[col]}</span>
                    {sortKey === col && <SortedPin />}
                  </div>
                </th>
              ))}
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
                  dynamicOrder={dynamicOrder}
                  isAdmin={isAdmin}
                />
              ))}
            </AnimatePresence>
          </tbody>
        </table>
      </div>

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
              dynamicOrder={dynamicOrder}
              isAdmin={isAdmin}
            />
          ))}
        </AnimatePresence>
      </div>

      {totalPages > 1 && (
        <div className="flex justify-between items-center p-4 border-t border-gray-200">
          <span className="text-sm text-gray-500">Page {currentPage} of {totalPages}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))} disabled={currentPage === 1}>Previous</Button>
            <Button variant="outline" size="sm" onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))} disabled={currentPage === totalPages}>Next</Button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ResultsTable;
