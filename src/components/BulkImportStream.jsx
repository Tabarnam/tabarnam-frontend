import React, { useEffect, useRef, useState } from "react";
import { API_BASE } from "@/lib/api";

export default function BulkImportStream({
  sessionId,
  targetResults = 10,
  take = 200,
  pollingMs = 1500,
  stopRequested = false,
  onStats = () => {},
  onSuccess = () => {},
  onFailure = () => {}
}) {
  const [items, setItems] = useState([]);
  const [steps, setSteps] = useState([]);
  const [stopped, setStopped] = useState(false);
  const [err, setErr] = useState("");
  const timerRef = useRef(null);
  const failureCountRef = useRef(0);
  const lastActivityRef = useRef(Date.now());
  const hasEmittedRef = useRef(false);
  const MAX_CONSECUTIVE_FAILURES = 10;
  const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  async function tick() {
    if (!sessionId) return;
    try {
      const url = `${API_BASE}/import/progress?session_id=${encodeURIComponent(sessionId)}&take=${encodeURIComponent(take)}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 seconds per request

      const r = await fetch(url, {
        method: "GET",
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || r.statusText);
      
      const saved = j.saved || 0;
      const items = j.items || [];
      
      setItems(items);
      setSteps(j.steps || []);
      setStopped(!!j.stopped);
      onStats({ saved, lastCreatedAt: j.lastCreatedAt || "" });
      setErr("");
      failureCountRef.current = 0;
      
      // Update last activity time
      lastActivityRef.current = Date.now();
      
      // Check if target reached
      if (!hasEmittedRef.current && saved >= targetResults) {
        hasEmittedRef.current = true;
        onSuccess({ found: saved, target: targetResults });
        return;
      }
      
      // Continue polling
      scheduleNextTick();
    } catch (e) {
      failureCountRef.current += 1;
      const errorMsg = e?.message || "fetch failed";

      // Check for inactivity timeout
      const timeSinceLastActivity = Date.now() - lastActivityRef.current;
      if (timeSinceLastActivity > INACTIVITY_TIMEOUT_MS) {
        if (!hasEmittedRef.current) {
          hasEmittedRef.current = true;
          const currentStats = { saved: items.length, target: targetResults };
          if (items.length > 0) {
            onFailure(currentStats);
          } else {
            setErr("❌ Search timed out with no results. Please try again.");
          }
        }
        return;
      }

      // If we've had too many consecutive failures, show a message but stop retrying
      if (failureCountRef.current >= MAX_CONSECUTIVE_FAILURES) {
        setErr(`⚠️ Progress endpoint unreachable after ${MAX_CONSECUTIVE_FAILURES} attempts. Import may have succeeded. Check database or use "Resume last stream" to retry.`);
        scheduleNextTick();
        return;
      }

      // Show temporary error on initial failures
      if (failureCountRef.current <= 3) {
        setErr(`⏳ Connecting… (attempt ${failureCountRef.current}/${MAX_CONSECUTIVE_FAILURES}) — ${errorMsg}`);
      } else {
        setErr(`⏳ Still connecting (${failureCountRef.current}/${MAX_CONSECUTIVE_FAILURES})…`);
      }
      
      scheduleNextTick();
    }
  }

  function scheduleNextTick() {
    if (stopRequested) {
      return;
    }
    timerRef.current = setTimeout(tick, pollingMs);
  }

  useEffect(() => {
    clearTimeout(timerRef.current);
    failureCountRef.current = 0;
    lastActivityRef.current = Date.now();
    hasEmittedRef.current = false;
    if (sessionId && !stopRequested) tick();
    return () => clearTimeout(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, take, pollingMs, targetResults, stopRequested]);

  const progressPercent = Math.min(100, Math.round((items.length / Math.max(1, targetResults)) * 100));

  return (
    <div className="mt-4 border rounded p-3 bg-white">
      <div className="flex items-center justify-between mb-2">
        <div className="font-semibold">Streaming Results ({items.length}/{targetResults})</div>
        {stopped ? <span className="text-xs px-2 py-1 bg-gray-200 rounded">Stopped</span> : <span className="text-xs px-2 py-1 bg-emerald-100 text-emerald-800 rounded">Running</span>}
      </div>
      
      {/* Progress bar */}
      <div className="mb-2 bg-gray-200 rounded-full h-2 overflow-hidden">
        <div
          className="bg-emerald-500 h-2 transition-all duration-300"
          style={{ width: `${progressPercent}%` }}
        />
      </div>
      
      {err && <div className="text-sm text-red-600 mb-2">{err}</div>}
      
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
