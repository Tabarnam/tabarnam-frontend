import React from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";

export default function BulkImportSection({
  bulkMode,
  setBulkMode,
  bulkUrls,
  setBulkUrls,
  bulkEnqueueLoading,
  bulkUrlCount,
  activeBatchId,
  batchJobs,
  handleBulkEnqueue,
  setActiveSessionId,
}) {
  return (
    <section className="rounded-lg border border-slate-200 dark:border-border bg-white dark:bg-card p-5 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-foreground">Bulk Import Queue</h2>
          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={bulkMode}
              onChange={(e) => setBulkMode(e.target.checked)}
              className="rounded border-slate-300"
            />
            Enable
          </label>
        </div>
        {activeBatchId && batchJobs.length > 0 ? (
          <div className="text-sm text-slate-600 dark:text-muted-foreground">
            Batch: <code className="rounded bg-slate-100 dark:bg-muted px-1 py-0.5 text-xs">{activeBatchId.slice(0, 8)}...</code>
          </div>
        ) : null}
      </div>

      {bulkMode ? (
        <>
          <div className="space-y-2">
            <label className="text-sm text-slate-700 dark:text-muted-foreground">Company URLs (one per line, max 50)</label>
            <textarea
              value={bulkUrls}
              onChange={(e) => setBulkUrls(e.target.value)}
              placeholder={"https://example.com\nhttps://another-company.com\nhttps://third-company.com"}
              className="w-full h-32 rounded border border-slate-300 bg-white dark:bg-card px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="flex items-center justify-between">
              <div className="text-xs text-slate-500 dark:text-muted-foreground">{bulkUrlCount} URL{bulkUrlCount !== 1 ? "s" : ""} entered</div>
              <Button
                onClick={handleBulkEnqueue}
                disabled={bulkEnqueueLoading || bulkUrlCount === 0}
              >
                {bulkEnqueueLoading ? "Queueing..." : `Queue ${bulkUrlCount} URL${bulkUrlCount !== 1 ? "s" : ""}`}
              </Button>
            </div>
          </div>

          {batchJobs.length > 0 ? (
            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700 dark:text-muted-foreground">Queue Progress</div>
              <div className="rounded border border-slate-200 dark:border-border divide-y divide-slate-200 max-h-64 overflow-y-auto">
                {batchJobs.map((job) => (
                  <div key={job.job_id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <div className="flex-shrink-0">
                      {job.status === "queued" ? (
                        <span className="inline-flex items-center rounded-full bg-slate-100 dark:bg-muted px-2 py-0.5 text-xs font-medium text-slate-600 dark:text-muted-foreground">
                          Queued
                        </span>
                      ) : job.status === "running" ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
                          <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />
                          Running
                        </span>
                      ) : job.status === "completed" ? (
                        <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                          Done
                        </span>
                      ) : job.status === "failed" ? (
                        <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                          Failed
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-slate-100 dark:bg-muted px-2 py-0.5 text-xs font-medium text-slate-600 dark:text-muted-foreground">
                          {job.status || "Unknown"}
                        </span>
                      )}
                    </div>
                    <div className="flex-1 min-w-0 truncate font-mono text-xs text-slate-600 dark:text-muted-foreground" title={job.url}>
                      {job.url}
                    </div>
                    {job.session_id ? (
                      <button
                        type="button"
                        className="text-xs text-blue-600 hover:underline flex-shrink-0"
                        onClick={() => {
                          setActiveSessionId(job.session_id);
                          toast.success(`Switched to session ${job.session_id.slice(0, 8)}...`);
                        }}
                      >
                        View
                      </button>
                    ) : null}
                    {job.error ? (
                      <span className="text-xs text-red-600 truncate max-w-[120px]" title={job.error}>
                        {job.error}
                      </span>
                    ) : null}
                    {job.result_summary?.saved_count > 0 ? (
                      <span className="text-xs text-emerald-600">
                        {job.result_summary.saved_count} saved
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-4 text-xs text-slate-500 dark:text-muted-foreground">
                <span>Queued: {batchJobs.filter((j) => j.status === "queued").length}</span>
                <span>Running: {batchJobs.filter((j) => j.status === "running").length}</span>
                <span>Completed: {batchJobs.filter((j) => j.status === "completed").length}</span>
                <span>Failed: {batchJobs.filter((j) => j.status === "failed").length}</span>
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <div className="text-sm text-slate-500 dark:text-muted-foreground">
          Enable bulk mode to queue multiple company URLs for sequential import.
        </div>
      )}
    </section>
  );
}
