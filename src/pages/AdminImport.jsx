import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Play, Square, RefreshCcw, Copy, AlertTriangle, Save, Download, Loader2, Volume2 } from "lucide-react";

import AdminHeader from "@/components/AdminHeader";
import useNotificationSound from "@/hooks/useNotificationSound";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/toast";
import {
  API_BASE,
  FUNCTIONS_BASE,
  apiFetch,
  apiFetchParsed,
  getCachedBuildId,
  getLastApiRequestExplain,
  getResponseBuildId,
  getResponseRequestId,
  getUserFacingConfigMessage,
  join,
  readJsonOrText,
  toErrorString,
} from "@/lib/api";

import {
  REVIEWS_ENABLED,
  asString,
  importMissingReasonLabel,
  looksLikeUrlOrDomain,
  normalizeItems,
  isMeaningfulString,
  normalizeStringList,
  hasMeaningfulSeedEnrichment,
  isValidSeedCompany,
  filterValidSeedCompanies,
  mergeById,
  mergeUniqueStrings,
  safeJsonParse,
  toPrettyJsonText,
  toDisplayText,
  toAbsoluteUrlForRepro,
  sanitizeFilename,
  downloadTextFile,
  downloadJsonFile,
  buildWindowsSafeCurlOutFileScript,
  buildWindowsSafeInvokeRestMethodScript,
  extractSessionId,
  IMPORT_LIMIT_MIN,
  IMPORT_LIMIT_MAX,
  IMPORT_LIMIT_DEFAULT,
  SUCCESSION_MIN,
  SUCCESSION_MAX,
  SUCCESSION_DEFAULT,
  IMPORT_STAGE_BEACON_TO_ENGLISH,
  STAGE_BEACON_PROGRESS_OR_SUCCESS,
  IMPORT_ERROR_CODE_TO_REASON,
  ENRICH_FIELD_TO_DISPLAY,
  humanizeImportCode,
  toEnglishImportStage,
  toEnglishImportStopReason,
  extractAcceptReason,
  isExpectedAsyncAcceptReason,
  isNonErrorAcceptedOutcome,
  isPrimarySkippedCompanyUrl,
  formatDurationShort,
  normalizeImportLimit,
  normalizeSuccessionCount,
} from "./admin-import/importUtils";
import ImportDebugPanel from "./admin-import/ImportDebugPanel";
import ImportReportSection from "./admin-import/ImportReportSection";
import BulkImportSection from "./admin-import/BulkImportSection";
import StatusAlerts from "./admin-import/StatusAlerts";
import ImportResultsPanels from "./admin-import/ImportResultsPanels";

async function apiFetchWithFallback(paths, init) {
  const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
  if (list.length === 0) throw new Error("apiFetchWithFallback: missing paths");

  let lastRes = null;
  let lastPath = list[list.length - 1];

  for (const path of list) {
    lastPath = path;
    const res = await apiFetch(path, init);
    lastRes = res;

    // Return the *effective* request path (including API_BASE) so debug payloads match what the browser actually called.
    const effectivePath = join(API_BASE || "", path);

    if (res.status !== 404) return { res, usedPath: effectivePath };
  }

  return { res: lastRes, usedPath: join(API_BASE || "", lastPath) };
}

