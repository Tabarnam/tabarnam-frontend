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
    setAllCompanies([]);
    setCurrentPage(1);

    try {
      let combinedCompanies = [];
      let loopCount = 0;
      const maxLoops = 10;

      while (loopCount < maxLoops) {
        setStatus(`Importing batch ${loopCount + 1}...`);

        const res = await fetch('https://qiqfjqegxnrivayvliba.supabase.co/functions/v1/xai-bulk-importer', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query: keyword }),
        });

        const data = await res.json();

        if (!res.ok || !Array.isArray(data.companies)) {
          setStatus(`❌ Error: ${data.error || data.message || 'Unknown error'}`);
          break;
        }

        const newCompanies = data.companies.filter(
          (c) => !combinedCompanies.some((e) => e.company_name === c.company_name)
        );

        combinedCompanies = [...combinedCompanies, ...newCompanies];
        setAllCompanies(combinedCompanies);
        setCurrentPage(1);

        if (data.warning || newCompanies.length < 10 || combinedCompanies.length >= 100) {
          if (combinedCompanies.length < 25) {
            setStatus(`⚠️ Only ${combinedCompanies.length} companies found. Try a broader search.`);
          } else {
            setStatus(`✅ Imported ${combinedCompanies.length} companies`);
          }
          break;
        }

        loopCount++;
      }
    } catch (err) {
      console.error(err);
      setStatus(`❌ Error: ${err.message}`);
    }
  };

  const handleClear = () => {
    setAllCompanies([]);
    setStatus('');
    setKeyword('');
    setCurrentPage(1);
    setExpandedIndex(null);
  };

  const filteredCompanies = allCompanies.filter((company) => {
    const nameMatch = company.company_name?.toLowerCase().includes(filter.toLowerCase());
    const industryMatch = company.industries?.some((i) =>
      i.toLowerCase().includes(filter.toLowerCase())
    );
    return nameMatch || industryMatch;
  });

  const paginatedCompanies = filteredCompanies.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h1 className="text-3xl font-bold mb-4">Bulk Company Import</h1>

      <input
        type="text"
        placeholder="Enter a keyword to search..."
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        className="w-full border rounded px-3 py-2 mb-3"
      />

      <button
        onClick={handleImport}
        className="bg-blue-600 text-white rounded px-4 py-2 mb-4"
      >
        Start Import
      </button>

      {status && <p className="mb-3">{status}</p>}

      {allCompanies.length > 0 && (
        <>
          <input
            type="text"
            placeholder="Filter by name or industry..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-full border rounded px-3 py-2 mb-3"
          />

          <div className="flex gap-2 mb-3">
            <button
              onClick={() =>
                navigator.clipboard.writeText(JSON.stringify(filteredCompanies, null, 2))
              }
              className="bg-green-600 text-white rounded px-3 py-2"
            >
              Copy All
            </button>
            <button
              onClick={() => {
                const blob = new Blob([JSON.stringify(filteredCompanies, null, 2)], {
                  type: 'text/json',
                });
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'companies.json';
                a.click();
                window.URL.revokeObjectURL(url);
              }}
              className="bg-yellow-600 text-white rounded px-3 py-2"
            >
              Export JSON
            </button>
            <button
              onClick={handleClear}
              className="bg-red-600 text-white rounded px-3 py-2"
            >
              Clear List
            </button>
          </div>

          <ul className="space-y-2">
            {paginatedCompanies.map((c, idx) => (
              <li
                key={idx}
                className="border rounded p-3 cursor-pointer"
                onClick={() => setExpandedIndex(expandedIndex === idx ? null : idx)}
              >
                <strong>
                  {(currentPage - 1) * itemsPerPage + idx + 1}. {c.company_name}
                </strong>{' '}
                — {c.industries?.join(', ') || 'N/A'}

                {expandedIndex === idx && (
                  <div className="mt-2 text-sm text-gray-700">
                    <p>
                      <strong>Tagline:</strong> {c.company_tagline}
                    </p>
                    <p>
                      <strong>Email:</strong> {c.email_address}
                    </p>
                    <p>
                      <strong>Website:</strong>{' '}
                      <a href={c.url} target="_blank" rel="noreferrer">
                        {c.url}
                      </a>
                    </p>
                    <p>
                      <strong>Keywords:</strong> {c.product_keywords}
                    </p>
                    <p>
                      <strong>HQ:</strong> {c.headquarters_location}
                    </p>
                    <p>
                      <strong>Manufacturing:</strong>{' '}
                      {c.manufacturing_locations?.join(', ') || 'N/A'}
                    </p>
                    <p>
                      <strong>Red Flag:</strong> {c.red_flag ? '🚩 Yes' : 'No'}
                    </p>

                    {Array.isArray(c.reviews) && c.reviews.length > 0 && (
                      <div className="mt-2">
                        <strong>Reviews:</strong>
                        <ul className="list-disc list-inside">
                          {c.reviews.map((r, i) => (
                            <li key={i}>
                              <a href={r.url} target="_blank" rel="noreferrer">
                                [{r.source}] {r.abstract}
                              </a>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>

          {filteredCompanies.length > itemsPerPage && (
            <div className="mt-4 flex gap-3">
              <button
                disabled={currentPage === 1}
                onClick={() => setCurrentPage((prev) => prev - 1)}
                className="px-3 py-1 border rounded"
              >
                Prev
              </button>
              <button
                disabled={currentPage * itemsPerPage >= filteredCompanies.length}
                onClick={() => setCurrentPage((prev) => prev + 1)}
                className="px-3 py-1 border rounded"
              >
                Next
              </button>
              <span className="text-sm pt-2">
                Page {currentPage} of {Math.ceil(filteredCompanies.length / itemsPerPage)}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

