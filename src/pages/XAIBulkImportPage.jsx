import React, { useState } from 'react';

export default function XAIBulkImportPage() {
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState('');
  const [allCompanies, setAllCompanies] = useState([]);
  const [filter, setFilter] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
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
          <div className="flex items-center gap-3 mt-6">
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
