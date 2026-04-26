import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Helmet } from "react-helmet-async";
import { CheckCircle2, ChevronDown, ChevronUp, Loader2, Pause, Play, Square, AlertTriangle, ImageIcon } from "lucide-react";

import AdminHeader from "@/components/AdminHeader";
import { Button } from "@/components/ui/button";
import { apiFetch, readJsonOrText, API_BASE, join } from "@/lib/api";

const POLL_RUNNING_MS = 3_000;
const POLL_IDLE_MS = 30_000;
const STALL_THRESHOLD_MS = 180_000;

function fmtTime(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleTimeString(); } catch { return "—"; }
}
function fmtElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}m ${r}s`;
}

export default function AdminBackfillHomepages() {
  const [status, setStatus] = useState(null);
  const [starting, setStarting] = useState(false);
  const [actionLoading, setActionLoading] = useState(null);
  const [batchSize, setBatchSize] = useState(50);
  const [concurrency, setConcurrency] = useState(5);
  const [maxCompanies, setMaxCompanies] = useState("");
  const [includeFailed, setIncludeFailed] = useState(false);
  const [error, setError] = useState(null);
  const [sessionCompleted, setSessionCompleted] = useState([]);
  const [logOpen, setLogOpen] = useState(false);

  const intervalRef = useRef(null);
  const lastProgressRef = useRef({ jobId: null, lastUpdated: null, lastSeenAt: 0 });
  const workerKickInFlightRef = useRef(false);

  const kickWorker = useCallback((jobId) => {
    if (!jobId || workerKickInFlightRef.current) return;
    workerKickInFlightRef.current = true;
    try {
      const url = join(API_BASE, "xadmin-api-backfill-homepages-worker");
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: jobId }),
        keepalive: true,
      })
        .catch(() => {})
        .finally(() => { workerKickInFlightRef.current = false; });
    } catch {
      workerKickInFlightRef.current = false;
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await apiFetch("/xadmin-api-backfill-homepages-status");
      const data = await readJsonOrText(res);
      if (data && typeof data === "object") {
        setStatus(data);
        setError(data.error || data.query_error || null);

        const incoming = Array.isArray(data?.job?.last_batch_results) ? data.job.last_batch_results : [];
        if (incoming.length > 0) {
          setSessionCompleted((prev) => {
            const seen = new Set(prev.map((x) => x.company_id || x.company_name));
            const adds = [];
            for (let i = incoming.length - 1; i >= 0; i--) {
              const r = incoming[i];
              const key = r?.company_id || r?.company_name;
              if (!key || seen.has(key)) continue;
              seen.add(key);
              adds.push(r);
            }
            if (adds.length === 0) return prev;
            return [...prev, ...adds];
          });
        }

        // Stall watchdog: if status is "running" but last_updated hasn't moved
        // for STALL_THRESHOLD_MS, kick the worker directly. Server status
        // endpoint also self-drives, but a stall here means polling missed it.
        const job = data?.job;
        if (job && job.status === "running") {
          const now = Date.now();
          const tracked = lastProgressRef.current;
          if (tracked.jobId !== job.job_id || tracked.lastUpdated !== job.last_updated) {
            lastProgressRef.current = { jobId: job.job_id, lastUpdated: job.last_updated, lastSeenAt: now };
          } else if (now - tracked.lastSeenAt > STALL_THRESHOLD_MS) {
            kickWorker(job.job_id);
            lastProgressRef.current = { ...tracked, lastSeenAt: now };
          }
        } else {
          lastProgressRef.current = { jobId: null, lastUpdated: null, lastSeenAt: 0 };
        }
      }
    } catch (e) {
      setError(e?.message || "Failed to load status");
    }
  }, [kickWorker]);

  // Polling
  useEffect(() => {
    fetchStatus();
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [fetchStatus]);

  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    const running = status?.job?.status === "running";
    intervalRef.current = setInterval(fetchStatus, running ? POLL_RUNNING_MS : POLL_IDLE_MS);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [status?.job?.status, fetchStatus]);

  const startBackfill = useCallback(async () => {
    setStarting(true);
    setError(null);
    setSessionCompleted([]);
    try {
      const body = { batch_size: batchSize, concurrency, include_failed: includeFailed };
      const m = String(maxCompanies).trim();
      if (m && Number.isFinite(Number(m))) body.max_companies = Number(m);
      const res = await apiFetch("/xadmin-api-backfill-homepages-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await readJsonOrText(res);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      // Kick the worker immediately so we don't wait for the next poll
      if (data?.job_id) kickWorker(data.job_id);
      await fetchStatus();
    } catch (e) {
      setError(e?.message || "Failed to start backfill");
    } finally {
      setStarting(false);
    }
  }, [batchSize, concurrency, includeFailed, maxCompanies, fetchStatus, kickWorker]);

  const sendAction = useCallback(async (action) => {
    const jobId = status?.job?.job_id;
    if (!jobId) return;
    setActionLoading(action);
    try {
      const res = await apiFetch(`/xadmin-api-backfill-homepages-status?action=${action}&job_id=${encodeURIComponent(jobId)}`, { method: "POST" });
      const data = await readJsonOrText(res);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      if (action === "resume" && data?.job_id) kickWorker(data.job_id);
      await fetchStatus();
    } catch (e) {
      setError(e?.message || `Failed to ${action} job`);
    } finally {
      setActionLoading(null);
    }
  }, [status?.job?.job_id, fetchStatus, kickWorker]);

  const job = status?.job || null;
  const isRunning = job?.status === "running";
  const isPaused = job?.status === "paused";

  const progressPct = useMemo(() => {
    if (!job || !job.total_to_process) return 0;
    const pct = ((job.processed || 0) / job.total_to_process) * 100;
    return Math.min(100, Math.max(0, pct));
  }, [job]);

  return (
    <>
      <Helmet><title>Admin - Backfill Homepages</title></Helmet>
      <AdminHeader />

      <div className="bg-slate-950 min-h-screen p-6">
        <div className="max-w-[1200px] mx-auto">
          <h1 className="text-2xl font-bold text-white mb-1">Backfill Homepages</h1>
          <p className="text-slate-400 text-sm mb-6">
            Fetch homepage screenshots via Microlink for any company that has a website but no homepage image.
            Mirrors the backfill-scores set-and-forget pattern: clicking Start kicks off a background job that
            survives page closes and worker recycles. Successful screenshots land unapproved — review them in
            <a href="/admin/images" className="text-teal-400 hover:underline mx-1">/admin/images</a>
            before they go public.
          </p>

          {error && (
            <div className="bg-red-900/30 border border-red-700 text-red-300 rounded p-3 mb-4 text-sm">
              {error}
            </div>
          )}

          {/* Counts */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <div className="rounded-lg border border-slate-800 bg-slate-900 p-3">
              <div className="text-xs uppercase text-slate-500 tracking-wider">Total</div>
              <div className="text-2xl font-semibold text-white">{status?.total_companies?.toLocaleString() ?? "—"}</div>
            </div>
            <div className="rounded-lg border border-emerald-900/50 bg-emerald-950/30 p-3">
              <div className="text-xs uppercase text-emerald-300/80 tracking-wider">With homepage</div>
              <div className="text-2xl font-semibold text-emerald-300">{status?.companies_with_homepage?.toLocaleString() ?? "—"}</div>
            </div>
            <div className="rounded-lg border border-amber-900/50 bg-amber-950/30 p-3">
              <div className="text-xs uppercase text-amber-300/80 tracking-wider">Missing</div>
              <div className="text-2xl font-semibold text-amber-300">{status?.companies_missing_homepage?.toLocaleString() ?? "—"}</div>
            </div>
            <div className="rounded-lg border border-rose-900/50 bg-rose-950/30 p-3">
              <div className="text-xs uppercase text-rose-300/80 tracking-wider">Previously failed</div>
              <div className="text-2xl font-semibold text-rose-300">{status?.companies_failed?.toLocaleString() ?? "—"}</div>
            </div>
          </div>

          {/* Controls */}
          <section className="rounded-lg border border-slate-800 bg-slate-900 p-4 mb-6">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Batch size (per invocation)</label>
                <input type="number" min={1} max={500} value={batchSize}
                  onChange={(e) => setBatchSize(Number(e.target.value) || 50)}
                  className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm text-slate-100"
                />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Concurrency (parallel calls)</label>
                <input type="number" min={1} max={20} value={concurrency}
                  onChange={(e) => setConcurrency(Number(e.target.value) || 5)}
                  className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm text-slate-100"
                />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Max companies (blank = all)</label>
                <input type="number" min={1} value={maxCompanies}
                  onChange={(e) => setMaxCompanies(e.target.value)}
                  placeholder="all"
                  className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm text-slate-100"
                />
              </div>
              <div className="flex items-end">
                <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                  <input type="checkbox" checked={includeFailed}
                    onChange={(e) => setIncludeFailed(e.target.checked)}
                    className="w-4 h-4"
                  />
                  Retry previously failed
                </label>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button onClick={startBackfill} disabled={starting || isRunning} className="bg-teal-600 hover:bg-teal-500 text-white">
                {starting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Play className="w-4 h-4 mr-1" />}
                Start backfill
              </Button>
              {isRunning && (
                <Button onClick={() => sendAction("pause")} disabled={actionLoading === "pause"}
                  variant="outline" className="border-amber-600/50 text-amber-300 hover:bg-amber-900/30">
                  {actionLoading === "pause" ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Pause className="w-4 h-4 mr-1" />}
                  Pause
                </Button>
              )}
              {isPaused && (
                <Button onClick={() => sendAction("resume")} disabled={actionLoading === "resume"}
                  variant="outline" className="border-emerald-600/50 text-emerald-300 hover:bg-emerald-900/30">
                  {actionLoading === "resume" ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Play className="w-4 h-4 mr-1" />}
                  Resume
                </Button>
              )}
              {(isRunning || isPaused) && (
                <Button onClick={() => sendAction("cancel")} disabled={actionLoading === "cancel"}
                  variant="outline" className="border-rose-600/50 text-rose-300 hover:bg-rose-900/30">
                  {actionLoading === "cancel" ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Square className="w-4 h-4 mr-1" />}
                  Cancel
                </Button>
              )}
            </div>
          </section>

          {/* Job state */}
          {job && (
            <section className="rounded-lg border border-slate-800 bg-slate-900 p-4 mb-6">
              <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-slate-400">Job:</span>
                  <code className="text-xs bg-slate-800 px-2 py-0.5 rounded text-slate-300">{job.job_id}</code>
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                    job.status === "running" ? "bg-emerald-900/40 text-emerald-300" :
                    job.status === "paused" ? "bg-amber-900/40 text-amber-300" :
                    job.status === "cancelled" ? "bg-rose-900/40 text-rose-300" :
                    job.status === "completed" ? "bg-teal-900/40 text-teal-300" :
                    "bg-slate-800 text-slate-300"
                  }`}>{job.status}</span>
                  {job.cycle_count != null && (
                    <span className="text-xs text-slate-500">cycle {job.cycle_count}</span>
                  )}
                </div>
                <div className="text-xs text-slate-500">
                  Started {fmtTime(job.started_at)}
                  {job.estimated_minutes_remaining != null && isRunning && (
                    <span className="ml-3 text-slate-400">~{job.estimated_minutes_remaining}m remaining</span>
                  )}
                </div>
              </div>

              {/* Progress bar */}
              <div className="mb-2">
                <div className="flex justify-between text-xs text-slate-400 mb-1">
                  <span>{(job.processed || 0).toLocaleString()} / {(job.total_to_process || 0).toLocaleString()} processed</span>
                  <span>
                    <span className="text-rose-300">{(job.failed || 0).toLocaleString()} failed</span>
                    <span className="mx-2">·</span>
                    <span>{(job.remaining || 0).toLocaleString()} remaining</span>
                  </span>
                </div>
                <div className="w-full h-2 bg-slate-800 rounded overflow-hidden">
                  <div className="h-full bg-teal-500 transition-all" style={{ width: `${progressPct}%` }} />
                </div>
              </div>

              {/* In-flight */}
              {Array.isArray(job.current_companies) && job.current_companies.length > 0 && (
                <div className="mt-4">
                  <div className="text-xs uppercase tracking-wider text-slate-500 mb-2">Now processing ({job.current_companies.length})</div>
                  <ul className="space-y-1">
                    {job.current_companies.slice(0, 10).map((c) => {
                      const startedMs = Date.parse(c.started_at || "") || 0;
                      const elapsed = startedMs ? Date.now() - startedMs : 0;
                      return (
                        <li key={c.id} className="flex items-center gap-2 text-xs text-slate-300">
                          <Loader2 className="w-3 h-3 animate-spin text-teal-400" />
                          <span className="truncate">{c.name}</span>
                          {c.domain && <span className="text-slate-500">· {c.domain}</span>}
                          <span className="text-slate-500 ml-auto">{fmtElapsed(elapsed)}</span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </section>
          )}

          {/* Recent results */}
          {Array.isArray(job?.last_batch_results) && job.last_batch_results.length > 0 && (
            <section className="rounded-lg border border-slate-800 bg-slate-900 p-4 mb-6">
              <div className="text-xs uppercase tracking-wider text-slate-500 mb-2">Recent results (last {job.last_batch_results.length})</div>
              <ul className="space-y-1 max-h-80 overflow-y-auto pr-2">
                {job.last_batch_results.map((r, i) => (
                  <li key={`${r.company_id}-${i}`} className="flex items-center gap-2 text-xs">
                    {r.ok
                      ? <CheckCircle2 className="w-3 h-3 text-emerald-400 flex-shrink-0" />
                      : <AlertTriangle className="w-3 h-3 text-rose-400 flex-shrink-0" />
                    }
                    <span className={`truncate ${r.ok ? "text-slate-200" : "text-slate-300"}`}>{r.company_name}</span>
                    {r.normalized_domain && <span className="text-slate-500">· {r.normalized_domain}</span>}
                    {!r.ok && r.reason && (
                      <span className="text-rose-400/80 ml-auto truncate max-w-[40%]" title={r.reason}>{r.reason}</span>
                    )}
                    {r.ok && (
                      <span className="text-slate-500 ml-auto">{fmtElapsed(r.duration_ms)}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Session log */}
          {sessionCompleted.length > 0 && (
            <section className="rounded-lg border border-slate-800 bg-slate-900">
              <button type="button" onClick={() => setLogOpen((v) => !v)} className="w-full flex items-center justify-between p-3 text-sm text-slate-300 hover:bg-slate-800/50">
                <span className="flex items-center gap-2">
                  <ImageIcon className="w-4 h-4" />
                  Session log ({sessionCompleted.length})
                </span>
                {logOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>
              {logOpen && (
                <div className="border-t border-slate-800 p-3">
                  <ul className="space-y-1 max-h-96 overflow-y-auto pr-2">
                    {sessionCompleted.map((r, i) => (
                      <li key={`${r.company_id}-session-${i}`} className="flex items-center gap-2 text-xs">
                        {r.ok ? <CheckCircle2 className="w-3 h-3 text-emerald-400" /> : <AlertTriangle className="w-3 h-3 text-rose-400" />}
                        <span className="truncate">{r.company_name}</span>
                        {!r.ok && r.reason && <span className="text-rose-400/80 ml-2 truncate" title={r.reason}>{r.reason}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </>
  );
}
