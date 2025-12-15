import React, { useEffect, useMemo, useRef, useState } from "react";
import { API_BASE } from "@/lib/api";

export default function BulkImportStream({
  sessionId,
  targetResults = 10,
  take = 200,
  pollingMs = 1500,
  stopRequested = false,
  importState = "running",
  onStats = () => {},
  onSuccess = () => {},
  onFailure = () => {},
  onStopped = () => {},
}) {
  const [items, setItems] = useState([]);
  const [steps, setSteps] = useState([]);
  const [err, setErr] = useState("");

  const timerRef = useRef(null);
  const failureCountRef = useRef(0);
  const lastActivityRef = useRef(Date.now());
  const lastSavedRef = useRef(0);
  const hasEmittedRef = useRef(false);
  const stopInitiatedRef = useRef(false);
  const stopRequestSentRef = useRef(false);

  const MAX_CONSECUTIVE_FAILURES = 10;
  const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

  const isActive = importState === "starting" || importState === "running";

  const statusBadge = useMemo(() => {
    if (importState === "stopped_by_user") {
      return { label: "Stopped by user", className: "bg-yellow-100 text-yellow-800" };
    }
    if (importState === "error") {
      return { label: "Error", className: "bg-red-100 text-red-800" };
    }
    if (importState === "completed_with_results" || importState === "completed_no_results") {
      return { label: "Completed", className: "bg-emerald-100 text-emerald-800" };
    }
    if (isActive) {
      return { label: "Running", className: "bg-emerald-100 text-emerald-800" };
    }
    return { label: "Idle", className: "bg-gray-100 text-gray-800" };
  }, [importState, isActive]);

  async function tick() {
    if (!sessionId) return;
    if (!isActive) return;

    try {
      const url = `${API_BASE}/import/progress?session_id=${encodeURIComponent(sessionId)}&take=${encodeURIComponent(take)}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      const r = await fetch(url, {
        method: "GET",
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || r.statusText);

      const saved = Number(j.saved || 0);
      const returnedItems = j.items || [];
      const isStopped = !!j.stopped;
      const isTimedOut = !!j.timedOut;
      const isCompleted = !!j.completed;

      const stopSignal = isStopped && !isTimedOut && !isCompleted;
      const noResultsCompleted = isCompleted && saved === 0;

      setItems(returnedItems);
      setSteps(j.steps || []);
      onStats({ saved, lastCreatedAt: j.lastCreatedAt || "" });

      setErr("");
      failureCountRef.current = 0;
      lastActivityRef.current = Date.now();
      lastSavedRef.current = saved;

      if (hasEmittedRef.current) return;

      if (isTimedOut) {
        hasEmittedRef.current = true;
        onFailure({ saved, target: targetResults, reason: "timed_out" });
        return;
      }

      if (stopSignal) {
        hasEmittedRef.current = true;
        if (stopInitiatedRef.current) {
          onStopped({ saved, target: targetResults, reason: "stopped_by_user" });
        } else {
          onFailure({ saved, target: targetResults, reason: "stopped" });
        }
        return;
      }

      if (noResultsCompleted) {
        hasEmittedRef.current = true;
        onFailure({ saved: 0, target: targetResults, reason: "completed_no_results" });
        return;
      }

      if (saved >= targetResults) {
        hasEmittedRef.current = true;
        onSuccess({ found: saved, target: targetResults, reason: "target_reached" });
        return;
      }

      scheduleNextTick();
    } catch (e) {
      failureCountRef.current += 1;
      const errorMsg = e?.message || "fetch failed";

      const timeSinceLastActivity = Date.now() - lastActivityRef.current;
      if (timeSinceLastActivity > INACTIVITY_TIMEOUT_MS) {
        if (!hasEmittedRef.current) {
          hasEmittedRef.current = true;
          const saved = lastSavedRef.current;
          onFailure({ saved, target: targetResults, reason: "inactivity_timeout" });
        }
        return;
      }

      if (failureCountRef.current >= MAX_CONSECUTIVE_FAILURES) {
        setErr(`⚠️ Progress endpoint unreachable after ${MAX_CONSECUTIVE_FAILURES} attempts. Import may have succeeded. Check database or use "Resume last stream" to retry.`);
        scheduleNextTick();
        return;
      }

      if (failureCountRef.current <= 3) {
        setErr(`⏳ Connecting… (attempt ${failureCountRef.current}/${MAX_CONSECUTIVE_FAILURES}) — ${errorMsg}`);
      } else {
        setErr(`⏳ Still connecting (${failureCountRef.current}/${MAX_CONSECUTIVE_FAILURES})…`);
      }

      scheduleNextTick();
    }
  }

  function scheduleNextTick() {
    if (!sessionId) return;
    if (!isActive) return;
    if (hasEmittedRef.current) return;
    timerRef.current = setTimeout(tick, pollingMs);
  }

  useEffect(() => {
    clearTimeout(timerRef.current);

    failureCountRef.current = 0;
    lastActivityRef.current = Date.now();
    lastSavedRef.current = 0;
    hasEmittedRef.current = false;
    stopInitiatedRef.current = false;
    stopRequestSentRef.current = false;

    if (sessionId && isActive) tick();

    return () => clearTimeout(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, take, pollingMs, targetResults, isActive]);

  useEffect(() => {
    if (!sessionId) return;
    if (!isActive) return;
    if (!stopRequested) return;
    if (stopRequestSentRef.current) return;
    if (hasEmittedRef.current) return;

    stopInitiatedRef.current = true;
    stopRequestSentRef.current = true;

    (async () => {
      try {
        const url = `${API_BASE}/import/stop`;
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId }),
        }).catch(() => {});
      } catch (e) {
        console.warn("Failed to notify server of stop:", e);
      }
    })();
  }, [stopRequested, sessionId, isActive]);

  const progressPercent = Math.min(100, Math.round((items.length / Math.max(1, targetResults)) * 100));

  return (
    <div className="mt-4 border rounded p-3 bg-white">
      <div className="flex items-center justify-between mb-2">
        <div className="font-semibold">Streaming Results ({items.length}/{targetResults})</div>
        <span className={`text-xs px-2 py-1 rounded ${statusBadge.className}`}>{statusBadge.label}</span>
      </div>

      <div className="mb-2 bg-gray-200 rounded-full h-2 overflow-hidden">
        <div className="bg-emerald-500 h-2 transition-all duration-300" style={{ width: `${progressPercent}%` }} />
      </div>

      {isActive && err && <div className="text-sm text-red-600 mb-2">{err}</div>}

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
                <div>
                  <strong>{s.status}</strong> — {s.message || ""}
                </div>
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
