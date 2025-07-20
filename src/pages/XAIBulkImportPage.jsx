import React, { useState } from 'react';

export default function XAIBulkImportPage() {
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState('');
  const [allCompanies, setAllCompanies] = useState([]);
  const [filter, setFilter] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [expandedIndex, setExpandedIndex] = useState(null);
  const itemsPerPage = 20;

  const handleImport = async () => {
    setStatus('Importing...');
    try {
      const res = await fetch('/api/xai/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: keyword }),
      });

      const data = await res.json();
      if (res.ok) {
        setAllCompanies((prev) => [...prev, ...data.companies]);
        setStatus(`✅ Imported ${data.companies.length} companies`);
        setCurrentPage(1);
      } else {
        setStatus(`❌ Error: ${data.error || data.message}`);
      }
    } catch (e) {
      console.error(e);
      setStatus(`❌ Error: ${e.message}`);
    }
  };

  const filteredCompanies = allCompanies.filter((c) => {
    const nameMatch = c.company_name?.toLowerCase().includes(filter.toLowerCase());
    const industryMatch = c.industries?.some((i) => i.toLowerCase().includes(filter.toLowerCase()));
    return nameMatch || industryMatch;
  });

  const paginatedCompanies = filteredCompanies.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  const handleCopy = async () => {
    const lines = filteredCompanies.map((c, i) => `${i + 1}. ${c.company_name} — ${c.industries?.join(', ')}`);
    await navigator.clipboard.writeText(lines.join('\n'));
    setStatus('✅ Copied to clipboard!');
  };

  const handleExportCSV = () => {
    const headers = Object.keys(filteredCompanies[0] || {});
    const rows = filteredCompanies.map(company =>
      headers.map(field => {
        const val = company[field];
        if (Array.isArray(val)) return `"${val.join(';')}"`;
        if (typeof val === 'object') return `"${JSON.stringify(val)}"`;
        return `"${String(val ?? '')}"`;
      }).join(',')
    );
    const csvContent = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `companies_export_${Date.now()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const totalPages = Math.ceil(filteredCompanies.length / itemsPerPage);

  return (
    <div className="min-h-screen p-6 space-y-6 bg-gray-50">
      <h1 className="text-3xl font-bold">Bulk Company Import</h1>

      <input
        type="text"
        placeholder="Enter search keyword"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && handleImport()}
        className="p-2 border rounded w-full"
      />

      <button
        onClick={handleImport}
        className="px-4 py-2 bg-blue-600 text-white rounded mt-2"
      >
        Start Import
      </button>

      {status && <div className="mt-4 text-gray-700 whitespace-pre-wrap">{status}</div>}

      {allCompanies.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-3 mt-6">
            <input
              type="text"
              placeholder="Filter by name or industry..."
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setCurrentPage(1);
              }}
              className="p-2 border rounded w-full max-w-md"
            />
            <button
              onClick={handleCopy}
              className="px-3 py-2 text-sm bg-green-600 text-white rounded"
            >
              Copy All
            </button>
            <button
              onClick={handleExportCSV}
              className="px-3 py-2 text-sm bg-yellow-600 text-white rounded"
            >
              Export CSV
            </button>
            <button
              onClick={() => {
                setAllCompanies([]);
                setFilter('');
                setCurrentPage(1);
              }}
              className="px-3 py-2 text-sm bg-red-600 text-white rounded"
            >
              Clear List
            </button>
          </div>

          <div className="max-h-[30rem] overflow-y-auto bg-white p-4 border rounded shadow text-sm mt-4">
            {paginatedCompanies.map((company, index) => {
              const isRed = company.red_flag === true;
              const listIndex = (currentPage - 1) * itemsPerPage + index + 1;
              const isExpanded = expandedIndex === listIndex;

              return (
                <div
                  key={index}
                  className={`mb-2 p-2 rounded cursor-pointer border ${isRed ? 'bg-red-100 border-red-300' : 'hover:bg-gray-100'}`}
                  onClick={() => setExpandedIndex(isExpanded ? null : listIndex)}
                >
                  <div>
                    <strong>{listIndex}.</strong> {company.company_name} — {company.industries?.join(', ')}
                    {isRed && <span className="ml-2 text-red-600 font-semibold">⚠ red_flag</span>}
                  </div>
                  {isExpanded && (
                    <pre className="mt-2 text-xs bg-gray-50 p-2 border rounded overflow-x-auto">
                      {JSON.stringify(company, null, 2)}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>

          {/* Pagination Controls */}
          {totalPages > 1 && (
            <div className="mt-4 flex items-center gap-2 text-sm">
              <button
                disabled={currentPage === 1}
                onClick={() => setCurrentPage((p) => p - 1)}
                className="px-2 py-1 bg-gray-300 rounded disabled:opacity-50"
              >
                Prev
              </button>
              <span>Page {currentPage} of {totalPages}</span>
              <button
                disabled={currentPage === totalPages}
                onClick={() => setCurrentPage((p) => p + 1)}
                className="px-2 py-1 bg-gray-300 rounded disabled:opacity-50"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
