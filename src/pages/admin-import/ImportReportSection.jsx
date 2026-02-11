import React from "react";
import { Copy, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import { asString, toDisplayText, downloadJsonFile } from "./importUtils";

export default function ImportReportSection({
  activeRun,
  activeReportPayload,
  activeReportText,
  activeDebugText,
  importReportRef,
}) {
  return (
    <section className="rounded-lg border border-slate-300 bg-slate-100 dark:bg-muted shadow">
      <div className="px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <div>
            <div className="text-xs font-medium text-slate-700 dark:text-muted-foreground">Import report</div>
            <div className="text-[10px] text-slate-500 dark:text-muted-foreground">
              Live report — auto-scrolls to bottom. Use buttons to copy/download.
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!activeReportText}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(activeReportText);
                  toast.success("Report copied");
                } catch {
                  toast.error("Could not copy");
                }
              }}
            >
              <Copy className="h-3 w-3 mr-1" />
              Copy
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!activeDebugText}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(activeDebugText);
                  toast.success("Debug JSON copied");
                } catch {
                  toast.error("Could not copy");
                }
              }}
            >
              <Copy className="h-3 w-3 mr-1" />
              Debug
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!activeReportPayload}
              onClick={() => {
                try {
                  const sid = asString(activeRun?.session_id).trim() || "session";
                  downloadJsonFile({ filename: `import-report-${sid}.json`, value: activeReportPayload });
                } catch {
                  toast.error("Download failed");
                }
              }}
            >
              <Download className="h-3 w-3 mr-1" />
              JSON
            </Button>
          </div>
        </div>
        <pre
          ref={importReportRef}
          className="h-[358px] overflow-y-scroll rounded border border-slate-300 bg-white dark:bg-card p-2 text-[11px] leading-relaxed text-slate-900 dark:text-foreground font-mono"
        >
          {activeReportText ? toDisplayText(activeReportText) : "No report yet. Run an import to populate."}
        </pre>
      </div>
    </section>
  );
}
