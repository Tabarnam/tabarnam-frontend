import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, readJsonOrText, API_BASE, join } from "@/lib/api";
import AdminHeader from "@/components/AdminHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  RefreshCw,
  Play,
  Pause,
  Square,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Search,
  RotateCw,
  ChevronDown,
  ChevronRight,
  Activity,
  Stethoscope,
  Clock,
} from "lucide-react";

const STATUS_COLORS = {
  running: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400",
  paused: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
  completed: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  cancelled: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
};

const STATE_PILL = {
  scored: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400",
  manual: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
  unscored: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
};

function StatusBadge({ status }) {
  if (!status) return null;
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[status] || STATUS_COLORS.cancelled}`}>
      {status}
    </span>
  );
}

function StateBadge({ state }) {
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${STATE_PILL[state] || STATE_PILL.unscored}`}>
      {state}
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

function formatDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return "—";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m ${rem}s`;
}

function useElapsed(startIso, endIso) {
  // If endIso is provided, the duration is frozen at endIso - startIso.
  // Otherwise it ticks every 500ms off Date.now().
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startIso || endIso) return undefined;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [startIso, endIso]);
  if (!startIso) return null;
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) return null;
  if (endIso) {
    const end = Date.parse(endIso);
    if (!Number.isNaN(end)) return Math.max(0, end - start);
  }
  return Math.max(0, now - start);
}

function formatRelativeAge(ms) {
  if (ms == null || Number.isNaN(ms)) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s - m * 60}s ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m - h * 60}m ago`;
}

