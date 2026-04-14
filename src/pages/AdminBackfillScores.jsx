import React, { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, readJsonOrText } from "@/lib/api";
import AdminHeader from "@/components/AdminHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RefreshCw, Play, Pause, Square, Loader2, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";

const STATUS_COLORS = {
  running: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400",
  paused: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
  completed: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  cancelled: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
};

function StatusBadge({ status }) {
  if (!status) return null;
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[status] || STATUS_COLORS.cancelled}`}>
      {status}
    </span>
  );
}

function StatCard({ label, value, sub }) {
  return (
    <div className="bg-white dark:bg-card rounded-lg border border-slate-200 dark:border-border p-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="text-2xl font-bold text-foreground mt-1">{value ?? "—"}</div>
      {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
    </div>
  );
}

function ProgressBar({ processed, total }) {
  if (!total || total <= 0) return null;
  const pct = Math.min(100, Math.round((processed / total) * 100));
  return (
    <div className="w-full bg-slate-200 dark:bg-muted rounded-full h-3 overflow-hidden">
      <div
        className="bg-emerald-500 h-3 rounded-full transition-all duration-500"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export default function AdminBackfillScores() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [actionLoading, setActionLoading] = useState(null);
  const [batchSize, setBatchSize] = useState(12);
  const [maxCompanies, setMaxCompanies] = useState("");
  const [error, setError] = useState(null);
  const intervalRef = useRef(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await apiFetch("/xadmin-api-score-status");
      const data = await readJsonOrText(res);
      if (data && typeof data === "object") {
        setStatus(data);
        setError(null);
      }
    } catch (e) {
      setError(e?.message || "Failed to fetch status");
    }
  }, []);

  // Initial load
  useEffect(() => {
    setLoading(true);
    fetchStatus().finally(() => setLoading(false));
  }, [fetchStatus]);

  // Polling when job is active
  useEffect(() => {
    const jobStatus = status?.job?.status;
    if (jobStatus === "running") {
      intervalRef.current = setInterval(fetchStatus, 30000);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [status?.job?.status, fetchStatus]);

  const handleStart = async () => {
    setStarting(true);
    setError(null);
    try {
      const body = {
        batch_size: batchSize,
        max_companies: maxCompanies ? Number(maxCompanies) : null,
      };
      const res = await apiFetch("/xadmin-api-score-all-missing", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const data = await readJsonOrText(res);
      if (data?.ok) {
        await fetchStatus();
      } else {
        setError(data?.error || "Failed to start backfill");
      }
    } catch (e) {
      setError(e?.message || "Failed to start");
    } finally {
      setStarting(false);
    }
  };

  const handleAction = async (action) => {
    const jobId = status?.job?.job_id;
    if (!jobId) return;
    setActionLoading(action);
    setError(null);
    try {
      const res = await apiFetch(`/xadmin-api-score-status?action=${action}&job_id=${jobId}`);
      const data = await readJsonOrText(res);
      if (data?.ok) {
        await fetchStatus();
      } else {
        setError(data?.error || `Failed to ${action}`);
      }
    } catch (e) {
      setError(e?.message || `Failed to ${action}`);
    } finally {
      setActionLoading(null);
    }
  };

  const job = status?.job;
  const jobStatus = job?.status;
  const isRunning = jobStatus === "running";
  const isPaused = jobStatus === "paused";
  const processed = job?.processed ?? 0;
  const failed = job?.failed ?? 0;
  const totalToScore = job?.total_to_score ?? status?.missing_companies ?? 0;
  const remaining = job?.remaining ?? status?.missing_companies ?? 0;
  const estimatedMinutes = job?.estimated_minutes_remaining;
  const batchResults = Array.isArray(job?.last_batch_results) ? job.last_batch_results : [];

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-background">
      <AdminHeader />
      <div className="max-w-5xl mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-foreground">Backfill Reputation & Quality Scores</h1>
          <Button variant="outline" size="sm" onClick={() => { setLoading(true); fetchStatus().finally(() => setLoading(false)); }}>
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {error && (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-sm text-red-700 dark:text-red-400 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 flex-none" />
            {error}
          </div>
        )}

        {/* Stats cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard label="Total Companies" value={status?.total_companies?.toLocaleString()} />
          <StatCard label="Scored" value={status?.scored_companies?.toLocaleString()} />
          <StatCard label="Missing" value={status?.missing_companies?.toLocaleString()} />
          <StatCard
            label="Job Status"
            value={job ? <StatusBadge status={jobStatus} /> : "No job"}
            sub={job ? `Cycle ${job.cycle_count || 0}` : null}
          />
        </div>

        {/* Progress bar */}
        {job && totalToScore > 0 && (
          <div className="space-y-2">
            <ProgressBar processed={processed} total={totalToScore} />
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                {processed.toLocaleString()} processed
                {failed > 0 ? ` (${failed} failed)` : ""}
              </span>
              <span>
                {remaining.toLocaleString()} remaining
                {estimatedMinutes != null ? ` \u00b7 ~${estimatedMinutes} min` : ""}
              </span>
            </div>
          </div>
        )}

        {/* Controls */}
        <div className="bg-white dark:bg-card rounded-lg border border-slate-200 dark:border-border p-4 space-y-4">
          <h2 className="text-sm font-medium text-foreground">Controls</h2>
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Batch size</label>
              <Input
                type="number"
                min={1}
                max={50}
                value={batchSize}
                onChange={(e) => setBatchSize(Math.max(1, Math.min(50, Number(e.target.value) || 12)))}
                className="w-20 h-9"
                disabled={isRunning}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Max companies (blank = all)</label>
              <Input
                type="number"
                min={1}
                value={maxCompanies}
                onChange={(e) => setMaxCompanies(e.target.value)}
                placeholder="all"
                className="w-28 h-9"
                disabled={isRunning}
              />
            </div>

            <div className="flex items-center gap-2">
              {!isRunning && !isPaused && (
                <Button onClick={handleStart} disabled={starting || loading}>
                  {starting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
                  Start Backfill
                </Button>
              )}
              {isRunning && (
                <Button variant="outline" onClick={() => handleAction("pause")} disabled={actionLoading === "pause"}>
                  {actionLoading === "pause" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Pause className="h-4 w-4 mr-2" />}
                  Pause
                </Button>
              )}
              {isPaused && (
                <Button onClick={() => handleAction("resume")} disabled={actionLoading === "resume"}>
                  {actionLoading === "resume" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
                  Resume
                </Button>
              )}
              {(isRunning || isPaused) && (
                <Button variant="destructive" onClick={() => handleAction("cancel")} disabled={actionLoading === "cancel"}>
                  {actionLoading === "cancel" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Square className="h-4 w-4 mr-2" />}
                  Cancel
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Activity log */}
        {batchResults.length > 0 && (
          <div className="bg-white dark:bg-card rounded-lg border border-slate-200 dark:border-border p-4 space-y-3">
            <h2 className="text-sm font-medium text-foreground">Recent Activity (last 20)</h2>
            <div className="divide-y divide-slate-100 dark:divide-border">
              {batchResults.map((r, i) => (
                <div key={i} className="flex items-center gap-3 py-2 text-sm">
                  {r.ok ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500 flex-none" />
                  ) : (
                    <XCircle className="h-4 w-4 text-red-500 flex-none" />
                  )}
                  <span className="text-foreground font-medium truncate flex-1">{r.company_name}</span>
                  {r.ok ? (
                    <span className="text-xs text-muted-foreground flex-none">
                      Rep: {r.star4?.toFixed(2)} &middot; Qual: {r.star5?.toFixed(2)}
                    </span>
                  ) : (
                    <span className="text-xs text-red-500 flex-none truncate max-w-[200px]">{r.reason}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Job details */}
        {job && (
          <details className="bg-white dark:bg-card rounded-lg border border-slate-200 dark:border-border p-4">
            <summary className="text-sm font-medium text-foreground cursor-pointer">Job Details</summary>
            <pre className="mt-3 text-xs text-muted-foreground overflow-x-auto whitespace-pre-wrap">
              {JSON.stringify(job, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}