export default function AdminImport() {
  const [query, setQuery] = useState("");
  const [companyUrl, setCompanyUrl] = useState("");
  const [queryTypes, setQueryTypes] = useState(["product_keyword"]);
  const [location, setLocation] = useState("");

  // Succession import state
  const [successionCountInput, setSuccessionCountInput] = useState(String(SUCCESSION_DEFAULT));
  const [successionRows, setSuccessionRows] = useState([{ companyName: "", companyUrl: "" }]);
  const [successionQueue, setSuccessionQueue] = useState([]);
  const [successionIndex, setSuccessionIndex] = useState(-1);
  const [successionResults, setSuccessionResults] = useState([]);
  const successionTriggerRef = useRef(false);
  const successionCount = normalizeSuccessionCount(successionCountInput);


  const importConfigured = Boolean(API_BASE);

  const [runs, setRuns] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [activeStatus, setActiveStatus] = useState("idle"); // idle | running | stopping | done | error

  const [apiVersion, setApiVersion] = useState(null);
  const [apiVersionLoading, setApiVersionLoading] = useState(true);

  const [saveLoading, setSaveLoading] = useState(false);
  const [savingSessionId, setSavingSessionId] = useState(null);
  const [retryingResumeSessionId, setRetryingResumeSessionId] = useState(null);

  const [debugQuery, setDebugQuery] = useState("");
  const [debugLimitInput, setDebugLimitInput] = useState("1");
  const [debugSessionId, setDebugSessionId] = useState("");
  const [debugStartResponseText, setDebugStartResponseText] = useState("");
  const [debugStatusResponseText, setDebugStatusResponseText] = useState("");
  const [debugStartLoading, setDebugStartLoading] = useState(false);
  const [debugStatusLoading, setDebugStatusLoading] = useState(false);

  const [pollingSessionId, setPollingSessionId] = useState("");
  const [statusRefreshSessionId, setStatusRefreshSessionId] = useState(null);
  const [sessionIdMismatchDebug, setSessionIdMismatchDebug] = useState(null);

  const [explainResponseText, setExplainResponseText] = useState("");
  const [explainLoading, setExplainLoading] = useState(false);

  // Bulk import state
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkUrls, setBulkUrls] = useState("");
  const [activeBatchId, setActiveBatchId] = useState(null);
  const [batchJobs, setBatchJobs] = useState([]);
  const [bulkEnqueueLoading, setBulkEnqueueLoading] = useState(false);

  const pollTimerRef = useRef(null);
  const startFetchAbortRef = useRef(null);
  const pollAttemptsRef = useRef(new Map());
  const pollBackoffRef = useRef(new Map());
  const terminalRefreshAttemptsRef = useRef(new Map());
  const terminalRefreshTimersRef = useRef(new Map());

  const companyDocFetchInFlightRef = useRef(new Set());

  const startImportRequestInFlightRef = useRef(false);
  const activeStatusRef = useRef(activeStatus);
  const importReportRef = useRef(null);
  activeStatusRef.current = activeStatus;

  const isSuccessionRunning = successionIndex >= 0;

  // Audio notification on import / succession completion
  const { play: playNotification, replay: replayNotification } = useNotificationSound();
  const prevActiveStatusRef = useRef(activeStatus);

  useEffect(() => {
    const prev = prevActiveStatusRef.current;
    prevActiveStatusRef.current = activeStatus;

    if (activeStatus !== "done" || prev === "done") return;

    // During succession, each sub-import hits "done" then immediately starts the next.
    // Only play when succession is NOT mid-run (successionIndex < 0 means finished or never started).
    if (successionIndex >= 0) return;

    playNotification();
  }, [activeStatus, successionIndex, playNotification]);

  // Also play on succession completion (all items processed)
  const prevSuccessionIndexRef = useRef(successionIndex);
  useEffect(() => {
    const prev = prevSuccessionIndexRef.current;
    prevSuccessionIndexRef.current = successionIndex;

    // Succession just finished: index went from >= 0 to -1
    if (prev >= 0 && successionIndex < 0) {
      playNotification();
    }
  }, [successionIndex, playNotification]);

  const handleSuccessionCountChange = useCallback((rawValue) => {
    const s = String(rawValue ?? "").trim();
    if (s === "") {
      setSuccessionCountInput("");
      return;
    }
    if (!/^\d+$/.test(s)) return;
    setSuccessionCountInput(s);
    const n = normalizeSuccessionCount(s);
    setSuccessionRows((prev) => {
      if (n === prev.length) return prev;
      if (n < prev.length) return prev.slice(0, n);
      const extended = [...prev];
      while (extended.length < n) {
        extended.push({ companyName: "", companyUrl: "" });
      }
      return extended;
    });
  }, []);

  const updateSuccessionRow = useCallback((index, field, value) => {
    setSuccessionRows((prev) => prev.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
    if (index === 0) {
      if (field === "companyName") setQuery(value);
      if (field === "companyUrl") setCompanyUrl(value);
    }
  }, []);

  const activeRun = useMemo(() => {
    if (!activeSessionId) return null;
    return runs.find((r) => r.session_id === activeSessionId) || null;
  }, [activeSessionId, runs]);

  useEffect(() => {
    if (!activeRun) return;

    const sid = asString(activeRun.session_id).trim();
    const verifiedCompanyId = Array.isArray(activeRun.saved_company_ids_verified)
      ? asString(activeRun.saved_company_ids_verified[0]).trim()
      : "";

    if (!sid || !verifiedCompanyId) return;

    const existingDocCompanyId = asString(activeRun.primary_company_doc?.company_id).trim();
    if (existingDocCompanyId === verifiedCompanyId) return;

    const existingErrCompanyId = asString(activeRun.primary_company_doc_error?.company_id).trim();
    if (existingErrCompanyId === verifiedCompanyId) return;

    const fetchKey = `${sid}:${verifiedCompanyId}`;
    if (companyDocFetchInFlightRef.current.has(fetchKey)) return;
    companyDocFetchInFlightRef.current.add(fetchKey);

    (async () => {
      try {
        const { res } = await apiFetchWithFallback([`/xadmin-api-companies/${encodeURIComponent(verifiedCompanyId)}`]);
        const body = await readJsonOrText(res);

        const company = body && typeof body === "object" ? body.company : null;
        if (!res.ok || !company || typeof company !== "object") {
          const msg =
            body && typeof body === "object"
              ? asString(body.error || body.message || body.text).trim() || `HTTP ${res.status}`
              : `HTTP ${res.status}`;

          setRuns((prev) =>
            prev.map((r) =>
              r.session_id === sid
                ? {
                    ...r,
                    primary_company_doc: null,
                    primary_company_doc_error: {
                      company_id: verifiedCompanyId,
                      message: msg || "Failed to load company doc",
                    },
                    updatedAt: new Date().toISOString(),
                  }
                : r
            )
          );
          return;
        }

        setRuns((prev) =>
          prev.map((r) =>
            r.session_id === sid
              ? {
                  ...r,
                  primary_company_doc: {
                    company_id: asString(company.id || verifiedCompanyId).trim() || verifiedCompanyId,
                    company_name: asString(company.company_name || company.name).trim() || "Unknown company",
                    canonical_url: asString(company.canonical_url).trim(),
                    website_url: asString(company.website_url || company.url || company.canonical_url).trim(),
                  },
                  primary_company_doc_error: null,
                  updatedAt: new Date().toISOString(),
                }
              : r
          )
        );
      } catch (e) {
        setRuns((prev) =>
          prev.map((r) =>
            r.session_id === sid
              ? {
                  ...r,
                  primary_company_doc: null,
                  primary_company_doc_error: {
                    company_id: verifiedCompanyId,
                    message: toErrorString(e) || "Failed to load company doc",
                  },
                  updatedAt: new Date().toISOString(),
                }
              : r
          )
        );
      } finally {
        companyDocFetchInFlightRef.current.delete(fetchKey);
      }
    })();
  }, [
    activeRun,
    activeRun?.session_id,
    Array.isArray(activeRun?.saved_company_ids_verified) ? activeRun.saved_company_ids_verified[0] : "",
    activeRun?.primary_company_doc?.company_id,
    activeRun?.primary_company_doc_error?.company_id,
  ]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const pollProgress = useCallback(
    async ({ session_id }) => {
      try {
        const encoded = encodeURIComponent(session_id);
        const { res } = await apiFetchWithFallback([`/import/status?session_id=${encoded}`], {
          signal: AbortSignal.timeout(STATUS_POLL_TIMEOUT_MS),
        });
        const body = await readJsonOrText(res);

        const state = typeof body?.state === "string" ? body.state : "";
        const isUnknownSession =
          res.status === 404 && body && typeof body === "object" && body.ok === false && body.error === "Unknown session_id";

        const hasStructuredBody = body && typeof body === "object";
        const hasStatus = Boolean(typeof body?.status === "string" && body.status.trim());
        const treatAsOk = Boolean(hasStructuredBody && (body.ok === true || hasStatus));

        if ((!res.ok && !treatAsOk) || (hasStructuredBody && body.ok === false && !treatAsOk)) {
          const bodyPreview = toPrettyJsonText(body);
          const configMsg = await getUserFacingConfigMessage(res);
          const baseMsg = toErrorString(
            configMsg ||
              (body && typeof body === "object" ? body.error || body.message || body.text : null) ||
              `Status failed (${res.status})`
          );
          const msg = bodyPreview ? `${baseMsg}\n${bodyPreview}` : baseMsg;

          if (isUnknownSession) {
            setRuns((prev) =>
              prev.map((r) =>
                r.session_id === session_id
                  ? {
                      ...r,
                      progress_error: null,
                      progress_notice: "Session not found yet; retrying status polling…",
                      updatedAt: new Date().toISOString(),
                    }
                  : r
              )
            );
            return { shouldStop: false, body, unknown_session: true };
          }

          setRuns((prev) => prev.map((r) => (r.session_id === session_id ? { ...r, progress_error: msg } : r)));
          toast.error(baseMsg);
          return { shouldStop: true, body };
        }

        const items = normalizeItems(body?.items || body?.companies);
        const savedCompanies = Array.isArray(body?.saved_companies) ? body.saved_companies : [];

        const incomingVerifiedIds = Array.isArray(body?.saved_company_ids_verified)
          ? body.saved_company_ids_verified
          : Array.isArray(body?.result?.saved_company_ids_verified)
            ? body.result.saved_company_ids_verified
            : [];

        const incomingUnverifiedIds = Array.isArray(body?.saved_company_ids_unverified)
          ? body.saved_company_ids_unverified
          : Array.isArray(body?.result?.saved_company_ids_unverified)
            ? body.result.saved_company_ids_unverified
            : [];

        const savedVerifiedCount =
          typeof body?.saved_verified_count === "number" && Number.isFinite(body.saved_verified_count)
            ? body.saved_verified_count
            : typeof body?.result?.saved_verified_count === "number" && Number.isFinite(body.result.saved_verified_count)
              ? body.result.saved_verified_count
              : incomingVerifiedIds.length > 0
                ? incomingVerifiedIds.length
                : null;

        const savedVerifiedCountNormalized =
          typeof savedVerifiedCount === "number" && Number.isFinite(savedVerifiedCount) ? savedVerifiedCount : null;

        const persistedIds = mergeUniqueStrings(incomingVerifiedIds, incomingUnverifiedIds);
        const persistedCountFromIds = persistedIds.length;

        const persistedCount = Math.max(
          savedCompanies.length,
          persistedCountFromIds,
          Number.isFinite(Number(body?.saved)) ? Number(body.saved) : 0,
          savedVerifiedCountNormalized != null ? savedVerifiedCountNormalized : 0
        );

        const saved = persistedCount;

        const reconciled = Boolean(body?.reconciled);
        const reconcileStrategy = asString(body?.reconcile_strategy).trim();
        const reconciledSavedIds = Array.isArray(body?.reconciled_saved_ids) ? body.reconciled_saved_ids : [];

        const status = asString(body?.status).trim();
        const jobState = asString(body?.job_state || body?.primary_job_state || body?.primary_job?.job_state).trim();
        const stageBeacon = asString(body?.stage_beacon).trim();
        const lastError = body?.last_error || null;
        const report = body?.report && typeof body.report === "object" ? body.report : null;

        const reportSessionStatus = asString(report?.session?.status).trim();

        // Resume flags
        const resumeNeeded = Boolean(body?.resume_needed || body?.resume?.needed || report?.session?.resume_needed);

        // Don't treat resume_needed=false as terminal when the session is still
        // actively processing.  Any beacon that isn't an explicit completion/error
        // signal means import-start is still working — the status poll simply
        // raced ahead.
        const TERMINAL_BEACONS = new Set([
          "complete",
          "enrichment_complete",
          "status_resume_terminal_only",
          "error",
          "stopped",
        ]);

        const sessionStillProcessing =
          !TERMINAL_BEACONS.has(stageBeacon) && saved === 0;

        const resumeNeededExplicitlyFalse =
          body?.resume_needed === false &&
          body?.resume?.needed === false &&
          !sessionStillProcessing;

        // Completion signals (UI must stop polling quickly when ANY are true)
        const stageBeaconComplete = stageBeacon === "complete";
        const reportSessionComplete = reportSessionStatus === "complete";

        const stageBeaconValues =
          body?.stage_beacon_values && typeof body.stage_beacon_values === "object" ? body.stage_beacon_values : {};

        const missingRetryableCount =
          Number.isFinite(Number(stageBeaconValues.status_resume_missing_retryable))
            ? Number(stageBeaconValues.status_resume_missing_retryable)
            : null;

        const missingTerminalCount =
          Number.isFinite(Number(stageBeaconValues.status_resume_missing_terminal))
            ? Number(stageBeaconValues.status_resume_missing_terminal)
            : null;

        const terminalOnlyFlag =
          Boolean(stageBeaconValues.status_resume_terminal_only) ||
          (missingRetryableCount === 0 && (missingTerminalCount || 0) > 0 && !resumeNeeded);

        const completed = state === "complete" ? true : Boolean(body?.completed);
        const timedOut = Boolean(body?.timedOut);
        const stopped = state === "failed" ? true : Boolean(body?.stopped);

        const isTerminalError = state === "failed" || status === "error" || jobState === "error";
        const isTerminalComplete =
          reportSessionComplete ||
          resumeNeededExplicitlyFalse ||
          terminalOnlyFlag ||
          (!resumeNeeded &&
            (stageBeaconComplete ||
              state === "complete" ||
              status === "complete" ||
              jobState === "complete" ||
              completed));

        // If at least one company is already saved (verified), we can pause polling while resume-worker
        // continues enrichment. This is NOT a terminal "Completed" state.
        const resumeStatusLabel = asString(body?.resume?.status).trim();

        const shouldBackoffForResume =
          resumeNeeded && saved > 0 && !isTerminalError && !isTerminalComplete && resumeStatusLabel !== "stalled";

        const lastErrorCode = asString(lastError?.code).trim();
        const primaryTimeoutLabel = formatDurationShort(lastError?.hard_timeout_ms);
        const noCandidatesLabel = formatDurationShort(lastError?.no_candidates_threshold_ms);

        const userFacingError =
          lastErrorCode === "primary_timeout"
            ? `Primary import timed out${primaryTimeoutLabel ? ` (${primaryTimeoutLabel} hard cap)` : ""}.`
            : lastErrorCode === "no_candidates_found"
              ? `No candidates found${noCandidatesLabel ? ` after ${noCandidatesLabel}` : ""}.`
              : lastErrorCode === "MISSING_XAI_ENDPOINT"
                ? "Import failed: missing XAI endpoint configuration."
                : lastErrorCode === "MISSING_XAI_KEY"
                  ? "Import failed: missing XAI API key configuration."
                  : lastErrorCode === "MISSING_OUTBOUND_BODY"
                    ? "Import failed: missing outbound request body. (This should be fixed now; rerun import.)"
                    : asString(lastError?.message).trim() || "Import failed.";

        setRuns((prev) =>
          prev.map((r) => {
            if (r.session_id !== session_id) return r;

            const nextLastStageBeacon = stageBeacon || asString(r.last_stage_beacon) || asString(r.stage_beacon);
            const reachedTerminal = isTerminalError || isTerminalComplete;
            const finalStageBeacon = reachedTerminal
              ? stageBeacon || nextLastStageBeacon || asString(r.final_stage_beacon)
              : asString(r.final_stage_beacon);

            const normalizedJobState = jobState || asString(r.job_state);
            const finalJobState = reachedTerminal
              ? normalizedJobState || asString(r.final_job_state) || asString(r.job_state)
              : asString(r.final_job_state);

            const finalLastErrorCode = reachedTerminal
              ? lastErrorCode || asString(r.final_last_error_code)
              : asString(r.final_last_error_code);

            const prevVerifiedIds = Array.isArray(r.saved_company_ids_verified) ? r.saved_company_ids_verified : [];
            const nextVerifiedIds = mergeUniqueStrings(prevVerifiedIds, incomingVerifiedIds);

            const prevUnverifiedIds = Array.isArray(r.saved_company_ids_unverified) ? r.saved_company_ids_unverified : [];
            const nextUnverifiedIds = mergeUniqueStrings(prevUnverifiedIds, incomingUnverifiedIds);

            const prevVerifiedCount =
              typeof r.saved_verified_count === "number" && Number.isFinite(r.saved_verified_count) ? r.saved_verified_count : 0;
            const nextSavedVerifiedCountRaw =
              typeof savedVerifiedCount === "number" && Number.isFinite(savedVerifiedCount) ? savedVerifiedCount : 0;

            const nextSavedVerifiedCount = Math.max(prevVerifiedCount, nextSavedVerifiedCountRaw, nextVerifiedIds.length);
            const savedCount = Math.max(nextSavedVerifiedCount, Number.isFinite(Number(saved)) ? Number(saved) : 0, savedCompanies.length);
            const hasSaved = savedCount > 0;

            const shouldDemoteStartErrorToWarning = Boolean(isTerminalComplete && hasSaved);

            let nextStartError = r.start_error;
            let nextStartErrorDetails = r.start_error_details;
            let nextProgressError = isTerminalError ? userFacingError : r.progress_error;

            if (shouldDemoteStartErrorToWarning) {
              const existingStartError = asString(r.start_error).trim();
              const responseBody = r.start_error_details?.response_body;

              const responseMsg = asString(
                responseBody && typeof responseBody === "object"
                  ? responseBody.message || responseBody.error || responseBody.text
                  : responseBody
              ).trim();

              const responseObj = responseBody && typeof responseBody === "object" ? responseBody : null;

              const stageLabel = asString(responseObj?.stage || responseObj?.stage_beacon || responseObj?.stageBeacon).trim();
              const rootCauseLabel = asString(responseObj?.root_cause || responseObj?.rootCause).trim();
              const upstreamRaw = responseObj?.upstream_status ?? responseObj?.upstreamStatus ?? responseObj?.status;
              const upstreamStatus =
                typeof upstreamRaw === "number" && Number.isFinite(upstreamRaw)
                  ? upstreamRaw
                  : typeof upstreamRaw === "string" && /^\d+$/.test(upstreamRaw.trim())
                    ? Number(upstreamRaw)
                    : null;

              const meta = [];
              if (rootCauseLabel) meta.push(rootCauseLabel);
              if (upstreamStatus != null) meta.push(`HTTP ${upstreamStatus}`);

              const safeMsg = responseMsg.toLowerCase() === "backend call failure" ? "" : responseMsg;
              const base = stageLabel || rootCauseLabel || "post_save_warning";
              const warningReason = `${base}${meta.length ? ` (${meta.join(", ")})` : ""}${safeMsg ? `: ${safeMsg}` : ""}`.trim() || existingStartError;

              nextStartError = null;
              nextStartErrorDetails = null;

              nextProgressError = warningReason ? `Saved with warnings: ${warningReason}` : null;
            }

            return {
              ...r,
              items: mergeById(r.items, items),
              lastCreatedAt: asString(body?.lastCreatedAt || r.lastCreatedAt),
              saved: savedCount,
              saved_verified_count: nextSavedVerifiedCount,
              saved_company_ids_verified: nextVerifiedIds,
              saved_company_ids_unverified: nextUnverifiedIds,
              saved_company_urls: Array.isArray(body?.saved_company_urls)
                ? body.saved_company_urls
                : Array.isArray(r.saved_company_urls)
                  ? r.saved_company_urls
                  : [],
              save_outcome: asString(body?.save_outcome || body?.save_report?.save_outcome || r.save_outcome).trim() || null,
              resume_error: asString(body?.resume_error || r.resume_error).trim() || null,
              reconciled,
              reconcile_strategy: reconcileStrategy || null,
              reconciled_saved_ids: reconciledSavedIds,
              saved_companies: savedCompanies.length > 0 ? savedCompanies : Array.isArray(r.saved_companies) ? r.saved_companies : [],
              completed: isTerminalComplete,
              terminal_only: Boolean(r.terminal_only) || terminalOnlyFlag,
              timedOut,
              stopped: isTerminalError ? true : stopped,
              job_state: normalizedJobState,
              stage_beacon: stageBeacon || asString(r.stage_beacon),
              last_stage_beacon: nextLastStageBeacon,
              final_stage_beacon: finalStageBeacon,
              final_job_state: finalJobState,
              final_last_error_code: finalLastErrorCode,
              elapsed_ms: Number.isFinite(Number(body?.elapsed_ms)) ? Number(body.elapsed_ms) : r.elapsed_ms ?? null,
              remaining_budget_ms: Number.isFinite(Number(body?.remaining_budget_ms))
                ? Number(body.remaining_budget_ms)
                : r.remaining_budget_ms ?? null,
              upstream_calls_made: Number.isFinite(Number(body?.upstream_calls_made))
                ? Number(body.upstream_calls_made)
                : Number(r.upstream_calls_made ?? 0) || 0,
              companies_candidates_found: Number.isFinite(Number(body?.companies_candidates_found))
                ? Number(body.companies_candidates_found)
                : Number(r.companies_candidates_found ?? 0) || 0,
              early_exit_triggered:
                typeof body?.early_exit_triggered === "boolean" ? body.early_exit_triggered : Boolean(r.early_exit_triggered),
              last_error: lastError || r.last_error || null,
              report: report || r.report || null,
              last_status_http_status: Number(res?.status) || null,
              last_status_checked_at: new Date().toISOString(),
              last_status_body: body,
              resume_needed: resumeNeeded,
              resume:
                body?.resume && typeof body.resume === "object"
                  ? body.resume
                  : r.resume && typeof r.resume === "object"
                    ? r.resume
                    : null,
              resume_worker:
                body?.resume_worker && typeof body.resume_worker === "object"
                  ? body.resume_worker
                  : r.resume_worker && typeof r.resume_worker === "object"
                    ? r.resume_worker
                    : null,
              enrichment_last_write_error:
                body?.enrichment_last_write_error && typeof body.enrichment_last_write_error === "object"
                  ? body.enrichment_last_write_error
                  : r.enrichment_last_write_error && typeof r.enrichment_last_write_error === "object"
                    ? r.enrichment_last_write_error
                    : null,
              start_error: nextStartError,
              start_error_details: nextStartErrorDetails,
              progress_error: nextProgressError,
              progress_notice: isTerminalComplete && !terminalOnlyFlag
                ? null
                : terminalOnlyFlag && isTerminalComplete
                  ? "Completed (terminal-only): remaining missing fields were marked Not disclosed / Exhausted."
                  : shouldBackoffForResume
                    ? `Resume ${resumeStatusLabel || "queued"}, waiting for worker. Polling will slow down.`
                    : r.progress_notice,
              updatedAt: new Date().toISOString(),
            };
          })
        );

        if (isTerminalError) {
          try {
            setActiveStatus((prev) => (prev === "running" ? "error" : prev));
          } catch {}
          return { shouldStop: true, body };
        }

        if (isTerminalComplete) {
          try {
            setActiveStatus((prev) => (prev === "running" ? "done" : prev));
          } catch {}
          return { shouldStop: true, body };
        }

        return { shouldStop: timedOut || stopped, body, shouldBackoff: shouldBackoffForResume };
      } catch (e) {
        const msg = toErrorString(e) || "Progress failed";
        setRuns((prev) => prev.map((r) => (r.session_id === session_id ? { ...r, progress_error: msg } : r)));
        return { shouldStop: false, error: msg };
      }
    },
    []
  );

  const POLL_MAX_ATTEMPTS = 180;
  const DEFAULT_POLL_INTERVAL_MS = 2500;
  const RESUME_POLL_RUNNING_MS = 15_000;
  // When resume worker is actively running in background (fire-and-forget), poll more aggressively.
  const RESUME_POLL_IN_PROGRESS_MS = [5_000, 5_000, 10_000, 10_000, 15_000, 15_000, 30_000];
  // When resume is queued but worker not yet triggered, use slower backoff.
  const RESUME_POLL_QUEUED_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000];
  const STATUS_POLL_TIMEOUT_MS = 180_000; // 3 min — generous for inline worker, short enough to recover from hung connections

  const resetPollAttempts = useCallback((session_id) => {
    if (!session_id) return;
    pollAttemptsRef.current.set(session_id, 0);
  }, []);

  const clearTerminalRefresh = useCallback(
    (session_id) => {
      const sid = asString(session_id).trim();
      if (!sid) return;

      const existing = terminalRefreshTimersRef.current.get(sid);
      if (existing) {
        clearTimeout(existing);
        terminalRefreshTimersRef.current.delete(sid);
      }

      terminalRefreshAttemptsRef.current.delete(sid);
    },
    []
  );

  const retryResumeWorker = useCallback(
    async ({ session_id }) => {
      const sid = asString(session_id).trim();
      if (!sid) return;

      const path = `/import/resume-enqueue?direct=1`;
      const endpointUrl = join(API_BASE, path);

      const requestHeaders = { "Content-Type": "application/json" };
      const requestBody = { session_id: sid, reason: "manual_retry", requested_by: "admin" };

      const initialBundle = {
        kind: "retry_resume",
        captured_at: new Date().toISOString(),
        endpoint_url: endpointUrl,
        request_payload: requestBody,
        request_explain: {
          url: endpointUrl,
          method: "POST",
          headers: requestHeaders,
          body_preview: JSON.stringify(requestBody).slice(0, 1200),
        },
        network_error: null,
        exception_message: null,
        response_status: null,
        response_text_preview: null,
        response: null,
        build_headers: {
          api_build_id: null,
          request_id: null,
          cached_build_id: getCachedBuildId() || null,
        },
      };

      // Critical: persist a debug bundle synchronously, before awaiting any network call.
      try {
        setRuns((prev) => prev.map((r) => (r.session_id === sid ? { ...r, last_resume_debug_bundle: initialBundle } : r)));
      } catch {}

      let finalBundle = initialBundle;

      try {
        const r = await apiFetchParsed(path, {
          method: "POST",
          headers: requestHeaders,
          body: JSON.stringify(requestBody),
          keepalive: true,
        });

        const res = r.response;
        const body = r.data;
        const textBody = typeof r.text === "string" ? r.text : "";

        const requestExplain = getLastApiRequestExplain();
        const apiBuildId = getResponseBuildId(res) || null;
        const requestId = getResponseRequestId(res) || null;

        finalBundle = {
          ...initialBundle,
          request_explain: requestExplain || initialBundle.request_explain,
          response_status: res?.status ?? null,
          response_text_preview: textBody ? textBody.slice(0, 2000) : null,
          response: {
            status: res.status,
            ok: res.ok,
            headers: {
              "content-type": res.headers.get("content-type") || "",
              "x-api-build-id": res.headers.get("x-api-build-id") || res.headers.get("X-Api-Build-Id") || "",
              "x-request-id": res.headers.get("x-request-id") || res.headers.get("X-Request-ID") || "",
              "x-ms-request-id": res.headers.get("x-ms-request-id") || "",
            },
            body_json: body && typeof body === "object" ? body : null,
            body_text: textBody,
            api_fetch_error: res && typeof res === "object" ? res.__api_fetch_error : null,
            api_fetch_fallback: res && typeof res === "object" ? res.__api_fetch_fallback : null,
          },
          build_headers: {
            api_build_id: apiBuildId,
            request_id: requestId,
            cached_build_id: getCachedBuildId() || null,
          },
        };

        const enqueued = Boolean(body?.ok);
        const triggerError = asString(body?.error || body?.message || "").trim();

        if (enqueued) {
          toast.success("Resume enqueued");
        } else if (triggerError) {
          toast.error(triggerError);
        } else {
          const msg = (await getUserFacingConfigMessage(res)) || `Enqueue resume failed (HTTP ${res.status})`;
          toast.error(msg);
        }
      } catch (e) {
        const maybeStatus = typeof e?.status === "number" ? e.status : Number(e?.status) || null;
        const res = e?.response;
        const body = e?.data;
        const textBody = typeof e?.text === "string" ? e.text : "";

        const requestExplain = getLastApiRequestExplain();
        const apiBuildId = res ? getResponseBuildId(res) : null;
        const requestId = res ? getResponseRequestId(res) : null;

        const networkError =
          body && typeof body === "object"
            ? asString(body.error_message || body.error || body.message).trim()
            : "";

        finalBundle = {
          ...initialBundle,
          request_explain: requestExplain || initialBundle.request_explain,
          network_error: networkError || null,
          exception_message: toErrorString(e) || "Retry resume failed",
          response_status: res ? res.status : maybeStatus,
          response_text_preview: textBody ? textBody.slice(0, 2000) : null,
          response: res
            ? {
                status: res.status,
                ok: res.ok,
                headers: {
                  "content-type": res.headers.get("content-type") || "",
                  "x-api-build-id": res.headers.get("x-api-build-id") || res.headers.get("X-Api-Build-Id") || "",
                  "x-request-id": res.headers.get("x-request-id") || res.headers.get("X-Request-ID") || "",
                  "x-ms-request-id": res.headers.get("x-ms-request-id") || "",
                },
                body_json: body && typeof body === "object" ? body : null,
                body_text: textBody,
                api_fetch_error: res && typeof res === "object" ? res.__api_fetch_error : null,
                api_fetch_fallback: res && typeof res === "object" ? res.__api_fetch_fallback : null,
              }
            : null,
          build_headers: {
            api_build_id: apiBuildId,
            request_id: requestId,
            cached_build_id: getCachedBuildId() || null,
          },
        };

        toast.error(toErrorString(e) || "Retry resume failed");
      } finally {
        try {
          setRuns((prev) => prev.map((r) => (r.session_id === sid ? { ...r, last_resume_debug_bundle: finalBundle } : r)));
        } catch {}

        await pollProgress({ session_id: sid });
      }
    },
    [pollProgress]
  );

  const runXaiDiag = useCallback(
    async ({ session_id }) => {
      const sid = asString(session_id).trim();
      if (!sid) return;

      const encoded = encodeURIComponent(sid);
      const path = `/diag/xai?session_id=${encoded}`;
      const endpointUrl = join(API_BASE, path);

      const requestHeaders = { "Content-Type": "application/json" };

      const initialBundle = {
        kind: "xai_diag",
        captured_at: new Date().toISOString(),
        endpoint_url: endpointUrl,
        request_payload: { session_id: sid },
        request_explain: {
          url: endpointUrl,
          method: "GET",
          headers: requestHeaders,
          body_preview: "",
        },
        network_error: null,
        exception_message: null,
        response_status: null,
        response_text_preview: null,
        response: null,
        build_headers: {
          api_build_id: null,
          request_id: null,
          cached_build_id: getCachedBuildId() || null,
        },
      };

      try {
        setRuns((prev) => prev.map((r) => (r.session_id === sid ? { ...r, last_xai_diag_bundle: initialBundle } : r)));
      } catch {}

      let finalBundle = initialBundle;

      try {
        const r = await apiFetchParsed(path, {
          method: "GET",
          headers: requestHeaders,
          keepalive: true,
        });

        const res = r.response;
        const body = r.data;
        const textBody = typeof r.text === "string" ? r.text : "";

        const requestExplain = getLastApiRequestExplain();
        const apiBuildId = getResponseBuildId(res) || null;
        const requestId = getResponseRequestId(res) || null;

        finalBundle = {
          ...initialBundle,
          request_explain: requestExplain || initialBundle.request_explain,
          response_status: res?.status ?? null,
          response_text_preview: textBody ? textBody.slice(0, 2000) : null,
          response: {
            status: res.status,
            ok: res.ok,
            headers: {
              "content-type": res.headers.get("content-type") || "",
              "x-api-build-id": res.headers.get("x-api-build-id") || res.headers.get("X-Api-Build-Id") || "",
              "x-request-id": res.headers.get("x-request-id") || res.headers.get("X-Request-ID") || "",
              "x-ms-request-id": res.headers.get("x-ms-request-id") || "",
            },
            body_json: body && typeof body === "object" ? body : null,
            body_text: textBody,
            api_fetch_error: res && typeof res === "object" ? res.__api_fetch_error : null,
            api_fetch_fallback: res && typeof res === "object" ? res.__api_fetch_fallback : null,
          },
          build_headers: {
            api_build_id: apiBuildId,
            request_id: requestId,
            cached_build_id: getCachedBuildId() || null,
          },
        };

        if (res.ok && body && typeof body === "object" && body.ok) {
          toast.success("xAI diag complete");
        } else {
          const msg = (await getUserFacingConfigMessage(res)) || `xAI diag failed (HTTP ${res.status})`;
          toast.error(msg);
        }
      } catch (e) {
        const maybeStatus = typeof e?.status === "number" ? e.status : Number(e?.status) || null;
        const res = e?.response;
        const body = e?.data;
        const textBody = typeof e?.text === "string" ? e.text : "";

        const requestExplain = getLastApiRequestExplain();
        const apiBuildId = res ? getResponseBuildId(res) : null;
        const requestId = res ? getResponseRequestId(res) : null;

        const networkError =
          body && typeof body === "object"
            ? asString(body.error_message || body.error || body.message).trim()
            : "";

        finalBundle = {
          ...initialBundle,
          request_explain: requestExplain || initialBundle.request_explain,
          network_error: networkError || null,
          exception_message: toErrorString(e) || "xAI diag failed",
          response_status: res ? res.status : maybeStatus,
          response_text_preview: textBody ? textBody.slice(0, 2000) : null,
          response: res
            ? {
                status: res.status,
                ok: res.ok,
                headers: {
                  "content-type": res.headers.get("content-type") || "",
                  "x-api-build-id": res.headers.get("x-api-build-id") || res.headers.get("X-Api-Build-Id") || "",
                  "x-request-id": res.headers.get("x-request-id") || res.headers.get("X-Request-ID") || "",
                  "x-ms-request-id": res.headers.get("x-ms-request-id") || "",
                },
                body_json: body && typeof body === "object" ? body : null,
                body_text: textBody,
                api_fetch_error: res && typeof res === "object" ? res.__api_fetch_error : null,
                api_fetch_fallback: res && typeof res === "object" ? res.__api_fetch_fallback : null,
              }
            : null,
          build_headers: {
            api_build_id: apiBuildId,
            request_id: requestId,
            cached_build_id: getCachedBuildId() || null,
          },
        };

        toast.error(toErrorString(e) || "xAI diag failed");
      } finally {
        try {
          setRuns((prev) => prev.map((r) => (r.session_id === sid ? { ...r, last_xai_diag_bundle: finalBundle } : r)));
        } catch {}
      }
    },
    []
  );

  const scheduleTerminalRefresh = useCallback(
    ({ session_id }) => {
      const sid = asString(session_id).trim();
      if (!sid) return;

      const MAX_TERMINAL_REFRESH_ATTEMPTS = 6;

      const runAttempt = async () => {
        const attempt = terminalRefreshAttemptsRef.current.get(sid) || 0;
        if (attempt >= MAX_TERMINAL_REFRESH_ATTEMPTS) {
          clearTerminalRefresh(sid);
          return;
        }

        terminalRefreshAttemptsRef.current.set(sid, attempt + 1);

        const result = await pollProgress({ session_id: sid });
        const body = result?.body;

        const savedCompanies = Array.isArray(body?.saved_companies) ? body.saved_companies : [];

        const savedVerifiedCount =
          typeof body?.saved_verified_count === "number" && Number.isFinite(body.saved_verified_count)
            ? body.saved_verified_count
            : typeof body?.result?.saved_verified_count === "number" && Number.isFinite(body.result.saved_verified_count)
              ? body.result.saved_verified_count
              : null;

        const verifiedIds = Array.isArray(body?.saved_company_ids_verified)
          ? body.saved_company_ids_verified
          : Array.isArray(body?.result?.saved_company_ids_verified)
            ? body.result.saved_company_ids_verified
            : [];

        const unverifiedIds = Array.isArray(body?.saved_company_ids_unverified)
          ? body.saved_company_ids_unverified
          : Array.isArray(body?.result?.saved_company_ids_unverified)
            ? body.result.saved_company_ids_unverified
            : [];

        const persistedIds = mergeUniqueStrings(verifiedIds, unverifiedIds);

        const savedCount = Math.max(
          persistedIds.length,
          savedCompanies.length,
          savedVerifiedCount != null ? savedVerifiedCount : 0,
          Number.isFinite(Number(body?.saved)) ? Number(body.saved) : 0
        );

        const status = asString(body?.status).trim();
        const state = asString(body?.state).trim();
        const jobState = asString(body?.job_state || body?.primary_job_state || body?.primary_job?.job_state).trim();
        const completed = state === "complete" ? true : Boolean(body?.completed);

        const isTerminalComplete =
          state === "complete" || status === "complete" || jobState === "complete" || completed;

        if (!isTerminalComplete) {
          clearTerminalRefresh(sid);
          return;
        }

        if (savedCount > 0) {
          clearTerminalRefresh(sid);
          return;
        }

        const timerId = setTimeout(runAttempt, 3000);
        terminalRefreshTimersRef.current.set(sid, timerId);
      };

      clearTerminalRefresh(sid);
      const timerId = setTimeout(runAttempt, 2500);
      terminalRefreshTimersRef.current.set(sid, timerId);
    },
    [clearTerminalRefresh, pollProgress]
  );

  const schedulePoll = useCallback(
    ({ session_id, delayMs } = {}) => {
      const sid = asString(session_id).trim();
      if (!sid) return;

      stopPolling();
      setPollingSessionId(sid);

      const initialDelay = Number.isFinite(Number(delayMs)) ? Math.max(500, Number(delayMs)) : DEFAULT_POLL_INTERVAL_MS;

      pollTimerRef.current = setTimeout(async () => {
        const prevAttempts = pollAttemptsRef.current.get(sid) || 0;
        const nextAttempts = prevAttempts + 1;
        pollAttemptsRef.current.set(sid, nextAttempts);

        const result = await pollProgress({ session_id: sid }).catch((e) => ({ shouldStop: false, error: e }));
        const latestBody = result?.body || null;

        const resumeNeeded = Boolean(latestBody?.resume_needed);
        const resumeStatus = asString(latestBody?.resume?.status).trim();
        const stageBeaconNow = asString(latestBody?.stage_beacon).trim();

        const shouldBackoffForResume =
          resumeNeeded &&
          (resumeStatus === "queued" ||
            resumeStatus === "running" ||
            resumeStatus === "in_progress" ||
            stageBeaconNow === "enrichment_resume_queued" ||
            stageBeaconNow === "enrichment_resume_running" ||
            stageBeaconNow === "enrichment_incomplete_retryable");

        const computeNextDelayMs = () => {
          // When the resume worker is actively running in background, poll more aggressively
          // so we detect completion quickly (worker may finish at any moment).
          const isInProgress =
            resumeNeeded &&
            (resumeStatus === "in_progress" ||
              resumeStatus === "running" ||
              stageBeaconNow === "enrichment_resume_running");

          if (isInProgress) {
            const currentIndex = pollBackoffRef.current.get(sid) || 0;
            const idx = Math.max(0, Math.min(currentIndex, RESUME_POLL_IN_PROGRESS_MS.length - 1));
            pollBackoffRef.current.set(sid, Math.min(idx + 1, RESUME_POLL_IN_PROGRESS_MS.length - 1));
            pollAttemptsRef.current.set(sid, 0);
            return RESUME_POLL_IN_PROGRESS_MS[idx];
          }

          // When resume is queued but not yet triggered, use slower backoff.
          const isQueued =
            resumeNeeded &&
            (resumeStatus === "queued" ||
              stageBeaconNow === "enrichment_resume_queued" ||
              stageBeaconNow === "enrichment_incomplete_retryable");

          if (isQueued) {
            const currentIndex = pollBackoffRef.current.get(sid) || 0;
            const idx = Math.max(0, Math.min(currentIndex, RESUME_POLL_QUEUED_BACKOFF_MS.length - 1));
            pollBackoffRef.current.set(sid, Math.min(idx + 1, RESUME_POLL_QUEUED_BACKOFF_MS.length - 1));

            // Don't let queued resume runs hit the tight-poll max.
            pollAttemptsRef.current.set(sid, 0);

            return RESUME_POLL_QUEUED_BACKOFF_MS[idx];
          }

          pollBackoffRef.current.delete(sid);
          return DEFAULT_POLL_INTERVAL_MS;
        };

        if (nextAttempts > POLL_MAX_ATTEMPTS && !shouldBackoffForResume) {
          const resumeWorker =
            latestBody?.resume_worker && typeof latestBody.resume_worker === "object" ? latestBody.resume_worker : null;
          const invokedAt = asString(resumeWorker?.last_invoked_at).trim();
          const finishedAt = asString(resumeWorker?.last_finished_at).trim();
          const lastResult = asString(resumeWorker?.last_result).trim();

          const triggerError = asString(
            latestBody?.resume?.trigger_error || latestBody?.resume_error || latestBody?.error || latestBody?.message || ""
          ).trim();

          const writeError =
            latestBody?.enrichment_last_write_error && typeof latestBody.enrichment_last_write_error === "object"
              ? latestBody.enrichment_last_write_error
              : null;

          const msg = (() => {
            if (resumeNeeded && !invokedAt) {
              return (
                `Polling paused after ${POLL_MAX_ATTEMPTS} attempts. ` +
                `Resume is still needed, but the resume worker has not invoked yet. ` +
                (triggerError ? `Last trigger error: ${triggerError}. ` : "") +
                `Use "Retry resume" or "View status" for details.`
              );
            }

            if (resumeNeeded && invokedAt && !finishedAt) {
              return (
                `Polling paused after ${POLL_MAX_ATTEMPTS} attempts. ` +
                `Resume worker started at ${invokedAt} but has not finished yet. ` +
                `Use "View status" to confirm progress.`
              );
            }

            if (resumeNeeded && invokedAt && finishedAt && lastResult && lastResult !== "ok") {
              return (
                `Polling paused after ${POLL_MAX_ATTEMPTS} attempts. ` +
                `Resume worker ran at ${invokedAt} and finished at ${finishedAt} with result: ${lastResult}. ` +
                (triggerError ? `Error: ${triggerError}. ` : "") +
                `Use "Retry resume" or "View status" for details.`
              );
            }

            if (writeError && writeError.root_cause) {
              return (
                `Polling paused after ${POLL_MAX_ATTEMPTS} attempts. ` +
                `Last enrichment write failed: ${asString(writeError.root_cause).trim()}. ` +
                (writeError.error ? `Details: ${asString(writeError.error).trim()}. ` : "") +
                `Use "View status" for the recorded failure.`
              );
            }

            return `Polling paused after ${POLL_MAX_ATTEMPTS} attempts. Use "View status" (or "Poll now") to refresh.`;
          })();

          toast.info(msg);
          try {
            setActiveStatus((prev) => (prev === "running" ? "done" : prev));
          } catch {}

          setRuns((prev) =>
            prev.map((r) =>
              r.session_id === sid
                ? {
                    ...r,
                    progress_error: null,
                    progress_notice: msg,
                    polling_exhausted: true,
                    updatedAt: new Date().toISOString(),
                  }
                : r
            )
          );

          return;
        }

        if (result?.unknown_session) {
          const MAX_UNKNOWN_SESSION_ATTEMPTS = 8;
          if (nextAttempts >= MAX_UNKNOWN_SESSION_ATTEMPTS) {
            const msg =
              "No session found after repeated status checks. The gateway may have interrupted before the session was created. Retry start.";

            setRuns((prev) =>
              prev.map((r) =>
                r.session_id === sid
                  ? {
                      ...r,
                      progress_error: msg,
                      progress_notice: null,
                      polling_exhausted: true,
                      updatedAt: new Date().toISOString(),
                    }
                  : r
              )
            );

            setActiveStatus("error");
            toast.error("No session found — retry start");
            return;
          }
        }

        if (result?.shouldStop) {
          stopPolling();
          pollBackoffRef.current.delete(sid);

          const body = result?.body;
          const stageBeacon = asString(body?.stage_beacon).trim();

          const savedCompanies = Array.isArray(body?.saved_companies) ? body.saved_companies : [];

          const savedVerifiedCount =
            typeof body?.saved_verified_count === "number" && Number.isFinite(body.saved_verified_count)
              ? body.saved_verified_count
              : typeof body?.result?.saved_verified_count === "number" && Number.isFinite(body.result.saved_verified_count)
                ? body.result.saved_verified_count
                : null;

          const verifiedIds = Array.isArray(body?.saved_company_ids_verified)
            ? body.saved_company_ids_verified
            : Array.isArray(body?.result?.saved_company_ids_verified)
              ? body.result.saved_company_ids_verified
              : [];

          const unverifiedIds = Array.isArray(body?.saved_company_ids_unverified)
            ? body.saved_company_ids_unverified
            : Array.isArray(body?.result?.saved_company_ids_unverified)
              ? body.result.saved_company_ids_unverified
              : [];

          const persistedIds = mergeUniqueStrings(verifiedIds, unverifiedIds);

          const savedCount = Math.max(
            persistedIds.length,
            savedCompanies.length,
            savedVerifiedCount != null ? savedVerifiedCount : 0,
            Number.isFinite(Number(body?.saved)) ? Number(body.saved) : 0
          );

          const status = asString(body?.status).trim();
          const state = asString(body?.state).trim();
          const jobState = asString(body?.job_state || body?.primary_job_state || body?.primary_job?.job_state).trim();
          const completed = state === "complete" ? true : Boolean(body?.completed);

          const reportSessionStatus = asString(body?.report?.session?.status).trim();
          const resumeNeededExplicitlyFalse = body?.resume_needed === false && body?.resume?.needed === false;

          const stageBeaconValues =
            body?.stage_beacon_values && typeof body.stage_beacon_values === "object" ? body.stage_beacon_values : {};

          const missingRetryable =
            Number.isFinite(Number(stageBeaconValues.status_resume_missing_retryable))
              ? Number(stageBeaconValues.status_resume_missing_retryable)
              : 0;

          const missingTerminal =
            Number.isFinite(Number(stageBeaconValues.status_resume_missing_terminal))
              ? Number(stageBeaconValues.status_resume_missing_terminal)
              : 0;

          const terminalOnly =
            Boolean(stageBeaconValues.status_resume_terminal_only) || (missingRetryable === 0 && missingTerminal > 0 && !Boolean(body?.resume_needed));

          const isTerminalComplete =
            stageBeacon === "complete" ||
            reportSessionStatus === "complete" ||
            resumeNeededExplicitlyFalse ||
            state === "complete" ||
            status === "complete" ||
            jobState === "complete" ||
            completed ||
            terminalOnly;

          if (isTerminalComplete) {
            try {
              setActiveStatus((prev) => (prev === "running" ? "done" : prev));
            } catch {}

            if (savedCount === 0 && !terminalOnly) {
              scheduleTerminalRefresh({ session_id: sid });
            }
          }

          return;
        }

        schedulePoll({ session_id: sid, delayMs: computeNextDelayMs() });
      }, initialDelay);
    },
    [pollProgress, scheduleTerminalRefresh, stopPolling]
  );

  const isUrlLikeQuery = useMemo(() => looksLikeUrlOrDomain(query), [query]);

  useEffect(() => {
    if (!isUrlLikeQuery) return;

    setQueryTypes((prev) => {
      const list = Array.isArray(prev) ? prev : [];
      const withoutKeyword = list.filter((t) => t !== "product_keyword");
      const next = withoutKeyword.includes("company_url") ? withoutKeyword : [...withoutKeyword, "company_url"];
      return next.length > 0 ? next : ["company_url"];
    });
  }, [isUrlLikeQuery]);

  // Auto-select optimal query types when both name + URL are provided
  const isNamePlusUrlMode = useMemo(() => {
    const urlFilled = asString(companyUrl).trim().length > 0;
    const queryIsName = query.trim().length > 0 && !looksLikeUrlOrDomain(query);
    return urlFilled && queryIsName;
  }, [companyUrl, query]);

  useEffect(() => {
    if (isNamePlusUrlMode) {
      setQueryTypes(["company_name", "company_url"]);
    }
  }, [isNamePlusUrlMode]);

  const urlTypeValidationError = useMemo(() => {
    if (!isUrlLikeQuery) return "";
    return queryTypes.includes("company_url")
      ? ""
      : "Query looks like a URL. Switch query type to Company URL/domain.";
  }, [isUrlLikeQuery, queryTypes]);

  const effectiveImportConfig = useMemo(() => {
    // P0 safety guard: the *initial* start import request must never skip primary, and must always be a full "expand" run.
    // The app will only send skip_stages=primary on the resume call, and only when it includes seeded companies.
    const maxStage = "expand";
    const skipStages = [];
    const dryRun = false;

    return {
      pipeline: REVIEWS_ENABLED
        ? "primary → keywords → reviews → location → save → expand"
        : "primary → keywords → location → save → expand",
      overridesLabel: "None",
      maxStage,
      skipStages,
      dryRun,
      persistBlocked: false,
    };
  }, []);

  const startDebugImport = useCallback(async () => {
    const q = debugQuery.trim();
    if (!q) {
      toast.error("Enter a query.");
      return;
    }

    const limit = normalizeImportLimit(debugLimitInput);

    setDebugStartLoading(true);
    setDebugStartResponseText("");
    setDebugStatusResponseText("");
    setDebugSessionId("");

    try {
      const { res } = await apiFetchWithFallback(["/import/start", "/import-start"], {
        method: "POST",
        body: { query: q, limit },
      });

      const body = await readJsonOrText(res);
      setDebugStartResponseText(toPrettyJsonText(body));

      const sid = extractSessionId(body);
      if (sid) setDebugSessionId(sid);

      if (!res.ok || body?.ok === false) {
        const msg = toErrorString(
          (await getUserFacingConfigMessage(res)) || body?.error || body?.message || `Import start failed (${res.status})`
        );
        toast.error(msg || "Import start failed");
        return;
      }

      if (!sid) {
        toast.error("Import start response missing session_id");
        return;
      }

      toast.success("Import started");
    } catch (e) {
      setDebugStartResponseText(JSON.stringify({ error: String(e?.message ?? e) }, null, 2));
      toast.error(e?.message || "Import start failed");
    } finally {
      setDebugStartLoading(false);
    }
  }, [debugLimitInput, debugQuery]);

  const explainDebugImport = useCallback(async () => {
    const q = debugQuery.trim();
    if (!q) {
      toast.error("Enter a query.");
      return;
    }

    const limit = normalizeImportLimit(debugLimitInput);

    setDebugStartLoading(true);
    setDebugStartResponseText("");
    setDebugStatusResponseText("");
    setDebugSessionId("");

    try {
      const { res } = await apiFetchWithFallback(["/import/start?explain=1", "/import-start?explain=1"], {
        method: "POST",
        body: { query: q, limit },
      });

      const body = await readJsonOrText(res);
      setDebugStartResponseText(toPrettyJsonText(body));

      if (!res.ok || body?.ok === false) {
        const msg = toErrorString(
          (await getUserFacingConfigMessage(res)) || body?.error || body?.message || `Explain failed (${res.status})`
        );
        toast.error(msg || "Explain failed");
        return;
      }

      toast.success("Explain payload ready");
    } catch (e) {
      setDebugStartResponseText(JSON.stringify({ error: String(e?.message ?? e) }, null, 2));
      toast.error(e?.message || "Explain failed");
    } finally {
      setDebugStartLoading(false);
    }
  }, [debugLimitInput, debugQuery]);

  const checkDebugStatus = useCallback(async () => {
    const sid = debugSessionId.trim();
    if (!sid) {
      toast.error("Missing session_id");
      return;
    }

    setDebugStatusLoading(true);

    try {
      const { res } = await apiFetchWithFallback([`/import/status?session_id=${encodeURIComponent(sid)}`]);
      const body = await readJsonOrText(res);
      setDebugStatusResponseText(toPrettyJsonText(body));

      if (!res.ok) {
        const msg = toErrorString(
          (await getUserFacingConfigMessage(res)) || body?.error || body?.message || `Status failed (${res.status})`
        );
        toast.error(msg || "Status failed");
      }
    } catch (e) {
      setDebugStatusResponseText(JSON.stringify({ error: String(e?.message ?? e) }, null, 2));
      toast.error(e?.message || "Status failed");
    } finally {
      setDebugStatusLoading(false);
    }
  }, [debugSessionId]);

  const beginImport = useCallback(async (options = {}) => {
    const q = query.trim();
    if (!q) {
      toast.error("Enter a query to import.");
      return;
    }

    if (urlTypeValidationError) {
      toast.error(urlTypeValidationError);
      return;
    }

    if (!importConfigured) {
      toast.error("Import is not configured.");
      return;
    }

    const runMode = options && typeof options === "object" ? asString(options.mode).trim() : "";
    const forceDryRun = runMode === "dry_run";

    const uiSessionIdBefore = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const normalizedLimit = 1;

    const selectedTypes = Array.isArray(queryTypes) && queryTypes.length > 0 ? queryTypes : ["product_keyword"];

    const newRun = {
      session_id: uiSessionIdBefore,
      session_id_confirmed: false,
      ui_session_id_before: uiSessionIdBefore,
      query: q,
      queryTypes: selectedTypes,
      location: asString(location).trim() || "",
      limit: normalizedLimit,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),

      // Debug snapshots (persisted across UI state transitions)
      start_request_payload: null,
      stage_calls: [],
      last_status_http_status: null,
      last_status_checked_at: null,
      last_status_body: null,

      items: [],
      saved: 0,
      saved_companies: [],
      completed: false,
      timedOut: false,
      stopped: false,
      job_state: "",
      stage_beacon: "",
      last_stage_beacon: "",
      final_stage_beacon: "",
      final_job_state: "",
      final_last_error_code: "",
      elapsed_ms: null,
      remaining_budget_ms: null,
      upstream_calls_made: 0,
      companies_candidates_found: 0,
      early_exit_triggered: false,
      last_error: null,
      async_primary_active: false,
      async_primary_timeout_ms: null,
      start_error: null,
      start_error_details: null,
      progress_error: null,
      progress_notice: null,
      polling_exhausted: false,
      accepted_reason: null,
      save_result: null,
      save_error: null,
    };

    setSessionIdMismatchDebug(null);
    setRuns((prev) => [newRun, ...prev]);
    setActiveSessionId(uiSessionIdBefore);
    setActiveStatus("running");

    startFetchAbortRef.current?.abort?.();
    const abort = new AbortController();
    startFetchAbortRef.current = abort;

    try {
      const pipelineMaxStage = "expand";
      const baseSkipStages = [];
      const dryRun = Boolean(forceDryRun);

      const requestPayload = {
        session_id: uiSessionIdBefore,
        query: q,
        queryTypes: selectedTypes,
        company_url_hint: asString(companyUrl).trim() || undefined,
        location: asString(location).trim() || undefined,
        limit: normalizedLimit,
        expand_if_few: true,
        dry_run: dryRun,
      };

      // Pre-warm: fire a lightweight request to wake up the Function App before the heavy import.
      // SWA cold-starts frequently cause 500 "Backend call failure". This non-blocking ping gives
      // the Function App a head-start on initialization.
      try {
        fetch(`${API_BASE}/import/status?session_id=warmup&_t=${Date.now()}`, {
          method: "GET",
          signal: AbortSignal.timeout(8000),
        }).catch(() => {});
        // Wait 3s for the warm-up to take effect before starting the import
        await sleep(3000);
      } catch {}

      // Persist the outbound payload so the Import Report panel can be copied/downloaded later.
      setRuns((prev) =>
        prev.map((r) => (r.session_id === uiSessionIdBefore ? { ...r, start_request_payload: requestPayload } : r))
      );

      let canonicalSessionId = uiSessionIdBefore;
      let mismatchDetected = false;

      const getResponseSessionIdHeader = (res) => {
        try {
          if (res?.headers?.get) return String(res.headers.get("x-session-id") || "");
          if (res?.headers && typeof res.headers === "object") return String(res.headers["x-session-id"] || "");
        } catch {}
        return "";
      };

      const applyCanonicalSessionId = (nextSessionId) => {
        const normalized = asString(nextSessionId).trim();
        if (!normalized) return canonicalSessionId;

        const before = canonicalSessionId;
        const changed = normalized !== canonicalSessionId;

        if (changed) {
          canonicalSessionId = normalized;
          requestPayload.session_id = canonicalSessionId;

          if (!mismatchDetected && uiSessionIdBefore && uiSessionIdBefore !== canonicalSessionId) {
            mismatchDetected = true;
            const mismatch = {
              session_id_mismatch_detected: true,
              ui_session_id_before: uiSessionIdBefore,
              canonical_session_id: canonicalSessionId,
            };

            setSessionIdMismatchDebug(mismatch);
            try {
              console.warn("[admin-import] session_id mismatch", mismatch);
            } catch {}
          }
        }

        setRuns((prev) =>
          prev.map((r) =>
            r.session_id === before
              ? {
                  ...r,
                  session_id: changed ? canonicalSessionId : r.session_id,
                  session_id_confirmed: true,
                  ui_session_id_before: r.ui_session_id_before || uiSessionIdBefore,
                }
              : r
          )
        );

        if (changed) {
          setActiveSessionId((prev) => (prev === before ? canonicalSessionId : prev));

          const prevAttempts = pollAttemptsRef.current.get(before);
          if (prevAttempts != null) {
            pollAttemptsRef.current.delete(before);
            pollAttemptsRef.current.set(canonicalSessionId, prevAttempts);
          }
        }

        setDebugSessionId(changed ? canonicalSessionId : before);

        return canonicalSessionId;
      };

      const syncCanonicalSessionId = ({ res, body }) => {
        const headerSid = getResponseSessionIdHeader(res).trim();
        if (headerSid) return applyCanonicalSessionId(headerSid);

        const sid = extractSessionId(body);
        if (sid) return applyCanonicalSessionId(sid);

        return canonicalSessionId;
      };

      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      const recordStartErrorAndToast = async (res, body, extra) => {
        const configMsg = await getUserFacingConfigMessage(res);
        const errorObj = body?.error && typeof body.error === "object" ? body.error : null;
        const requestId =
          (errorObj?.request_id && String(errorObj.request_id)) ||
          (body?.request_id && String(body.request_id)) ||
          getResponseRequestId(res) ||
          "";

        const msg = toErrorString(
          configMsg ||
            errorObj?.message ||
            body?.legacy_error ||
            body?.message ||
            (typeof body?.error === "string" ? body.error : "") ||
            `Import request failed (HTTP ${res.status})`
        );

        const buildId = getResponseBuildId(res) || getCachedBuildId() || "";

        const detailsForCopy = {
          status: res.status,
          build_id: buildId || null,
          session_id: canonicalSessionId,
          request_id: requestId,
          request_payload: requestPayload,
          response_body: body,
          api_fetch_error: res && res.__api_fetch_error ? res.__api_fetch_error : null,
          ...(extra && typeof extra === "object" ? extra : {}),
        };

        const isNonJsonMasked =
          body &&
          typeof body === "object" &&
          typeof body?.text === "string" &&
          Object.keys(body).length === 1;

        const reportedHttpStatusRaw = body?.http_status ?? errorObj?.http_status ?? null;
        const reportedHttpStatus =
          typeof reportedHttpStatusRaw === "number" && Number.isFinite(reportedHttpStatusRaw)
            ? reportedHttpStatusRaw
            : typeof reportedHttpStatusRaw === "string" && /^\d+$/.test(reportedHttpStatusRaw.trim())
              ? Number(reportedHttpStatusRaw.trim())
              : null;

        const isReported5xx = reportedHttpStatus != null && reportedHttpStatus >= 500;

        // Guard: if import-start fails with a SWA-masked raw-text response ("Backend call failure") or any 5xx,
        // immediately switch to session-driven polling. The session status endpoint is the ONLY source of truth
        // about whether anything was actually persisted.
        const rawText = asString(body?.text).trim();
        const isBackendCallFailureText = isNonJsonMasked && rawText === "Backend call failure";
        const shouldRecoverViaPolling =
          Boolean(canonicalSessionId) &&
          (isBackendCallFailureText || (Number(res?.status) || 0) >= 500 || isReported5xx);

        if (shouldRecoverViaPolling && canonicalSessionId) {
          setRuns((prev) =>
            prev.map((r) =>
              r.session_id === canonicalSessionId
                ? {
                    ...r,
                    // Keep the row visible, but avoid any optimistic saved/completed values.
                    completed: false,
                    start_error: null,
                    start_error_details: detailsForCopy,
                    progress_error: null,
                    progress_notice: isBackendCallFailureText
                      ? "Gateway interrupted — auto-retrying in 5s…"
                      : "Start call failed — auto-retrying in 5s…",
                    polling_exhausted: false,
                    updatedAt: new Date().toISOString(),
                  }
                : r
            )
          );

          resetPollAttempts(canonicalSessionId);
          setActiveStatus("running");

          toast.info(isBackendCallFailureText ? "Gateway interrupted — auto-retrying…" : "Start failed — auto-retrying…");

          // Auto-retry loop: single retry after 5s delay.
          // The SWA gateway may return 500 during cold starts. With the save-first architecture,
          // the backend saves the company stub and fires enrichment async. One retry is sufficient
          // because the backend detects stuck sessions and resets them.
          const retryDelays = [5000];
          let retrySucceeded = false;
          for (let retryIdx = 0; retryIdx < retryDelays.length; retryIdx++) {
            try {
              const delayMs = retryDelays[retryIdx];
              await sleep(delayMs);
              if (abort.signal.aborted) break;

              setRuns((prev) =>
                prev.map((r) =>
                  r.session_id === canonicalSessionId
                    ? { ...r, progress_notice: `Retrying import/start (attempt ${retryIdx + 1}/${retryDelays.length})…`, updatedAt: new Date().toISOString() }
                    : r
                )
              );

              const retryPaths = [`/import/start`, `/import-start`];
              const retryPayload = { ...requestPayload, session_id: canonicalSessionId };
              const { res: retryRes } = await apiFetchWithFallback(retryPaths, {
                method: "POST",
                body: retryPayload,
                signal: abort.signal,
              });
              const retryBody = await readJsonOrText(retryRes);
              syncCanonicalSessionId({ res: retryRes, body: retryBody });

              const retryOk = retryRes.ok || retryBody?.ok === true || retryBody?.accepted === true;

              if (retryOk) {
                setRuns((prev) =>
                  prev.map((r) =>
                    r.session_id === canonicalSessionId
                      ? { ...r, progress_notice: `Retry ${retryIdx + 1} succeeded — monitoring progress…`, updatedAt: new Date().toISOString() }
                      : r
                  )
                );
                retrySucceeded = true;
                break;
              }

              // Check if the response is another SWA 500 (worth retrying) vs a real error (don't retry)
              const retryRawText = asString(retryBody?.text).trim();
              const retryIsSwa500 = (Number(retryRes?.status) || 0) >= 500 &&
                (retryRawText === "Backend call failure" || !retryRawText);
              if (!retryIsSwa500) {
                // Real error (not SWA gateway), stop retrying
                setRuns((prev) =>
                  prev.map((r) =>
                    r.session_id === canonicalSessionId
                      ? { ...r, progress_notice: `Retry ${retryIdx + 1} returned error — falling back to polling…`, updatedAt: new Date().toISOString() }
                      : r
                  )
                );
                break;
              }

              // SWA 500 again, continue retry loop
              try {
                console.warn(`[admin-import] SWA 500 auto-retry attempt ${retryIdx + 1}/${retryDelays.length} still got 500`);
              } catch {}
            } catch (retryErr) {
              try {
                console.warn(`[admin-import] SWA 500 auto-retry attempt ${retryIdx + 1} failed: ${retryErr?.message || String(retryErr)}`);
              } catch {}
            }
          }

          if (!retrySucceeded) {
            setRuns((prev) =>
              prev.map((r) =>
                r.session_id === canonicalSessionId
                  ? { ...r, progress_notice: "All retries failed — falling back to polling…", updatedAt: new Date().toISOString() }
                  : r
              )
            );
          }

          // Fall back to polling regardless of retry outcome
          try {
            await pollProgress({ session_id: canonicalSessionId });
          } catch {}
          schedulePoll({ session_id: canonicalSessionId });
          return;
        }

        setRuns((prev) =>
          prev.map((r) =>
            r.session_id === canonicalSessionId
              ? {
                  ...r,
                  start_error: msg,
                  start_error_details: detailsForCopy,
                }
              : r
          )
        );
        setActiveStatus("error");
        toast.error(
          errorObj?.code
            ? `${msg} (code: ${errorObj.code}${errorObj.step ? `, step: ${errorObj.step}` : ""}${requestId ? `, request_id: ${requestId}` : ""}${buildId ? `, build ${buildId}` : ""})`
            : `${msg}${buildId ? ` (build ${buildId})` : ""}`
        );
      };

      const updateRunCompanies = (companies, extra) => {
        const list = normalizeItems(companies);
        setRuns((prev) =>
          prev.map((r) => {
            if (r.session_id !== canonicalSessionId) return r;
            return {
              ...r,
              ...(extra && typeof extra === "object" ? extra : {}),
              items: mergeById(r.items, list),
              updatedAt: new Date().toISOString(),
            };
          })
        );
        return list;
      };

      const callImportStage = async ({ stage, skipStages, companies }) => {
        const params = new URLSearchParams();

        // IMPORTANT: real imports must not send max_stage=expand (or any max_stage) via query params.
        // The backend should run the full pipeline by default. (Keeping `stage` only for UI/debug labels.)
        if (skipStages && skipStages.length > 0) params.set("skip_stages", skipStages.join(","));
        const qs = params.toString();

        const paths = [`/import/start${qs ? `?${qs}` : ""}`, `/import-start${qs ? `?${qs}` : ""}`];

        const payload = {
          ...requestPayload,
          ...(Array.isArray(companies) && companies.length > 0 ? { companies } : {}),
        };

        try {
          console.log("[admin-import] import/start payload", {
            query: payload.query,
            queryTypes: payload.queryTypes,
            limit: payload.limit,
            max_stage: stage || null,
            skip_stages: Array.isArray(skipStages) ? skipStages : [],
            dry_run: payload.dry_run === true,
          });
        } catch {}

        const { res, usedPath } = await apiFetchWithFallback(paths, {
          method: "POST",
          body: payload,
          signal: abort.signal,
        });

        const body = await readJsonOrText(res);
        return { res, body, usedPath, payload };
      };

      const recordStageCall = ({ stage, skipStages, usedPath, payload, res, body }) => {
        const entry = {
          at: new Date().toISOString(),
          stage: asString(stage).trim() || null,
          skip_stages: Array.isArray(skipStages) ? skipStages : [],
          used_path: asString(usedPath).trim() || null,
          http_status: Number(res?.status) || null,
          request_id: getResponseRequestId(res) || null,
          payload,
          response_body: body,
        };

        setRuns((prev) =>
          prev.map((r) => {
            if (r.session_id !== canonicalSessionId) return r;
            const existing = Array.isArray(r.stage_calls) ? r.stage_calls : [];
            const next = [entry, ...existing].slice(0, 12);
            return {
              ...r,
              stage_calls: next,
              updatedAt: new Date().toISOString(),
            };
          })
        );
      };

      let companiesForNextStage = [];

      const recordStatusFailureAndToast = (body, extra) => {
        const state = asString(body?.state).trim();
        const status = asString(body?.status).trim();
        const reason = asString(body?.reason).trim();
        const stageBeacon = asString(body?.stage_beacon).trim();

        const lastErrorCode = asString(body?.last_error?.code).trim();
        const mappedHardTimeout = formatDurationShort(body?.last_error?.hard_timeout_ms);
        const mappedNoCandidates = formatDurationShort(body?.last_error?.no_candidates_threshold_ms);

        const mappedMsg =
          lastErrorCode === "primary_timeout"
            ? `Primary import timed out${mappedHardTimeout ? ` (${mappedHardTimeout} hard cap)` : ""}.`
            : lastErrorCode === "no_candidates_found"
              ? `No candidates found${mappedNoCandidates ? ` after ${mappedNoCandidates}` : ""}.`
              : "";

        const msg =
          mappedMsg ||
          toErrorString(
            body && typeof body === "object"
              ? body.error || body.last_error || body.message || body.text || (reason ? `Import failed (${reason})` : "")
              : ""
          ) || `Import failed${state ? ` (state: ${state})` : status ? ` (status: ${status})` : ""}`;

        setRuns((prev) =>
          prev.map((r) =>
            r.session_id === canonicalSessionId
              ? {
                  ...r,
                  start_error: msg,
                  start_error_details: {
                    session_id: canonicalSessionId,
                    status_body: body,
                    state,
                    status,
                    reason,
                    stage_beacon: stageBeacon,
                    ...(extra && typeof extra === "object" ? extra : {}),
                  },
                }
              : r
          )
        );
        setActiveStatus("error");
        toast.error(msg);
      };

      const waitForAsyncStatus = async ({ stage }) => {
        stopPolling();

        for (let pollAttempt = 0; pollAttempt < POLL_MAX_ATTEMPTS; pollAttempt += 1) {
          if (abort.signal.aborted) {
            const aborted = new Error("Aborted");
            aborted.name = "AbortError";
            throw aborted;
          }

          const { body, error } = await pollProgress({ session_id: canonicalSessionId });
          if (error) {
            await sleep(2500);
            continue;
          }

          const state = asString(body?.state).trim();
          const status = asString(body?.status).trim();
          const jobState = asString(body?.job_state || body?.primary_job_state).trim();

          const completed = state === "complete" ? true : Boolean(body?.completed);
          const timedOut = Boolean(body?.timedOut);
          const stopped = Boolean(body?.stopped);

          const items = normalizeItems(body?.items || body?.companies);
          const seedCompanies = filterValidSeedCompanies(items);
          const companiesCountRaw = body?.companies_count ?? body?.count ?? items.length ?? 0;
          const companiesCount = Number.isFinite(Number(companiesCountRaw)) ? Number(companiesCountRaw) : items.length;

          const primaryJobState = asString(body?.primary_job?.job_state || body?.primary_job_state || jobState).trim();

          const isFailure =
            state === "failed" ||
            status === "error" ||
            jobState === "error" ||
            primaryJobState === "error" ||
            (body && typeof body === "object" && body.ok === false) ||
            (timedOut ? true : false) ||
            (stopped && !completed);

          if (isFailure) return { kind: "failed", body };

          const hasSeedCompanies = seedCompanies.length > 0;
          const terminalComplete = completed || jobState === "complete" || primaryJobState === "complete";

          if (hasSeedCompanies) return { kind: "ready", body, seedCompanies };

          // Important: never resume the pipeline with skip_stages=["primary"] unless we have a seed list.
          // If primary finishes with 0 candidates, treat it as a clean terminal success (saved: 0), not an error.
          if (terminalComplete) {
            return {
              kind: "no_candidates",
              body: {
                ok: true,
                status: "complete",
                state: "complete",
                stage_beacon: stage === "primary" ? "no_candidates_found" : `stage_${stage}_no_candidates`,
                companies_count: 0,
                items: [],
                saved: 0,
                message: stage === "primary" ? "No companies found." : `Stage \"${stage}\" returned no companies.`,
              },
            };
          }

          await sleep(2500);
        }

        return {
          kind: "exhausted",
          body: {
            ok: true,
            accepted: true,
            status: "accepted",
            state: "accepted",
            stage_beacon: stage === "primary" ? "primary_enqueued" : `stage_${stage}_enqueued`,
            reason: "polling_exhausted",
          },
        };
      };

      resetPollAttempts(canonicalSessionId);
      schedulePoll({ session_id: canonicalSessionId });

      const startResult = await callImportStage({ stage: pipelineMaxStage, skipStages: baseSkipStages, companies: [] });
      syncCanonicalSessionId({ res: startResult.res, body: startResult.body });
      recordStageCall({
        stage: pipelineMaxStage,
        skipStages: baseSkipStages,
        usedPath: startResult.usedPath,
        payload: startResult.payload,
        res: startResult.res,
        body: startResult.body,
      });

      let lastStageBody = startResult.body;

      const startStageBeacon = asString(startResult.body?.stage_beacon).trim();
      const startAcceptReason = extractAcceptReason(startResult.body);

      if (isPrimarySkippedCompanyUrl(startStageBeacon)) {
        const notice = "Company not persisted — primary worker skipped company_url job. Reviews stage did not run.";

        setRuns((prev) =>
          prev.map((r) =>
            r.session_id === canonicalSessionId
              ? {
                  ...r,
                  completed: true,
                  skipped: true,
                  skipped_reason: "primary_skipped_company_url",
                  job_state: "complete",
                  final_job_state: "complete",
                  saved: 0,
                  start_error: null,
                  progress_error: null,
                  progress_notice: notice,
                  stage_beacon: startStageBeacon,
                  last_stage_beacon: startStageBeacon,
                  final_stage_beacon: startStageBeacon,
                  accepted_reason: startAcceptReason || r.accepted_reason || null,
                  updatedAt: new Date().toISOString(),
                }
              : r
          )
        );
        setActiveStatus("done");
        toast.info("Skipped: company_url import did not persist a company");
        return;
      }

      const treatNonOkAsAccepted = (!startResult.res.ok || startResult.body?.ok === false) && isNonErrorAcceptedOutcome(startResult.body);

      if ((!startResult.res.ok || startResult.body?.ok === false) && !treatNonOkAsAccepted) {
        await recordStartErrorAndToast(startResult.res, startResult.body, {
          usedPath: startResult.usedPath,
          mode: "full",
          max_stage: pipelineMaxStage,
          skip_stages: baseSkipStages,
          dry_run: dryRun,
          stage_payload: startResult.payload,
        });
        return;
      }

      if (startResult.res.status === 202 || startResult.body?.accepted === true || treatNonOkAsAccepted) {
        const stageBeacon = asString(startResult.body?.stage_beacon).trim();
        const acceptReason = extractAcceptReason(startResult.body);

        // ── "Seed saved, enriching async" fast path ──
        // The backend saved the company stub and returned 202. Enrichment is running
        // asynchronously in the background. Skip the async-primary wait loop and go
        // directly to polling — the company is already persisted.
        const isSeedSavedAsync =
          stageBeacon === "seed_saved_enriching_async" ||
          (startResult.body?.accepted === true && Number(startResult.body?.saved_count) > 0);

        if (isSeedSavedAsync) {
          const savedVerified = Number(startResult.body?.saved_verified_count) || Number(startResult.body?.saved_count) || 0;
          const stageCompanies = updateRunCompanies(startResult.body?.companies, { async_primary_active: false });
          if (stageCompanies.length > 0) companiesForNextStage = stageCompanies;

          setRuns((prev) =>
            prev.map((r) =>
              r.session_id === canonicalSessionId
                ? {
                    ...r,
                    saved: savedVerified,
                    saved_verified_count: savedVerified,
                    saved_company_ids_verified: Array.isArray(startResult.body?.saved_company_ids_verified)
                      ? startResult.body.saved_company_ids_verified
                      : [],
                    resume_needed: true,
                    start_error: null,
                    progress_notice: "Saved — enrichment running in background…",
                    stage_beacon: stageBeacon,
                    last_stage_beacon: stageBeacon,
                    updatedAt: new Date().toISOString(),
                  }
                : r
            )
          );

          toast.success(`Saved (${savedVerified} verified). Enrichment in progress…`);
          // Fall through to the normal post-stage polling below (don't return)
        } else {
        const isAsyncPrimary =
          startResult.body?.reason === "primary_async_enqueued" ||
          isExpectedAsyncAcceptReason(acceptReason) ||
          stageBeacon.startsWith("primary_") ||
          stageBeacon.startsWith("xai_primary_fetch_");

        if (!isAsyncPrimary) {
          await recordStartErrorAndToast(startResult.res, startResult.body, {
            usedPath: startResult.usedPath,
            mode: "full",
            max_stage: pipelineMaxStage,
            skip_stages: baseSkipStages,
            dry_run: dryRun,
            stage_payload: startResult.payload,
          });
          return;
        }

        const timeoutMsUsed = Number(startResult.body?.timeout_ms_used);
        const timeoutMsForUi = Number.isFinite(timeoutMsUsed) && timeoutMsUsed > 0 ? timeoutMsUsed : null;

        setRuns((prev) =>
          prev.map((r) =>
            r.session_id === canonicalSessionId
              ? {
                  ...r,
                  updatedAt: new Date().toISOString(),
                  start_error: null,
                  progress_notice: isExpectedAsyncAcceptReason(acceptReason)
                    ? "Import accepted, processing asynchronously (upstream timeout)."
                    : "Import accepted, processing asynchronously.",
                  polling_exhausted: false,
                  accepted_reason: acceptReason || r.accepted_reason || null,
                  async_primary_active: true,
                  async_primary_timeout_ms: timeoutMsForUi,
                }
              : r
          )
        );

        try {
          const workerUrl = join(API_BASE, "import/primary-worker");
          fetch(`${workerUrl}?session_id=${encodeURIComponent(canonicalSessionId)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session_id: canonicalSessionId }),
            keepalive: true,
          }).catch(() => {});
        } catch {}

        const waitResult = await waitForAsyncStatus({ stage: "primary" });
        resetPollAttempts(canonicalSessionId);
        schedulePoll({ session_id: canonicalSessionId });

        if (waitResult.kind === "exhausted") {
          setRuns((prev) =>
            prev.map((r) =>
              r.session_id === canonicalSessionId
                ? {
                    ...r,
                    async_primary_active: true,
                    progress_notice:
                      "Import is still processing or completed asynchronously. Use \"View status\" (or \"Poll now\") to refresh.",
                    polling_exhausted: true,
                    updatedAt: new Date().toISOString(),
                  }
                : r
            )
          );
          toast.info("Import still processing asynchronously");
          return;
        }

        if (waitResult.kind === "no_candidates") {
          updateRunCompanies([], { async_primary_active: false });
          setRuns((prev) =>
            prev.map((r) =>
              r.session_id === canonicalSessionId
                ? {
                    ...r,
                    completed: true,
                    updatedAt: new Date().toISOString(),
                    stage_beacon: "no_candidates_found",
                    last_stage_beacon: "no_candidates_found",
                    final_stage_beacon: "no_candidates_found",
                    job_state: "complete",
                    final_job_state: "complete",
                    saved: 0,
                    start_error: null,
                    progress_error: null,
                  }
                : r
            )
          );
          setActiveStatus("done");
          toast.success("No candidates from primary");
          return;
        }

        if (waitResult.kind === "failed") {
          recordStatusFailureAndToast(waitResult.body, { stage: "primary", mode: "full" });
          return;
        }

        const asyncCompanies = normalizeItems(waitResult.body?.items || waitResult.body?.companies);
        const stageCompanies = updateRunCompanies(asyncCompanies, { async_primary_active: false });

        const seedCompanies = Array.isArray(waitResult.seedCompanies)
          ? waitResult.seedCompanies
          : filterValidSeedCompanies(stageCompanies);

        if (seedCompanies.length > 0) companiesForNextStage = seedCompanies;

        if (companiesForNextStage.length === 0) {
          const { body: latestBody } = await pollProgress({ session_id: canonicalSessionId });
          const latestCompanies = normalizeItems(latestBody?.items || latestBody?.companies);
          const latestStageCompanies = updateRunCompanies(latestCompanies, { async_primary_active: false });
          const latestSeedCompanies = filterValidSeedCompanies(latestStageCompanies);
          if (latestSeedCompanies.length > 0) companiesForNextStage = latestSeedCompanies;
        }

        if (companiesForNextStage.length === 0) {
          setRuns((prev) =>
            prev.map((r) =>
              r.session_id === canonicalSessionId
                ? {
                    ...r,
                    completed: true,
                    updatedAt: new Date().toISOString(),
                    stage_beacon: "no_candidates_found",
                    last_stage_beacon: "no_candidates_found",
                    final_stage_beacon: "no_candidates_found",
                    job_state: "complete",
                    final_job_state: "complete",
                    saved: 0,
                    start_error: null,
                    progress_error: null,
                  }
                : r
            )
          );
          setActiveStatus("done");
          toast.success("No candidates from primary");
          return;
        }

        const resumeSkipStages = Array.from(new Set(["primary", ...baseSkipStages]));

        const resumeResult = await callImportStage({
          stage: pipelineMaxStage,
          skipStages: resumeSkipStages,
          companies: companiesForNextStage,
        });

        syncCanonicalSessionId({ res: resumeResult.res, body: resumeResult.body });
        recordStageCall({
          stage: pipelineMaxStage,
          skipStages: resumeSkipStages,
          usedPath: resumeResult.usedPath,
          payload: resumeResult.payload,
          res: resumeResult.res,
          body: resumeResult.body,
        });

        if (!resumeResult.res.ok || resumeResult.body?.ok === false) {
          await recordStartErrorAndToast(resumeResult.res, resumeResult.body, {
            usedPath: resumeResult.usedPath,
            mode: "full_resume",
            max_stage: pipelineMaxStage,
            skip_stages: resumeSkipStages,
            dry_run: dryRun,
            stage_payload: resumeResult.payload,
          });
          return;
        }

        lastStageBody = resumeResult.body;

        const resumeCompanies = updateRunCompanies(resumeResult.body?.companies, { async_primary_active: false });
        if (resumeCompanies.length > 0) companiesForNextStage = resumeCompanies;
      } // end: else (isAsyncPrimary, not isSeedSavedAsync)
      } else {
        const stageCompanies = updateRunCompanies(startResult.body?.companies, { async_primary_active: false });
        if (stageCompanies.length > 0) companiesForNextStage = stageCompanies;
      }

      const warnings = Array.isArray(lastStageBody?.warnings)
        ? lastStageBody.warnings.map((w) => asString(w).trim()).filter(Boolean)
        : [];
      const warningsDetail =
        lastStageBody?.warnings_detail && typeof lastStageBody.warnings_detail === "object" ? lastStageBody.warnings_detail : null;

      const snapshotVerifiedIds = Array.isArray(lastStageBody?.saved_company_ids_verified)
        ? lastStageBody.saved_company_ids_verified
        : Array.isArray(lastStageBody?.saved_company_ids)
          ? lastStageBody.saved_company_ids
          : [];

      const snapshotSavedVerifiedCount =
        typeof lastStageBody?.saved_verified_count === "number" && Number.isFinite(lastStageBody.saved_verified_count)
          ? lastStageBody.saved_verified_count
          : snapshotVerifiedIds.length > 0
            ? snapshotVerifiedIds.length
            : null;

      const snapshotResumeNeeded = Boolean(lastStageBody?.resume_needed);
      const snapshotSaveOutcome = asString(lastStageBody?.save_outcome || lastStageBody?.save_report?.save_outcome).trim() || null;
      const snapshotCompanyUrls = Array.isArray(lastStageBody?.saved_company_urls) ? lastStageBody.saved_company_urls : [];

      setRuns((prev) =>
        prev.map((r) => {
          if (r.session_id !== canonicalSessionId) return r;

          const prevVerifiedIds = Array.isArray(r.saved_company_ids_verified) ? r.saved_company_ids_verified : [];
          const nextVerifiedIds = mergeUniqueStrings(prevVerifiedIds, snapshotVerifiedIds);

          const prevSavedVerified =
            typeof r.saved_verified_count === "number" && Number.isFinite(r.saved_verified_count) ? r.saved_verified_count : 0;
          const nextSavedVerifiedRaw =
            typeof snapshotSavedVerifiedCount === "number" && Number.isFinite(snapshotSavedVerifiedCount) ? snapshotSavedVerifiedCount : 0;

          const nextSavedVerifiedCount = Math.max(prevSavedVerified, nextSavedVerifiedRaw, nextVerifiedIds.length);

          return {
            ...r,
            saved_verified_count: nextSavedVerifiedCount,
            saved_company_ids_verified: nextVerifiedIds,
            saved_company_urls: mergeUniqueStrings(r.saved_company_urls, snapshotCompanyUrls),
            save_outcome: snapshotSaveOutcome || r.save_outcome || null,
            resume_needed: snapshotResumeNeeded || Boolean(r.resume_needed),
            // Do not mark completed here; /import/status polling is the source of truth.
            updatedAt: new Date().toISOString(),
          };
        })
      );

      const responseState = asString(lastStageBody?.state).trim();
      const responseStatus = asString(lastStageBody?.status).trim();
      const terminalComplete = (responseState === "complete" || responseStatus === "complete") && !snapshotResumeNeeded;

      if (terminalComplete) {
        setRuns((prev) =>
          prev.map((r) =>
            r.session_id === canonicalSessionId ? { ...r, completed: true, updatedAt: new Date().toISOString() } : r
          )
        );
        setActiveStatus("done");

        if (warnings.length > 0) {
          const firstKey = warnings[0];
          const detail =
            firstKey && warningsDetail && typeof warningsDetail[firstKey] === "object" ? warningsDetail[firstKey] : null;

          const stage = asString(detail?.stage).trim() || asString(firstKey).trim();
          const rootCause = asString(detail?.root_cause).trim();
          const upstreamStatusRaw = detail?.upstream_status;
          const upstreamStatus = Number.isFinite(Number(upstreamStatusRaw)) ? Number(upstreamStatusRaw) : null;

          const meta = [];
          if (rootCause) meta.push(rootCause);
          if (upstreamStatus != null) meta.push(`HTTP ${upstreamStatus}`);

          const suffix = meta.length ? ` (${meta.join(", ")})` : "";
          const extraCount = warnings.length > 1 ? ` (+${warnings.length - 1} more)` : "";

          toast.warning(`Saved with warnings: ${stage}${suffix}${extraCount}`);
        } else {
          toast.success(`Import finished (${companiesForNextStage.length} companies)`);
        }
      } else {
        // Keep the run in a non-terminal state until /import/status confirms completion.
        const savedVerifiedLabel = (snapshotSavedVerifiedCount ?? snapshotVerifiedIds.length) || 0;
        const label = snapshotResumeNeeded ? `Saved (verified): ${savedVerifiedLabel}. Enrichment in progress…` : "Import started";
        toast.success(label);
      }
    } catch (e) {
      const msg = e?.name === "AbortError" ? "Import aborted" : toErrorString(e) || "Import failed";
      // eslint-disable-next-line no-undef -- canonicalSessionId is defined in the try block above (line ~1614)
      setRuns((prev) => prev.map((r) => (r.session_id === canonicalSessionId ? { ...r, start_error: msg } : r)));
      if (e?.name === "AbortError") {
        setActiveStatus("idle");
      } else {
        setActiveStatus("error");
        toast.error(msg);
      }
    } finally {
      // Keep polling alive long enough to capture saved counts/report from /import/status.
    }
  }, [
    importConfigured,
    location,
    query,
    queryTypes,
    resetPollAttempts,
    pollProgress,
    schedulePoll,
    stopPolling,
    urlTypeValidationError,
  ]);

  const explainImportPayload = useCallback(async () => {
    const q = query.trim();
    if (!q) {
      toast.error("Enter a query to explain.");
      return;
    }

    if (urlTypeValidationError) {
      toast.error(urlTypeValidationError);
      return;
    }

    if (!importConfigured) {
      toast.error("Import is not configured.");
      return;
    }

    const session_id =
      globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const normalizedLimit = 1;
    const selectedTypes = Array.isArray(queryTypes) && queryTypes.length > 0 ? queryTypes : ["product_keyword"];

    const requestPayload = {
      session_id,
      query: q,
      queryTypes: selectedTypes,
      location: asString(location).trim() || undefined,
      limit: normalizedLimit,
      expand_if_few: true,
    };

    setExplainLoading(true);
    setExplainResponseText("");

    try {
      const { res } = await apiFetchWithFallback(["/import-start?explain=1", "/import/start?explain=1"], {
        method: "POST",
        body: requestPayload,
      });

      const body = await readJsonOrText(res);
      const pretty = toPrettyJsonText(body);
      setExplainResponseText(pretty);

      if (!res.ok || body?.ok === false) {
        const msg = toErrorString(
          (await getUserFacingConfigMessage(res)) || body?.error || body?.message || `Explain failed (${res.status})`
        );
        toast.error(msg || "Explain failed");
        return;
      }

      toast.success("Explain payload ready");
    } catch (e) {
      const msg = toErrorString(e) || "Explain failed";
      setExplainResponseText(JSON.stringify({ error: msg }, null, 2));
      toast.error(msg);
    } finally {
      setExplainLoading(false);
    }
  }, [importConfigured, location, query, queryTypes, urlTypeValidationError]);

  const stopImport = useCallback(async () => {
    if (!activeSessionId) return;

    setActiveStatus("stopping");
    startFetchAbortRef.current?.abort?.();

    try {
      const res = await apiFetch("/import/stop", {
        method: "POST",
        body: { session_id: activeSessionId },
      });

      const body = await readJsonOrText(res);
      if (!res.ok) {
        const msg = toErrorString((await getUserFacingConfigMessage(res)) || body?.error || body?.message || body?.text || `Stop failed (${res.status})`);
        toast.error(msg);
        setActiveStatus("running"); // Revert if stop failed
        return;
      }

      toast.success("Stop signal sent");

      // Mark the run as stopped and update UI
      setRuns((prev) =>
        prev.map((r) =>
          r.session_id === activeSessionId
            ? { ...r, stopped: true, progress_notice: "Import stopped by user" }
            : r
        )
      );

      // Brief delay to show "Stopping..." state, then set to idle
      setTimeout(() => {
        stopPolling();
        setActiveStatus("idle");
      }, 1500);

    } catch (e) {
      toast.error(toErrorString(e) || "Stop failed");
      setActiveStatus("running"); // Revert on error
    }
  }, [activeSessionId, stopPolling]);

  const saveResults = useCallback(async () => {
    if (!activeRun) {
      toast.error("No active run");
      return;
    }

    const session_id = asString(activeRun.session_id).trim();
    if (!session_id) {
      toast.error("Missing session id");
      return;
    }

    const runCompleted = Boolean(activeRun.completed || activeRun.timedOut || activeRun.stopped);
    if (!runCompleted) {
      toast.error("Run is still in progress. Wait until it completes.");
      return;
    }

    if (activeRun.save_result?.ok === true) {
      toast.success("This run has already been saved.");
      return;
    }

    const companies = normalizeItems(activeRun.items);
    if (companies.length === 0) {
      toast.error("No companies to save.");
      return;
    }

    setSaveLoading(true);
    setSavingSessionId(session_id);
    setRuns((prev) => prev.map((r) => (r.session_id === session_id ? { ...r, save_error: null } : r)));

    try {
      const res = await apiFetch("/save-companies", {
        method: "POST",
        body: { companies, session_id },
      });

      const body = await readJsonOrText(res);

      if (!res.ok || body?.ok !== true) {
        const msg = toErrorString((await getUserFacingConfigMessage(res)) || body?.error || body?.message || body?.text || `Save failed (${res.status})`);
        setRuns((prev) =>
          prev.map((r) =>
            r.session_id === session_id
              ? { ...r, save_error: msg, save_result: body || { ok: false, error: msg } }
              : r
          )
        );
        toast.error(msg);
        return;
      }

      setRuns((prev) => prev.map((r) => (r.session_id === session_id ? { ...r, save_result: body, save_error: null } : r)));
      toast.success(`Saved ${Number(body?.saved ?? 0) || 0} compan${Number(body?.saved ?? 0) === 1 ? "y" : "ies"}`);
    } catch (e) {
      const msg = toErrorString(e) || "Save failed";
      setRuns((prev) => prev.map((r) => (r.session_id === session_id ? { ...r, save_error: msg } : r)));
      toast.error(msg);
    } finally {
      setSaveLoading(false);
      setSavingSessionId(null);
    }
  }, [activeRun]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setApiVersionLoading(true);
      try {
        const res = await apiFetch("/version");
        const body = await readJsonOrText(res);
        if (cancelled) return;
        if (res.ok) {
          setApiVersion(body);
        } else {
          setApiVersion({ ok: false, status: res.status, body });
        }
      } catch (e) {
        if (cancelled) return;
        setApiVersion({ ok: false, error: toErrorString(e) || "Failed to load version" });
      } finally {
        if (!cancelled) setApiVersionLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      stopPolling();
      startFetchAbortRef.current?.abort?.();

      for (const timer of terminalRefreshTimersRef.current.values()) {
        clearTimeout(timer);
      }
      terminalRefreshTimersRef.current.clear();
      terminalRefreshAttemptsRef.current.clear();
    };
  }, [stopPolling]);

  const activeItems = Array.isArray(activeRun?.items) ? activeRun.items : [];
  const activeSavedCompanies = Array.isArray(activeRun?.saved_companies) ? activeRun.saved_companies : [];
  const activeSavedVerifiedIds = Array.isArray(activeRun?.saved_company_ids_verified) ? activeRun.saved_company_ids_verified : [];
  const activeSavedUnverifiedIds = Array.isArray(activeRun?.saved_company_ids_unverified) ? activeRun.saved_company_ids_unverified : [];

  const activeSavedVerifiedCount =
    typeof activeRun?.saved_verified_count === "number" && Number.isFinite(activeRun.saved_verified_count)
      ? activeRun.saved_verified_count
      : activeSavedVerifiedIds.length;

  const activePersistedIds = mergeUniqueStrings(activeSavedVerifiedIds, activeSavedUnverifiedIds);
  const activeSavedCount = Math.max(
    activeSavedCompanies.length,
    activePersistedIds.length,
    Number.isFinite(Number(activeRun?.saved)) ? Number(activeRun.saved) : 0
  );

  const activeIsTerminal = Boolean(activeRun && (activeRun.completed || activeRun.timedOut || activeRun.stopped));

  // If the start request errored (e.g. post-save follow-up stage) but status polling later confirms
  // that companies were saved, treat it as a warning instead of a fatal import failure.
  useEffect(() => {
    if (!activeRun) return;
    if (activeStatus !== "error") return;
    if (activeSavedVerifiedCount <= 0) return;

    setActiveStatus("done");
  }, [activeRun, activeSavedVerifiedCount, activeStatus]);

  // Play a notification sound each time a company is saved during an import.
  const prevSavedCountRef = useRef(activeSavedCount);
  useEffect(() => {
    const prev = prevSavedCountRef.current;
    prevSavedCountRef.current = activeSavedCount;

    // Only play when the count actually increases (not on reset to 0 for a new run).
    if (activeSavedCount > prev && prev >= 0) {
      playNotification();
    }
  }, [activeSavedCount, playNotification]);

  // Saved results should render as soon as we have verified saved ids/counts, even if the session
  // still needs resume-worker to finish enrichment.
  const showSavedResults = activeSavedVerifiedCount > 0 || activeSavedCompanies.length > 0;
  const activeResults = showSavedResults ? activeSavedCompanies : activeItems;

  const activeItemsCount = activeIsTerminal && activeSavedCount === 0 ? 0 : activeResults.length;
  const canSaveActive = Boolean(activeRun && activeIsTerminal && activeItems.length > 0);

  const lastRequestExplain = getLastApiRequestExplain();
  const lastRequestWindowsCurlScript = buildWindowsSafeCurlOutFileScript({
    url: lastRequestExplain?.url,
    method: lastRequestExplain?.method,
    jsonBody: lastRequestExplain?.bodyString?.full || "",
  });
  const lastRequestWindowsInvokeRestScript = buildWindowsSafeInvokeRestMethodScript({
    url: lastRequestExplain?.url,
    method: lastRequestExplain?.method,
    jsonBody: lastRequestExplain?.bodyString?.full || "",
  });

  const activeSummary = useMemo(() => {
    if (!activeRun) return null;
    const flags = [];
    if (activeRun.completed) flags.push("completed");
    if (activeRun.timedOut) flags.push("timed out");
    if (activeRun.stopped) flags.push("stopped");
    if (activeRun.start_error) flags.push("error");
    return flags.join(" · ");
  }, [activeRun]);

  const activeAsyncPrimaryMessage = useMemo(() => {
    if (!activeRun || !activeRun.async_primary_active) return null;

    const stageBeacon = asString(activeRun.stage_beacon).trim();

    const elapsedMs = Number(activeRun.elapsed_ms);
    const remainingMs = Number(activeRun.remaining_budget_ms);
    const upstreamCalls = Number(activeRun.upstream_calls_made);
    const candidatesFound = Number(activeRun.companies_candidates_found);

    const elapsedSeconds = Number.isFinite(elapsedMs) && elapsedMs >= 0 ? Math.round(elapsedMs / 1000) : null;
    const remainingSeconds = Number.isFinite(remainingMs) && remainingMs >= 0 ? Math.round(remainingMs / 1000) : null;

    const progressBits = [];
    if (elapsedSeconds != null) progressBits.push(`${elapsedSeconds}s elapsed`);
    if (remainingSeconds != null) progressBits.push(`${remainingSeconds}s remaining`);
    if (Number.isFinite(upstreamCalls) && upstreamCalls > 0) progressBits.push(`${upstreamCalls} upstream call${upstreamCalls === 1 ? "" : "s"}`);
    if (Number.isFinite(candidatesFound) && candidatesFound > 0) progressBits.push(`${candidatesFound} candidate${candidatesFound === 1 ? "" : "s"}`);

    const suffix = progressBits.length > 0 ? ` (${progressBits.join(" · ")})` : "";

    const lastErrorCode = asString(activeRun?.last_error?.code).trim();

    if (lastErrorCode === "no_candidates_found") {
      const threshold = formatDurationShort(activeRun?.last_error?.no_candidates_threshold_ms);
      return `No candidates found${threshold ? ` after ${threshold}` : ""}.${suffix}`;
    }
    if (lastErrorCode === "primary_timeout" || stageBeacon === "primary_timeout") {
      const hardCap = formatDurationShort(activeRun?.last_error?.hard_timeout_ms);
      return `Primary import timed out${hardCap ? ` (${hardCap} hard cap)` : ""}.${suffix}`;
    }

    if (stageBeacon) return `${toEnglishImportStage(stageBeacon)}${suffix}`;

    return `Searching for matching companies${suffix}`;
  }, [activeRun]);

  const skipEnrichmentWarning = useMemo(() => {
    if (!activeRun) return null;

    const report = activeRun.report && typeof activeRun.report === "object" ? activeRun.report : null;
    const session = report?.session && typeof report.session === "object" ? report.session : null;
    const request = session?.request && typeof session.request === "object" ? session.request : null;

    const skipStages = Array.isArray(request?.skip_stages) ? request.skip_stages.map((s) => asString(s).trim()).filter(Boolean) : [];
    if (skipStages.length === 0) return null;

    const enrichmentStages = new Set(["keywords", ...(REVIEWS_ENABLED ? ["reviews"] : []), "location"]);
    const skippedEnrichment = skipStages.filter((s) => enrichmentStages.has(s));
    if (skippedEnrichment.length === 0) return null;

    return { skipStages, skippedEnrichment };
  }, [activeRun]);

  const keywordsStageSkipped = useMemo(() => {
    if (!activeRun) return false;

    const report = activeRun.report && typeof activeRun.report === "object" ? activeRun.report : null;
    const session = report?.session && typeof report.session === "object" ? report.session : null;
    const request = session?.request && typeof session.request === "object" ? session.request : null;

    const skipStages = Array.isArray(request?.skip_stages) ? request.skip_stages.map((s) => asString(s).trim()).filter(Boolean) : [];
    return skipStages.includes("keywords");
  }, [activeRun]);

  const plainEnglishProgress = useMemo(() => {
    if (!activeRun) {
      return {
        hasRun: false,
        isTerminal: false,
        terminalKind: "",
        stepText: "",
        reasonText: "",
      };
    }

    const rawJobState = asString(activeRun.final_job_state || activeRun.job_state).trim().toLowerCase();

    const resumeNeeded = Boolean(activeRun.resume_needed || activeRun.report?.session?.resume_needed);

    const inferredTerminal =
      !resumeNeeded &&
      (rawJobState === "complete" ||
        rawJobState === "error" ||
        Boolean(activeRun.completed || activeRun.timedOut || activeRun.stopped) ||
        Boolean(activeRun.start_error || activeRun.progress_error));

    const stageBeacon = asString(
      (inferredTerminal ? activeRun.final_stage_beacon : "") || activeRun.stage_beacon || activeRun.last_stage_beacon
    ).trim();

    const savedCompanies = Array.isArray(activeRun.saved_companies) ? activeRun.saved_companies : [];
    const savedCount = savedCompanies.length > 0 ? savedCompanies.length : Number(activeRun.saved ?? 0) || 0;

    // Saved count is authoritative, but some older runs only signaled persistence via stage beacon.
    // Treat cosmos_write_done as a persisted signal so the UI never claims "No company persisted" when a company was written.
    const persistedDetected = savedCount > 0 || stageBeacon === "cosmos_write_done";

    let stepText = stageBeacon ? toEnglishImportStage(stageBeacon) : "";

    if (inferredTerminal && !persistedDetected) {
      if (stageBeacon === "primary_early_exit") {
        stepText = "Single match found, but no save was performed";
      }
    }

    const terminalKind =
      rawJobState === "error" || activeRun.start_error || activeRun.progress_error
        ? "error"
        : rawJobState === "complete" || activeRun.completed
          ? "complete"
          : "";

    const lastErrorCode = asString(
      (inferredTerminal ? activeRun.final_last_error_code : "") || activeRun?.last_error?.code
    ).trim();

    let reasonText = terminalKind === "error" ? toEnglishImportStopReason(lastErrorCode) : "";

    if (terminalKind === "complete" && !persistedDetected) {
      const report = activeRun.report && typeof activeRun.report === "object" ? activeRun.report : null;
      const session = report?.session && typeof report.session === "object" ? report.session : null;
      const request = session?.request && typeof session.request === "object" ? session.request : null;
      const skipStages = Array.isArray(request?.skip_stages)
        ? request.skip_stages.map((s) => asString(s).trim()).filter(Boolean)
        : [];

      const dryRunEnabled = Boolean(request?.dry_run);
      const terminalOnly = Boolean(activeRun.terminal_only);

      if (terminalOnly) {
        reasonText = "Completed (terminal-only): remaining missing fields were marked Not disclosed / Exhausted. No resume needed.";
      } else if (dryRunEnabled) {
        reasonText = "Dry run: saving was skipped by config (dry_run=true).";
      } else if (skipStages.includes("primary")) {
        reasonText = "Match found, but persistence was skipped by config (skip_stages includes primary).";
      } else if (stageBeacon === "primary_early_exit") {
        reasonText = "Completed with an early exit. No company was persisted.";
      } else if (isPrimarySkippedCompanyUrl(stageBeacon)) {
        reasonText = "Company not persisted — primary worker skipped company_url job. Reviews stage did not run.";
      } else if (stageBeacon === "no_candidates_found" || lastErrorCode === "no_candidates_found") {
        reasonText = "Completed: no eligible companies found.";
      } else {
        reasonText = "Completed: no company persisted.";
      }
    }

    return {
      hasRun: true,
      isTerminal: inferredTerminal,
      terminalKind,
      stepText,
      reasonText,
    };
  }, [activeRun]);

  const activeReportPayload = useMemo(() => {
    if (!activeRun) return null;

    const report = activeRun.report && typeof activeRun.report === "object" ? activeRun.report : null;
    const saveResult =
      activeRun.save_result && typeof activeRun.save_result === "object" && activeRun.save_result.ok === true
        ? activeRun.save_result
        : null;

    if (!report && !saveResult) return null;

    return {
      session_id: activeRun.session_id,
      stage_beacon: asString(activeRun.final_stage_beacon || activeRun.stage_beacon || activeRun.last_stage_beacon).trim() || null,
      saved: Number.isFinite(Number(activeRun.saved)) ? Number(activeRun.saved) : null,
      report,
      ...(saveResult ? { save_result: saveResult } : {}),
    };
  }, [activeRun]);

  const activeReportText = useMemo(() => {
    if (!activeReportPayload) return "";
    try {
      return JSON.stringify(activeReportPayload, null, 2);
    } catch {
      return String(activeReportPayload);
    }
  }, [activeReportPayload]);

  useEffect(() => {
    if (importReportRef.current && activeReportText) {
      importReportRef.current.scrollTop = importReportRef.current.scrollHeight;
    }
  }, [activeReportText]);

  const activeDebugPayload = useMemo(() => {
    if (!activeRun) return null;

    return {
      kind: "admin_import_debug",
      captured_at: new Date().toISOString(),
      session_id: asString(activeRun.session_id).trim() || null,
      run: activeRun,
      report: activeReportPayload,
      last_request_explain: getLastApiRequestExplain(),
    };
  }, [activeRun, activeReportPayload]);

  const activeDebugText = useMemo(() => {
    if (!activeDebugPayload) return "";
    return toPrettyJsonText(activeDebugPayload);
  }, [activeDebugPayload]);

  const resumeDebugPayload = useMemo(() => {
    if (!activeRun) return null;
    const bundle = activeRun?.last_resume_debug_bundle;
    return bundle && typeof bundle === "object" ? bundle : null;
  }, [activeRun]);

  const resumeDebugText = useMemo(() => {
    if (!resumeDebugPayload) return "";
    return toPrettyJsonText(resumeDebugPayload);
  }, [resumeDebugPayload]);

  const beginImportOneUrl = useCallback(async () => {
    const url = query.trim();
    if (!url || !looksLikeUrlOrDomain(url)) {
      toast.error("Enter a valid URL to import.");
      return;
    }

    if (!importConfigured) {
      toast.error("Import is not configured.");
      return;
    }

    const uiSessionId = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const newRun = {
      session_id: uiSessionId,
      session_id_confirmed: false,
      query: url,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      items: [],
      saved: 0,
      completed: false,
      start_error: null,
      progress_error: null,
      progress_notice: null,
    };

    setRuns((prev) => [newRun, ...prev]);
    setActiveSessionId(uiSessionId);
    setActiveStatus("running");

    try {
      const res = await apiFetch("/import-one", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      const body = await readJsonOrText(res);

      if (!res.ok || !body.ok) {
        const errorCode = body?.error?.code;
        const msg = typeof body?.error?.message === "string" ? body.error.message : `Failed (HTTP ${res.status})`;

        // Handle duplicate company error with more context
        const isDuplicate = errorCode === "duplicate_company" || res.status === 409;
        const existingCompany = body?.error?.existing_company;

        setRuns((prev) =>
          prev.map((r) =>
            r.session_id === uiSessionId
              ? {
                  ...r,
                  start_error: msg,
                  updatedAt: new Date().toISOString(),
                  ...(isDuplicate && existingCompany ? { duplicate_company: existingCompany } : {}),
                }
              : r
          )
        );

        if (isDuplicate) {
          toast.error(msg, { duration: 6000 });
        } else {
          toast.error(msg);
        }
        setActiveStatus("error");
        return;
      }

      const sessionId = body.session_id || uiSessionId;

      if (body.completed) {
        const isDuplicate = body.save_outcome === "duplicate_detected" ||
          body.stage_beacon === "duplicate_detected" ||
          body.last_error?.code === "DUPLICATE_DETECTED";
        const dupName = body.duplicate_company_name || body.last_error?.message || "";
        const dupId = body.duplicate_of_id || "";

        if (isDuplicate) {
          setRuns((prev) =>
            prev.map((r) =>
              r.session_id === uiSessionId
                ? {
                    ...r,
                    session_id: sessionId,
                    session_id_confirmed: true,
                    saved: 0,
                    completed: true,
                    stage_beacon: "duplicate_detected",
                    final_stage_beacon: "duplicate_detected",
                    save_outcome: "duplicate_detected",
                    duplicate_of_id: dupId,
                    duplicate_company_name: dupName,
                    updatedAt: new Date().toISOString(),
                  }
                : r
            )
          );
          toast.warning(
            dupName
              ? `Already exists: ${dupName}`
              : "Company already exists in the database",
            { duration: 6000 }
          );
          setActiveStatus("done");
        } else {
          // Import completed within the request — compute saved count from all available signals
          const savedCompanies = Array.isArray(body.saved_companies) ? body.saved_companies : [];
          const savedVerifiedIds = Array.isArray(body.saved_company_ids_verified) ? body.saved_company_ids_verified : [];
          const savedUnverifiedIds = Array.isArray(body.saved_company_ids_unverified) ? body.saved_company_ids_unverified : [];
          const savedIdsTotal = new Set([...savedVerifiedIds, ...savedUnverifiedIds]).size;
          const computedSaved = Math.max(
            Number(body.saved_count) || 0,
            Number(body.saved) || 0,
            Number(body.saved_verified_count) || 0,
            savedCompanies.length,
            savedIdsTotal,
          );
          setRuns((prev) =>
            prev.map((r) =>
              r.session_id === uiSessionId
                ? {
                    ...r,
                    session_id: sessionId,
                    session_id_confirmed: true,
                    saved: computedSaved,
                    saved_companies: savedCompanies.length > 0 ? savedCompanies : r.saved_companies,
                    saved_company_ids_verified: savedVerifiedIds.length > 0 ? savedVerifiedIds : r.saved_company_ids_verified,
                    saved_company_ids_unverified: savedUnverifiedIds.length > 0 ? savedUnverifiedIds : r.saved_company_ids_unverified,
                    completed: true,
                    updatedAt: new Date().toISOString(),
                  }
                : r
            )
          );
          toast.success(`Import complete: ${computedSaved} company saved${savedCompanies[0]?.company_name ? ` (${savedCompanies[0].company_name})` : ""}`);
          setActiveStatus("done");
        }
      } else {
        // Import still running, start polling
        setRuns((prev) =>
          prev.map((r) =>
            r.session_id === uiSessionId
              ? {
                  ...r,
                  session_id: sessionId,
                  session_id_confirmed: true,
                  updatedAt: new Date().toISOString(),
                }
              : r
          )
        );
        toast.info("Import started, polling for completion...");
        resetPollAttempts(sessionId);
        schedulePoll({ session_id: sessionId });
      }
    } catch (e) {
      const msg = toErrorString(e) || "Import request failed";
      setRuns((prev) =>
        prev.map((r) =>
          r.session_id === uiSessionId
            ? { ...r, start_error: msg, updatedAt: new Date().toISOString() }
            : r
        )
      );
      toast.error(msg);
      setActiveStatus("error");
    }
  }, [query, importConfigured, resetPollAttempts, schedulePoll]);

  const startImportDisabled = !API_BASE || activeStatus === "running" || activeStatus === "stopping";

  useEffect(() => {
    if (activeStatus !== "running" && activeStatus !== "stopping") {
      startImportRequestInFlightRef.current = false;
    }
  }, [activeStatus]);

  const handleStartImportStaged = useCallback(() => {
    if (startImportDisabled) return;
    if (startImportRequestInFlightRef.current) return;

    startImportRequestInFlightRef.current = true;

    const q = query.trim();
    const isUrl = looksLikeUrlOrDomain(q);

    if (isUrl) {
      // Single URL import using new import-one endpoint
      beginImportOneUrl();
    } else {
      // Bulk import using traditional import-start
      beginImport();
    }

    // If either handler bails early (validation/config), don't lock the UI.
    setTimeout(() => {
      const status = activeStatusRef.current;
      if (status !== "running" && status !== "stopping") {
        startImportRequestInFlightRef.current = false;
      }
    }, 0);
  }, [query, beginImport, beginImportOneUrl, startImportDisabled]);

  const handleQueryInputEnter = useCallback(
    (e) => {
      if (!e) return;
      if (e.nativeEvent?.isComposing) return;

      e.preventDefault();
      e.stopPropagation();
      handleStartImportStaged();
    },
    [handleStartImportStaged]
  );

  // Succession import: start handler
  const handleStartSuccession = useCallback(() => {
    if (startImportDisabled) return;

    if (successionCount <= 1) {
      handleStartImportStaged();
      return;
    }

    const validRows = successionRows.filter(
      (row) => row.companyName.trim() || row.companyUrl.trim()
    );

    if (validRows.length === 0) {
      toast.error("Enter at least one company name or URL.");
      return;
    }

    setSuccessionQueue(validRows);
    setSuccessionResults([]);
    setSuccessionIndex(0);

    const first = validRows[0];
    setQuery(first.companyName);
    setCompanyUrl(first.companyUrl);
    successionTriggerRef.current = true;
  }, [successionCount, successionRows, startImportDisabled, handleStartImportStaged]);

  // Succession import: trigger effect — fires the import after state has updated
  useEffect(() => {
    if (successionIndex < 0 || successionIndex >= successionQueue.length) return;
    if (!successionTriggerRef.current) return;

    successionTriggerRef.current = false;
    handleStartImportStaged();
  }, [successionIndex, query, companyUrl, handleStartImportStaged, successionQueue]);

  // Succession import: advancement effect — when current import completes, start next
  useEffect(() => {
    if (successionIndex < 0) return;
    if (activeStatus !== "done" && activeStatus !== "error") return;

    setSuccessionResults((prev) => [
      ...prev,
      { index: successionIndex, status: activeStatus === "done" ? "done" : "error", sessionId: activeSessionId },
    ]);

    const nextIndex = successionIndex + 1;

    if (nextIndex >= successionQueue.length) {
      const doneCount = successionResults.length + 1;
      setSuccessionIndex(-1);
      toast.success(`Succession import complete: ${doneCount} imports processed`);
      return;
    }

    const next = successionQueue[nextIndex];
    setQuery(next.companyName);
    setCompanyUrl(next.companyUrl);
    setSuccessionIndex(nextIndex);
    successionTriggerRef.current = true;
  }, [activeStatus, successionIndex, successionQueue, activeSessionId, successionResults]);

  // Bulk import handlers
  const bulkUrlCount = useMemo(() => {
    return bulkUrls.split("\n").map((s) => s.trim()).filter(Boolean).length;
  }, [bulkUrls]);

  const handleBulkEnqueue = useCallback(async () => {
    if (bulkEnqueueLoading) return;
    const urls = bulkUrls.split("\n").map((s) => s.trim()).filter(Boolean);
    if (urls.length === 0) {
      toast.error("Enter at least one URL");
      return;
    }
    if (urls.length > 50) {
      toast.error("Maximum 50 URLs per batch");
      return;
    }

    setBulkEnqueueLoading(true);
    try {
      const res = await fetch(`${API_BASE}/bulk-import/enqueue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls }),
      });
      const data = await res.json();
      if (!data.ok) {
        toast.error(data.message || data.error || "Failed to enqueue");
        return;
      }
      setActiveBatchId(data.batch_id);
      setBatchJobs(data.jobs || []);
      setBulkUrls("");
      toast.success(`Queued ${data.summary?.total || urls.length} URLs for import`);
    } catch (err) {
      toast.error(err?.message || "Failed to enqueue bulk import");
    } finally {
      setBulkEnqueueLoading(false);
    }
  }, [bulkUrls, bulkEnqueueLoading]);

  // Poll for batch status
  useEffect(() => {
    if (!activeBatchId) return;

    const pollBatchStatus = async () => {
      try {
        const res = await fetch(`${API_BASE}/bulk-import/status?batch_id=${activeBatchId}`);
        const data = await res.json();
        if (data.ok && data.jobs) {
          setBatchJobs(data.jobs);
          // Stop polling when all complete
          if (data.summary?.queued === 0 && data.summary?.running === 0) {
            return true; // Done polling
          }
        }
      } catch (err) {
        console.warn("[bulk-import] Failed to fetch batch status:", err);
      }
      return false;
    };

    // Initial poll
    pollBatchStatus();

    // Set up interval
    const interval = setInterval(async () => {
      const done = await pollBatchStatus();
      if (done) {
        clearInterval(interval);
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [activeBatchId]);

  return (
    <>
      <Helmet>
        <title>Tabarnam Admin — Company Import</title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>

      <div className="min-h-screen bg-slate-50 dark:bg-background">
        <AdminHeader />

        <main className="container mx-auto py-6 px-4 space-y-6">
          <header className="flex flex-col gap-2">
            <h1 className="text-3xl font-bold text-slate-900 dark:text-foreground">Company Import</h1>
            <p className="text-sm text-slate-600 dark:text-muted-foreground">Start an import session and poll progress until it completes.</p>
          </header>

          <StatusAlerts
            activeRun={activeRun}
            activeStatus={activeStatus}
            API_BASE={API_BASE}
            replayNotification={replayNotification}
          />

          <section className="rounded-lg border border-slate-200 dark:border-border bg-white dark:bg-card p-5 space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-3">
              {successionCount <= 1 ? (
                <>
                  <div className="lg:col-span-2 space-y-1">
                    <label className="text-sm text-slate-700 dark:text-muted-foreground">Company Name</label>
                    <Input
                      value={query}
                      onChange={(e) => {
                        setQuery(e.target.value);
                        setSuccessionRows((prev) => {
                          const updated = [...prev];
                          updated[0] = { ...updated[0], companyName: e.target.value };
                          return updated;
                        });
                      }}
                      onEnter={handleQueryInputEnter}
                      placeholder="e.g. Acme Widgets"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-sm text-slate-700 dark:text-muted-foreground">Company URL</label>
                    <Input
                      value={companyUrl}
                      onChange={(e) => {
                        setCompanyUrl(e.target.value);
                        setSuccessionRows((prev) => {
                          const updated = [...prev];
                          updated[0] = { ...updated[0], companyUrl: e.target.value };
                          return updated;
                        });
                      }}
                      placeholder="e.g. acmewidgets.com"
                    />
                  </div>
                </>
              ) : null}

              <div className={successionCount > 1 ? "lg:col-span-3 space-y-1" : "space-y-1"}>
                <label className="text-sm text-slate-700 dark:text-muted-foreground">Location (optional)</label>
                <Input
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="e.g. United States or Austin, TX"
                />
              </div>

              <div className="space-y-1">
                <label className="text-sm text-slate-700 dark:text-muted-foreground"># of Imports to Run in Succession</label>
                <Input
                  value={successionCountInput}
                  onChange={(e) => {
                    const next = e.target.value;
                    if (next === "" || /^\d+$/.test(next)) {
                      handleSuccessionCountChange(next);
                    }
                  }}
                  onBlur={() => setSuccessionCountInput((prev) => String(normalizeSuccessionCount(prev)))}
                  inputMode="numeric"
                  disabled={isSuccessionRunning}
                />
              </div>
            </div>

            {successionCount > 1 ? (
              <div className="space-y-2">
                <div className="text-sm font-medium text-slate-700 dark:text-muted-foreground">Import queue ({successionCount} companies)</div>
                {successionRows.map((row, i) => (
                  <div key={i} className="grid grid-cols-[2rem_2fr_1fr] gap-2 items-end">
                    <div className="text-xs text-slate-500 dark:text-muted-foreground text-right pb-2">{i + 1}.</div>
                    <div className="space-y-1">
                      {i === 0 ? <label className="text-xs text-slate-500 dark:text-muted-foreground">Company Name</label> : null}
                      <Input
                        value={row.companyName}
                        onChange={(e) => updateSuccessionRow(i, "companyName", e.target.value)}
                        placeholder="e.g. Acme Widgets"
                        disabled={isSuccessionRunning}
                      />
                    </div>
                    <div className="space-y-1">
                      {i === 0 ? <label className="text-xs text-slate-500 dark:text-muted-foreground">Company URL</label> : null}
                      <Input
                        value={row.companyUrl}
                        onChange={(e) => updateSuccessionRow(i, "companyUrl", e.target.value)}
                        placeholder="e.g. acmewidgets.com"
                        disabled={isSuccessionRunning}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700 dark:text-muted-foreground">Query types</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {[
                  { key: "product_keyword", label: "Keyword" },
                  { key: "company_name", label: "Company name" },
                  { key: "company_url", label: "Company URL/domain" },
                  { key: "industry", label: "Industry" },
                  { key: "hq_country", label: "HQ country" },
                  { key: "manufacturing_country", label: "Manufacturing country" },
                ].map((opt) => (
                  <label
                    key={opt.key}
                    className="flex items-center gap-2 rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted px-3 py-2 text-sm text-slate-800 dark:text-foreground"
                  >
                    <input
                      type="checkbox"
                      checked={queryTypes.includes(opt.key)}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setQueryTypes((prev) => {
                          const list = Array.isArray(prev) ? prev : [];
                          if (checked) return Array.from(new Set([...list, opt.key]));
                          const next = list.filter((v) => v !== opt.key);
                          return next.length > 0 ? next : [isUrlLikeQuery ? "company_url" : "product_keyword"];
                        });
                      }}
                    />
                    {opt.label}
                  </label>
                ))}
              </div>
              {isNamePlusUrlMode ? (
                <div className="text-xs text-emerald-700">Name + URL provided — query types auto-selected for best results.</div>
              ) : urlTypeValidationError ? (
                <div className="text-xs text-red-700">{urlTypeValidationError}</div>
              ) : (
                <div className="text-xs text-slate-600 dark:text-muted-foreground">If you provide a location, results that match it are ranked higher.</div>
              )}
            </div>

            <details className="rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted px-4 py-3">
              <summary className="cursor-pointer select-none text-sm font-medium text-slate-800 dark:text-foreground">Advanced import config</summary>
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-3 text-xs text-slate-600 dark:text-muted-foreground space-y-1">
                  <div>
                    <span className="font-semibold">Safety rule:</span> the initial “Start import” call always sends max_stage=expand, skip_stages=(none),
                    dry_run=false.
                  </div>
                  <div>
                    If the first call returns 202 (async primary), the UI will poll /api/import/status until it receives a non-empty seed company list,
                    then resume with skip_stages=primary <span className="font-semibold">and</span> companies=[...].
                  </div>
                </div>
              </div>
            </details>

            <div className="rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted px-3 py-2 text-xs text-slate-700 dark:text-muted-foreground space-y-1">
              <div>
                <span className="font-semibold">Pipeline:</span> {effectiveImportConfig.pipeline}
              </div>
              <div>
                <span className="font-semibold">Overrides:</span> {effectiveImportConfig.overridesLabel}
              </div>
              <div>
                <span className="font-semibold">Effective request:</span> max_stage={effectiveImportConfig.maxStage}; skip_stages=
                {effectiveImportConfig.skipStages.length > 0 ? effectiveImportConfig.skipStages.join(",") : "(none)"}; dry_run=
                {effectiveImportConfig.dryRun ? "true" : "false"}
              </div>
              <div>
                <span className="font-semibold">Resume debug:</span> resume_allowed:{" "}
                {activeRun && ((Array.isArray(activeRun.items) && activeRun.items.length > 0) || (Array.isArray(activeRun.saved_companies) && activeRun.saved_companies.length > 0))
                  ? "true"
                  : "false"} (seeded_companies_count=
                {activeRun
                  ? Array.isArray(activeRun.items) && activeRun.items.length > 0
                    ? activeRun.items.length
                    : Array.isArray(activeRun.saved_companies)
                      ? activeRun.saved_companies.length
                      : 0
                  : 0}
                )
              </div>
            </div>

            {skipEnrichmentWarning ? (
              <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 mt-0.5" />
                <div className="space-y-0.5">
                  <div className="font-semibold">You are skipping enrichment</div>
                  <div className="text-xs text-amber-900/90">
                    Saved companies will be stub profiles. Skipped stages: {skipEnrichmentWarning.skippedEnrichment.join(", ")}.
                  </div>
                </div>
              </div>
            ) : null}

            {isSuccessionRunning ? (
              <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800 space-y-2">
                <div className="font-medium">
                  Succession import: {successionIndex + 1} of {successionQueue.length}
                </div>
                <div className="flex gap-1 flex-wrap">
                  {successionResults.map((r, i) => (
                    <span
                      key={i}
                      className={`inline-block h-2 w-4 rounded ${r.status === "done" ? "bg-emerald-400" : "bg-red-400"}`}
                      title={`Import ${i + 1}: ${r.status}`}
                    />
                  ))}
                  <span className="inline-block h-2 w-4 rounded bg-blue-400 animate-pulse" title={`Import ${successionIndex + 1}: running`} />
                  {Array.from({ length: successionQueue.length - successionIndex - 1 }).map((_, i) => (
                    <span key={`pending-${i}`} className="inline-block h-2 w-4 rounded bg-slate-200" title="Pending" />
                  ))}
                </div>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" onClick={handleStartSuccession} disabled={startImportDisabled || isSuccessionRunning}>
                <Play className="h-4 w-4 mr-2" />
                {isSuccessionRunning
                  ? `Running ${successionIndex + 1}/${successionQueue.length}…`
                  : activeStatus === "running"
                    ? "Running…"
                    : successionCount > 1
                      ? `Start ${successionCount} imports`
                      : "Start import"}
              </Button>

              <Button
                type="button"
                variant="outline"
                onClick={() => beginImport({ mode: "dry_run" })}
                disabled={startImportDisabled}
              >
                Dry run (no save)
              </Button>

              <Button
                type="button"
                variant="outline"
                onClick={explainImportPayload}
                disabled={!API_BASE || explainLoading}
              >
                Explain payload
              </Button>

              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  if (!activeSessionId || !activeRun?.session_id_confirmed) {
                    toast.error("Session id is not ready yet");
                    return;
                  }
                  resetPollAttempts(activeSessionId);
                  schedulePoll({ session_id: activeSessionId });
                  toast.success("Polling refresh started");
                }}
                disabled={!activeSessionId || !activeRun?.session_id_confirmed}
              >
                <RefreshCcw className="h-4 w-4 mr-2" />
                Poll now
              </Button>

              <Button
                type="button"
                variant="outline"
                className={`border-red-600 text-red-600 hover:bg-red-600 hover:text-white ${
                  activeStatus === "stopping" ? "opacity-70" : ""
                }`}
                onClick={() => {
                  if (isSuccessionRunning) {
                    setSuccessionIndex(-1);
                    setSuccessionQueue([]);
                  }
                  stopImport();
                }}
                disabled={!activeSessionId || !activeRun?.session_id_confirmed || (activeStatus !== "running" && activeStatus !== "stopping" && !activeRun?.resume_needed)}
              >
                {activeStatus === "stopping" ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Stopping...
                  </>
                ) : (
                  <>
                    <Square className="h-4 w-4 mr-2" />
                    Stop
                  </>
                )}
              </Button>

              {canSaveActive ? (
                <Button
                  onClick={saveResults}
                  disabled={saveLoading || activeRun?.save_result?.ok === true}
                >
                  <Save className="h-4 w-4 mr-2" />
                  {saveLoading && savingSessionId === activeSessionId
                    ? "Saving…"
                    : activeRun?.save_result?.ok === true
                      ? `Saved (${Number(activeRun?.save_result?.saved ?? 0) || 0})`
                      : "Save results"}
                </Button>
              ) : null}

              {activeSessionId && activeRun?.session_id_confirmed ? (
                <Button
                  variant="outline"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(activeSessionId);
                      toast.success("Session id copied");
                    } catch {
                      toast.error("Could not copy");
                    }
                  }}
                >
                  <Copy className="h-4 w-4 mr-2" />
                  Copy session id
                </Button>
              ) : null}

              {activeRun?.start_error_details ? (
                <Button
                  variant="outline"
                  onClick={async () => {
                    try {
                      const text = JSON.stringify(activeRun.start_error_details, null, 2);
                      await navigator.clipboard.writeText(text);
                      toast.success("Error details copied");
                    } catch {
                      toast.error("Could not copy");
                    }
                  }}
                >
                  <Copy className="h-4 w-4 mr-2" />
                  Copy error details
                </Button>
              ) : null}

              {activeSessionId ? (
                <div className="text-sm text-slate-700 dark:text-muted-foreground">
                  Session:{" "}
                  <code className="rounded bg-slate-100 dark:bg-muted px-1 py-0.5">{activeRun?.session_id_confirmed ? activeSessionId : "—"}</code>
                </div>
              ) : null}

              {activeSummary ? <div className="text-sm text-slate-600 dark:text-muted-foreground">{activeSummary}</div> : null}
            </div>

            {activeAsyncPrimaryMessage ? (
              <div className="rounded border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/50 px-3 py-2 text-sm text-blue-900 dark:text-blue-200">
                {activeAsyncPrimaryMessage}
              </div>
            ) : null}

            {explainResponseText ? (
              <div className="rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-3">
                <div className="text-xs font-medium text-slate-700 dark:text-muted-foreground">Explain payload response</div>
                <pre className="mt-2 max-h-64 overflow-auto rounded bg-white dark:bg-card p-2 text-[11px] leading-relaxed text-slate-900 dark:text-foreground">{toDisplayText(explainResponseText)}</pre>
              </div>
            ) : null}

            {lastRequestExplain ? (
              <div className="rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-medium text-slate-700 dark:text-muted-foreground">Last request repro (Windows PowerShell)</div>
                    <div className="mt-0.5 text-[11px] text-slate-600 dark:text-muted-foreground">
                      Uses a here-string and writes JSON to a file first to avoid PowerShell + curl quoting issues.
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!lastRequestWindowsCurlScript}
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(lastRequestWindowsCurlScript);
                          toast.success("Copied curl repro");
                        } catch (e) {
                          toast.error(e?.message || "Copy failed");
                        }
                      }}
                    >
                      <Copy className="h-4 w-4 mr-2" />
                      Copy curl (Windows-safe)
                    </Button>

                    <Button
                      type="button"
                      variant="outline"
                      disabled={!lastRequestWindowsInvokeRestScript}
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(lastRequestWindowsInvokeRestScript);
                          toast.success("Copied Invoke-RestMethod repro");
                        } catch (e) {
                          toast.error(e?.message || "Copy failed");
                        }
                      }}
                    >
                      <Copy className="h-4 w-4 mr-2" />
                      Copy Invoke-RestMethod
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  <div className="rounded border border-slate-200 dark:border-border bg-white dark:bg-card p-2">
                    <div className="text-[11px] font-medium text-slate-700 dark:text-muted-foreground">Request</div>
                    <div className="mt-1 text-[11px] text-slate-700 dark:text-muted-foreground">
                      <span className="font-medium">{lastRequestExplain.method}</span> {toAbsoluteUrlForRepro(lastRequestExplain.url)}
                    </div>
                    <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-slate-50 dark:bg-muted p-2 text-[11px] leading-snug text-slate-900 dark:text-foreground">{toDisplayText(lastRequestExplain)}</pre>
                  </div>

                  <div className="rounded border border-slate-200 dark:border-border bg-white dark:bg-card p-2">
                    <div className="text-[11px] font-medium text-slate-700 dark:text-muted-foreground">PowerShell script (curl.exe via @file)</div>
                    <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-slate-50 dark:bg-muted p-2 text-[11px] leading-snug text-slate-900 dark:text-foreground">
                      {lastRequestWindowsCurlScript || "Run an import to generate a repro."}
                    </pre>
                  </div>
                </div>
              </div>
            ) : null}

            {activeRun?.start_error ? (
              <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-900 space-y-2">
                <div className="font-semibold">Import failed</div>
                <div>{toDisplayText(activeRun.start_error)}</div>
                {(() => {
                  const responseBody = activeRun?.start_error_details?.response_body;
                  const bodyObj = responseBody && typeof responseBody === "object" ? responseBody : null;
                  const err = bodyObj?.error && typeof bodyObj.error === "object" ? bodyObj.error : null;
                  const apiFetchError = activeRun?.start_error_details?.api_fetch_error;

                  const requestId =
                    (err?.request_id && String(err.request_id)) ||
                    (bodyObj?.request_id && String(bodyObj.request_id)) ||
                    (activeRun?.start_error_details?.request_id && String(activeRun.start_error_details.request_id)) ||
                    "";

                  const code = (err?.code && String(err.code)) || "";
                  const message = (err?.message && String(err.message)) || "";
                  const step = (err?.step && String(err.step)) || "";
                  const stage = (bodyObj?.stage && String(bodyObj.stage)) || "";

                  const upstreamStatus = err?.upstream_status ?? bodyObj?.upstream_status;
                  const upstreamRequestId = err?.upstream_request_id ?? bodyObj?.upstream_request_id;
                  const upstreamTextPreview = err?.upstream_text_preview ?? bodyObj?.upstream_text_preview;
                  const upstreamUrl = err?.upstream_url ?? bodyObj?.upstream_url;

                  const details = bodyObj?.details && typeof bodyObj.details === "object" ? bodyObj.details : null;
                  const contentType = details?.content_type ?? null;
                  const bodyType = details?.body_type ?? null;
                  const isBodyObject = details?.is_body_object ?? null;
                  const rawTextPreview = details?.raw_text_preview ?? null;
                  const rawTextHexPreview = details?.raw_text_hex_preview ?? null;

                  if (
                    !code &&
                    !message &&
                    !step &&
                    !stage &&
                    !requestId &&
                    !upstreamStatus &&
                    !upstreamRequestId &&
                    !upstreamTextPreview &&
                    !contentType &&
                    !bodyType &&
                    isBodyObject == null &&
                    !rawTextPreview &&
                    !rawTextHexPreview
                  ) {
                    return null;
                  }

                  const Row = ({ label, value }) => {
                    if (value == null || value === "") return null;
                    return (
                      <div>
                        <span className="font-medium">{label}:</span>{" "}
                        <code className="bg-red-100 px-1 py-0.5 rounded break-all">{String(value)}</code>
                      </div>
                    );
                  };

                  return (
                    <div className="rounded border border-red-200 bg-white dark:bg-card/60 p-2 text-xs text-red-900 space-y-2">
                      <div className="space-y-1">
                        <Row label="error.code" value={code} />
                        <Row label="error.message" value={message} />
                        <Row label="error.step" value={step} />
                        <Row label="stage" value={stage} />
                        <Row label="request_id" value={requestId} />
                        <Row label="upstream_status" value={upstreamStatus} />
                        <Row label="upstream_request_id" value={upstreamRequestId} />
                        <Row label="upstream_url" value={upstreamUrl} />
                      </div>

                      {apiFetchError ? (
                        <div>
                          <div className="font-medium">__api_fetch_error (client diagnostics):</div>
                          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-red-100 p-2 text-[11px] leading-snug text-red-950">{toPrettyJsonText(apiFetchError)}</pre>
                        </div>
                      ) : null}

                      {code === "INVALID_JSON_BODY" ? (
                        <>
                          <Row label="content_type" value={contentType} />
                          <Row label="body_type" value={bodyType} />
                          <Row label="is_body_object" value={isBodyObject == null ? "" : String(isBodyObject)} />
                          <Row label="raw_text_hex_preview" value={rawTextHexPreview} />

                          {rawTextPreview ? (
                            <div>
                              <div className="font-medium">raw_text_preview:</div>
                              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-red-100 p-2 text-[11px] leading-snug text-red-950">{String(rawTextPreview)}</pre>
                            </div>
                          ) : null}
                        </>
                      ) : null}

                      {upstreamTextPreview ? (
                        <div>
                          <div className="font-medium">upstream_text_preview:</div>
                          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-red-100 p-2 text-[11px] leading-snug text-red-950">{String(upstreamTextPreview)}</pre>
                        </div>
                      ) : null}

                      {bodyObj ? (
                        <div>
                          <div className="font-medium">response_body (server payload):</div>
                          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-red-100 p-2 text-[11px] leading-snug text-red-950">{toPrettyJsonText(bodyObj)}</pre>
                        </div>
                      ) : null}
                    </div>
                  );
                })()}
              </div>
            ) : null}

            {activeRun?.progress_notice ? (
              <div className="rounded border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">{toDisplayText(activeRun.progress_notice)}</div>
            ) : null}

            {/* Current enrichment field indicator for real-time status */}
            {activeRun?.resume_worker?.current_field && activeStatus === "running" ? (
              <div className="flex items-center gap-2 rounded border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>
                  {ENRICH_FIELD_TO_DISPLAY[activeRun.resume_worker.current_field] || `Enriching: ${activeRun.resume_worker.current_field}`}
                  {activeRun.resume_worker.current_company ? (
                    <span className="font-medium"> for {activeRun.resume_worker.current_company}</span>
                  ) : null}
                </span>
              </div>
            ) : null}

            {activeRun?.progress_error ? (
              <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{toDisplayText(activeRun.progress_error)}</div>
            ) : null}

            {activeRun?.save_error ? (
              <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-900">{toDisplayText(activeRun.save_error)}</div>
            ) : null}

            {activeRun?.save_result?.ok === true ? (
              <div className="rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
                Saved {Number(activeRun.save_result.saved ?? 0) || 0} / {Number(activeRun.save_result.total ?? activeItemsCount) || activeItemsCount} companies
                {Number(activeRun.save_result.failed ?? 0) ? ` (failed ${Number(activeRun.save_result.failed)})` : ""}.
              </div>
            ) : null}
          </section>

          <BulkImportSection
            bulkMode={bulkMode}
            setBulkMode={setBulkMode}
            bulkUrls={bulkUrls}
            setBulkUrls={setBulkUrls}
            bulkEnqueueLoading={bulkEnqueueLoading}
            bulkUrlCount={bulkUrlCount}
            activeBatchId={activeBatchId}
            batchJobs={batchJobs}
            handleBulkEnqueue={handleBulkEnqueue}
            setActiveSessionId={setActiveSessionId}
          />

          <ImportResultsPanels
            activeRun={activeRun}
            activeSessionId={activeSessionId}
            setActiveSessionId={setActiveSessionId}
            activeStatus={activeStatus}
            activeItemsCount={activeItemsCount}
            activeIsTerminal={activeIsTerminal}
            activeSavedCount={activeSavedCount}
            activeResults={activeResults}
            showSavedResults={showSavedResults}
            keywordsStageSkipped={keywordsStageSkipped}
            plainEnglishProgress={plainEnglishProgress}
            runs={runs}
            setRuns={setRuns}
            statusRefreshSessionId={statusRefreshSessionId}
            setStatusRefreshSessionId={setStatusRefreshSessionId}
            clearTerminalRefresh={clearTerminalRefresh}
            pollProgress={pollProgress}
            retryResumeWorker={retryResumeWorker}
            retryingResumeSessionId={retryingResumeSessionId}
            setRetryingResumeSessionId={setRetryingResumeSessionId}
            runXaiDiag={runXaiDiag}
            resumeDebugText={resumeDebugText}
            resumeDebugPayload={resumeDebugPayload}
          />

          <div className="pt-2 text-xs text-slate-500 dark:text-muted-foreground">
            API Version:{" "}
            {apiVersionLoading ? (
              <span>loading…</span>
            ) : apiVersion && typeof apiVersion === "object" ? (
              <span>
                <code className="rounded bg-slate-100 dark:bg-muted px-1 py-0.5">{String(apiVersion?.source || "unknown")}</code>{" "}
                <code className="rounded bg-slate-100 dark:bg-muted px-1 py-0.5">{String(apiVersion?.build_id || "unknown")}</code>
              </span>
            ) : (
              <span>unknown</span>
            )}
          </div>

          <div className="rounded border border-slate-200 dark:border-border bg-white dark:bg-card p-3 text-xs text-slate-700 dark:text-muted-foreground space-y-1">
            <div>
              <span className="font-medium">FUNCTIONS_BASE:</span>{" "}
              <code className="rounded bg-slate-100 dark:bg-muted px-1 py-0.5 break-all">{FUNCTIONS_BASE || "(same-origin)"}</code>
            </div>
            <div>
              <span className="font-medium">API_BASE:</span>{" "}
              <code className="rounded bg-slate-100 dark:bg-muted px-1 py-0.5 break-all">{API_BASE}</code>
            </div>
            <div>
              <span className="font-medium">Start URL (try 1):</span>{" "}
              <code className="rounded bg-slate-100 dark:bg-muted px-1 py-0.5 break-all">POST {join(API_BASE, "/import/start")}</code>
            </div>
            <div>
              <span className="font-medium">Start URL (try 2):</span>{" "}
              <code className="rounded bg-slate-100 dark:bg-muted px-1 py-0.5 break-all">POST {join(API_BASE, "/import-start")}</code>
            </div>
            <div>
              <span className="font-medium">Status URL (try 1):</span>{" "}
              <code className="rounded bg-slate-100 dark:bg-muted px-1 py-0.5 break-all">GET {join(API_BASE, "/import/status")}</code>
            </div>
            <div>
              <span className="font-medium">Status URL (deprecated):</span>{" "}
              <code className="rounded bg-slate-100 dark:bg-muted px-1 py-0.5 break-all">GET {join(API_BASE, "/import-status")}</code>
            </div>
          </div>

          <section className="rounded-lg border border-slate-200 dark:border-border bg-white dark:bg-card p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold text-slate-900 dark:text-foreground">Import progress (plain English)</h2>
              <div className="text-xs text-slate-500 dark:text-muted-foreground">Shows what the importer is doing without reading logs.</div>
            </div>

            <div className="rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-4 space-y-2">
              {!plainEnglishProgress.hasRun ? (
                <div className="text-sm text-slate-700 dark:text-muted-foreground">Start an import to see a step-by-step explanation.</div>
              ) : (
                <>
                  <div className="text-sm text-slate-900 dark:text-foreground">
                    <span className="font-medium">{plainEnglishProgress.isTerminal ? "Final step:" : "Current step:"}</span>{" "}
                    {plainEnglishProgress.stepText || (activeStatus === "running" ? "Starting import…" : "Waiting for the next update…")}
                  </div>

                  {plainEnglishProgress.isTerminal ? (
                    <>
                      <div className="text-sm text-slate-900 dark:text-foreground">
                        <span className="font-medium">{plainEnglishProgress.terminalKind === "error" ? "Stopped at:" : "Finished at:"}</span>{" "}
                        {plainEnglishProgress.stepText || "—"}
                      </div>

                      {plainEnglishProgress.terminalKind === "error" ? (
                        <div className="text-sm text-slate-900 dark:text-foreground">
                          <span className="font-medium">Reason:</span> {plainEnglishProgress.reasonText || "Import failed."}
                        </div>
                      ) : (
                        <div className="text-sm text-slate-900 dark:text-foreground">
                          <span className="font-medium">Result:</span> {activeSavedCount > 0 ? "Import completed." : "Completed: no company persisted."}
                        </div>
                      )}

                      {plainEnglishProgress.terminalKind !== "error" && activeSavedCount === 0 ? (
                        <div className="text-sm text-slate-900 dark:text-foreground">
                          <span className="font-medium">Reason:</span> {plainEnglishProgress.reasonText || "Completed: no company persisted."}
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </>
              )}
            </div>
          </section>
          <ImportDebugPanel
            debugQuery={debugQuery}
            setDebugQuery={setDebugQuery}
            debugLimitInput={debugLimitInput}
            setDebugLimitInput={setDebugLimitInput}
            debugSessionId={debugSessionId}
            setDebugSessionId={setDebugSessionId}
            debugStartLoading={debugStartLoading}
            debugStatusLoading={debugStatusLoading}
            startImportDisabled={startImportDisabled}
            pollingSessionId={pollingSessionId}
            sessionIdMismatchDebug={sessionIdMismatchDebug}
            debugStartResponseText={debugStartResponseText}
            debugStatusResponseText={debugStatusResponseText}
            startDebugImport={startDebugImport}
            explainDebugImport={explainDebugImport}
            checkDebugStatus={checkDebugStatus}
          />

          <ImportReportSection
            activeRun={activeRun}
            activeReportPayload={activeReportPayload}
            activeReportText={activeReportText}
            activeDebugText={activeDebugText}
            importReportRef={importReportRef}
          />
        </main>
      </div>
    </>
  );
}
