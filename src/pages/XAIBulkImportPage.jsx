import React, { useState } from 'react';

export default function XAIBulkImportPage() {
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState('');

  const handleImport = async () => {
    setStatus('Importing...');

    try {
      const res = await fetch('/api/xai/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: keyword }),
      });

      if (res.ok) {
        setStatus('✅ Import succeeded!');
      } else {
        const error = await res.json();
        setStatus(`❌ Error: ${error.error}`);
      }
    } catch (e) {
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
      <div className="mt-4 text-gray-700">{status}</div>
    </div>
  );
}
