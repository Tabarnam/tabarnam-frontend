import React from "react";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/toast";
import { normalizeImportLimit, toDisplayText, toPrettyJsonText } from "./importUtils";

export default function ImportDebugPanel({
  debugQuery,
  setDebugQuery,
  debugLimitInput,
  setDebugLimitInput,
  debugSessionId,
  setDebugSessionId,
  debugStartLoading,
  debugStatusLoading,
  startImportDisabled,
  pollingSessionId,
  sessionIdMismatchDebug,
  debugStartResponseText,
  debugStatusResponseText,
  startDebugImport,
  explainDebugImport,
  checkDebugStatus,
}) {
  return (
    <section className="rounded-lg border border-slate-200 dark:border-border bg-white dark:bg-card p-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-foreground">Import Debug Panel (temporary)</h2>
        <div className="text-xs text-slate-500 dark:text-muted-foreground">Tries /api/import/start (fallback /api/import-start) and /api/import/status (fallback /api/import-status).</div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="md:col-span-2 space-y-1">
          <label className="text-sm text-slate-700 dark:text-muted-foreground">Query string</label>
          <Input
            value={debugQuery}
            onChange={(e) => setDebugQuery(e.target.value)}
            placeholder="query string"
          />
        </div>

        <div className="space-y-1">
          <label className="text-sm text-slate-700 dark:text-muted-foreground">Limit (number)</label>
          <Input
            value={debugLimitInput}
            onChange={(e) => {
              const next = e.target.value;
              if (next === "" || /^\d+$/.test(next)) {
                setDebugLimitInput(next);
              }
            }}
            onBlur={() => setDebugLimitInput((prev) => String(normalizeImportLimit(prev)))}
            inputMode="numeric"
            placeholder="1"
          />
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-sm text-slate-700 dark:text-muted-foreground">Session id (for status)</label>
        <Input value={debugSessionId} onChange={(e) => setDebugSessionId(e.target.value)} placeholder="session id" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={startDebugImport} disabled={debugStartLoading || startImportDisabled}>
          {debugStartLoading ? "Starting\u2026" : "Start (debug)"}
        </Button>

        <Button variant="outline" onClick={explainDebugImport} disabled={debugStartLoading}>
          Explain payload
        </Button>

        <Button variant="outline" onClick={checkDebugStatus} disabled={debugStatusLoading || !debugSessionId.trim()}>
          {debugStatusLoading ? "Checking\u2026" : "Check Status"}
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-3">
          <div className="text-xs font-medium text-slate-700 dark:text-muted-foreground">session_id</div>
          <div className="mt-1 flex items-start justify-between gap-2">
            <code className="text-xs text-slate-900 dark:text-foreground break-all">{debugSessionId || "\u2014"}</code>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              disabled={!debugSessionId}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(debugSessionId);
                  toast.success("Copied session_id");
                } catch (e) {
                  toast.error(e?.message || "Copy failed");
                }
              }}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          <div className="mt-2 text-[11px] text-slate-600 dark:text-muted-foreground">
            Polling session_id: <code className="text-[11px] text-slate-900 dark:text-foreground break-all">{pollingSessionId || "\u2014"}</code>
          </div>

          {sessionIdMismatchDebug ? (
            <pre className="mt-2 max-h-24 overflow-auto rounded bg-white dark:bg-card p-2 text-[11px] leading-relaxed text-slate-900 dark:text-foreground">
              {toDisplayText(toPrettyJsonText(sessionIdMismatchDebug))}
            </pre>
          ) : null}
        </div>

        <div className="rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-3">
          <div className="text-xs font-medium text-slate-700 dark:text-muted-foreground">Start response</div>
          <pre className="mt-2 max-h-48 overflow-auto rounded bg-white dark:bg-card p-2 text-[11px] leading-relaxed text-slate-900 dark:text-foreground">{toDisplayText(debugStartResponseText)}</pre>
        </div>
      </div>

      <div className="rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-3">
        <div className="text-xs font-medium text-slate-700 dark:text-muted-foreground">Status response</div>
        <pre className="mt-2 max-h-64 overflow-auto rounded bg-white dark:bg-card p-2 text-[11px] leading-relaxed text-slate-900 dark:text-foreground">{toDisplayText(debugStatusResponseText)}</pre>
      </div>
    </section>
  );
}
