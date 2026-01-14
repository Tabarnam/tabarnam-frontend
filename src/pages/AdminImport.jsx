import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Play, Square, RefreshCcw, Copy, AlertTriangle, Save, Download } from "lucide-react";

import AdminHeader from "@/components/AdminHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/toast";
import {
  API_BASE,
  FUNCTIONS_BASE,
  apiFetch,
  getCachedBuildId,
  getLastApiRequestExplain,
  getResponseBuildId,
  getResponseRequestId,
  getUserFacingConfigMessage,
  join,
  readJsonOrText,
  toErrorString,
} from "@/lib/api";

function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function looksLikeUrlOrDomain(raw) {
  const s = asString(raw).trim();
  if (!s) return false;
  if (/\s/.test(s)) return false;

  try {
    const u = s.includes("://") ? new URL(s) : new URL(`https://${s}`);
    const host = (u.hostname || "").toLowerCase();
    if (!host || !host.includes(".")) return false;
    const parts = host.split(".").filter(Boolean);
    if (parts.length < 2) return false;
    const tld = parts[parts.length - 1];
    if (!tld || tld.length < 2) return false;
    return true;
  } catch {
    return false;
  }
}

function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.filter((it) => it && typeof it === "object");
}

function isMeaningfulString(raw) {
  const s = asString(raw).trim();
  if (!s) return false;
  const lower = s.toLowerCase();
  if (lower === "unknown" || lower === "n/a" || lower === "na" || lower === "none") return false;
  return true;
}

function normalizeStringList(value) {
  if (value == null) return [];

  if (Array.isArray(value)) {
    return value
      .map((v) => asString(v).trim())
      .filter(Boolean)
      .map((v) => v.replace(/\s+/g, " "));
  }

  const raw = asString(value).trim();
  if (!raw) return [];

  return raw
    .split(/\s*,\s*/g)
    .map((v) => asString(v).trim())
    .filter(Boolean)
    .map((v) => v.replace(/\s+/g, " "));
}

function hasMeaningfulSeedEnrichment(item) {
  if (!item || typeof item !== "object") return false;

  const industries = Array.isArray(item.industries) ? item.industries.filter(Boolean) : [];
  const keywordsRaw = item.keywords ?? item.product_keywords ?? item.keyword_list;
  const keywords = typeof keywordsRaw === "string" ? keywordsRaw.split(/\s*,\s*/g).filter(Boolean) : Array.isArray(keywordsRaw) ? keywordsRaw.filter(Boolean) : [];

  const manufacturingLocations = Array.isArray(item.manufacturing_locations)
    ? item.manufacturing_locations
        .map((loc) => {
          if (typeof loc === "string") return loc.trim();
          if (loc && typeof loc === "object") return asString(loc.formatted || loc.address || loc.location).trim();
          return "";
        })
        .filter(Boolean)
    : [];

  const curatedReviews = Array.isArray(item.curated_reviews) ? item.curated_reviews.filter((r) => r && typeof r === "object") : [];
  const reviewCount = Number.isFinite(Number(item.review_count)) ? Number(item.review_count) : curatedReviews.length;

  return (
    industries.length > 0 ||
    keywords.length > 0 ||
    isMeaningfulString(item.headquarters_location) ||
    manufacturingLocations.length > 0 ||
    curatedReviews.length > 0 ||
    reviewCount > 0
  );
}

function isValidSeedCompany(item) {
  if (!item || typeof item !== "object") return false;

  const companyName = asString(item.company_name || item.name).trim();
  const websiteUrl = asString(item.website_url || item.url || item.canonical_url).trim();

  if (!companyName || !websiteUrl) return false;

  const id = asString(item.id || item.company_id).trim();

  // Rule: if a company doc is already persisted (id exists), it is always eligible for resume.
  if (id && !id.startsWith("_import_")) return true;

  const source = asString(item.source).trim();

  // Critical: company_url_shortcut is NEVER a valid resume seed unless it already contains meaningful enrichment
  // (keywords/industries/HQ/MFG/reviews) or carries an explicit seed_ready marker.
  if (source === "company_url_shortcut") {
    if (item.seed_ready === true) return true;
    return hasMeaningfulSeedEnrichment(item);
  }

  // For any other source, accept.
  if (source) return true;

  // Fallback: accept explicit markers that the seed is known-good for resume.
  if (item.primary_candidate === true) return true;
  if (item.seed === true) return true;
  if (asString(item.source_stage).trim() === "primary") return true;

  return false;
}

function filterValidSeedCompanies(items) {
  const list = normalizeItems(items);
  return list.filter(isValidSeedCompany);
}

function mergeById(prev, next) {
  const map = new Map();
  for (const item of prev) {
    const id = asString(item?.id || item?.company_id).trim();
    if (!id) continue;
    map.set(id, item);
  }
  for (const item of next) {
    const id = asString(item?.id || item?.company_id).trim();
    if (!id) continue;
    map.set(id, item);
  }
  return Array.from(map.values());
}

function safeJsonParse(text) {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toPrettyJsonText(value) {
  if (typeof value === "string") {
    const parsed = safeJsonParse(value);
    if (parsed && typeof parsed === "object") return JSON.stringify(parsed, null, 2);
    return value;
  }

  try {
    const text = JSON.stringify(value, null, 2);
    return typeof text === "string" ? text : JSON.stringify({ value: asString(value) }, null, 2);
  } catch {
    return JSON.stringify({ value: asString(value) }, null, 2);
  }
}

function toDisplayText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    const text = JSON.stringify(value, null, 2);
    return typeof text === "string" ? text : String(value);
  } catch {
    return String(value);
  }
}

function toAbsoluteUrlForRepro(rawUrl) {
  const s = asString(rawUrl).trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  const origin = typeof window !== "undefined" && window.location?.origin ? window.location.origin : "";
  if (!origin) return s;
  if (s.startsWith("/")) return `${origin}${s}`;
  return `${origin}/${s}`;
}

function sanitizeFilename(value) {
  return asString(value)
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 120);
}

function downloadTextFile({ filename, text, mime = "application/json" }) {
  const safeName = sanitizeFilename(filename) || "download.json";
  const content = typeof text === "string" ? text : "";

  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = safeName;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 2500);
}

function downloadJsonFile({ filename, value }) {
  downloadTextFile({ filename, text: toPrettyJsonText(value), mime: "application/json" });
}

function buildWindowsSafeCurlOutFileScript({ url, method, jsonBody }) {
  const safeUrl = toAbsoluteUrlForRepro(url);
  const safeMethod = asString(method).trim().toUpperCase() || "POST";
  const body = typeof jsonBody === "string" ? jsonBody : "";

  if (!safeUrl || !body) return "";

  return `@'\n${body}\n'@ | Out-File -Encoding ascii body.json\ncurl.exe -i -X ${safeMethod} "${safeUrl}" -H "Content-Type: application/json" --data-binary "@body.json"`;
}

