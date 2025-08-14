// src/pages/XAIBulkImportPage.jsx
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom'; // For navigation

console.log('Deploy test');

export default function XAIBulkImportPage() {
  const [maxImports, setMaxImports] = useState(1);
  const [searchField, setSearchField] = useState('product_keywords');
  const [searchValue, setSearchValue] = useState('');
  const [status, setStatus] = useState('');
  const [allCompanies, setAllCompanies] = useState([]);
  const [filter, setFilter] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [expandedIndex, setExpandedIndex] = useState(null);
  const [isImporting, setIsImporting] = useState(false);
  const [notes, setNotes] = useState(''); // New state for notes
  const itemsPerPage = 20;
  const navigate = useNavigate(); // For clickable navigation

  // Check user role (assuming a context or prop provides this)
  const userRole = 'admin'; // Replace with actual role from context (e.g., useUserRole())

  useEffect(() => {
    const hasLogged = sessionStorage.getItem('keyLogged');
    if (!hasLogged) {
      console.log("ENV CHECK (once on mount):", { VITE_FUNCTION_KEY: import.meta.env.VITE_FUNCTION_KEY });
      sessionStorage.setItem('keyLogged', 'true');
    }
  }, []);

  useEffect(() => {
    if (isImporting && searchValue.trim()) {
      const importData = async () => {
        setStatus('Importing...');
        setAllCompanies([]);
        setCurrentPage(1);

        const functionKey = import.meta.env.VITE_FUNCTION_KEY;
        if (!functionKey) {
          setStatus('❌ Missing VITE_FUNCTION_KEY. Set it in your environment variables.');
          setIsImporting(false);
          return;
        }
        const apiUrl = `https://tabarnam-xai-dedicated-b4a0gdchamaeb8cp.canadacentral-01.azurewebsites.net/xai?code=${functionKey}`;
        try {
          const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ maxImports, search: { [searchField]: searchValue } }),
          });

          if (!response.ok) {
            const errorText = await response.text();
            console.error('Fetch error:', response.status, errorText);
            setStatus(`❌ Error: ${response.statusText} - ${errorText || 'Network issue'}`);
            return;
          }

          const data = await response.json();
          if (!Array.isArray(data.companies)) {
            setStatus('❌ Invalid response format from server');
            return;
          }

          const newCompanies = data.companies.filter(
            (c) => !allCompanies.some((e) => e.company_name === c.company_name)
          );
          const combinedCompanies = [...allCompanies, ...newCompanies];
          setAllCompanies(combinedCompanies);

          if (newCompanies.length < maxImports) {
            setStatus(`✅ Imported ${combinedCompanies.length} companies (exhaustive)`);
          } else if (combinedCompanies.length >= 200) {
            setStatus(`✅ Imported ${combinedCompanies.length} companies (max reached)`);
          } else {
            setStatus(`✅ Imported ${combinedCompanies.length} companies, more may be available`);
          }
        } catch (err) {
          console.error('Import error:', err);
          setStatus(`❌ Error: ${err.message}`);
        } finally {
          setIsImporting(false);
        }
      };
      importData();
    }
  }, [isImporting, searchValue, searchField, maxImports]);

  const handleImport = () => {
    if (!searchValue.trim()) {
      setStatus('❌ Enter a search value.');
      return;
    }
    setIsImporting(true);
  };

  const handleClear = () => {
    setAllCompanies([]);
    setStatus('');
    setSearchValue('');
    setMaxImports(1);
    setCurrentPage(1);
    setExpandedIndex(null);
    setIsImporting(false);
    setNotes(''); // Clear notes on clear
    sessionStorage.removeItem('keyLogged');
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

  const fields = [
    { value: 'company_name', label: 'Company Name' },
    { value: 'product_keywords', label: 'Product Keywords' },
    { value: 'industries', label: 'Industry' },
    { value: 'headquarters_location', label: 'Headquarters Location' },
    { value: 'manufacturing_locations', label: 'Manufacturing Location' },
    { value: 'email_address', label: 'Email Address' },
    { value: 'url', label: 'Website URL' },
    { value: 'amazon_url', label: 'Amazon URL' },
  ];

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h1 className="text-3xl font-bold mb-4">Bulk Company Import</h1>

      <div className="space-y-4 mb-4">
        <div>
          <label htmlFor="maxImports" className="block text-sm font-medium text-gray-700">Number of Companies (1-20)</label>
          <input
            id="maxImports"
            type="number"
            min="1"
            max="20"
            value={maxImports}
            onChange={(e) => setMaxImports(Number(e.target.value))}
            className="w-full border rounded px-3 py-2"
          />
        </div>
        <div>
          <label htmlFor="searchField" className="block text-sm font-medium text-gray-700">Search Field</label>
          <select
            id="searchField"
            value={searchField}
            onChange={(e) => setSearchField(e.target.value)}
            className="w-full border rounded px-3 py-2"
          >
            {fields.map(field => (
              <option key={field.value} value={field.value}>{field.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="searchValue" className="block text-sm font-medium text-gray-700">Search Value</label>
          <input
            id="searchValue"
            type="text"
            value={searchValue}
            onChange={(e) => setSearchValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleImport();
              }
            }}
            className="w-full border rounded px-3 py-2"
          />
        </div>
      </div>

      <button
        onClick={handleImport}
        className="bg-blue-600 text-white rounded px-4 py-2 mb-4"
        disabled={isImporting}
      >
        {isImporting ? 'Importing...' : 'Start Import'}
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
                —{' '}
                {c.industries?.map((industry, i) => (
                  <span
                    key={i}
                    onClick={(e) => {
                      e.stopPropagation(); // Prevent expanding the card
                      navigate(`/search?query=${encodeURIComponent(industry)}`);
                    }}
                    className="text-blue-600 cursor-pointer underline mr-1"
                  >
                    {industry}
                  </span>
                )) || 'N/A'}
                {c.product_keywords?.map((keyword, i) => (
                  <span
                    key={i}
                    onClick={(e) => {
                      e.stopPropagation(); // Prevent expanding the card
                      navigate(`/search?query=${encodeURIComponent(keyword)}`);
                    }}
                    className="text-blue-600 cursor-pointer underline ml-1"
                  >
                    {keyword}
                  </span>
                ))}

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
                    {c.amazon_url && (
                      <p>
                        <strong>Amazon:</strong>{' '}
                        <a href={c.amazon_url} target="_blank" rel="noreferrer">
                          {c.amazon_url}
                        </a>
                      </p>
                    )}
                    {Array.isArray(c.reviews) && c.reviews.length > 0 && (
                      <div className="mt-2">
                        <strong>Reviews:</strong>
                        <ul className="list-disc list-inside">
                          {c.reviews.map((r, i) => (
                            <li key={i}>
                              <a href={r.link} target="_blank" rel="noreferrer">
                                [{r.source || 'Review'}] {r.text}
                              </a>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {userRole === 'admin' && c.company_contact_info && (
                      <div className="mt-2">
                        <strong>Contact Info:</strong>
                        <p>
                          <strong>Page URL:</strong>{' '}
                          <a href={c.company_contact_info.contact_page_url} target="_blank" rel="noreferrer">
                            {c.company_contact_info.contact_page_url}
                          </a>
                        </p>
                        <p>
                          <strong>Email:</strong> {c.company_contact_info.contact_email}
                        </p>
                      </div>
                    )}
                    {userRole === 'admin' && (
                      <div className="mt-2">
                        <label htmlFor={`notes-${idx}`} className="block text-sm font-medium text-gray-700">
                          Notes:
                        </label>
                        <textarea
                          id={`notes-${idx}`}
                          value={notes}
                          onChange={(e) => setNotes(e.target.value)}
                          className="w-full border rounded px-3 py-2 mt-1"
                          rows="3"
                        />
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