import React, { useState } from 'react';

export default function BulkImportPage() {
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState('');
  const [importedCompanies, setImportedCompanies] = useState([]);

  const handleImport = async () => {
    setStatus('Loading...');
    const res = await fetch('/api/xai/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: keyword }),
    });

    const json = await res.json();
    if (json.error) {
      setStatus('Error: ' + json.error);
      return;
    }

    setStatus(`✅ Imported ${json.total_returned} companies.`);
    setImportedCompanies((prev) => [...prev, ...json.companies]);
  };

  return (
    <div className="min-h-screen p-6 space-y-6 bg-gray-50">
      <h1 className="text-3xl font-bold">Bulk Company Import</h1>

      <input
        type="text"
        className="p-2 border rounded w-full"
        placeholder="Enter search keyword"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
      />

      <button
        className="px-4 py-2 bg-blue-600 text-white rounded"
        onClick={handleImport}
      >
        Start Import
      </button>

      <div className="mt-4 text-gray-700 whitespace-pre-wrap">{status}</div>

      {importedCompanies.length > 0 && (
        <div className="mt-6">
          <h2 className="text-xl font-semibold mb-2">Imported Companies</h2>
          <div className="max-h-96 overflow-y-auto bg-white p-4 border rounded shadow text-sm">
            {importedCompanies.map((company, index) => (
              <div key={index} className="mb-2">
                {index + 1}. {company.company_name} — {company.industries?.join(', ')}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