function buildWindowsSafeInvokeRestMethodScript({ url, method, jsonBody }) {
  const safeUrl = toAbsoluteUrlForRepro(url);
  const safeMethod = asString(method).trim().toUpperCase() || "POST";
  const body = typeof jsonBody === "string" ? jsonBody : "";

  if (!safeUrl || !body) return "";

  return `$body = @'\n${body}\n'@\nInvoke-RestMethod -Method ${safeMethod} -Uri "${safeUrl}" -ContentType "application/json" -Body $body`;
}

async function apiFetchWithFallback(paths, init) {
  const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
  if (list.length === 0) throw new Error("apiFetchWithFallback: missing paths");

  let lastRes = null;
  let lastPath = list[list.length - 1];

  for (const path of list) {
    lastPath = path;
    const res = await apiFetch(path, init);
    lastRes = res;
    if (res.status !== 404) return { res, usedPath: path };
  }

  return { res: lastRes, usedPath: lastPath };
}

function extractSessionId(value) {
  if (!value) return "";
  if (typeof value === "object") {
    return typeof value?.session_id === "string" ? value.session_id.trim() : "";
  }
  if (typeof value === "string") {
    const parsed = safeJsonParse(value);
    return typeof parsed?.session_id === "string" ? parsed.session_id.trim() : "";
  }
  return "";
}

const IMPORT_LIMIT_MIN = 1;
const IMPORT_LIMIT_MAX = 25;
const IMPORT_LIMIT_DEFAULT = 1;

const IMPORT_STAGE_BEACON_TO_ENGLISH = Object.freeze({
  primary_enqueued: "Queued primary search",
  primary_search_started: "Searching for matching companies",
  primary_candidate_found: "Company candidate found",
  primary_expanding_candidates: "Expanding search for better matches",
  primary_early_exit: "Single match found. Finalizing import",
  primary_complete: "Primary search complete",
  primary_timeout: "Primary search timed out",
  primary_skipped_company_url: "URL import detected — primary search skipped",
  no_candidates_found: "No matching companies found",
});

const IMPORT_ERROR_CODE_TO_REASON = Object.freeze({
  primary_timeout: "Primary search timed out",
  no_candidates_found: "No matching companies found",
  MISSING_XAI_ENDPOINT: "Missing XAI endpoint configuration",
  MISSING_XAI_KEY: "Missing XAI API key configuration",
  MISSING_OUTBOUND_BODY: "Missing outbound body (import request payload)",
  stalled_worker: "Import worker stalled (heartbeat stale)",
});

