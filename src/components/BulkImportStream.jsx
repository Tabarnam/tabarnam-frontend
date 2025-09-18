// src/components/BulkImportStream.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";

export default function BulkImportStream({
  sessionId,
  take = 400,
  pollingMs = 1500,
  onStats = () => {},
}) {
  const [items, setItems] = useState([]);
  const [steps, setSteps] = useState([]);
  const [stopped, setStopped] = useState(false);
  const [err, setErr] = useState("");
  const timerRef = useRef(null);
  const MAX_SHOW = 50;

  function toDateISO(r) {
    if (r?.created_at) return r.created_at;
    if (typeof r?._ts === "number") return new Date(r._ts * 1000).toISOString();
    return "";
  }

  const sortedDesc = useMemo(() => {
    const withDates = (items || []).map((r) => ({
      ...r,
      __iso: toDateISO(r),
    }));
    withDates.sort((a, b) => {
      const da = a.__iso ? Date.parse(a.__iso) : 0;
      const db = b.__iso ? Date.parse(b.__iso) : 0;
      return db - da; // newest first
    });
    return withDates;
  }, [items]);

  const view = useMemo(() => sortedDesc.slice(0, MAX_SHOW), [sortedDesc]);

  // publish stats upward
  useEffect(() => {
    const lastCreatedAt = sortedDesc[0]?.__iso || "";
    onStats({
      saved: items.length,
      lastCreatedAt,
      stopped,
    });
  }, [items, sortedDesc, stopped, onStats]);

  async function tick() {
    if (!sessionId) return;
    try {
      const url = `/api/import-progress?session_id=${encodeURIComponent(
        sessionId
      )}&take=${encodeURIComponent(take)}`;
      const r = await fetch(url, { method: "GET" });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || r.statusText);
      setItems(j.items || []);
      setSteps(j.steps || []);
      setStopped(!!j.stopped);
      setErr("");
    } catch (e) {
      setErr(e?.message || "fetch failed");
    } finally {
      timerRef.current = setTimeout(tick, pollingMs);
    }
  }

  useEffect(() => {
    clearTimeout(timerRef.current);
    tick();
    return () => clearTimeout(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, take, pollingMs]);

  return (
    <div className="mt-4">
      <div className="text-sm text-gray-700 mb-2">
        {err ? (
          <span className="text-red-600">Stream error: {err}</span>
        ) : (
          <>
            Showing {view.length} of {items.length} streamed results (most recent first)
            {stopped && <span className="ml-2 text-emerald-700">✅ Import complete</span>}
          </>
        )}
      </div>

      <ul className="space-y-3">
        {view.map((r, idx) => {
          const when = r.__iso ? new Date(r.__iso) : null;
          const whenText = when ? when.toLocaleString() : "—";
          const industries = Array.isArray(r.industries)
            ? r.industries.join(", ")
            : r.industries || "—";
          const key = r.id || `${r.company_name || "item"}-${idx}`;
          return (
            <li key={key} className="p-3 border rounded flex items-start justify-between gap-3">
              <div>
                <div className="font-medium">{r.company_name || "—"}</div>
                <div className="text-sm text-gray-600">{industries}</div>
                {r.amazon_url ? (
                  <a
                    href={r.amazon_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm text-blue-600 hover:underline"
                  >
                    Amazon
                  </a>
                ) : (
                  <span className="text-sm text-gray-400">—</span>
                )}
              </div>
              <div className="text-xs text-gray-500 whitespace-nowrap">
                Imported: {whenText}
              </div>
            </li>
          );
        })}
      </ul>

      {steps?.length ? (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm text-gray-600">Logs ({steps.length})</summary>
          <pre className="mt-2 bg-gray-50 p-2 rounded text-xs overflow-auto">
            {JSON.stringify(steps, null, 2)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
