// src/UserTools.js
import React, { useEffect, useState } from "react";
import PinIcon from "@/assets/tabarnam-pin.jpg";
import { API_BASE } from "@/lib/api";

const UserTools = () => {
  const [companies, setCompanies] = useState([]);
  const [query, setQuery] = useState("candles");
  const [maxImports, setMaxImports] = useState(10);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [saveResult, setSaveResult] = useState(null);

  const fetchCompanies = async () => {
    const q = (query || "").trim();
    if (!q) { setStatus("Enter a search query."); return; }
    setStatus("Searching…"); setLoading(true); setCompanies([]); setSaveResult(null);

    try {
      const session_id = (crypto?.randomUUID?.() || `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`);
      const res = await fetch(`${API_BASE}/import/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queryType: "product_keyword",
          query: q,
          limit: Math.max(1, Math.min(Number(maxImports) || 1, 25)),
          session_id,
          timeout_ms: 600000
        }),
      });

      if (!res.ok) throw new Error(`${res.status} ${res.statusText} – ${(await res.text()) || "Proxy error"}`);
      const data = await res.json();
      const items = Array.isArray(data?.companies) ? data.companies : [];
      setCompanies(items);
      setStatus(items.length ? `✅ Loaded ${items.length} companies.` : "⚠️ No companies returned.");
    } catch (e) {
      console.error("Fetch error:", e);
      setStatus(`❌ ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const saveAll = async () => {
    if (!companies.length) { setStatus("Nothing to save."); return; }
    setSaving(true); setStatus("Saving…"); setSaveResult(null);
    try {
      const res = await fetch(`${API_BASE}/save-companies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companies }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || res.statusText);
      setSaveResult(data);
      setStatus(`💾 Saved ${data.saved} companies${data.failed ? `, ${data.failed} failed` : ""}.`);
    } catch (e) {
      setStatus(`❌ Save error: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => { fetchCompanies(); /* initial */ }, []);

  const exportToCSV = () => {
    if (!companies.length) return;
    const headers = ["Name","Industries","Keywords","Website","Amazon","Tagged","Confidence","Red Flag","Reason","Distance (mi)"];
    const rows = companies.map(c => [
      csv(c.company_name),
      csv(Array.isArray(c.industries) ? c.industries.join("; ") : c.industries),
      csv(c.product_keywords),
      csv(c.url),
      csv(c.amazon_url),
      csv(c.amazon_url ? (c.amazon_url_tagged ? "Yes" : "No") : ""),
      csv(c.confidence_score != null ? `${(c.confidence_score*100).toFixed(0)}%` : ""),
      csv(c.red_flag ? "true" : "false"),
      csv(c.red_flag_reason || ""),
      csv(c.distance_miles != null ? c.distance_miles : ""),
    ].join(","));
    const txt = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([txt], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = "companies.csv"; a.click(); URL.revokeObjectURL(url);
  };

  const exportToJSON = () => {
    const blob = new Blob([JSON.stringify(companies, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = "companies.json"; a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h2 className="text-2xl font-bold mb-4">User Tools</h2>

      <div className="flex flex-col md:flex-row gap-3 md:items-end mb-4">
        <div className="flex-1">
          <label className="block text-sm font-medium text-gray-700 mb-1">Search query</label>
          <input type="text" value={query} onChange={(e)=>setQuery(e.target.value)} placeholder='e.g., "candles"'
                 className="w-full border rounded px-3 py-2" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Number (1–20)</label>
          <input type="number" min={1} max={20} value={maxImports}
                 onChange={(e)=>setMaxImports(Math.max(1, Math.min(20, Number(e.target.value)||1)))}
                 className="w-28 border rounded px-3 py-2" />
        </div>
        <button onClick={fetchCompanies}
                className={`rounded px-4 py-2 text-white ${loading ? "bg-blue-400" : "bg-blue-600 hover:bg-blue-700"}`}
                disabled={loading}>
          {loading ? "Searching…" : "Search"}
        </button>
        <button onClick={saveAll}
                className={`rounded px-4 py-2 text-white ${saving || !companies.length ? "bg-emerald-400" : "bg-emerald-600 hover:bg-emerald-700"}`}
                disabled={saving || !companies.length}>
          {saving ? "Saving…" : "Save to DB"}
        </button>
      </div>

      <div className="mb-3 text-sm text-gray-700">
        {status}
        {saveResult && (
          <span className="ml-2 text-gray-600">Saved: {saveResult.saved} • Failed: {saveResult.failed}</span>
        )}
      </div>

      <div className="flex gap-2 mb-3">
        <button onClick={()=>navigator.clipboard.writeText(JSON.stringify(companies, null, 2))}
                className="bg-green-600 hover:bg-green-700 text-white rounded px-3 py-2 disabled:opacity-50"
                disabled={!companies.length}>
          Copy JSON
        </button>
        <button onClick={exportToJSON}
                className="bg-yellow-600 hover:bg-yellow-700 text-white rounded px-3 py-2 disabled:opacity-50"
                disabled={!companies.length}>
          Export JSON
        </button>
        <button onClick={exportToCSV}
                className="bg-indigo-600 hover:bg-indigo-700 text-white rounded px-3 py-2 disabled:opacity-50"
                disabled={!companies.length}>
          Export CSV
        </button>
      </div>

      <div className="overflow-auto border rounded">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-100 text-left">
            <tr>
              <th className="p-2">Name</th>
              <th className="p-2">Industries</th>
              <th className="p-2">Keywords</th>
              <th className="p-2">Website</th>
              <th className="p-2">Amazon</th>
              <th className="p-2">Tagged</th>
              <th className="p-2">Confidence</th>
              <th className="p-2">Red Flag</th>
              <th className="p-2">Reason</th>
              <th className="p-2">Distance</th>
            </tr>
          </thead>
          <tbody>
            {companies.map((c, i) => (
              <tr key={(c.company_name || "row") + "-" + i} className="border-t">
                <td className="p-2">{c.company_name || "—"}</td>
                <td className="p-2">{Array.isArray(c.industries) ? c.industries.join(", ") : (c.industries || "—")}</td>
                <td className="p-2">
                  {String(c.product_keywords || "").split(",").map(s=>s.trim()).filter(Boolean).slice(0,6).join(", ")}
                </td>
                <td className="p-2">
                  {c.url ? <a href={c.url} target="_blank" rel="noreferrer" className="text-blue-600 underline">{c.url}</a> : "—"}
                </td>
                <td className="p-2">
                  {c.amazon_url ? <a href={c.amazon_url} target="_blank" rel="noreferrer" className="text-blue-600 underline">Amazon</a> : "—"}
                </td>
                <td className="p-2">{c.amazon_url ? (c.amazon_url_tagged ? "Yes" : "No") : "—"}</td>
                <td className="p-2">{c.confidence_score != null ? `${(c.confidence_score*100).toFixed(0)}%` : "—"}</td>
                <td className="p-2">{c.red_flag ? "🚩" : "—"}</td>
                <td className="p-2">{c.red_flag_reason || "—"}</td>
                <td className="p-2">
                  {c.distance_miles != null ? (
                    <span className="inline-flex items-center gap-1">
                      <img src={PinIcon} alt="Distance" className="inline-block w-4 h-4 rounded-full object-contain" />
                      {c.distance_miles} mi
                    </span>
                  ) : "—"}
                </td>
              </tr>
            ))}
            {!companies.length && !loading && (
              <tr><td className="p-4 text-gray-500" colSpan={10}>No results yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

function csv(v){ if(v==null) return '""'; const s=String(v); return `"${s.replace(/"/g,'""')}"`; }

export default UserTools;
