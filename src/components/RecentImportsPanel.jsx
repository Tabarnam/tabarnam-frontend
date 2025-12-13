import React, { useEffect, useState } from 'react';
import { API_BASE } from '@/lib/api';
import { withAmazonAffiliate } from "@/lib/amazonAffiliate";

export default function RecentImportsPanel({ take = 25 }) {
  const [imports, setImports] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [currentTake, setCurrentTake] = useState(take);

  async function fetchRecentImports(limit) {
    try {
      setLoading(true);
      setError('');
      
      // Query the Cosmos DB for most recent companies across all sessions
      const url = `${API_BASE}/xadmin-api-recent-imports?take=${encodeURIComponent(limit)}`;
      const r = await fetch(url);
      
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error || r.statusText);
      }
      
      const j = await r.json();
      setImports(j.imports || []);
    } catch (e) {
      setError(e?.message || 'Failed to load recent imports');
      setImports([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchRecentImports(currentTake);
  }, [currentTake]);

  return (
    <div className="mt-8 border rounded p-4 bg-gray-50">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold">Recent Imports (All Admins)</h3>
        {!expanded && (
          <span className="text-sm text-gray-500">{currentTake} most recent</span>
        )}
      </div>

      {error && (
        <div className="text-sm text-red-600 mb-4 p-2 bg-red-50 rounded">
          ⚠️ {error}
        </div>
      )}

      {loading ? (
        <div className="text-center py-8">
          <div className="text-gray-500">Loading imports…</div>
        </div>
      ) : imports.length === 0 ? (
        <div className="text-center py-8">
          <div className="text-gray-500">No recent imports found</div>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-white">
                  <th className="text-left py-2 px-3 font-semibold">Company Name</th>
                  <th className="text-left py-2 px-3 font-semibold">URL</th>
                  <th className="text-left py-2 px-3 font-semibold">Imported By</th>
                  <th className="text-left py-2 px-3 font-semibold">Date</th>
                </tr>
              </thead>
              <tbody>
                {imports.map((imp, i) => (
                  <tr key={i} className="border-b hover:bg-gray-100">
                    <td className="py-2 px-3 font-medium">{imp.company_name || imp.name || '—'}</td>
                    <td className="py-2 px-3 text-blue-600 truncate">
                      {imp.url || imp.website_url ? (
                        <a
                          href={withAmazonAffiliate(imp.url || imp.website_url)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:underline"
                        >
                          {withAmazonAffiliate(imp.url || imp.website_url)}
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="py-2 px-3 text-gray-600">{imp.imported_by || 'Unknown'}</td>
                    <td className="py-2 px-3 text-gray-600 whitespace-nowrap">
                      {imp.created_at ? new Date(imp.created_at).toLocaleString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!expanded && (
            <div className="mt-4 flex gap-2 justify-center">
              <button
                onClick={() => {
                  setExpanded(true);
                  setCurrentTake(50);
                }}
                className="px-3 py-1 text-sm bg-gray-300 hover:bg-gray-400 text-gray-800 rounded"
              >
                Show 50
              </button>
              <button
                onClick={() => {
                  setExpanded(true);
                  setCurrentTake(100);
                }}
                className="px-3 py-1 text-sm bg-gray-300 hover:bg-gray-400 text-gray-800 rounded"
              >
                Show 100
              </button>
              <button
                onClick={() => {
                  setExpanded(true);
                  setCurrentTake(200);
                }}
                className="px-3 py-1 text-sm bg-gray-300 hover:bg-gray-400 text-gray-800 rounded"
              >
                Show 200
              </button>
            </div>
          )}

          {expanded && (
            <div className="mt-4 text-center">
              <button
                onClick={() => {
                  setExpanded(false);
                  setCurrentTake(25);
                }}
                className="px-3 py-1 text-sm bg-gray-400 hover:bg-gray-500 text-white rounded"
              >
                Show Less
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
