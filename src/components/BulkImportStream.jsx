// src/components/BulkImportStream.jsx
import React, { useEffect, useRef, useState } from "react";
import { API_BASE } from "@/lib/api";

export default function BulkImportStream({ sessionId, take = 200, pollingMs = 1500, onStats = () => {} }) {
  const [items, setItems] = useState([]);
  const [steps, setSteps] = useState([]);
  const [stopped, setStopped] = useState(false);
  const [err, setErr] = useState("");
  const timerRef = useRef(null);

  async function tick() {
    if (!sessionId) return;
    try {
      const url = `${API_BASE}/import/progress?session_id=${encodeURIComponent(sessionId)}&take=${encodeURIComponent(take)}`;
      const r = await fetch(url, { method: "GET" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || r.statusText);
      setItems(j.items || []);
      setSteps(j.steps || []);
      setStopped(!!j.stopped);
      onStats({ saved: j.saved || 0, lastCreatedAt: j.lastCreatedAt || "" });
      setErr("");
    } catch (e) {
      setErr(e?.message || "fetch failed");
    } finally {
      timerRef.current = setTimeout(tick, pollingMs);
    }
  }

  useEffect(() => {
    clearTimeout(timerRef.current);
    if (sessionId) tick();
    return () => clearTimeout(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, take, pollingMs]);

  return (
    <div className="mt-4 border rounded p-3 bg-white">
      <div className="flex items-center justify-between mb-2">
        <div className="font-semibold">Streaming Results</div>
        {stopped ? <span className="text-xs px-2 py-1 bg-gray-200 rounded">Stopped</span> : <span className="text-xs px-2 py-1 bg-emerald-100 text-emerald-800 rounded">Running</span>}
      </div>
      {err && <div className="text-sm text-red-600 mb-2">❌ {err}</div>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <div className="text-xs text-gray-500 mb-1">Items</div>
          <ul className="space-y-2 max-h-96 overflow-auto">
            {items.map((it, i) => (
              <li key={(it?.id || "row") + "-" + i} className="border rounded p-2">
                <div className="font-medium">{it?.company_name || it?.name || "—"}</div>
                <div className="text-xs text-gray-600">{it?.url || it?.website_url || ""}</div>
              </li>
            ))}
            {!items.length && <li className="text-sm text-gray-500">No items yet…</li>}
          </ul>
        </div>
        <div>
          <div className="text-xs text-gray-500 mb-1">Steps</div>
          <ul className="space-y-2 max-h-96 overflow-auto">
            {(steps || []).map((s, i) => (
              <li key={i} className="border rounded p-2 text-xs">
                <div><strong>{s.status}</strong> — {s.message || ""}</div>
                {s.ts && <div className="text-gray-500">{new Date(s.ts).toLocaleString()}</div>}
              </li>
            ))}
            {!steps.length && <li className="text-sm text-gray-500">Waiting for progress…</li>}
          </ul>
        </div>
      </div>
    </div>
  );
}
