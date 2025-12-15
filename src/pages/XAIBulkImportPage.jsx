import React, { useEffect, useMemo, useState } from "react";
import BulkImportStream from "@/components/BulkImportStream";
import SearchResultModal from "@/components/SearchResultModal";
import RecentImportsPanel from "@/components/RecentImportsPanel";
import { API_BASE } from "@/lib/api";

const IMPORT_STATES = {
  idle: "idle",
  starting: "starting",
  running: "running",
  completed_with_results: "completed_with_results",
  completed_no_results: "completed_no_results",
  stopped_by_user: "stopped_by_user",
  error: "error",
};

export default function XAIBulkImportPage() {
  const [searchMode, setSearchMode] = useState("multiple");
  const [maxImports, setMaxImports] = useState(1);
  const [searchField, setSearchField] = useState("product_keywords");
  const [searchValue, setSearchValue] = useState("");
  const [center, setCenter] = useState({ lat: "", lng: "" });
  const [expandIfFew, setExpandIfFew] = useState(false);

  const [postal, setPostal] = useState("");
  const [city, setCity] = useState("");
  const [stateR, setStateR] = useState("");
  const [country, setCountry] = useState("");

  const [sessionId, setSessionId] = useState("");
  const [lastSessionId, setLastSessionId] = useState("");
  const [lastMeta, setLastMeta] = useState(null);
  const [usedDirect] = useState(false);

  const [savedSoFar, setSavedSoFar] = useState(0);
  const [lastRowTs, setLastRowTs] = useState("");

  const [importState, setImportState] = useState(IMPORT_STATES.idle);
  const [importError, setImportError] = useState("");

  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [startTime, setStartTime] = useState(null);

  const [stopRequested, setStopRequested] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [modalStatus, setModalStatus] = useState("success");
  const [foundResults, setFoundResults] = useState(0);
  const [recentImportsKey, setRecentImportsKey] = useState(0);

  useEffect(() => {
    const prev = localStorage.getItem("last_session_id") || "";
    setLastSessionId(prev);
  }, []);

  const clockRunning = !!sessionId && (importState === IMPORT_STATES.starting || importState === IMPORT_STATES.running);

  useEffect(() => {
    if (!clockRunning) return;

    const interval = setInterval(() => {
      setElapsedSeconds((prev) => prev + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, [clockRunning]);

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

  function formatElapsedTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
      return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    }
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  const fields = [
    { value: "company_name", label: "Company Name" },
    { value: "product_keywords", label: "Product Keywords" },
    { value: "industries", label: "Industry" },
    { value: "headquarters_location", label: "Headquarters Location" },
    { value: "manufacturing_locations", label: "Manufacturing Location" },
    { value: "email_address", label: "Email Address" },
    { value: "url", label: "Website URL" },
    { value: "amazon_url", label: "Amazon URL" },
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

  const statusBanner = useMemo(() => {
    if (importState === IMPORT_STATES.idle) return null;

    const base = {
      bg: "bg-gray-50",
      text: "text-gray-800",
      msg: "",
    };

    if (importState === IMPORT_STATES.starting) {
      return {
        ...base,
        bg: "bg-blue-50",
        text: "text-blue-900",
        msg:
          searchMode === "specific"
            ? "🔍 Searching for a specific company… (may take longer for thorough location search)"
            : "Starting import… (rows will stream in below)",
      };
    }

    if (importState === IMPORT_STATES.running) {
      return {
        ...base,
        bg: "bg-emerald-50",
        text: "text-emerald-900",
        msg:
          searchMode === "specific"
            ? "✅ Search started. Performing thorough location search…"
            : "✅ Import started. Streaming…",
      };
    }

    if (importState === IMPORT_STATES.completed_with_results) {
      return {
        ...base,
        bg: "bg-emerald-50",
        text: "text-emerald-900",
        msg: `✅ Search complete. Found ${foundResults} ${foundResults === 1 ? "company" : "companies"}.`,
      };
    }

    if (importState === IMPORT_STATES.completed_no_results) {
      return {
        ...base,
        bg: "bg-amber-50",
        text: "text-amber-900",
        msg: "❌ No companies found for this search.",
      };
    }

    if (importState === IMPORT_STATES.stopped_by_user) {
      return {
        ...base,
        bg: "bg-yellow-50",
        text: "text-yellow-900",
        msg: `🛑 Import stopped by user. ${foundResults > 0 ? `Found ${foundResults} ${foundResults === 1 ? "company" : "companies"}.` : "No companies imported."}`,
      };
    }

    if (importState === IMPORT_STATES.error) {
      return {
        ...base,
        bg: "bg-red-50",
        text: "text-red-900",
        msg: `❌ Error: ${importError || "Unknown error"}`,
      };
    }

    return null;
  }, [foundResults, importError, importState, searchMode]);

  const handleImport = async () => {
    const q = searchValue.trim();
    if (!q) {
      setImportError("Enter a search value.");
      setImportState(IMPORT_STATES.error);
      return;
    }

    const sid = globalThis.crypto?.randomUUID?.() ?? `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    setImportError("");
    setImportState(IMPORT_STATES.starting);

    setSessionId(sid);
    localStorage.setItem("last_session_id", sid);
    setLastSessionId(sid);

    setSavedSoFar(0);
    setLastRowTs("");
    setFoundResults(0);
    setModalOpen(false);
    setModalStatus("success");

    setStartTime(Date.now());
    setElapsedSeconds(0);

    setStopRequested(false);

    const isSpecificSearch = searchMode === "specific";

    try {
      const queryType = mapFieldToQueryType(searchField);
      const maybeCenter = resolveCenter(center);

      const limit = isSpecificSearch ? 1 : Math.max(1, Math.min(Number(maxImports) || 1, 25));

      const body = {
        queryType,
        query: q,
        limit,
        timeout_ms: 600000,
        session_id: sid,
        expand_if_few: isSpecificSearch ? false : !!expandIfFew,
        ...(maybeCenter ? { center: maybeCenter } : {}),
      };

      const j = await postImportStart(body);
      setLastMeta(j?.meta || null);
      setImportState(IMPORT_STATES.running);
    } catch (err) {
      console.error("Import error:", err);
      setImportError(err?.message || "Unknown error");
      setImportState(IMPORT_STATES.error);

      setLastMeta(null);
      setSessionId("");
      setStopRequested(false);
      setStartTime(null);
    }
  };

  const handleResume = () => {
    if (!lastSessionId) return;

    setImportError("");
    setImportState(IMPORT_STATES.running);

    setSessionId(lastSessionId);
    setSavedSoFar(0);
    setLastRowTs("");
    setFoundResults(0);
    setModalOpen(false);
    setStopRequested(false);

    setStartTime(Date.now());
    setElapsedSeconds(0);
  };

  const handleImportSuccess = (data) => {
    const saved = Number(data?.found ?? data?.saved ?? 0);

    setStopRequested(false);
    setImportError("");
    setFoundResults(saved);
    setImportState(saved > 0 ? IMPORT_STATES.completed_with_results : IMPORT_STATES.completed_no_results);

    setModalStatus("success");
    setModalOpen(true);
    setRecentImportsKey((k) => k + 1);
  };

  const handleImportFailure = (data) => {
    const saved = Number(data?.saved ?? 0);

    setStopRequested(false);
    setImportError("");
    setFoundResults(saved);

    setImportState(saved > 0 ? IMPORT_STATES.completed_with_results : IMPORT_STATES.completed_no_results);

    setModalStatus("failure");
    setModalOpen(true);
    setRecentImportsKey((k) => k + 1);
  };

  const handleImportStopped = (data) => {
    const saved = Number(data?.saved ?? 0);

    setStopRequested(false);
    setImportError("");
    setFoundResults(saved);
    setImportState(IMPORT_STATES.stopped_by_user);
  };

  const handleSearchMore = () => {
    setModalOpen(false);
    setSessionId("");
    setImportError("");
    setImportState(IMPORT_STATES.idle);
    setStartTime(null);
    setElapsedSeconds(0);
    setStopRequested(false);
  };

  const handleRedefine = () => {
    setModalOpen(false);
  };

  const handleCloseModal = () => {
    setModalOpen(false);
  };

  const handleStop = () => {
    if (importState !== IMPORT_STATES.starting && importState !== IMPORT_STATES.running) return;
    if (!sessionId) return;
    setStopRequested(true);
  };

  const handleClear = async () => {
    if (sessionId) {
      try {
        await fetch(`${API_BASE}/import/stop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId }),
        }).catch(() => {});
      } catch (e) {
        console.warn("Failed to stop import during clear:", e);
      }
    }

    setSessionId("");
    setImportError("");
    setImportState(IMPORT_STATES.idle);

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
    setSearchMode("multiple");
    setModalOpen(false);
    setElapsedSeconds(0);
    setStartTime(null);
    setStopRequested(false);
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h1 className="text-3xl font-bold mb-4">Company Import</h1>
      <div className="flex gap-2 items-center mb-6">
        {sessionId && (
          <span className="text-xs px-2 py-1 rounded bg-gray-200">
            Session: <code>{sessionId}</code>
          </span>
        )}
        {!!savedSoFar && (
          <span className="text-xs px-2 py-1 rounded bg-emerald-100 text-emerald-900">
            Saved so far: <strong>{savedSoFar}</strong>
            {lastRowTs ? ` · last at ${new Date(lastRowTs).toLocaleTimeString()}` : ""}
          </span>
        )}
      </div>

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
            <span className="text-sm text-gray-700">🔍 Specific Company (finds exactly one company with thorough location search)</span>
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
            <span className="text-sm text-gray-700">📋 Multiple Results (bulk import up to 25 companies)</span>
          </label>
        </div>
      </div>

      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700">Search Value</label>
        <input
          type="text"
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleImport();
            }
          }}
          placeholder='e.g., "electrolyte powder"'
          className="w-full border rounded px-3 py-2"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">
            Target results (1–25)
            {searchMode === "specific" && <span className="text-xs text-teal-600 ml-2">(locked to 1 for specific search)</span>}
          </label>
          <input
            type="number"
            min="1"
            max="25"
            value={searchMode === "specific" ? 1 : maxImports}
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
            {fields.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">Postal Code</label>
          <input value={postal} onChange={(e) => setPostal(e.target.value)} placeholder="e.g. 94107" className="w-full border rounded px-3 py-2" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">City</label>
          <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="e.g. San Francisco" className="w-full border rounded px-3 py-2" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">State/Region</label>
          <input value={stateR} onChange={(e) => setStateR(e.target.value)} placeholder="e.g. CA / California" className="w-full border rounded px-3 py-2" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Country</label>
          <input value={country} onChange={(e) => setCountry(e.target.value)} placeholder="e.g. USA" className="w-full border rounded px-3 py-2" />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">Center Latitude (optional)</label>
          <input
            type="number"
            step="any"
            value={center.lat}
            onChange={(e) => setCenter((s) => ({ ...s, lat: e.target.value }))}
            className="w-full border rounded px-3 py-2"
            placeholder="34.103"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Center Longitude (optional)</label>
          <input
            type="number"
            step="any"
            value={center.lng}
            onChange={(e) => setCenter((s) => ({ ...s, lng: e.target.value }))}
            className="w-full border rounded px-3 py-2"
            placeholder="-118.325"
          />
        </div>
        <div className="flex items-end gap-2">
          <button
            onClick={handleImport}
            disabled={!!sessionId && (importState === IMPORT_STATES.starting || importState === IMPORT_STATES.running)}
            className={`rounded px-4 py-2 text-white ${sessionId && (importState === IMPORT_STATES.starting || importState === IMPORT_STATES.running) ? "bg-gray-300 cursor-not-allowed" : "bg-lime-500 hover:bg-lime-600"}`}
          >
            Start Import
          </button>
          <button
            onClick={handleStop}
            disabled={!sessionId || stopRequested || (importState !== IMPORT_STATES.starting && importState !== IMPORT_STATES.running)}
            className={`rounded px-4 py-2 text-white ${sessionId && !stopRequested && (importState === IMPORT_STATES.starting || importState === IMPORT_STATES.running) ? "bg-amber-500 hover:bg-amber-600" : "bg-gray-300 cursor-not-allowed"}`}
          >
            Stop Import
          </button>
          <button onClick={handleClear} className="bg-red-600 hover:bg-red-700 text-white rounded px-4 py-2">
            Clear
          </button>
          <button
            onClick={handleResume}
            disabled={!lastSessionId || !!sessionId}
            className={`rounded px-4 py-2 text-white ${!lastSessionId || !!sessionId ? "bg-gray-300 cursor-not-allowed" : "bg-slate-600 hover:bg-slate-700"}`}
          >
            Resume last stream
          </button>
          <div className="ml-auto text-sm font-medium text-gray-700">
            Runtime: <code className="bg-gray-100 px-2 py-1 rounded">{formatElapsedTime(elapsedSeconds)}</code>
          </div>
        </div>
      </div>

      <div className="mb-4 text-sm">
        {statusBanner && (
          <div className={`mb-2 p-3 border rounded ${statusBanner.bg} ${statusBanner.text}`}>{statusBanner.msg}</div>
        )}
        {lastMeta && (
          <div className="text-gray-600 flex flex-wrap gap-3">
            <span>
              Req ID: <code>{lastMeta.request_id}</code>
            </span>
            <span>Latency: {lastMeta.latency_ms} ms</span>
            <span>Model: {lastMeta.model}</span>
            {lastMeta?.proxy?.build && <span>Proxy: {lastMeta.proxy.build}</span>}
          </div>
        )}
      </div>

      {sessionId ? (
        <>
          <BulkImportStream
            sessionId={sessionId}
            targetResults={maxImports}
            take={400}
            pollingMs={1500}
            stopRequested={stopRequested}
            importState={importState}
            onStats={(s) => {
              setSavedSoFar(s.saved || 0);
              setLastRowTs(s.lastCreatedAt || "");
            }}
            onSuccess={handleImportSuccess}
            onFailure={handleImportFailure}
            onStopped={handleImportStopped}
          />
          {savedSoFar > 0 && (importState === IMPORT_STATES.starting || importState === IMPORT_STATES.running) && (
            <div className="mt-4 p-3 border rounded bg-emerald-50 text-emerald-800 text-sm">
              ✅ Import is working! {savedSoFar} {savedSoFar === 1 ? "company" : "companies"} saved so far. If you don't see all results, the progress endpoint may be slow — check the database directly.
            </div>
          )}
        </>
      ) : (
        <p className="text-sm text-gray-500">Start an import or click "Resume last stream".</p>
      )}

      <SearchResultModal
        isOpen={modalOpen}
        status={modalStatus}
        targetResults={maxImports}
        foundResults={foundResults}
        onSearchMore={handleSearchMore}
        onRedefine={handleRedefine}
        onClose={handleCloseModal}
      />

      <RecentImportsPanel key={recentImportsKey} take={25} />
    </div>
  );
}