function humanizeImportCode(raw) {
  const input = asString(raw).trim();
  if (!input) return "";

  const cleaned = input.replace(/[_-]+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function toEnglishImportStage(stageBeacon) {
  const key = asString(stageBeacon).trim();
  if (!key) return "";
  if (Object.prototype.hasOwnProperty.call(IMPORT_STAGE_BEACON_TO_ENGLISH, key)) return IMPORT_STAGE_BEACON_TO_ENGLISH[key];
  return humanizeImportCode(key);
}

function toEnglishImportStopReason(lastErrorCode) {
  const key = asString(lastErrorCode).trim();
  if (!key) return "Import stopped.";
  if (Object.prototype.hasOwnProperty.call(IMPORT_ERROR_CODE_TO_REASON, key)) return IMPORT_ERROR_CODE_TO_REASON[key];
  return humanizeImportCode(key);
}

function extractAcceptReason(body) {
  const obj = body && typeof body === "object" ? body : null;
  return asString(
    obj?.accept?.reason ??
      obj?.accept_reason ??
      obj?.reason ??
      obj?.root_cause ??
      obj?.error?.root_cause ??
      obj?.error?.reason
  ).trim();
}

function isExpectedAsyncAcceptReason(reason) {
  const r = asString(reason).trim();
  if (!r) return false;
  return r === "upstream_timeout_returning_202" || r === "deadline_exceeded_returning_202";
}

function isNonErrorAcceptedOutcome(body) {
  const obj = body && typeof body === "object" ? body : null;
  if (!obj) return false;

  if (obj.accepted === true) return true;

  const reason = extractAcceptReason(obj);
  if (isExpectedAsyncAcceptReason(reason)) return true;

  return false;
}

function isPrimarySkippedCompanyUrl(stageBeacon) {
  return asString(stageBeacon).trim() === "primary_skipped_company_url";
}

function formatDurationShort(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n >= 60_000) {
    const minutes = Math.round(n / 60_000);
    return `${minutes}m`;
  }
  const seconds = Math.round(n / 1000);
  return `${seconds}s`;
}

function normalizeImportLimit(raw, fallback = IMPORT_LIMIT_DEFAULT) {
  const s = String(raw ?? "").trim();
  if (!s) return fallback;

  const n = Number(s);
  if (!Number.isFinite(n)) return fallback;

  const truncated = Math.trunc(n);
  return Math.max(IMPORT_LIMIT_MIN, Math.min(IMPORT_LIMIT_MAX, truncated));
}

export default function AdminImport() {
  const [query, setQuery] = useState("");
  const [queryTypes, setQueryTypes] = useState(["product_keyword"]);
  const [location, setLocation] = useState("");
  const [limitInput, setLimitInput] = useState(String(IMPORT_LIMIT_DEFAULT));


  const importConfigured = Boolean(API_BASE);

  const [runs, setRuns] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [activeStatus, setActiveStatus] = useState("idle"); // idle | running | stopping | done | error

  const [apiVersion, setApiVersion] = useState(null);
  const [apiVersionLoading, setApiVersionLoading] = useState(true);

  const [saveLoading, setSaveLoading] = useState(false);
  const [savingSessionId, setSavingSessionId] = useState(null);

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

  const pollTimerRef = useRef(null);
  const startFetchAbortRef = useRef(null);
  const pollAttemptsRef = useRef(new Map());
  const terminalRefreshAttemptsRef = useRef(new Map());
  const terminalRefreshTimersRef = useRef(new Map());

  const startImportRequestInFlightRef = useRef(false);
  const activeStatusRef = useRef(activeStatus);
  activeStatusRef.current = activeStatus;

  const activeRun = useMemo(() => {
    if (!activeSessionId) return null;
    return runs.find((r) => r.session_id === activeSessionId) || null;
  }, [activeSessionId, runs]);

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
        const { res } = await apiFetchWithFallback([`/import/status?session_id=${encoded}`]);
        const body = await readJsonOrText(res);

        const state = typeof body?.state === "string" ? body.state : "";
        const isUnknownSession =
          res.status === 404 && body && typeof body === "object" && body.ok === false && body.error === "Unknown session_id";

        const hasStructuredBody = body && typeof body === "object";
        const treatAsOk = Boolean(hasStructuredBody && body.ok === true);

        if ((!res.ok && !treatAsOk) || (hasStructuredBody && body.ok === false)) {
          const bodyPreview = toPrettyJsonText(body);
          const configMsg = await getUserFacingConfigMessage(res);
          const baseMsg = toErrorString(
            configMsg ||
              (body && typeof body === "object" ? body.error || body.message || body.text : null) ||
              `Status failed (${res.status})`
          );
          const msg = bodyPreview ? `${baseMsg}\n${bodyPreview}` : baseMsg;

          setRuns((prev) => prev.map((r) => (r.session_id === session_id ? { ...r, progress_error: msg } : r)));

          if (!isUnknownSession) toast.error(baseMsg);
          return { shouldStop: true, body };
        }

        const items = normalizeItems(body?.items || body?.companies);
        const savedCompanies = Array.isArray(body?.saved_companies) ? body.saved_companies : [];

        const savedVerifiedCount =
          typeof body?.saved_verified_count === "number" && Number.isFinite(body.saved_verified_count)
            ? body.saved_verified_count
            : typeof body?.result?.saved_verified_count === "number" && Number.isFinite(body.result.saved_verified_count)
              ? body.result.saved_verified_count
              : null;

        const saved =
          savedVerifiedCount != null
            ? savedVerifiedCount
            : savedCompanies.length > 0
              ? savedCompanies.length
              : Number(body?.result?.saved ?? body?.saved ?? 0) || 0;

        const reconciled = Boolean(body?.reconciled);
        const reconcileStrategy = asString(body?.reconcile_strategy).trim();
        const reconciledSavedIds = Array.isArray(body?.reconciled_saved_ids) ? body.reconciled_saved_ids : [];

        const status = asString(body?.status).trim();
        const jobState = asString(body?.job_state || body?.primary_job_state || body?.primary_job?.job_state).trim();
        const stageBeacon = asString(body?.stage_beacon).trim();
        const lastError = body?.last_error || null;
        const report = body?.report && typeof body.report === "object" ? body.report : null;

        const resumeNeeded = Boolean(body?.resume_needed || body?.resume?.needed || report?.session?.resume_needed);

        const completed = state === "complete" ? true : Boolean(body?.completed);
        const timedOut = Boolean(body?.timedOut);
        const stopped = state === "failed" ? true : Boolean(body?.stopped);

        const isTerminalError = state === "failed" || status === "error" || jobState === "error";
        const isTerminalComplete =
          state === "complete" ||
          status === "complete" ||
          (!resumeNeeded && jobState === "complete") ||
          (completed && !resumeNeeded);

        // If at least one company is already saved (verified), we can pause polling while resume-worker
        // continues enrichment. This is NOT a terminal "Completed" state.
        const shouldPauseForResume = resumeNeeded && saved > 0 && !isTerminalError && !isTerminalComplete;

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

            const savedVerifiedCount = Number.isFinite(r.saved_verified_count) ? r.saved_verified_count : null;
            const savedCount =
              savedVerifiedCount != null ? savedVerifiedCount : Number.isFinite(saved) ? saved : Number(r.saved ?? 0) || 0;
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
              saved_verified_count:
                typeof body?.saved_verified_count === "number" && Number.isFinite(body.saved_verified_count)
                  ? body.saved_verified_count
                  : Number.isFinite(r.saved_verified_count)
                    ? r.saved_verified_count
                    : null,
              saved_company_ids_verified: Array.isArray(body?.saved_company_ids_verified)
                ? body.saved_company_ids_verified
                : Array.isArray(r.saved_company_ids_verified)
                  ? r.saved_company_ids_verified
                  : [],
              saved_company_ids_unverified: Array.isArray(body?.saved_company_ids_unverified)
                ? body.saved_company_ids_unverified
                : Array.isArray(r.saved_company_ids_unverified)
                  ? r.saved_company_ids_unverified
                  : [],
              reconciled,
              reconcile_strategy: reconcileStrategy || null,
              reconciled_saved_ids: reconciledSavedIds,
              saved_companies: savedCompanies.length > 0 ? savedCompanies : Array.isArray(r.saved_companies) ? r.saved_companies : [],
              completed: isTerminalComplete,
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
              start_error: nextStartError,
              start_error_details: nextStartErrorDetails,
              progress_error: nextProgressError,
              progress_notice: shouldPauseForResume
                ? `Saved (verified): ${savedCount}. Resume needed — enrichment will continue in the background.`
                : r.progress_notice,
              updatedAt: new Date().toISOString(),
            };
          })
        );

        if (isTerminalError) return { shouldStop: true, body };
        if (isTerminalComplete) return { shouldStop: true, body };

        if (shouldPauseForResume) {
          try {
            setActiveStatus((prev) => (prev === "running" ? "done" : prev));
          } catch {}
          toast.info("Saved (verified). Enrichment pending — use Retry resume if it gets stuck.");
          return { shouldStop: true, body, stop_reason: "resume_needed" };
        }

        return { shouldStop: timedOut || stopped, body };
      } catch (e) {
        const msg = toErrorString(e) || "Progress failed";
        setRuns((prev) => prev.map((r) => (r.session_id === session_id ? { ...r, progress_error: msg } : r)));
        return { shouldStop: false, error: msg };
      }
    },
    []
  );

  const POLL_MAX_ATTEMPTS = 180;

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

      try {
        const resumeUrl = join(API_BASE, "import/resume-worker");
        const res = await fetch(`${resumeUrl}?session_id=${encodeURIComponent(sid)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sid }),
          keepalive: true,
        });

        if (!res.ok) {
          const msg = (await getUserFacingConfigMessage(res)) || `Retry resume failed (HTTP ${res.status})`;
          toast.error(msg);
        } else {
          toast.success("Resume requested");
        }
      } catch (e) {
        toast.error(toErrorString(e) || "Retry resume failed");
      } finally {
        await pollProgress({ session_id: sid });
      }
    },
    [pollProgress]
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

        const savedCount =
          savedVerifiedCount != null
            ? savedVerifiedCount
            : savedCompanies.length > 0
              ? savedCompanies.length
              : Number(body?.result?.saved ?? body?.saved ?? 0) || 0;

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
    ({ session_id }) => {
      stopPolling();
      setPollingSessionId(asString(session_id).trim());
      pollTimerRef.current = setTimeout(async () => {
        const prevAttempts = pollAttemptsRef.current.get(session_id) || 0;
        const nextAttempts = prevAttempts + 1;
        pollAttemptsRef.current.set(session_id, nextAttempts);

        if (nextAttempts > POLL_MAX_ATTEMPTS) {
          const msg =
            `Polling paused after ${POLL_MAX_ATTEMPTS} attempts. ` +
            `Import may still be processing or may have completed asynchronously. ` +
            `Use "View status" (or "Poll now") to refresh.`;
          toast.info(msg);
          try {
            setActiveStatus((prev) => (prev === "running" ? "done" : prev));
          } catch {}
          setRuns((prev) =>
            prev.map((r) =>
              r.session_id === session_id
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

        const result = await pollProgress({ session_id });
        if (result?.shouldStop) {
          const body = result?.body;

          const savedCompanies = Array.isArray(body?.saved_companies) ? body.saved_companies : [];

          const savedVerifiedCount =
            typeof body?.saved_verified_count === "number" && Number.isFinite(body.saved_verified_count)
              ? body.saved_verified_count
              : typeof body?.result?.saved_verified_count === "number" && Number.isFinite(body.result.saved_verified_count)
                ? body.result.saved_verified_count
                : null;

          const savedCount =
            savedVerifiedCount != null
              ? savedVerifiedCount
              : savedCompanies.length > 0
                ? savedCompanies.length
                : Number(body?.result?.saved ?? body?.saved ?? 0) || 0;

          const status = asString(body?.status).trim();
          const state = asString(body?.state).trim();
          const jobState = asString(body?.job_state || body?.primary_job_state || body?.primary_job?.job_state).trim();
          const completed = state === "complete" ? true : Boolean(body?.completed);

          const isTerminalComplete =
            state === "complete" || status === "complete" || jobState === "complete" || completed;

          if (isTerminalComplete && savedCount === 0) {
            scheduleTerminalRefresh({ session_id });
          }

          return;
        }

        schedulePoll({ session_id });
      }, 2500);
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
      pipeline: "primary → keywords → reviews → location → save → expand",
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

    const normalizedLimit = normalizeImportLimit(limitInput);

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
        location: asString(location).trim() || undefined,
        limit: normalizedLimit,
        expand_if_few: true,
        dry_run: dryRun,
      };

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
                      ? "Gateway interrupted, recovering via status polling…"
                      : "Start call failed, recovering via status polling…",
                    polling_exhausted: false,
                    updatedAt: new Date().toISOString(),
                  }
                : r
            )
          );

          resetPollAttempts(canonicalSessionId);
          setActiveStatus("running");

          // Kick off the recovery loop. Status polling will populate verified saved ids/counts.
          try {
            await pollProgress({ session_id: canonicalSessionId });
          } catch {}
          schedulePoll({ session_id: canonicalSessionId });

          toast.info(isBackendCallFailureText ? "Gateway interrupted — recovering…" : "Start failed — checking status…");
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
        if (stage) params.set("max_stage", stage);
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
      } else {
        const stageCompanies = updateRunCompanies(startResult.body?.companies, { async_primary_active: false });
        if (stageCompanies.length > 0) companiesForNextStage = stageCompanies;
      }

      const warnings = Array.isArray(lastStageBody?.warnings)
        ? lastStageBody.warnings.map((w) => asString(w).trim()).filter(Boolean)
        : [];
      const warningsDetail =
        lastStageBody?.warnings_detail && typeof lastStageBody.warnings_detail === "object" ? lastStageBody.warnings_detail : null;

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
    } catch (e) {
      const msg = e?.name === "AbortError" ? "Import aborted" : toErrorString(e) || "Import failed";
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
    limitInput,
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

    const normalizedLimit = normalizeImportLimit(limitInput);
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
  }, [importConfigured, limitInput, location, query, queryTypes, urlTypeValidationError]);

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
      } else {
        toast.success("Stop signal sent");
      }
    } catch (e) {
      toast.error(toErrorString(e) || "Stop failed");
    } finally {
      stopPolling();
      setActiveStatus("idle");
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

  const activeSavedVerifiedCount =
    typeof activeRun?.saved_verified_count === "number" && Number.isFinite(activeRun.saved_verified_count)
      ? activeRun.saved_verified_count
      : activeSavedVerifiedIds.length;

  const activeSavedCount = Math.max(
    activeSavedCompanies.length,
    activeSavedVerifiedCount,
    Number(activeRun?.saved ?? 0) || 0
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

    const enrichmentStages = new Set(["keywords", "reviews", "location"]);
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

      if (dryRunEnabled) {
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
    beginImport();

    // If beginImport bails early (validation/config), don't lock the UI.
    setTimeout(() => {
      const status = activeStatusRef.current;
      if (status !== "running" && status !== "stopping") {
        startImportRequestInFlightRef.current = false;
      }
    }, 0);
  }, [beginImport, startImportDisabled]);

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

  return (
    <>
      <Helmet>
        <title>Tabarnam Admin — Company Import</title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>

      <div className="min-h-screen bg-slate-50">
        <AdminHeader />

        <main className="container mx-auto py-6 px-4 space-y-6">
          <header className="flex flex-col gap-2">
            <h1 className="text-3xl font-bold text-slate-900">Company Import</h1>
            <p className="text-sm text-slate-600">Start an import session and poll progress until it completes.</p>
          </header>


          {!API_BASE ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 mt-0.5" />
              <div className="space-y-1">
                <div className="font-semibold">Import is not configured</div>
                <div className="text-amber-900/90">API base could not be resolved, and /api fallback is unavailable.</div>
              </div>
            </div>
          ) : null}

          <section className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-4 gap-3">
              <div className="lg:col-span-2 space-y-1">
                <label className="text-sm text-slate-700">Search query</label>
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onEnter={handleQueryInputEnter}
                  placeholder="e.g. running shoes"
                />
              </div>

              <div className="space-y-1">
                <label className="text-sm text-slate-700">Location (optional)</label>
                <Input
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="e.g. United States or Austin, TX"
                />
              </div>

              <div className="space-y-1">
                <label className="text-sm text-slate-700">Limit (1–25)</label>
                <Input
                  value={limitInput}
                  onChange={(e) => {
                    const next = e.target.value;
                    if (next === "" || /^\d+$/.test(next)) {
                      setLimitInput(next);
                    }
                  }}
                  onBlur={() => setLimitInput((prev) => String(normalizeImportLimit(prev)))}
                  inputMode="numeric"
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700">Query types</div>
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
                    className="flex items-center gap-2 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800"
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
              {urlTypeValidationError ? (
                <div className="text-xs text-red-700">{urlTypeValidationError}</div>
              ) : (
                <div className="text-xs text-slate-600">If you provide a location, results that match it are ranked higher.</div>
              )}
            </div>

            <details className="rounded border border-slate-200 bg-slate-50 px-4 py-3">
              <summary className="cursor-pointer select-none text-sm font-medium text-slate-800">Advanced import config</summary>
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-3 text-xs text-slate-600 space-y-1">
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

            <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 space-y-1">
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

            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" onClick={handleStartImportStaged} disabled={startImportDisabled}>
                <Play className="h-4 w-4 mr-2" />
                {activeStatus === "running" ? "Running…" : "Start import"}
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
                className="border-red-600 text-red-600 hover:bg-red-600 hover:text-white"
                onClick={stopImport}
                disabled={!activeSessionId || !activeRun?.session_id_confirmed || activeStatus !== "running"}
              >
                <Square className="h-4 w-4 mr-2" />
                Stop
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
                <div className="text-sm text-slate-700">
                  Session:{" "}
                  <code className="rounded bg-slate-100 px-1 py-0.5">{activeRun?.session_id_confirmed ? activeSessionId : "—"}</code>
                </div>
              ) : null}

              {activeSummary ? <div className="text-sm text-slate-600">{activeSummary}</div> : null}
            </div>

            {activeAsyncPrimaryMessage ? (
              <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
                {activeAsyncPrimaryMessage}
              </div>
            ) : null}

            {activeRun ? (
              <div className="rounded border border-slate-200 bg-slate-50 p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-medium text-slate-700">Import report</div>
                    <div className="mt-0.5 text-[11px] text-slate-600">
                      Includes report + save result (if any). Use Copy Debug / Download JSON to share with support.
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
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
                      <Copy className="h-4 w-4 mr-2" />
                      Copy report
                    </Button>

                    <Button
                      type="button"
                      variant="outline"
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
                      <Copy className="h-4 w-4 mr-2" />
                      Copy debug
                    </Button>

                    <Button
                      type="button"
                      variant="outline"
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
                      <Download className="h-4 w-4 mr-2" />
                      Download report
                    </Button>

                    <Button
                      type="button"
                      variant="outline"
                      disabled={!activeDebugPayload}
                      onClick={() => {
                        try {
                          const sid = asString(activeRun?.session_id).trim() || "session";
                          downloadJsonFile({ filename: `import-debug-${sid}.json`, value: activeDebugPayload });
                        } catch {
                          toast.error("Download failed");
                        }
                      }}
                    >
                      <Download className="h-4 w-4 mr-2" />
                      Download debug
                    </Button>
                  </div>
                </div>

                {activeReportText ? (
                  <pre className="max-h-64 overflow-auto rounded bg-white p-2 text-[11px] leading-relaxed text-slate-900">
                    {toDisplayText(activeReportText)}
                  </pre>
                ) : (
                  <div className="rounded bg-white p-2 text-[11px] leading-relaxed text-slate-700">
                    No report yet. Run an import (or click Poll now) to populate the report.
                  </div>
                )}
              </div>
            ) : null}

            {explainResponseText ? (
              <div className="rounded border border-slate-200 bg-slate-50 p-3">
                <div className="text-xs font-medium text-slate-700">Explain payload response</div>
                <pre className="mt-2 max-h-64 overflow-auto rounded bg-white p-2 text-[11px] leading-relaxed text-slate-900">{toDisplayText(explainResponseText)}</pre>
              </div>
            ) : null}

            {lastRequestExplain ? (
              <div className="rounded border border-slate-200 bg-slate-50 p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-medium text-slate-700">Last request repro (Windows PowerShell)</div>
                    <div className="mt-0.5 text-[11px] text-slate-600">
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
                  <div className="rounded border border-slate-200 bg-white p-2">
                    <div className="text-[11px] font-medium text-slate-700">Request</div>
                    <div className="mt-1 text-[11px] text-slate-700">
                      <span className="font-medium">{lastRequestExplain.method}</span> {toAbsoluteUrlForRepro(lastRequestExplain.url)}
                    </div>
                    <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-[11px] leading-snug text-slate-900">{toDisplayText(lastRequestExplain)}</pre>
                  </div>

                  <div className="rounded border border-slate-200 bg-white p-2">
                    <div className="text-[11px] font-medium text-slate-700">PowerShell script (curl.exe via @file)</div>
                    <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-[11px] leading-snug text-slate-900">
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
                    <div className="rounded border border-red-200 bg-white/60 p-2 text-xs text-red-900 space-y-2">
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

          <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="rounded-lg border border-slate-200 bg-white p-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-lg font-semibold text-slate-900">Active results</h2>
                <div className="text-sm text-slate-600">{activeItemsCount} companies</div>
              </div>

              {!activeSessionId ? (
                <div className="mt-4 text-sm text-slate-600">Start an import to see results.</div>
              ) : activeIsTerminal && activeSavedCount === 0 ? (
                <div className="mt-4 rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700 space-y-1">
                  {(() => {
                    const stageBeacon = asString(activeRun?.final_stage_beacon || activeRun?.stage_beacon || activeRun?.last_stage_beacon).trim();
                    const isSkipped = isPrimarySkippedCompanyUrl(stageBeacon);
                    return (
                      <>
                        <div className="font-medium">{isSkipped ? "Skipped: company not persisted" : "Completed: no company persisted"}</div>
                        <div className="text-slate-600">{plainEnglishProgress.reasonText || "No company was saved for this run."}</div>
                        {isSkipped ? <div className="text-slate-600">Reviews stage did not run (company was never saved).</div> : null}
                      </>
                    );
                  })()}
                </div>
              ) : (
                <div className="mt-4 space-y-2 max-h-[520px] overflow-auto">
                  {(() => {
                    const items = Array.isArray(activeResults) ? activeResults.slice() : [];
                    const loc = asString(activeRun?.location).trim().toLowerCase();
                    if (!loc) return items;

                    const scoreFor = (company) => {
                      const hq = asString(company?.headquarters_location).toLowerCase();
                      const manu = Array.isArray(company?.manufacturing_locations)
                        ? company.manufacturing_locations
                            .map((m) => (typeof m === "string" ? m : asString(m?.formatted || m?.address || m?.location)))
                            .join(" ")
                            .toLowerCase()
                        : "";
                      const ind = Array.isArray(company?.industries) ? company.industries.join(" ").toLowerCase() : "";
                      const combined = `${hq} ${manu} ${ind}`;
                      return combined.includes(loc) ? 1 : 0;
                    };

                    items.sort((a, b) => scoreFor(b) - scoreFor(a));
                    return items;
                  })().map((c) => {
                    const name = asString(c?.company_name || c?.name).trim() || "(unnamed)";
                    const url = asString(c?.website_url || c?.url).trim();

                    const keywordsCanonical =
                      Array.isArray(c?.keywords) && c.keywords.length > 0
                        ? c.keywords
                        : Array.isArray(c?.keyword_tags) && c.keyword_tags.length > 0
                          ? c.keyword_tags
                          : c?.product_keywords ?? c?.keyword_list;

                    const keywordsList = normalizeStringList(keywordsCanonical);
                    const keywordsText = keywordsList.join(", ");

                    const issues = [];
                    if (!url) issues.push("missing url");

                    // Truthfulness: do not flag missing keywords based on seed/pre-save items.
                    // Only evaluate keywords once we're rendering saved (persisted) company docs.
                    const shouldEvaluateKeywords = showSavedResults && !keywordsStageSkipped;
                    if (shouldEvaluateKeywords && keywordsList.length === 0) issues.push("missing keywords");

                    return (
                      <div key={asString(c?.id || c?.company_id)} className="rounded border border-slate-200 p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="font-semibold text-slate-900">{name}</div>
                            {url ? (
                              <a
                                className="text-sm text-blue-700 underline break-all"
                                href={url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {url}
                              </a>
                            ) : (
                              <div className="text-sm text-slate-500">No URL</div>
                            )}
                          </div>

                          {issues.length > 0 ? (
                            <div className="flex items-center gap-1 text-xs text-amber-900">
                              <AlertTriangle className="h-4 w-4" />
                              {issues.join(", ")}
                            </div>
                          ) : null}
                        </div>

                        {keywordsText ? (
                          <div className="mt-2 text-xs text-slate-600">{keywordsText}</div>
                        ) : null}

                        {(() => {
                          const companyId = asString(c?.id || c?.company_id).trim();
                          const canonicalCount = Number.isFinite(Number(c?.review_count)) ? Number(c.review_count) : 0;
                          const curatedCount = Array.isArray(c?.curated_reviews) ? c.curated_reviews.length : 0;
                          const reviewCount = Math.max(0, canonicalCount, curatedCount);

                          const stageStatus = asString(
                            c?.reviews_stage_status || c?.review_cursor?.reviews_stage_status || ""
                          ).trim();

                          const statusKind =
                            stageStatus === "ok" && reviewCount > 0
                              ? "ok"
                              : stageStatus === "pending"
                                ? "pending"
                                : stageStatus
                                  ? "warning"
                                  : "unknown";

                          const badgeClass =
                            statusKind === "ok"
                              ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                              : statusKind === "pending"
                                ? "border-sky-200 bg-sky-50 text-sky-900"
                                : statusKind === "warning"
                                  ? "border-amber-200 bg-amber-50 text-amber-900"
                                  : "border-slate-200 bg-slate-50 text-slate-700";

                          if (!companyId && !stageStatus && reviewCount === 0) return null;

                          return (
                            <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
                              <span className="rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-slate-700">
                                review_count: {reviewCount}
                              </span>
                              {stageStatus ? (
                                <span className={`rounded border px-2 py-0.5 ${badgeClass}`}>
                                  reviews_stage_status: {stageStatus}
                                </span>
                              ) : null}
                              {companyId ? (
                                <a
                                  className="rounded border border-slate-200 bg-white px-2 py-0.5 text-slate-700 hover:bg-slate-50"
                                  href={`/admin?company_id=${encodeURIComponent(companyId)}#reviews`}
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  Open dashboard
                                </a>
                              ) : null}
                            </div>
                          );
                        })()}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-5">
              <h2 className="text-lg font-semibold text-slate-900">Run history</h2>
              <div className="mt-4 space-y-2 max-h-[520px] overflow-auto">
                {runs.length === 0 ? (
                  <div className="text-sm text-slate-600">No runs yet.</div>
                ) : (
                  runs.map((r) => {
                    const savedCompanies = Array.isArray(r.saved_companies) ? r.saved_companies : [];
                    const primarySaved = savedCompanies.length > 0 ? savedCompanies[0] : null;

                    const verifiedCount = Number.isFinite(r.saved_verified_count) ? r.saved_verified_count : null;
                    const savedCount =
                      verifiedCount != null
                        ? verifiedCount
                        : savedCompanies.length > 0
                          ? savedCompanies.length
                          : Number(r.saved ?? 0) || 0;

                    const companyId =
                      asString(primarySaved?.company_id).trim() ||
                      (Array.isArray(r.saved_company_ids_verified) ? asString(r.saved_company_ids_verified[0]).trim() : "") ||
                      (Array.isArray(r.saved_company_ids) ? asString(r.saved_company_ids[0]).trim() : "");

                    const stageBeaconForStatus = asString(r.final_stage_beacon || r.stage_beacon || r.last_stage_beacon).trim();
                    const persistedDetected = savedCount > 0 || stageBeaconForStatus === "cosmos_write_done";

                    const enrichmentMissingFields = (() => {
                      const missing = new Set();
                      for (const c of savedCompanies) {
                        const fields = Array.isArray(c?.enrichment_health?.missing_fields)
                          ? c.enrichment_health.missing_fields
                          : Array.isArray(c?.enrichment_health?.missing)
                            ? c.enrichment_health.missing
                            : [];
                        for (const f of fields) {
                          const key = asString(f).trim();
                          if (key) missing.add(key);
                        }
                      }
                      return Array.from(missing);
                    })();

                    const report = r.report && typeof r.report === "object" ? r.report : null;
                    const session = report?.session && typeof report.session === "object" ? report.session : null;
                    const request = session?.request && typeof session.request === "object" ? session.request : null;
                    const skipStages = Array.isArray(request?.skip_stages)
                      ? request.skip_stages.map((s) => asString(s).trim()).filter(Boolean)
                      : [];
                    const dryRunEnabled = Boolean(request?.dry_run);

                    // "No company persisted" should only appear when saved===0 AND we have an explicit skip/early-exit signal.
                    const explicitNoPersist =
                      !persistedDetected &&
                      (stageBeaconForStatus === "primary_early_exit" ||
                        isPrimarySkippedCompanyUrl(stageBeaconForStatus) ||
                        dryRunEnabled ||
                        skipStages.includes("primary"));

                    const primaryCandidate =
                      savedCompanies.length > 0
                        ? primarySaved
                        : Array.isArray(r.items) && r.items.length > 0
                          ? r.items[0]
                          : null;

                    const companyName = primaryCandidate
                      ? asString(primaryCandidate?.company_name || primaryCandidate?.name).trim() || "Company candidate"
                      : explicitNoPersist
                        ? "No company persisted"
                        : "Company candidate";

                    const websiteUrl = asString(primaryCandidate?.website_url || primaryCandidate?.url).trim();
                    const isRefreshing = statusRefreshSessionId === r.session_id;

                    const jobState = asString(r.final_job_state || r.job_state).trim().toLowerCase();

                    const isTerminal = Boolean(
                      r.completed || r.timedOut || r.stopped || jobState === "complete" || jobState === "error"
                    );
                    const isFailed = Boolean(r.start_error) || (isTerminal && jobState === "error");
                    const isComplete = isTerminal && !isFailed;
                    const isCompleteWithSave = isComplete && savedCount > 0;
                    const isCompleteNoSave = isComplete && savedCount === 0;

                    const isSkipped = Boolean(r.skipped) || (isCompleteNoSave && isPrimarySkippedCompanyUrl(stageBeaconForStatus));

                    const warningsList = Array.isArray(r.warnings) ? r.warnings : [];
                    const hasWarnings = warningsList.length > 0 || Boolean(r.warnings_detail || r.warnings_v2);

                    const statusLabel = isFailed
                      ? "Failed"
                      : isSkipped
                        ? "Skipped"
                        : isCompleteWithSave
                          ? hasWarnings
                            ? "Completed with warnings"
                            : "Completed"
                          : isCompleteNoSave
                            ? "Completed: no save"
                            : r.polling_exhausted
                              ? "Processing async"
                              : "Processing";

                    const statusBadgeClass = isFailed
                      ? "border-red-200 bg-red-50 text-red-800"
                      : isSkipped
                        ? "border-amber-200 bg-amber-50 text-amber-900"
                        : isCompleteWithSave
                          ? hasWarnings
                            ? "border-amber-200 bg-amber-50 text-amber-900"
                            : "border-emerald-200 bg-emerald-50 text-emerald-800"
                          : isCompleteNoSave
                            ? "border-slate-200 bg-slate-50 text-slate-700"
                            : "border-sky-200 bg-sky-50 text-sky-800";

                    return (
                      <div
                        key={r.session_id}
                        role="button"
                        tabIndex={0}
                        className={`w-full text-left rounded border p-3 transition cursor-pointer ${
                          r.session_id === activeSessionId
                            ? "border-slate-900 bg-slate-50"
                            : "border-slate-200 bg-white hover:bg-slate-50"
                        }`}
                        onClick={() => setActiveSessionId(r.session_id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") setActiveSessionId(r.session_id);
                        }}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="font-semibold text-slate-900 truncate">{companyName}</div>
                            {websiteUrl ? (
                              <a
                                className="mt-1 block text-xs text-blue-700 underline break-all"
                                href={websiteUrl}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {websiteUrl}
                              </a>
                            ) : (
                              <div className="mt-1 text-xs text-slate-500">No URL</div>
                            )}
                            <div className="mt-1 text-xs text-slate-600 truncate">Query: {r.query}</div>
                          </div>

                          <div className="flex flex-col items-end gap-2 text-xs text-slate-600">
                            <div className="flex items-center gap-2">
                              <span>Saved: {savedCount}</span>
                              <span className={`rounded border px-2 py-0.5 text-[11px] ${statusBadgeClass}`}>{statusLabel}</span>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  clearTerminalRefresh(r.session_id);
                                  setStatusRefreshSessionId(r.session_id);
                                  setRuns((prev) =>
                                    prev.map((it) =>
                                      it.session_id === r.session_id
                                        ? { ...it, progress_error: null, progress_notice: null, polling_exhausted: false }
                                        : it
                                    )
                                  );
                                  try {
                                    await pollProgress({ session_id: r.session_id });
                                  } finally {
                                    setStatusRefreshSessionId(null);
                                  }
                                }}
                                disabled={isRefreshing}
                              >
                                <RefreshCcw className={isRefreshing ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                                <span className="ml-1">View status</span>
                              </Button>

                              {companyId ? (
                                <Button
                                  asChild
                                  variant="outline"
                                  size="sm"
                                  className="h-7 px-2 text-xs"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <a href={`/admin?company_id=${encodeURIComponent(companyId)}`}>Open company</a>
                                </Button>
                              ) : null}
                            </div>

                            {Boolean(r.reconciled) ? (
                              <span className="rounded border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-900">
                                reconciled{r.reconcile_strategy ? ` (${r.reconcile_strategy})` : ""}
                              </span>
                            ) : null}

                            {enrichmentMissingFields.length > 0 ? (
                              <span className="rounded border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-900">
                                incomplete enrichment: {enrichmentMissingFields.slice(0, 3).join(", ")}
                                {enrichmentMissingFields.length > 3 ? ` (+${enrichmentMissingFields.length - 3})` : ""}
                              </span>
                            ) : null}

                            {r.save_result?.ok === true ? (
                              <span className="rounded border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-800">
                                saved {Number(r.save_result.saved ?? 0) || 0}
                              </span>
                            ) : null}
                          </div>
                        </div>

                        <div className="mt-2 text-xs text-slate-600">
                          <code className="rounded bg-slate-100 px-1 py-0.5">{r.session_id}</code>
                        </div>
                        <div className="mt-1 text-xs text-slate-500">{new Date(r.startedAt).toLocaleString()}</div>
                      </div>
                    );
                  })
                )}

                {activeRun ? (
                  <div className="mt-4 rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800 space-y-2">
                    {(() => {
                      const savedCompanies = Array.isArray(activeRun.saved_companies) ? activeRun.saved_companies : [];
                      const primarySaved = savedCompanies.length > 0 ? savedCompanies[0] : null;

                      const verifiedCount = Number.isFinite(activeRun.saved_verified_count) ? activeRun.saved_verified_count : null;
                      const savedCount =
                        verifiedCount != null
                          ? verifiedCount
                          : savedCompanies.length > 0
                            ? savedCompanies.length
                            : Number(activeRun.saved ?? 0) || 0;

                      const stageBeacon = asString(activeRun.final_stage_beacon || activeRun.stage_beacon || activeRun.last_stage_beacon).trim();
                      const persistedDetected = savedCount > 0 || stageBeacon === "cosmos_write_done";

                      const report = activeRun.report && typeof activeRun.report === "object" ? activeRun.report : null;
                      const session = report?.session && typeof report.session === "object" ? report.session : null;
                      const request = session?.request && typeof session.request === "object" ? session.request : null;
                      const skipStages = Array.isArray(request?.skip_stages)
                        ? request.skip_stages.map((s) => asString(s).trim()).filter(Boolean)
                        : [];
                      const dryRunEnabled = Boolean(request?.dry_run);

                      const explicitNoPersist =
                        !persistedDetected &&
                        (stageBeacon === "primary_early_exit" ||
                          isPrimarySkippedCompanyUrl(stageBeacon) ||
                          dryRunEnabled ||
                          skipStages.includes("primary"));

                      const primaryCandidate =
                        savedCompanies.length > 0
                          ? primarySaved
                          : Array.isArray(activeRun.items) && activeRun.items.length > 0
                            ? activeRun.items[0]
                            : null;

                      const companyId =
                        asString(primarySaved?.company_id).trim() ||
                        (Array.isArray(activeRun.saved_company_ids_verified) ? asString(activeRun.saved_company_ids_verified[0]).trim() : "") ||
                        (Array.isArray(activeRun.saved_company_ids) ? asString(activeRun.saved_company_ids[0]).trim() : "");
                      const companyName = primaryCandidate
                        ? asString(primaryCandidate?.company_name || primaryCandidate?.name).trim() || "Company candidate"
                        : explicitNoPersist
                          ? "No company persisted"
                          : "Company candidate";
                      const websiteUrl = asString(primaryCandidate?.website_url || primaryCandidate?.url).trim();

                      const enrichmentMissingFields = (() => {
                        const missing = new Set();
                        for (const c of savedCompanies) {
                          const fields = Array.isArray(c?.enrichment_health?.missing_fields)
                            ? c.enrichment_health.missing_fields
                            : Array.isArray(c?.enrichment_health?.missing)
                              ? c.enrichment_health.missing
                              : [];
                          for (const f of fields) {
                            const key = asString(f).trim();
                            if (key) missing.add(key);
                          }
                        }
                        return Array.from(missing);
                      })();

                      return (
                        <>
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="font-semibold text-slate-900">{companyName}</div>
                              {websiteUrl ? (
                                <a
                                  className="mt-1 block text-sm text-blue-700 underline break-all"
                                  href={websiteUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {websiteUrl}
                                </a>
                              ) : (
                                <div className="mt-1 text-sm text-slate-600">No URL</div>
                              )}
                            </div>
                            <div className="text-sm text-slate-700">Saved: {savedCount}</div>
                          </div>

                          {enrichmentMissingFields.length > 0 ? (
                            <div className="mt-2 text-sm text-amber-900">
                              Enrichment incomplete: {enrichmentMissingFields.slice(0, 4).join(", ")}
                              {enrichmentMissingFields.length > 4 ? ` (+${enrichmentMissingFields.length - 4})` : ""}
                            </div>
                          ) : null}

                          {companyId ? (
                            <div>
                              <a className="text-sm text-blue-700 underline" href={`/admin?company_id=${encodeURIComponent(companyId)}`}>
                                Open company in admin
                              </a>
                            </div>
                          ) : null}

                          {Boolean(activeRun.resume_needed) ? (
                            <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 space-y-2">
                              <div className="font-medium">Resume needed</div>
                              {asString(activeRun.resume?.trigger_error).trim() ? (
                                <div className="text-amber-900/90 break-words">
                                  Last resume error: {asString(activeRun.resume?.trigger_error).trim()}
                                </div>
                              ) : (
                                <div className="text-amber-900/90">
                                  Enrichment is still in progress (reviews/logos/location). You can retry the resume worker if it stalled.
                                </div>
                              )}
                              <div>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="h-8"
                                  onClick={() => retryResumeWorker({ session_id: activeRun.session_id })}
                                >
                                  Retry resume
                                </Button>
                              </div>
                            </div>
                          ) : null}
                        </>
                      );
                    })()}
                  </div>
                ) : null}
              </div>
            </div>
          </section>

          <div className="pt-2 text-xs text-slate-500">
            API Version:{" "}
            {apiVersionLoading ? (
              <span>loading…</span>
            ) : apiVersion && typeof apiVersion === "object" ? (
              <span>
                <code className="rounded bg-slate-100 px-1 py-0.5">{String(apiVersion?.source || "unknown")}</code>{" "}
                <code className="rounded bg-slate-100 px-1 py-0.5">{String(apiVersion?.build_id || "unknown")}</code>
              </span>
            ) : (
              <span>unknown</span>
            )}
          </div>

          <div className="rounded border border-slate-200 bg-white p-3 text-xs text-slate-700 space-y-1">
            <div>
              <span className="font-medium">FUNCTIONS_BASE:</span>{" "}
              <code className="rounded bg-slate-100 px-1 py-0.5 break-all">{FUNCTIONS_BASE || "(same-origin)"}</code>
            </div>
            <div>
              <span className="font-medium">API_BASE:</span>{" "}
              <code className="rounded bg-slate-100 px-1 py-0.5 break-all">{API_BASE}</code>
            </div>
            <div>
              <span className="font-medium">Start URL (try 1):</span>{" "}
              <code className="rounded bg-slate-100 px-1 py-0.5 break-all">POST {join(API_BASE, "/import/start")}</code>
            </div>
            <div>
              <span className="font-medium">Start URL (try 2):</span>{" "}
              <code className="rounded bg-slate-100 px-1 py-0.5 break-all">POST {join(API_BASE, "/import-start")}</code>
            </div>
            <div>
              <span className="font-medium">Status URL (try 1):</span>{" "}
              <code className="rounded bg-slate-100 px-1 py-0.5 break-all">GET {join(API_BASE, "/import/status")}</code>
            </div>
            <div>
              <span className="font-medium">Status URL (deprecated):</span>{" "}
              <code className="rounded bg-slate-100 px-1 py-0.5 break-all">GET {join(API_BASE, "/import-status")}</code>
            </div>
          </div>

          <section className="rounded-lg border border-slate-200 bg-white p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold text-slate-900">Import progress (plain English)</h2>
              <div className="text-xs text-slate-500">Shows what the importer is doing without reading logs.</div>
            </div>

            <div className="rounded border border-slate-200 bg-slate-50 p-4 space-y-2">
              {!plainEnglishProgress.hasRun ? (
                <div className="text-sm text-slate-700">Start an import to see a step-by-step explanation.</div>
              ) : (
                <>
                  <div className="text-sm text-slate-900">
                    <span className="font-medium">{plainEnglishProgress.isTerminal ? "Final step:" : "Current step:"}</span>{" "}
                    {plainEnglishProgress.stepText || (activeStatus === "running" ? "Starting import…" : "Waiting for the next update…")}
                  </div>

                  {plainEnglishProgress.isTerminal ? (
                    <>
                      <div className="text-sm text-slate-900">
                        <span className="font-medium">{plainEnglishProgress.terminalKind === "error" ? "Stopped at:" : "Finished at:"}</span>{" "}
                        {plainEnglishProgress.stepText || "—"}
                      </div>

                      {plainEnglishProgress.terminalKind === "error" ? (
                        <div className="text-sm text-slate-900">
                          <span className="font-medium">Reason:</span> {plainEnglishProgress.reasonText || "Import failed."}
                        </div>
                      ) : (
                        <div className="text-sm text-slate-900">
                          <span className="font-medium">Result:</span> {activeSavedCount > 0 ? "Import completed." : "Completed: no company persisted."}
                        </div>
                      )}

                      {plainEnglishProgress.terminalKind !== "error" && activeSavedCount === 0 ? (
                        <div className="text-sm text-slate-900">
                          <span className="font-medium">Reason:</span> {plainEnglishProgress.reasonText || "Completed: no company persisted."}
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </>
              )}
            </div>
          </section>
          <section className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-slate-900">Import Debug Panel (temporary)</h2>
              <div className="text-xs text-slate-500">Tries /api/import/start (fallback /api/import-start) and /api/import/status (fallback /api/import-status).</div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="md:col-span-2 space-y-1">
                <label className="text-sm text-slate-700">Query string</label>
                <Input
                  value={debugQuery}
                  onChange={(e) => setDebugQuery(e.target.value)}
                  placeholder="query string"
                />
              </div>

              <div className="space-y-1">
                <label className="text-sm text-slate-700">Limit (number)</label>
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
              <label className="text-sm text-slate-700">Session id (for status)</label>
              <Input value={debugSessionId} onChange={(e) => setDebugSessionId(e.target.value)} placeholder="session id" />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={startDebugImport} disabled={debugStartLoading || startImportDisabled}>
                {debugStartLoading ? "Starting…" : "Start (debug)"}
              </Button>

              <Button variant="outline" onClick={explainDebugImport} disabled={debugStartLoading}>
                Explain payload
              </Button>

              <Button variant="outline" onClick={checkDebugStatus} disabled={debugStatusLoading || !debugSessionId.trim()}>
                {debugStatusLoading ? "Checking…" : "Check Status"}
              </Button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <div className="rounded border border-slate-200 bg-slate-50 p-3">
                <div className="text-xs font-medium text-slate-700">session_id</div>
                <div className="mt-1 flex items-start justify-between gap-2">
                  <code className="text-xs text-slate-900 break-all">{debugSessionId || "—"}</code>
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
                <div className="mt-2 text-[11px] text-slate-600">
                  Polling session_id: <code className="text-[11px] text-slate-900 break-all">{pollingSessionId || "—"}</code>
                </div>

                {sessionIdMismatchDebug ? (
                  <pre className="mt-2 max-h-24 overflow-auto rounded bg-white p-2 text-[11px] leading-relaxed text-slate-900">
                    {toDisplayText(toPrettyJsonText(sessionIdMismatchDebug))}
                  </pre>
                ) : null}
              </div>

              <div className="rounded border border-slate-200 bg-slate-50 p-3">
                <div className="text-xs font-medium text-slate-700">Start response</div>
                <pre className="mt-2 max-h-48 overflow-auto rounded bg-white p-2 text-[11px] leading-relaxed text-slate-900">{toDisplayText(debugStartResponseText)}</pre>
              </div>
            </div>

            <div className="rounded border border-slate-200 bg-slate-50 p-3">
              <div className="text-xs font-medium text-slate-700">Status response</div>
              <pre className="mt-2 max-h-64 overflow-auto rounded bg-white p-2 text-[11px] leading-relaxed text-slate-900">{toDisplayText(debugStatusResponseText)}</pre>
            </div>
          </section>
        </main>
      </div>
    </>
  );
}
