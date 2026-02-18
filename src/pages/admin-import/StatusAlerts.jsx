import React from "react";
import { AlertTriangle, Volume2 } from "lucide-react";
import {
  asString,
  toEnglishImportStage,
  STAGE_BEACON_PROGRESS_OR_SUCCESS,
} from "./importUtils";

export default function StatusAlerts({
  activeRun,
  activeStatus,
  API_BASE,
  replayNotification,
}) {
  return (
    <>
      {/* Error status */}
      {activeRun?.start_error && !activeRun.completed ? (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 flex items-center gap-4">
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-red-500 text-white">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <div className="flex-1">
            <div className="text-sm font-medium text-red-900">{activeRun.start_error}</div>
            {activeRun.progress_notice ? (
              <div className="text-xs text-red-700 mt-0.5">{activeRun.progress_notice}</div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Live status indicator - keep visible during enrichment even after company is created */}
      {activeRun && activeStatus !== "idle" && (activeStatus === "running" || activeStatus === "stopping" || activeRun.resume_needed || (!activeRun.completed && !activeRun.stopped && !activeRun.timedOut)) ? (
        <div className="rounded-lg border border-blue-300 bg-blue-50 p-4 flex items-center gap-4">
          <div className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-3 w-3 bg-blue-500"></span>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-blue-900">
              {(() => {
                const stageBeacon = asString(activeRun.stage_beacon || activeRun.last_stage_beacon).trim();
                const resumeNeeded = Boolean(activeRun.resume_needed);
                const resumeStatus = asString(activeRun.resume?.status || activeRun.last_status_body?.resume?.status).trim();
                const savedCount = Number(activeRun.saved ?? 0) || 0;
                const missingFields = activeRun.saved_companies?.[0]?.enrichment_health?.missing_fields || [];
                const lastFieldAttempted = asString(activeRun.resume_worker?.last_field_attempted).trim();
                const lastFieldResult = asString(activeRun.resume_worker?.last_field_result).trim();
                const resumeError = asString(activeRun.resume_error || activeRun.last_status_body?.resume_error).trim();

                if (resumeError) {
                  return `Enrichment stalled: ${resumeError.replace(/_/g, " ")}`;
                }

                if (resumeNeeded && missingFields.length > 0) {
                  const fieldList = missingFields.join(", ");
                  if (lastFieldAttempted) {
                    return `Enriching: ${lastFieldAttempted}${lastFieldResult ? ` (${lastFieldResult})` : ""} — still need: ${fieldList}`;
                  }
                  if (resumeStatus === "queued") {
                    return `Waiting for enrichment worker — missing: ${fieldList}`;
                  }
                  return `Fetching missing fields: ${fieldList}`;
                }

                if (stageBeacon) {
                  return toEnglishImportStage(stageBeacon);
                }

                if (savedCount > 0) {
                  return `Company saved, completing enrichment...`;
                }

                return "Import in progress...";
              })()}
            </div>
            <div className="text-xs text-blue-700 mt-0.5">
              {(() => {
                const parts = [];
                const savedCount = Number(activeRun.saved ?? 0) || 0;
                const elapsedMs = Number(activeRun.elapsed_ms);
                const companyName = activeRun.saved_companies?.[0]?.company_name || activeRun.items?.[0]?.company_name;

                if (companyName) parts.push(companyName);
                if (savedCount > 0) parts.push(`${savedCount} saved`);
                if (Number.isFinite(elapsedMs) && elapsedMs > 0) parts.push(`${Math.round(elapsedMs / 1000)}s elapsed`);

                if (parts.length > 0) return parts.join(" · ");
                const notice = asString(activeRun.progress_notice).trim();
                if (notice) return notice;
                return "Starting...";
              })()}
            </div>
          </div>
          {activeRun.progress_notice ? (
            <div className="text-xs text-blue-600 max-w-xs truncate" title={activeRun.progress_notice}>
              {activeRun.progress_notice}
            </div>
          ) : null}
          <button
            type="button"
            onClick={replayNotification}
            className="shrink-0 rounded-md p-1.5 text-blue-600 hover:bg-blue-100 transition-colors"
            title="Replay notification sound"
          >
            <Volume2 className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      {/* Completed status */}
      {activeRun?.completed && !activeRun.start_error ? (() => {
        const stageBeacon = asString(activeRun.final_stage_beacon || activeRun.stage_beacon || activeRun.last_stage_beacon).trim();
        const isDuplicate =
          stageBeacon === "duplicate_detected" ||
          activeRun.save_outcome === "duplicate_detected" ||
          activeRun.duplicate_of_id;

        if (isDuplicate) {
          const dupName = activeRun.duplicate_company_name || activeRun.items?.[0]?.company_name || "";
          const dupId = activeRun.duplicate_of_id || "";
          return (
            <div className="rounded-lg border border-sky-300 bg-sky-50 p-4 flex items-center gap-4">
              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-sky-500 text-white">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </div>
              <div className="flex-1">
                <div className="text-sm font-medium text-sky-900">
                  Already exists{dupName ? `: ${dupName}` : ""}
                </div>
                <div className="text-xs text-sky-700 mt-0.5">
                  This company is already in the database.{dupId ? ` Edit it in the Companies tab.` : ""}
                </div>
              </div>
            </div>
          );
        }

        const savedCount = Math.max(
          Number(activeRun.saved ?? 0) || 0,
          (Array.isArray(activeRun.saved_companies) ? activeRun.saved_companies : []).length,
          (Array.isArray(activeRun.saved_company_ids_verified) ? activeRun.saved_company_ids_verified : []).length,
        );
        const companyName = activeRun.saved_companies?.[0]?.company_name || activeRun.items?.[0]?.company_name || "";
        const companyUrl = activeRun.saved_companies?.[0]?.website_url || activeRun.saved_companies?.[0]?.canonical_url || activeRun.items?.[0]?.website_url || "";
        const resumeNeeded = Boolean(activeRun.resume_needed);
        const missingFields = activeRun.saved_companies?.[0]?.enrichment_health?.missing_fields || [];
        const hasSave = savedCount > 0;

        // Determine banner colour: green for normal progression or success, amber only
        // for genuinely terminal no-result outcomes (e.g. no_candidates_found, primary_timeout).
        const isProgressStage = STAGE_BEACON_PROGRESS_OR_SUCCESS.has(stageBeacon) || resumeNeeded;
        const useGreen = hasSave || isProgressStage;

        const borderClass = useGreen ? "border-emerald-300 bg-emerald-50" : "border-amber-300 bg-amber-50";
        const textClass = useGreen ? "text-emerald-900" : "text-amber-900";
        const subTextClass = useGreen ? "text-emerald-700" : "text-amber-700";
        const iconBgClass = useGreen ? "bg-emerald-500" : "bg-amber-500";

        // Choose message text: avoid alarming "Import finished — no company saved" for
        // progress stages that simply haven't reached the save step yet.
        let bannerMessage;
        if (hasSave) {
          bannerMessage = `Import complete — ${savedCount} company saved`;
        } else if (isProgressStage) {
          bannerMessage = `Import started — enrichment pending${stageBeacon ? ` (${toEnglishImportStage(stageBeacon)})` : ""}`;
        } else {
          bannerMessage = `Import finished — no company saved${stageBeacon ? ` (${toEnglishImportStage(stageBeacon)})` : ""}`;
        }

        return (
          <div className={`rounded-lg border ${borderClass} p-4 flex items-center gap-4`}>
            <div className={`flex h-6 w-6 items-center justify-center rounded-full ${iconBgClass} text-white`}>
              {useGreen ? (
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              )}
            </div>
            <div className="flex-1">
              <div className={`text-sm font-medium ${textClass}`}>
                {bannerMessage}
              </div>
              {companyName ? (
                <div className={`text-xs ${subTextClass} mt-0.5`}>{companyName}{companyUrl ? ` · ${companyUrl}` : ""}</div>
              ) : null}
              {resumeNeeded && missingFields.length > 0 ? (
                <div className={`text-xs ${subTextClass} mt-0.5`}>Enrichment pending: {missingFields.join(", ")}</div>
              ) : null}
            </div>
            <button
              type="button"
              onClick={replayNotification}
              className={`shrink-0 rounded-md p-1.5 ${useGreen ? "text-emerald-600 hover:bg-emerald-100" : "text-amber-600 hover:bg-amber-100"} transition-colors`}
              title="Replay notification sound"
            >
              <Volume2 className="h-4 w-4" />
            </button>
          </div>
        );
      })() : null}

      {!API_BASE ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 mt-0.5" />
          <div className="space-y-1">
            <div className="font-semibold">Import is not configured</div>
            <div className="text-amber-900/90">API base could not be resolved, and /api fallback is unavailable.</div>
          </div>
        </div>
      ) : null}
    </>
  );
}
