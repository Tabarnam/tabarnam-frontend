import React, { useState } from 'react';

export default function XAIBulkImportPage() {
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState('');
  const [resultCount, setResultCount] = useState(null);

  const handleImport = async () => {
    setStatus('Importing...');
    setResultCount(null);

    try {
      const res = await fetch('/api/xai/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: keyword }),
      });

      if (res.ok) {
        const data = await res.json();
        setResultCount(data?.companies?.length || 0);
        setStatus(`✅ Import succeeded: ${data.companies.length} companies returned`);
      } else {
        let errorMsg = 'Unknown error';
        try {
          const error = await res.json();
          errorMsg = error.error || error.message || errorMsg;
        } catch {
          errorMsg = `HTTP ${res.status}`;
        }
        setStatus(`❌ Error: ${errorMsg}`);
      }
    } catch (e) {
      console.error('IMPORT CATCH ERROR:', e);
      setStatus(`❌ Error: ${e.message}`);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-3xl font-bold">XAI Bulk Import</h1>
      <input
        type="text"
        placeholder="Enter search keyword"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        className="p-2 border rounded w-full"
      />
      <button
        onClick={handleImport}
        className="px-4 py-2 bg-blue-600 text-white rounded"
      >
        Start Import
      </button>
      <div className="mt-4 text-gray-700 whitespace-pre-wrap">
        {status}
        {resultCount !== null && resultCount > 0 && (
          <p className="mt-2 text-sm text-green-700">
            ✅ {resultCount} companies processed successfully.
          </p>
        )}
      </div>
    </div>
  );
}
