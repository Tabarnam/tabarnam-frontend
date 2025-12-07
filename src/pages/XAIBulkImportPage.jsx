import React, { useEffect, useState } from "react";
import BulkImportStream from "@/components/BulkImportStream";
import SearchResultModal from "@/components/SearchResultModal";
import RecentImportsPanel from "@/components/RecentImportsPanel";
import { API_BASE } from "@/lib/api";

export default function XAIBulkImportPage() {
  const [searchMode, setSearchMode] = useState("multiple"); // "specific" or "multiple"
  const [maxImports, setMaxImports] = useState(1);
  const [searchField, setSearchField] = useState("product_keywords");
  const [searchValue, setSearchValue] = useState("");
  const [center, setCenter] = useState({ lat: "", lng: "" });
  const [expandIfFew, setExpandIfFew] = useState(false);
  const [showLocationSources, setShowLocationSources] = useState(false);

  const [postal, setPostal]   = useState("");
  const [city, setCity]       = useState("");
  const [stateR, setStateR]   = useState("");
  const [country, setCountry] = useState("");

  const [sessionId, setSessionId] = useState("");
  const [lastSessionId, setLastSessionId] = useState("");
  const [status, setStatus] = useState("");
  const [lastMeta, setLastMeta] = useState(null);
  const [usedDirect] = useState(false); // no longer needed with /xapi proxy

  const [savedSoFar, setSavedSoFar] = useState(0);
  const [lastRowTs, setLastRowTs] = useState("");

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [modalStatus, setModalStatus] = useState("success"); // "success" or "failure"
  const [foundResults, setFoundResults] = useState(0);
  const [recentImportsKey, setRecentImportsKey] = useState(0); // Force refresh

  useEffect(() => {
    const prev = localStorage.getItem("last_session_id") || "";
    setLastSessionId(prev);
  }, []);

  // sanity ping
  useEffect(() => {
    if (window.__xaiPingOnce) return;
    window.__xaiPingOnce = true;
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/ping`);
        const body = await r.text().catch(() => "");
        console.log("XAI ping:", r.status, body);
      } catch (e) {
        console.warn("XAI ping failed:", e);
      }
    })();
  }, []);

  const fields = [
    { value: "company_name",           label: "Company Name" },
    { value: "product_keywords",       label: "Product Keywords" },
    { value: "industries",             label: "Industry" },
    { value: "headquarters_location",  label: "Headquarters Location" },
    { value: "manufacturing_locations",label: "Manufacturing Location" },
    { value: "email_address",          label: "Email Address" },
    { value: "url",                    label: "Website URL" },
    { value: "amazon_url",             label: "Amazon URL" },
  ];

  function mapFieldToQueryType(val) {
    const map = {
      product_keywords: "product_keyword",
      industries: "industry",
      company_name: "company_name",
      headquarters_location: "hq_location",
      manufacturing_locations: "manufacturing_location",
      email_address: "email",
      url: "url",
      amazon_url: "amazon_url",
    };
    return map[val] || "product_keyword";
  }

  async function postImportStart(body) {
    const r = await fetch(`${API_BASE}/import/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(j?.error || r.statusText || "import/start failed");
    }
    return j;
  }

  function resolveCenter(currentCenter) {
    const latNum = Number(currentCenter?.lat);
    const lngNum = Number(currentCenter?.lng);
    if (Number.isFinite(latNum) && Number.isFinite(lngNum)) {
      return { lat: latNum, lng: lngNum };
    }
    return undefined;
  }

  const handleImport = async () => {
    const q = searchValue.trim();
    if (!q) { setStatus("❌ Enter a search value."); return; }

    const sid = (globalThis.crypto?.randomUUID?.() ?? `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    setSessionId(sid);
    localStorage.setItem("last_session_id", sid);
    setLastSessionId(sid);
    setSavedSoFar(0);
    setLastRowTs("");
    setModalOpen(false);

    const isSpecificSearch = searchMode === "specific";
    setStatus(isSpecificSearch ? "🔍 Searching for specific company… (may take longer for thorough location search)" : "Starting import… (rows will stream in below)");

    try {
      const queryType = mapFieldToQueryType(searchField);
      const maybeCenter = resolveCenter(center);

      // For specific company search, always use limit of 1; for multiple, use user's choice
      const limit = isSpecificSearch ? 1 : Math.max(1, Math.min(Number(maxImports) || 1, 25));

      const body = {
        queryType,
        query: q,
        limit,
        timeout_ms: isSpecificSearch ? 600000 : 600000, // Allow more time for thorough specific searches
        session_id: sid,
        expand_if_few: isSpecificSearch ? false : !!expandIfFew, // Don't expand when searching for specific company
        show_location_sources: showLocationSources,
        ...(maybeCenter ? { center: maybeCenter } : {}),
      };

      const j = await postImportStart(body);
      setLastMeta(j?.meta || null);
      setStatus(isSpecificSearch ? "✅ Specific company search started. Performing thorough location search…" : "✅ Import started. Streaming…");
    } catch (err) {
      console.error("Import error:", err);
      setStatus(`❌ Error: ${err?.message || "Unknown error"}`);
      setLastMeta(null);
    }
  };

  const handleResume = () => {
    if (!lastSessionId) return;
    setSessionId(lastSessionId);
    setSavedSoFar(0);
    setLastRowTs("");
    setModalOpen(false);
    setStatus("Resumed previous stream.");
  };

  const handleImportSuccess = (data) => {
    console.log("Import succeeded:", data);
    setFoundResults(data.found || 0);
    setModalStatus("success");
    setModalOpen(true);
    setRecentImportsKey(k => k + 1); // Refresh recent imports
  };

  const handleImportFailure = (data) => {
    console.log("Import failed:", data);
    setFoundResults(data.saved || 0);
    setModalStatus("failure");
    setModalOpen(true);
    setRecentImportsKey(k => k + 1); // Refresh recent imports
  };

  const handleSearchMore = () => {
    setModalOpen(false);
    setSessionId("");
    setStatus("");
    // Keep search parameters, just clear the session
  };

  const handleRedefine = () => {
    setModalOpen(false);
    // User can now modify the search parameters
    // Could highlight the search controls here if desired
  };

  const handleCloseModal = () => {
    setModalOpen(false);
  };


  const handleClear = () => {
    setSessionId(""); 
    setStatus(""); 
    setSearchValue("");
    setMaxImports(1); 
    setLastMeta(null); 
    setSavedSoFar(0); 
    setLastRowTs("");
    setCenter({ lat: "", lng: "" });
    setPostal(""); 
    setCity(""); 
    setStateR(""); 
    setCountry("");
    setModalOpen(false);
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h1 className="text-3xl font-bold mb-4">Company Import</h1>
      <div className="flex gap-2 items-center mb-6">
        {sessionId && (
          <span className="text-xs px-2 py-1 rounded bg-gray-200">Session: <code>{sessionId}</code></span>
        )}
        {!!savedSoFar && (
          <span className="text-xs px-2 py-1 rounded bg-emerald-100 text-emerald-900">
            Saved so far: <strong>{savedSoFar}</strong>{lastRowTs ? ` · last at ${new Date(lastRowTs).toLocaleTimeString()}` : ""}
          </span>
        )}
      </div>

      {/* Search Mode Toggle */}
      <div className="mb-6 p-4 border rounded bg-blue-50">
        <label className="block text-sm font-medium text-gray-700 mb-2">Search Mode</label>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="searchMode"
              value="specific"
              checked={searchMode === "specific"}
              onChange={(e) => setSearchMode(e.target.value)}
              className="h-4 w-4"
            />
            <span className="text-sm text-gray-700">
              🔍 Specific Company (finds exactly one company with thorough location search)
            </span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="searchMode"
              value="multiple"
              checked={searchMode === "multiple"}
              onChange={(e) => setSearchMode(e.target.value)}
              className="h-4 w-4"
            />
            <span className="text-sm text-gray-700">
              📋 Multiple Results (bulk import up to 25 companies)
            </span>
          </label>
        </div>
      </div>

      {/* Search Value - full width, dedicated line */}
      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700">Search Value</label>
        <input
          type="text"
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleImport(); } }}
          placeholder='e.g., "electrolyte powder"'
          className="w-full border rounded px-3 py-2"
        />
      </div>

      {/* Discovery controls */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">
            Target results (1–25)
            {searchMode === "specific" && <span className="text-xs text-teal-600 ml-2">(locked to 1 for specific search)</span>}
          </label>
          <input
            type="number" min="1" max="25" value={searchMode === "specific" ? 1 : maxImports}
            onChange={(e) => setMaxImports(Math.max(1, Math.min(25, Number(e.target.value) || 1)))}
            disabled={searchMode === "specific"}
            className={`w-full border rounded px-3 py-2 ${searchMode === "specific" ? "bg-gray-100 text-gray-500 cursor-not-allowed" : ""}`}
          />
          {searchMode === "multiple" && (
            <div className="mt-2 flex items-center gap-2">
              <input
                id="expandIfFew"
                type="checkbox"
                className="h-4 w-4"
                checked={expandIfFew}
                onChange={(e) => setExpandIfFew(e.target.checked)}
              />
              <label htmlFor="expandIfFew" className="text-sm text-gray-700">
                Expand search area if few results
              </label>
            </div>
          )}
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Search Field</label>
          <select value={searchField} onChange={(e) => setSearchField(e.target.value)} className="w-full border rounded px-3 py-2">
            {fields.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </div>
      </div>

      {/* Location Sources Visibility for Specific Search */}
      {searchMode === "specific" && (
        <div className="mb-4 p-3 border rounded bg-teal-50">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={showLocationSources}
              onChange={(e) => setShowLocationSources(e.target.checked)}
            />
            <span className="text-sm font-medium text-gray-700">
              ✨ Make Location Sources Visible to Users
            </span>
          </label>
          <p className="text-xs text-gray-600 mt-1 ml-6">
            When enabled, source links for HQ and manufacturing locations will appear on the public company page.
          </p>
        </div>
      )}

      {/* Address inputs (for future geocode; no-op today) */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">Postal Code</label>
          <input value={postal} onChange={(e)=>setPostal(e.target.value)} placeholder="e.g. 94107" className="w-full border rounded px-3 py-2" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">City</label>
          <input value={city} onChange={(e)=>setCity(e.target.value)} placeholder="e.g. San Francisco" className="w-full border rounded px-3 py-2" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">State/Region</label>
          <input value={stateR} onChange={(e)=>setStateR(e.target.value)} placeholder="e.g. CA / California" className="w-full border rounded px-3 py-2" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Country</label>
          <input value={country} onChange={(e)=>setCountry(e.target.value)} placeholder="e.g. USA" className="w-full border rounded px-3 py-2" />
        </div>
      </div>

      {/* Center Latitude + Center Longitude + Buttons */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">Center Latitude (optional)</label>
          <input type="number" step="any" value={center.lat}
                 onChange={(e) => setCenter((s) => ({ ...s, lat: e.target.value }))}
                 className="w-full border rounded px-3 py-2" placeholder="34.103" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Center Longitude (optional)</label>
          <input type="number" step="any" value={center.lng}
                 onChange={(e) => setCenter((s) => ({ ...s, lng: e.target.value }))}
                 className="w-full border rounded px-3 py-2" placeholder="-118.325" />
        </div>
        <div className="flex items-end gap-2">
          <button onClick={handleImport} className="rounded px-4 py-2 text-white bg-lime-500 hover:bg-lime-600">Start Import</button>
          <button onClick={handleClear} className="bg-red-600 hover:bg-red-700 text-white rounded px-4 py-2">Clear</button>
        </div>
      </div>

      {/* Status + meta */}
      <div className="mb-4 text-sm text-gray-700">
        {status && <div className="mb-1">{status}</div>}
        {lastMeta && (
          <div className="text-gray-600 flex flex-wrap gap-3">
            <span>Req ID: <code>{lastMeta.request_id}</code></span>
            <span>Latency: {lastMeta.latency_ms} ms</span>
            <span>Model: {lastMeta.model}</span>
            {lastMeta?.proxy?.build && <span>Proxy: {lastMeta.proxy.build}</span>}
          </div>
        )}
      </div>

      {/* Live stream and search result modal */}
      {sessionId ? (
        <>
          <BulkImportStream
            sessionId={sessionId}
            targetResults={maxImports}
            take={400}
            pollingMs={1500}
            onStats={(s) => { setSavedSoFar(s.saved || 0); setLastRowTs(s.lastCreatedAt || ""); }}
            onSuccess={handleImportSuccess}
            onFailure={handleImportFailure}
          />
          {savedSoFar > 0 && (
            <div className="mt-4 p-3 border rounded bg-emerald-50 text-emerald-800 text-sm">
              ✅ Import is working! {savedSoFar} {savedSoFar === 1 ? 'company' : 'companies'} saved so far.
              If you don't see all results, the progress endpoint may be slow — check the database directly.
            </div>
          )}
        </>
      ) : (
        <p className="text-sm text-gray-500">Start an import or click "Resume last stream".</p>
      )}

      {/* Search Result Modal */}
      <SearchResultModal
        isOpen={modalOpen}
        status={modalStatus}
        targetResults={maxImports}
        foundResults={foundResults}
        onSearchMore={handleSearchMore}
        onRedefine={handleRedefine}
        onClose={handleCloseModal}
      />

      {/* Recent imports section */}
      <RecentImportsPanel key={recentImportsKey} take={25} />
    </div>
  );
}