function JobHealth({ job, onRunDiagnostics, diagnostics, diagnosing }) {
  const status = job?.status;
  const isTerminal = status === "cancelled" || status === "completed" || status === "failed";
  // For terminal statuses, freeze elapsed at the terminal timestamp (cancelled_at
  // / completed_at / failed_at, falling back to last_updated). Live clocks on
  // terminal jobs mislead the operator.
  const terminalAt =
    isTerminal
      ? job?.cancelled_at || job?.completed_at || job?.failed_at || job?.last_updated || null
      : null;
  const startedMs = useElapsed(job?.started_at, terminalAt);
  const lastUpdatedMs = useElapsed(job?.last_updated);
  if (!job) return null;

  const cycleCount = job.cycle_count || 0;
  const processed = job.processed || 0;
  const failed = job.failed || 0;
  const total = job.total_to_score || 0;
  const jobIdShort = (job.job_id || "").slice(0, 8);

  // Stall detection only applies while the job is running. Suppress on terminal.
  const stalledNoProgress = !isTerminal && status === "running" && cycleCount === 0 && (startedMs || 0) > 60_000;
  const stalledMidRun = !isTerminal && status === "running" && cycleCount > 0 && (lastUpdatedMs || 0) > 120_000;
  const isStalled = stalledNoProgress || stalledMidRun;

  return (
    <div
      className={`rounded-lg border p-4 space-y-2 ${
        isStalled
          ? "border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/15"
          : "border-slate-200 dark:border-border bg-white dark:bg-card"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground flex items-center gap-2">
          <Clock className="h-4 w-4" />
          Job Health
          <StatusBadge status={status} />
          <span className="text-xs font-mono text-muted-foreground">#{jobIdShort}</span>
        </h2>
        <Button
          variant="outline"
          size="sm"
          onClick={onRunDiagnostics}
          disabled={diagnosing}
        >
          {diagnosing ? (
            <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
          ) : (
            <Stethoscope className="h-3.5 w-3.5 mr-1" />
          )}
          Run diagnostics
        </Button>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div>
          <div className="text-muted-foreground">{isTerminal ? "Ran for" : "Started"}</div>
          <div className="text-foreground tabular-nums">
            {isTerminal
              ? (startedMs != null ? formatDuration(startedMs) : "—")
              : formatRelativeAge(startedMs)}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground">Last updated</div>
          <div className="text-foreground tabular-nums">{formatRelativeAge(lastUpdatedMs)}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Cycles</div>
          <div className="text-foreground tabular-nums">{cycleCount}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Processed / Total</div>
          <div className="text-foreground tabular-nums">
            {processed} / {total}
            {failed > 0 ? <span className="text-red-500"> · {failed} failed</span> : null}
          </div>
        </div>
      </div>
      {stalledNoProgress ? (
        <div className="text-xs text-amber-800 dark:text-amber-300 border-t border-amber-200 dark:border-amber-800/50 pt-2">
          ⚠️ Job has been in <code className="font-mono">running</code> for{" "}
          {formatRelativeAge(startedMs).replace(" ago", "")} but no batch has completed. The queue
          worker (dedicated app) may not be picking up messages. Click <strong>Run diagnostics</strong> above.
        </div>
      ) : null}
      {stalledMidRun ? (
        <div className="text-xs text-amber-800 dark:text-amber-300 border-t border-amber-200 dark:border-amber-800/50 pt-2">
          ⚠️ Job last updated {formatRelativeAge(lastUpdatedMs)} — the worker may have stopped.
        </div>
      ) : null}
      {diagnostics ? (
        <div className="text-xs border-t border-slate-200 dark:border-border pt-2 space-y-1">
          <div className="font-medium text-foreground">Diagnostics</div>
          <div className="font-mono text-muted-foreground whitespace-pre-wrap break-all">
            {diagnostics.recommendation || "—"}
          </div>
          <div className="text-muted-foreground">
            role: <span className="text-foreground">{diagnostics.role || "unknown"}</span>
            {" · "}
            queue_trigger: <span className="text-foreground">
              {diagnostics.has_queue_trigger
                ? "registered"
                : diagnostics.role === "enqueuer"
                  ? "n/a (worker-side)"
                  : "MISSING"}
            </span>
            {" · "}
            connection: <span className="text-foreground">{diagnostics.connection_ready ? "ready" : "MISSING"}</span>
            {diagnostics.queue_name ? <> · queue: <span className="text-foreground">{diagnostics.queue_name}</span></> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NowProcessing({ current }) {
  const elapsedMs = useElapsed(current?.started_at);
  if (!current?.name) return null;
  return (
    <div className="rounded-lg border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/15 p-3 flex items-center gap-3">
      <Activity className="h-4 w-4 text-emerald-600 dark:text-emerald-400 animate-pulse flex-none" />
      <div className="flex-1 min-w-0">
        <div className="text-xs text-muted-foreground">Now processing</div>
        <div className="text-sm font-medium text-foreground truncate">
          {current.name}
          {current.domain ? <span className="text-muted-foreground font-normal"> · {current.domain}</span> : null}
        </div>
      </div>
      <div className="text-sm tabular-nums text-emerald-700 dark:text-emerald-400 flex-none">
        {elapsedMs != null ? formatDuration(elapsedMs) : "—"}
      </div>
    </div>
  );
}

function ActivityRow({ r, onRetry, retryingId }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = !r.ok && r.reason && r.reason.length > 40;
  const canRetry = !r.ok && r.company_id && r.normalized_domain && onRetry;
  const isRetrying = retryingId === r.company_id;
  return (
    <div className="py-1.5 text-sm">
      <div className="flex items-center gap-2">
        {r.ok ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-500 flex-none" />
        ) : (
          <XCircle className="h-4 w-4 text-red-500 flex-none" />
        )}
        <span className="text-foreground font-medium truncate flex-1">{r.company_name}</span>
        {r.ok ? (
          <span className="text-xs text-muted-foreground flex-none">
            Rep: {typeof r.star4 === "number" ? r.star4.toFixed(2) : "—"} &middot; Qual: {typeof r.star5 === "number" ? r.star5.toFixed(2) : "—"}
          </span>
        ) : (
          <span className="text-xs text-red-500 flex-none truncate max-w-[260px]">{r.reason}</span>
        )}
        {r.duration_ms != null ? (
          <span className="text-[10px] text-muted-foreground tabular-nums flex-none w-14 text-right">
            {formatDuration(r.duration_ms)}
          </span>
        ) : (
          <span className="flex-none w-14" />
        )}
        {hasDetail ? (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground flex-none"
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? "Collapse" : "Show full reason"}
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        ) : null}
        {canRetry ? (
          <button
            type="button"
            className="text-xs text-primary hover:underline flex items-center gap-0.5 flex-none"
            onClick={() => onRetry(r)}
            disabled={isRetrying}
            title="Re-score this company via admin-score-company with force=true"
          >
            {isRetrying ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RotateCw className="h-3 w-3" />
            )}
            retry
          </button>
        ) : null}
      </div>
      {expanded && hasDetail ? (
        <div className="mt-1 ml-6 text-xs text-red-500 font-mono whitespace-pre-wrap break-all">
          {r.reason}
        </div>
      ) : null}
    </div>
  );
}

function CompaniesTable({ companies, loading, onRefresh, onRetry, retryingId, onScoreMany, bulkScoring, onDismissBulkSummary }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all"); // all | scored | manual | unscored
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState(() => new Set());
  const pageSize = 50;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (companies || []).filter((c) => {
      if (filter !== "all" && c.state !== filter) return false;
      if (!q) return true;
      return (
        (c.name || "").toLowerCase().includes(q) ||
        (c.domain || "").toLowerCase().includes(q) ||
        (c.id || "").toLowerCase().includes(q)
      );
    });
  }, [companies, search, filter]);

  // Reset page when filters change
  useEffect(() => {
    setPage(0);
  }, [search, filter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageRows = filtered.slice(page * pageSize, page * pageSize + pageSize);

  const counts = useMemo(() => {
    const c = { all: 0, scored: 0, manual: 0, unscored: 0 };
    for (const row of companies || []) {
      c.all++;
      c[row.state] = (c[row.state] || 0) + 1;
    }
    return c;
  }, [companies]);

  const toggleOne = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const pageAllSelected = pageRows.length > 0 && pageRows.every((r) => selected.has(r.id));
  const togglePage = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (pageAllSelected) {
        for (const r of pageRows) next.delete(r.id);
      } else {
        for (const r of pageRows) next.add(r.id);
      }
      return next;
    });
  };

  const selectAllFiltered = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of filtered) next.add(r.id);
      return next;
    });
  };

  const clearSelection = () => setSelected(new Set());

  const selectedCompanies = useMemo(
    () => (companies || []).filter((c) => selected.has(c.id)),
    [companies, selected]
  );

  const handleScoreSelected = () => {
    if (selectedCompanies.length === 0 || !onScoreMany) return;
    const n = selectedCompanies.length;
    if (n > 20) {
      const ok = window.confirm(
        `Score ${n} companies? Each takes ~30-60s, so this could run for roughly ${Math.ceil((n * 45) / 60)} minutes. Runs sequentially in the browser — keep this tab open until it finishes.`
      );
      if (!ok) return;
    }
    onScoreMany(selectedCompanies).then(() => {
      clearSelection();
    });
  };

  return (
    <div className="bg-white dark:bg-card rounded-lg border border-slate-200 dark:border-border p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground">Company Search</h2>
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1 ${loading ? "animate-spin" : ""}`} />
          {companies ? "Reload" : "Load companies"}
        </Button>
      </div>

      {companies ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, domain, or id…"
                className="h-8 pl-7 text-sm"
              />
            </div>
            {["all", "scored", "manual", "unscored"].map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`h-8 px-2.5 rounded text-xs font-medium border transition-colors ${
                  filter === f
                    ? "bg-slate-900 text-white border-slate-900 dark:bg-foreground dark:text-background dark:border-foreground"
                    : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50 dark:bg-card dark:text-muted-foreground dark:border-border dark:hover:bg-muted"
                }`}
              >
                {f} <span className="opacity-70">({counts[f] ?? 0})</span>
              </button>
            ))}
          </div>

          {/* Selection bar */}
          {selected.size > 0 ? (
            <div className="flex flex-wrap items-center gap-2 px-3 py-2 rounded bg-emerald-50 dark:bg-emerald-900/15 border border-emerald-200 dark:border-emerald-800">
              <span className="text-sm font-medium text-emerald-800 dark:text-emerald-300">
                {selected.size} selected
              </span>
              {selected.size < filtered.length ? (
                <button
                  type="button"
                  onClick={selectAllFiltered}
                  className="text-xs text-emerald-700 dark:text-emerald-400 hover:underline"
                >
                  Select all {filtered.length} filtered
                </button>
              ) : null}
              <button
                type="button"
                onClick={clearSelection}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Clear
              </button>
              <div className="ml-auto">
                <Button
                  size="sm"
                  onClick={handleScoreSelected}
                  disabled={bulkScoring?.active}
                >
                  {bulkScoring?.active ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      Scoring {bulkScoring.done}/{bulkScoring.total}…
                    </>
                  ) : (
                    <>Score selected ({selected.size})</>
                  )}
                </Button>
              </div>
            </div>
          ) : null}

          {bulkScoring?.active && bulkScoring.current ? (
            <div className="text-xs text-muted-foreground">
              Currently scoring: <span className="text-foreground font-medium">{bulkScoring.current}</span>
              {bulkScoring.lastError ? (
                <span className="ml-2 text-red-500">· last error: {bulkScoring.lastError}</span>
              ) : null}
            </div>
          ) : null}

          {!bulkScoring?.active && bulkScoring?.completedAt ? (
            <div className={`rounded border p-2 text-xs ${
              bulkScoring.errors.length > 0
                ? "border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20"
                : "border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-900/20"
            }`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-foreground">
                  Scored {bulkScoring.done - bulkScoring.errors.length} of {bulkScoring.total}
                  {bulkScoring.errors.length > 0 ? ` · ${bulkScoring.errors.length} failed` : ""}
                </span>
                {onDismissBulkSummary ? (
                  <button
                    type="button"
                    onClick={onDismissBulkSummary}
                    className="text-muted-foreground hover:text-foreground text-[11px]"
                  >
                    Dismiss
                  </button>
                ) : null}
              </div>
              {bulkScoring.errors.length > 0 ? (
                <ul className="mt-1 space-y-0.5 list-disc list-inside text-red-600 dark:text-red-400">
                  {bulkScoring.errors.map((msg, i) => (
                    <li key={i} className="break-all">{msg}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          <div className="text-xs text-muted-foreground">
            Showing {filtered.length === 0 ? 0 : page * pageSize + 1}–{Math.min(filtered.length, page * pageSize + pageSize)} of {filtered.length}
          </div>

          <div className="border border-slate-200 dark:border-border rounded overflow-hidden">
            <div className="grid grid-cols-[32px_1fr_180px_70px_70px_70px_140px] gap-2 bg-slate-50 dark:bg-muted px-2 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wide items-center">
              <div>
                <input
                  type="checkbox"
                  checked={pageAllSelected}
                  onChange={togglePage}
                  title={pageAllSelected ? "Deselect page" : "Select all on this page"}
                  className="h-3.5 w-3.5"
                />
              </div>
              <div>Company</div>
              <div>Domain</div>
              <div className="text-right">Rep</div>
              <div className="text-right">Qual</div>
              <div className="text-center">State</div>
              <div>Updated</div>
            </div>
            <div className="divide-y divide-slate-100 dark:divide-border max-h-[500px] overflow-y-auto">
              {pageRows.map((c) => {
                const isSelected = selected.has(c.id);
                return (
                  <div
                    key={c.id}
                    className={`grid grid-cols-[32px_1fr_180px_70px_70px_70px_140px] gap-2 px-2 py-1.5 text-xs items-center ${
                      isSelected ? "bg-emerald-50/50 dark:bg-emerald-900/10" : "hover:bg-slate-50 dark:hover:bg-muted/50"
                    }`}
                  >
                    <div>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleOne(c.id)}
                        className="h-3.5 w-3.5"
                      />
                    </div>
                    <div className="truncate">
                      <span className="text-foreground font-medium">{c.name || "(unnamed)"}</span>
                      {onRetry && c.state !== "unscored" ? (
                        <button
                          type="button"
                          className="ml-2 text-[10px] text-primary hover:underline"
                          onClick={() =>
                            onRetry({ company_id: c.id, normalized_domain: c.domain, company_name: c.name })
                          }
                          disabled={retryingId === c.id}
                          title="Re-score via admin-score-company with force=true"
                        >
                          {retryingId === c.id ? "…" : "rescore"}
                        </button>
                      ) : null}
                    </div>
                    <div className="truncate text-muted-foreground">{c.domain || "—"}</div>
                    <div className="text-right tabular-nums text-foreground">{typeof c.star4 === "number" ? c.star4.toFixed(2) : "—"}</div>
                    <div className="text-right tabular-nums text-foreground">{typeof c.star5 === "number" ? c.star5.toFixed(2) : "—"}</div>
                    <div className="text-center"><StateBadge state={c.state} /></div>
                    <div className="text-muted-foreground truncate tabular-nums">
                      {c.updated_at ? new Date(c.updated_at).toLocaleString("sv-SE").slice(0, 16) : "—"}
                    </div>
                  </div>
                );
              })}
              {pageRows.length === 0 ? (
                <div className="text-center text-xs text-muted-foreground py-4">No matches</div>
              ) : null}
            </div>
          </div>

          {totalPages > 1 ? (
            <div className="flex items-center justify-center gap-2 text-xs">
              <Button size="sm" variant="outline" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
                Prev
              </Button>
              <span className="text-muted-foreground">
                Page {page + 1} / {totalPages}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
              >
                Next
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <div className="text-xs text-muted-foreground">
          Click "Load companies" to pull the full list (~5k rows). Filter by scoring state and search by name or domain.
        </div>
      )}
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
  const [companies, setCompanies] = useState(null);
  const [loadingCompanies, setLoadingCompanies] = useState(false);
  const [retryingId, setRetryingId] = useState(null);
  const [bulkScoring, setBulkScoring] = useState({ active: false, done: 0, total: 0, current: null, lastError: null, errors: [], completedAt: null });
  const [diagnostics, setDiagnostics] = useState(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const intervalRef = useRef(null);
  // Stall watchdog state — tracks (job_id, last_updated, last_seen_at) so we can
  // detect a worker that has stopped making progress and kick a fresh one.
  const lastProgressRef = useRef({ jobId: null, lastUpdated: null, lastSeenAt: 0 });
  const workerKickInFlightRef = useRef(false);

  // Fire-and-forget POST to the score-batch-worker. Keepalive allows it to
  // survive a page nav/unload; we never await the response. Mirrors the
  // admin/import → primary-worker pattern in AdminImport.jsx.
  const kickScoreBatchWorker = useCallback((jobId, cycleCount = 0) => {
    if (!jobId) return;
    if (workerKickInFlightRef.current) return;
    workerKickInFlightRef.current = true;
    try {
      const workerUrl = join(API_BASE, "xadmin-api-score-batch-worker");
      fetch(workerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: jobId, cycle_count: cycleCount }),
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
      const res = await apiFetch("/xadmin-api-score-status");
      const data = await readJsonOrText(res);
      if (data && typeof data === "object") {
        setStatus(data);
        if (data.error) {
          setError(data.error);
        } else if (data.query_error) {
          setError(`Query failed: ${data.query_error}`);
        } else {
          setError(null);
        }
      }
    } catch (e) {
      setError(e?.message || "Failed to fetch status");
    }
  }, []);

  const fetchCompanies = useCallback(async () => {
    setLoadingCompanies(true);
    try {
      const res = await apiFetch("/xadmin-api-score-status?action=list-all");
      const data = await readJsonOrText(res);
      if (data?.ok && Array.isArray(data.companies)) {
        setCompanies(data.companies);
      } else {
        setError(data?.error || "Failed to load company list");
      }
    } catch (e) {
      setError(e?.message || "Failed to load companies");
    } finally {
      setLoadingCompanies(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    setLoading(true);
    fetchStatus().finally(() => setLoading(false));
  }, [fetchStatus]);

  // Polling — 3s while running (live updates), 30s otherwise
  useEffect(() => {
    const jobStatus = status?.job?.status;
    const interval = jobStatus === "running" ? 3000 : 30000;
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(fetchStatus, interval);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [status?.job?.status, fetchStatus]);

  // Stall watchdog — if the job is running but last_updated hasn't advanced
  // for >60s, assume the previous score-batch-worker invocation exited (time
  // cap, function restart, transient error) and fire a fresh one to resume.
  useEffect(() => {
    const job = status?.job;
    if (!job || job.status !== "running" || !job.job_id) {
      lastProgressRef.current = { jobId: null, lastUpdated: null, lastSeenAt: 0 };
      return;
    }
    const now = Date.now();
    const prev = lastProgressRef.current;
    const lastUpdated = job.last_updated || null;

    if (prev.jobId !== job.job_id || prev.lastUpdated !== lastUpdated) {
      // Progress advanced (or new job) — reset the watchdog window.
      lastProgressRef.current = { jobId: job.job_id, lastUpdated, lastSeenAt: now };
      return;
    }

    // Same (jobId, last_updated) as last poll — check staleness.
    const stalledMs = now - (prev.lastSeenAt || now);
    if (stalledMs > 60000) {
      kickScoreBatchWorker(job.job_id, job.cycle_count || 0);
      // Push the window forward so we don't re-kick every 3s while waiting
      // for the new worker's first write.
      lastProgressRef.current = { jobId: job.job_id, lastUpdated, lastSeenAt: now };
    }
  }, [status?.job?.job_id, status?.job?.status, status?.job?.last_updated, status?.job?.cycle_count, kickScoreBatchWorker]);

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
        // Kick the inline worker immediately. The worker drives scoring
        // via processBackfillScoreBatch until the job is done or it hits
        // the 9-min time cap. If it exits early, the stall watchdog below
        // re-fires it.
        if (data.job_id) {
          kickScoreBatchWorker(data.job_id, 0);
        }
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

  const handleScoreMany = async (companiesToScore) => {
    if (!Array.isArray(companiesToScore) || companiesToScore.length === 0) return;
    setError(null);
    setBulkScoring({ active: true, done: 0, total: companiesToScore.length, current: null, lastError: null, errors: [], completedAt: null });
    try {
      for (let i = 0; i < companiesToScore.length; i++) {
        const c = companiesToScore[i];
        const label = c?.name || c?.id || "(unknown)";
        if (!c?.id || !c?.domain) {
          const msg = `${label}: missing id/domain`;
          setBulkScoring((prev) => ({ ...prev, done: i + 1, lastError: msg, errors: [...prev.errors, msg] }));
          continue;
        }
        setBulkScoring((prev) => ({ ...prev, current: label }));
        try {
          const res = await apiFetch("/xadmin-api-score-company", {
            method: "POST",
            body: JSON.stringify({
              company_id: c.id,
              normalized_domain: c.domain,
              force: true,
            }),
          });
          const data = await readJsonOrText(res);
          if (!data?.ok) {
            const msg = `${label}: ${data?.reason || data?.error || "unknown"}`;
            setBulkScoring((prev) => ({ ...prev, lastError: msg, errors: [...prev.errors, msg] }));
          }
        } catch (e) {
          const msg = `${label}: ${e?.message || "request failed"}`;
          setBulkScoring((prev) => ({ ...prev, lastError: msg, errors: [...prev.errors, msg] }));
        }
        setBulkScoring((prev) => ({ ...prev, done: i + 1 }));
      }
    } finally {
      setBulkScoring((prev) => ({ ...prev, active: false, current: null, completedAt: new Date().toISOString() }));
      await fetchStatus();
      if (companies) await fetchCompanies();
    }
  };

  const runDiagnostics = async () => {
    setDiagnosing(true);
    setError(null);
    try {
      const res = await apiFetch("/xadmin-api-diag-triggers");
      const data = await readJsonOrText(res);
      if (data && typeof data === "object") {
        const diag = data.diagnostics || {};
        setDiagnostics({
          recommendation: diag.recommendation || null,
          has_queue_trigger: Boolean(diag.has_queue_trigger),
          connection_ready: Boolean(diag.connection_ready),
          role: diag.role || data.host?.role || null,
          site_name: data.host?.site_name || null,
          queue_name: data.queue_configuration?.queue_name || null,
          raw: data,
        });
      } else {
        setError("Diagnostics returned a non-JSON response");
      }
    } catch (e) {
      setError(`Diagnostics failed: ${e?.message || e}`);
    } finally {
      setDiagnosing(false);
    }
  };

  const dismissBulkSummary = () => {
    setBulkScoring({ active: false, done: 0, total: 0, current: null, lastError: null, errors: [], completedAt: null });
  };

  const handleRetry = async (row) => {
    if (!row?.company_id || !row?.normalized_domain) return;
    setRetryingId(row.company_id);
    setError(null);
    try {
      const res = await apiFetch("/xadmin-api-score-company", {
        method: "POST",
        body: JSON.stringify({
          company_id: row.company_id,
          normalized_domain: row.normalized_domain,
          force: true,
        }),
      });
      const data = await readJsonOrText(res);
      if (!data?.ok) {
        setError(`Retry failed for ${row.company_name || row.company_id}: ${data?.reason || data?.error || "unknown"}`);
      } else {
        // Refresh status and company list if loaded
        await fetchStatus();
        if (companies) await fetchCompanies();
      }
    } catch (e) {
      setError(e?.message || "Retry failed");
    } finally {
      setRetryingId(null);
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
  const currentCompany = isRunning ? job?.current_company : null;

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

        {/* Job health — always visible when a job exists */}
        {job ? (
          <JobHealth
            job={job}
            onRunDiagnostics={runDiagnostics}
            diagnostics={diagnostics}
            diagnosing={diagnosing}
          />
        ) : null}

        {/* Now processing banner */}
        {currentCompany ? <NowProcessing current={currentCompany} /> : null}

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
          <div className="bg-white dark:bg-card rounded-lg border border-slate-200 dark:border-border p-4 space-y-2">
            <h2 className="text-sm font-medium text-foreground">
              Recent Activity <span className="text-muted-foreground font-normal">(last {batchResults.length})</span>
            </h2>
            <div className="divide-y divide-slate-100 dark:divide-border max-h-[480px] overflow-y-auto">
              {batchResults.map((r, i) => (
                <ActivityRow key={`${r.company_id || r.company_name}-${i}`} r={r} onRetry={handleRetry} retryingId={retryingId} />
              ))}
            </div>
          </div>
        )}

        {/* Companies search table */}
        <CompaniesTable
          companies={companies}
          loading={loadingCompanies}
          onRefresh={fetchCompanies}
          onRetry={handleRetry}
          retryingId={retryingId}
          onScoreMany={handleScoreMany}
          bulkScoring={bulkScoring}
          onDismissBulkSummary={dismissBulkSummary}
        />

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
