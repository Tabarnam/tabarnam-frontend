import React from 'react';

export default function SearchResultModal({ isOpen, status, targetResults, foundResults, onSearchMore, onRedefine, onClose }) {
  if (!isOpen) return null;

  const isSuccess = status === 'success';

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-lg max-w-sm w-full mx-4">
        <div className="p-6">
          {isSuccess ? (
            <>
              <div className="text-center mb-4">
                <div className="text-4xl mb-2">🎉</div>
                <h2 className="text-2xl font-bold text-emerald-600 mb-2">Search Successful!</h2>
                <p className="text-gray-700">
                  Found <strong>{foundResults}</strong> {foundResults === 1 ? 'company' : 'companies'}
                </p>
              </div>
              <p className="text-gray-600 text-center mb-6">
                Would you like to search for more companies?
              </p>
              <div className="flex gap-3">
                <button
                  onClick={onSearchMore}
                  className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded"
                >
                  Search More
                </button>
                <button
                  onClick={onClose}
                  className="flex-1 bg-gray-300 hover:bg-gray-400 text-gray-800 font-medium py-2 px-4 rounded"
                >
                  Done
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="text-center mb-4">
                <div className="text-4xl mb-2">📊</div>
                <h2 className="text-2xl font-bold text-amber-600 mb-2">Search Complete</h2>
                <p className="text-gray-700">
                  Found <strong>{foundResults}</strong> of <strong>{targetResults}</strong> target results
                </p>
              </div>
              <p className="text-gray-600 text-center mb-6">
                Your search didn't reach the target number. Would you like to refine your criteria?
              </p>
              <div className="flex gap-3">
                <button
                  onClick={onRedefine}
                  className="flex-1 bg-amber-600 hover:bg-amber-700 text-white font-medium py-2 px-4 rounded"
                >
                  Redefine Search
                </button>
                <button
                  onClick={onClose}
                  className="flex-1 bg-gray-300 hover:bg-gray-400 text-gray-800 font-medium py-2 px-4 rounded"
                >
                  Keep Results
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
