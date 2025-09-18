// src/pages/XAIBulkImportPage.jsx
import React, { useEffect, useState } from "react";
import BulkImportStream from "@/components/BulkImportStream";

export default function XAIBulkImportPage() {
  const [maxImports, setMaxImports] = useState(10);
  const [searchField, setSearchField] = useState("product_keywords");
  const [searchValue, setSearchValue] = useState("");
  const [center, setCenter] = useState({ lat: "", lng: "" });
  const [expandIfFew, setExpandIfFew] = useState(true);

  // Address inputs for geocoding
  const [postal, setPostal]   = useState("");
  const [city, setCity]       = useState("");
  const [stateR, setStateR]   = useState("");
  const [country, setCountry] = useState("");

  const [sessionId, setSessionId] = useState("");
  const [lastSessionId, setLastSessionId] = useState("");
  const [status, setStatus] = useState("");
  const [lastMeta, setLastMeta] = useState(null);
  const [usedDirect, setUsedDirect] = useState(false);
  const [saving, setSaving] = useState(false);
  const [manualList, setManualList] = useState("");

  // tiny progress chip state
  const [savedSoFar, setSavedSoFar] = useState(0);
  const [lastRowTs, setLastRowTs] = useState("");

  const FN_URL = import.meta.env.VITE_FUNCTIONS_URL || "http://127.0.0.1:7071";
  const PREFER_DIRECT = import.meta.env.DEV; // ✅ prefer direct Functions in dev

  // discover previous session
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
        const r = await fetch("/api/proxy-xai");
        if (!r.ok) throw new Error(`proxy ${r.status}`);
        console.log("Proxy OK:", await r.json());
      } catch (e) {
        console.warn("Proxy ping failed, trying direct Functions URL...", e);
        try {
          const r2 = await fetch(`${FN_URL}/api/proxy-xai`);
          console.log("Direct Functions OK:", await r2.json());
        } catch (e2) {
          console.error("Direct Functions ping also failed:", e2);
        }
      }
    })();
  }, [FN_URL]);

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

  // ✅ Prefer direct Functions in dev; fall back to the other path on failure
  async function postProxyXai(body) {
    const directUrl = `${FN_URL}/api/proxy-xai`;
    const relUrl = `/api/proxy-xai`;
    const headers = { "Content-Type": "application/json" };

    async function call(url) {
      const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`${url.includes(FN_URL) ? "direct" : "proxy"} ${r.status} ${await r.text().catch(()=> "")}`);
      return r.json();
    }

    try {
      if (PREFER_DIRECT) {
        const j = await call(directUrl);
        setUsedDirect(true);
        return j;
      } else {
        const j = await call(relUrl);
        setUsedDirect(false);
        return j;
      }
    } catch (e) {
      // swap order on failure
      try {
        const j = await call(PREFER_DIRECT ? relUrl : directUrl);
        setUsedDirect(!PREFER_DIRECT);
        return j;
      } catch (e2) {
        throw e2;
      }
    }
  }

  // Geocode helper — only runs if lat/lng are blank and any address parts exist
  async function geocodeIfNeeded(currentCenter) {
    const latNum = Number(currentCenter?.lat);
    const lngNum = Number(currentCenter?.lng);
    const hasLatLng = Number.isFinite(latNum) && Number.isFinite(lngNum);
    const hasAddress = [postal, city, stateR, country].some(Boolean);
    if (hasLatLng || !hasAddress) return { lat: latNum, lng: lngNum };

    const address = [postal, city, stateR, country].filter(Boolean).join(", ");
    try {
      // try relative first
      let res = await fetch("/api/google/geocode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address })
      });
      if (!res.ok) {
        // fallback to direct Functions URL
        res = await fetch(`${FN_URL}/api/google/geocode`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address })
        });
      }
      if (!res.ok) throw new Error(`geocode ${res.status}`);
      const j = await res.json();
      const glat = Number(j?.lat);
      const glng = Number(j?.lng);
      if (Number.isFinite(glat) && Number.isFinite(glng)) return { lat: glat, lng: glng };
    } catch (e) {
      console.warn("Geocode failed:", e?.message || e);
    }
    return { lat: latNum, lng: lngNum };
  }

  const handleImport = async () => {
    const q = searchValue.trim();
    if (!q) { setStatus("❌ Enter a search value."); return; }

    const sid = (globalThis.crypto?.randomUUID?.() ?? `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    setSessionId(sid);
    localStorage.setItem("last_session_id", sid);
    setLastSessionId(sid);
    setSavedSoFar(0); setLastRowTs("");
    setStatus("Starting import… (rows will stream in below)");

    try {
      const fieldMap = {
        product_keywords: "product_keyword",
        industries: "industry",
        company_name: "company_name",
        headquarters_location: "hq_location",
        manufacturing_locations: "manufacturing_location",
        email_address: "email",
        url: "url",
        amazon_url: "amazon_url",
      };
      const queryType = fieldMap[searchField] || "product_keyword";

      // resolve center via geocode if lat/lng missing
      const resolved = await geocodeIfNeeded(center);

      const body = {
        queryType,
        query: q,
        limit: Number(maxImports) || 3,
        timeout_ms: 600000,
        session_id: sid,
        expand_if_few: !!expandIfFew,
      };

      if (Number.isFinite(resolved.lat) && Number.isFinite(resolved.lng)) {
        body.center = { lat: resolved.lat, lng: resolved.lng };
      }

      const j = await postProxyXai(body);
      setLastMeta(j?.meta || null);
      setStatus("✅ Import started. Streaming…");
    } catch (err) {
      console.error("Import error:", err);
      setStatus(`❌ Error: ${err?.message || "Unknown error"}`);
      setLastMeta(null);
    }
  };

  const handleResume = () => {
    if (!lastSessionId) return;
    setSessionId(lastSessionId);
    setSavedSoFar(0); setLastRowTs("");
    setStatus("Resumed previous stream.");
  };

  // Manual save (unchanged)
  const handleQuickImportSave = async () => {
    const lines = manualList.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!lines.length) { setStatus("Paste at least one company name or URL."); return; }
    const companies = lines.map((line) => {
      const looksLikeUrl = /^(https?:\/\/|www\.)/i.test(line) || /^[\w.-]+\.[a-z]{2,}$/i.test(line);
      const url = looksLikeUrl ? (line.startsWith("http") ? line : `https://${line}`) : "";
      const company_name = looksLikeUrl ? "" : line;
      return { company_name, url };
    });
    try {
      setSaving(true); setStatus("Saving…");
      const r = await fetch("/api/save-companies", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ companies }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) setStatus(`💾 Saved ${j.saved} companies${j.failed ? `, ${j.failed} failed` : ""}.`);
      else setStatus(`❌ Save failed: ${j?.error || r.statusText}`);
    } catch (e) {
      setStatus(`❌ Save error: ${e.message}`);
    } finally { setSaving(false); }
  };

  const handleClear = () => {
    setSessionId(""); setStatus(""); setSearchValue("");
    setMaxImports(10); setLastMeta(null); setManualList("");
    setSavedSoFar(0); setLastRowTs(""); setUsedDirect(false);
    setCenter({ lat: "", lng: "" });
    setPostal(""); setCity(""); setStateR(""); setCountry("");
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h1 className="text-3xl font-bold mb-2">Bulk Company Import</h1>
      <div className="flex gap-2 items-center mb-6">
        {sessionId && (
          <span className="text-xs px-2 py-1 rounded bg-gray-200">Session: <code>{sessionId}</code></span>
        )}
        {!!savedSoFar && (
          <span className="text-xs px-2 py-1 rounded bg-emerald-100 text-emerald-900">
            Saved so far: <strong>{savedSoFar}</strong>{lastRowTs ? ` · last at ${new Date(lastRowTs).toLocaleTimeString()}` : ""}
          </span>
        )}
        {usedDirect && (
          <span className="text-xs px-2 py-1 rounded bg-amber-100 text-amber-900">
            Using direct Functions URL
          </span>
        )}
        {!sessionId && lastSessionId && (
          <button onClick={handleResume} className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700">
            Resume last stream
          </button>
        )}
      </div>

      {/* Manual/CSV quick import */}
      <div className="mb-6 p-3 border rounded">
        <label className="block text-sm font-medium text-gray-700 mb-1">Manual/CSV Quick Import (one per line)</label>
        <textarea
          rows={5}
          value={manualList}
          onChange={(e) => setManualList(e.target.value)}
          placeholder={`Acme Candles\nhttps://www.bunn.com\ncarpigiani.com`}
          className="w-full border rounded px-3 py-2"
        />
        <div className="mt-2 flex gap-2 items-center">
          <button
            onClick={handleQuickImportSave}
            disabled={saving}
            className={`rounded px-4 py-2 text-white ${saving ? "bg-emerald-400" : "bg-emerald-600 hover:bg-emerald-700"}`}
          >
            {saving ? "Saving…" : "Save These Lines to DB"}
          </button>
          <span className="text-xs text-gray-500">Calls <code>/api/save-companies</code> directly (no xAI).</span>
        </div>
      </div>

      {/* Discovery controls */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">Target results (1–25)</label>
          <input
            type="number" min="1" max="25" value={maxImports}
            onChange={(e) => setMaxImports(Math.max(1, Math.min(25, Number(e.target.value) || 1)))}
            className="w-full border rounded px-3 py-2"
          />
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
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Search Field</label>
          <select value={searchField} onChange={(e) => setSearchField(e.target.value)} className="w-full border rounded px-3 py-2">
            {fields.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </div>
        <div className="md:col-span-2">
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
      </div>

      {/* Center + Address */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-2">
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
          <button onClick={handleImport} className="rounded px-4 py-2 text-white bg-blue-600 hover:bg-blue-700">Start Import</button>
          <button onClick={handleClear} className="bg-red-600 hover:bg-red-700 text-white rounded px-4 py-2">Clear</button>
        </div>
      </div>

      {/* Address fields to auto-geocode when lat/lng are blank */}
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

      {/* Live stream */}
      {sessionId ? (
        <BulkImportStream
          sessionId={sessionId}
          take={400}
          pollingMs={1500}
          onStats={(s) => { setSavedSoFar(s.saved || 0); setLastRowTs(s.lastCreatedAt || ""); }}
        />
      ) : (
        <p className="text-sm text-gray-500">Start an import or click “Resume last stream”.</p>
      )}
    </div>
  );
}
