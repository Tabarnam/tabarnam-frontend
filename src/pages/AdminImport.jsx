import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Play, Square, RefreshCcw, Copy, AlertTriangle, Save, Download, Loader2, Volume2, Tags, Check } from "lucide-react";

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
  ENRICH_FIELDS_OPTIONS,
  ALL_ENRICH_FIELD_KEYS,
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
import StatusAlerts from "./admin-import/StatusAlerts";
import ImportResultsPanels from "./admin-import/ImportResultsPanels";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader,
  AlertDialogTitle, AlertDialogDescription, AlertDialogFooter,
} from "@/components/ui/alert-dialog";

// Phase 3.5 — shared active-imports state so the Companies dashboard can
// render an "Importing…" badge on rows that are currently being processed.
import { markImportActive, markImportInactive } from "@/lib/activeImports";

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
  const [enrichFields, setEnrichFields] = useState([...ALL_ENRICH_FIELD_KEYS]);
  const [location, setLocation] = useState("");
  const [batchIndustries, setBatchIndustries] = useState("");
  const [batchKeywords, setBatchKeywords] = useState("");

  // Succession import state
  const [successionCountInput, setSuccessionCountInput] = useState(String(SUCCESSION_DEFAULT));
  const [successionRows, setSuccessionRows] = useState([{ companyName: "", companyUrl: "" }]);
  const [successionQueue, setSuccessionQueue] = useState([]);
  const [successionIndex, setSuccessionIndex] = useState(-1);
  const [successionResults, setSuccessionResults] = useState([]);
  const successionTriggerRef = useRef(false);
  const successionCount = normalizeSuccessionCount(successionCountInput);

  // Concurrent succession: shadow slot (slot B) for parallel imports
  // Set to 1 to instantly disable concurrent imports (revert to sequential)
  const SUCCESSION_CONCURRENCY = 2;
  const [shadowSessionId, setShadowSessionId] = useState(null);
  const [shadowStatus, setShadowStatus] = useState("idle"); // idle | running | done | error
  const shadowPollTimerRef = useRef(null);
  const shadowPollAttemptsRef = useRef(new Map());
  const shadowPollBackoffRef = useRef(new Map());
  const shadowAbortRef = useRef(null);
  const shadowStatusRef = useRef("idle");
  shadowStatusRef.current = shadowStatus;

  // Phase 2.17 — rolling-pool dispatcher state.
  //
  // Pre-2.17 the dispatcher was pair-batched: start companies 0+1, wait for
  // BOTH to finish, then start 2+3. If one company in the pair was much
  // slower than the other (RockDove 6:43 paired with Merippa 2:18, the
  // Steger+Verloop pair couldn't start until 6:43 elapsed), the wall-clock
  // for the whole batch was bottlenecked by the slowest company in each
  // pair.
  //
  // Phase 2.17 makes each slot advance independently: when EITHER slot
  // finishes, it claims the next available company from the queue and
  // starts immediately, regardless of what the other slot is doing.
  //
  // - successionShadowIndex: shadow slot's current queue index (was
  //   implicit as successionIndex + 1 under pair-batching).
  // - nextDispatchIndexRef: atomic counter for the next company to claim
  //   from the queue. Refs update synchronously, so two simultaneous
  //   advance-effects can't grab the same index.
  // - lastProcessedPrimaryIndexRef / lastProcessedShadowIndexRef: guard
  //   refs to ensure we record each completion exactly once (the slot
  //   advance effect fires whenever activeStatus/shadowStatus changes,
  //   including transient "running" → "done" → re-mounted "running").
  const [successionShadowIndex, setSuccessionShadowIndex] = useState(-1);
  const nextDispatchIndexRef = useRef(0);
  const lastProcessedPrimaryIndexRef = useRef(-1);
  const lastProcessedShadowIndexRef = useRef(-1);

  // Phase 4.9 — bulk-dispatcher graceful failure watchdog.
  //
  // Observed 2026-05-13 batch (session 0d66a460-f2dd-48ed-9312-baaa85f10d11):
  // 10-company batch with Asics as the 2nd row. Eloquii (row 1) and the 8
  // others (rows 3-10) all completed normally. Asics's `import-start` HTTP
  // request never reached the backend (no log entries, no Cosmos doc).
  // The shadow slot stayed in "running" state indefinitely, the dispatcher
  // never advanced past Asics, and the UI showed "Finishing 2 of 10
  // companies (9 done)" with Asics's row missing checkmark and timestamps.
  // User had no way to clear the stuck slot short of manual intervention.
  //
  // Cause: `beginImportShadow`/`beginImport` await `apiFetchWithFallback`
  // which throws on network errors (caught and sets status="error" → slot
  // advances correctly). BUT if the request "succeeds" with a malformed
  // body OR if some other in-flight state leaves the slot in "running"
  // without ever transitioning to "done"/"error", the dispatcher stalls
  // forever.
  //
  // Phase 4.9 watchdog: track when each slot started its current company.
  // If a slot has been "running" longer than BULK_DISPATCH_TIMEOUT_MS
  // (default 5 minutes — well above the 60-90s per-company expected with
  // Phase 4.7's reasoning.effort=high), force the slot to error state,
  // tag the run with `timedOut: true` + `start_error: "dispatcher_timeout"`,
  // and let the existing slot-advance dispatcher pick up the next company.
  //
  // Operator override: VITE_BULK_DISPATCH_TIMEOUT_MS env var (milliseconds).
  // Set to 0 or empty to disable the watchdog entirely (debug only).
  const primarySlotStartedAtRef = useRef(null);
  const shadowSlotStartedAtRef = useRef(null);

  // Preflight duplicate check state
  const [preflightResults, setPreflightResults] = useState(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightError, setPreflightError] = useState(null);
  const [preflightEnabled, setPreflightEnabled] = useState(true);
  const [duplicateDialogOpen, setDuplicateDialogOpen] = useState(false);

  // Spreadsheet paste state
  const [spreadsheetPasteOpen, setSpreadsheetPasteOpen] = useState(false);
  const [spreadsheetPasteText, setSpreadsheetPasteText] = useState("");

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

  // Phase 3.5.1 — succession is "running" as long as EITHER slot is still
  // working. Pre-3.5.1 only checked the primary slot, so the panel flipped
  // to "Succession complete: 1 imports processed" the moment Hudson finished,
  // even while Scrub Daddy was still mid-canonical in the shadow slot.
  // Empirical (2026-05-11 Hudson + Scrub Daddy): user saw the
  // misleading "complete" text + missing checkmark while the actual import
  // ran another 3 minutes in the background.
  //
  // The shadow slot becomes -1 when it's exhausted OR finishes its last
  // company. A shadow session that's still mid-poll has successionShadowIndex
  // >= 0 AND shadowStatus !== "idle"; checking either correctly captures
  // both "queued for next dispatch" and "actively running" states.
  const isPrimaryRunning = successionIndex >= 0;
  const isShadowRunning = successionShadowIndex >= 0 || (shadowSessionId && shadowStatus !== "idle");
  const isSuccessionRunning = isPrimaryRunning || isShadowRunning;
  const isSuccessionRunningRef = useRef(false);
  isSuccessionRunningRef.current = isSuccessionRunning;
  const successionTerminalGateRef = useRef(0);
  const successionCompleted = !isSuccessionRunning && successionResults.length > 0 && successionQueue.length > 0;
  const showSuccessionPanel = isSuccessionRunning || successionCompleted;

  // Audio notification on import / succession completion
  const { play: playNotification, replay: replayNotification, lastPlayed } = useNotificationSound();
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

  // ── Preflight duplicate check (auto-fires on field change) ────────────────
  const removeSuccessionRow = useCallback((index) => {
    setSuccessionRows((prev) => {
      const next = prev.filter((_, i) => i !== index);
      if (next.length === 0) next.push({ companyName: "", companyUrl: "" });
      return next;
    });
    setSuccessionCountInput((prev) => {
      const n = Math.max(1, Number(prev) - 1);
      return String(n);
    });
    setPreflightResults((prev) => {
      if (!prev) return prev;
      return prev
        .filter((r) => r.index !== index)
        .map((r) => (r.index > index ? { ...r, index: r.index - 1 } : r));
    });
  }, []);

  // Debounced auto-preflight check
  useEffect(() => {
    if (!preflightEnabled || !API_BASE) return;

    const entries =
      successionCount > 1
        ? successionRows
            .filter((r) => r.companyName.trim() || r.companyUrl.trim())
            .map((r) => ({ company_name: r.companyName.trim(), url: r.companyUrl.trim() }))
        : [{ company_name: query.trim(), url: companyUrl.trim() }].filter(
            (e) => e.company_name || e.url,
          );

    if (entries.length === 0) {
      setPreflightResults(null);
      setPreflightError(null);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setPreflightLoading(true);
      setPreflightError(null);
      try {
        const res = await apiFetch("/import-preflight", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entries }),
        });
        if (cancelled) return;
        const body = await readJsonOrText(res);
        if (cancelled) return;
        if (!res.ok || !body?.ok) {
          setPreflightError(body?.error || body?.message || `HTTP ${res.status}`);
        } else {
          setPreflightResults(body.results || []);
        }
      } catch (err) {
        if (!cancelled) {
          setPreflightError(err?.message || "Preflight check failed");
        }
      } finally {
        if (!cancelled) setPreflightLoading(false);
      }
    }, 800);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [preflightEnabled, successionRows, successionCount, query, companyUrl]);

  // Clear results when toggle is turned off
  useEffect(() => {
    if (!preflightEnabled) {
      setPreflightResults(null);
      setPreflightError(null);
    }
  }, [preflightEnabled]);
  // ── End preflight ─────────────────────────────────────────────────────────

  // Spreadsheet paste: parse tab-separated lines into succession rows
  const handleSpreadsheetPaste = useCallback((text) => {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) {
      toast.error("No rows found. Paste tab-separated rows (Company Name \\t URL).");
      return;
    }

    let truncated = false;
    let trimmedLines = lines;
    if (trimmedLines.length > SUCCESSION_MAX) {
      trimmedLines = trimmedLines.slice(0, SUCCESSION_MAX);
      truncated = true;
    }

    const rows = trimmedLines.map((line) => {
      const cols = line.split("\t").map((c) => c.trim());
      if (cols.length >= 2) {
        return { companyName: cols[0], companyUrl: cols[1] };
      }
      // Single column: detect if it looks like a URL
      const val = cols[0];
      if (looksLikeUrlOrDomain(val)) {
        return { companyName: "", companyUrl: val };
      }
      return { companyName: val, companyUrl: "" };
    });

    setSuccessionRows(rows);
    setSuccessionCountInput(String(rows.length));
    // Sync first row to the primary query/url inputs
    if (rows.length > 0) {
      setQuery(rows[0].companyName);
      setCompanyUrl(rows[0].companyUrl);
    }
    setSpreadsheetPasteOpen(false);
    setSpreadsheetPasteText("");

    if (truncated) {
      toast.warning(`Pasted ${rows.length} companies (truncated from ${lines.length} — max ${SUCCESSION_MAX}).`);
    } else {
      toast.success(`Pasted ${rows.length} compan${rows.length === 1 ? "y" : "ies"} from spreadsheet.`);
    }
  }, []);

  const spreadsheetPasteRowCount = useMemo(() => {
    return spreadsheetPasteText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).length;
  }, [spreadsheetPasteText]);

  const activeRun = useMemo(() => {
    if (!activeSessionId) return null;
    return runs.find((r) => r.session_id === activeSessionId) || null;
  }, [activeSessionId, runs]);

  const successionRunDetails = useMemo(() => {
    if (!showSuccessionPanel) return [];

    // Phase 3.8 — precompute which session currently holds the xAI lock.
    //
    // Phase 3.8.1 — prefer canonical-timestamp detection over xai_lock_status.
    // Both signals are written via bestEffortPatchSessionDoc (async fire-and-
    // forget). The "held" status patch can lag the actual lock acquisition
    // by seconds because:
    //   - "waiting" is overwritten every backoff cycle while waiting (~2-5s)
    //   - "held" is written ONCE when acquired
    //   - Cosmos write latency means a session can briefly show stale "waiting"
    //     while it's actually holding the lock.
    // Empirical (Artisan Grills + Hestan 2026-05-12): UI showed BOTH rows
    // with amber hourglass simultaneously, even though XAI_CONCURRENCY=1
    // means exactly one of them must hold the lock at any moment.
    //
    // Fix: use `xai_canonical_started_at` (Phase 3.5.2) as primary signal —
    // it's written ONCE when canonical call starts (after lock acquired)
    // and only cleared when canonical finishes. A row in that state IS the
    // lock-holder by definition. Fall back to xai_lock_status only when
    // the canonical timestamps aren't available yet.
    // Phase 3.8.2 — strengthened lock-holder detection. Pre-3.8.2 the
    // heuristic fallback could return "" when no run records yet had a
    // populated session_id, OR when both rows had stale "waiting" status
    // from the wait-loop's repeated patches. In that case heldByRunId
    // was empty AND both rows' xai_lock_status === "waiting" → both
    // flipped to waiting_for_xai → UI showed two amber hourglasses.
    //
    // Strict rule: with XAI_CONCURRENCY=1, exactly ONE in-flight row
    // must hold the lock at any moment. We always identify ONE row as
    // the lock-holder using a priority chain of signals:
    //   1. Canonical started AND not finished (Phase 3.5.2 timestamp)
    //   2. xai_lock_acquired_at set AND no xai_lock_released_at (or
    //      released_at older than acquired_at — re-acquired)
    //   3. xai_lock_status === "held" (laggy patch, last resort signal)
    //   4. Earliest xai_lock_wait_started_at (most-waited = most likely
    //      next to acquire OR current holder)
    //   5. Earliest run.startedAt as ultimate fallback
    //
    // If there are NO in-flight rows (all completed), heldByRunId is "".
    const heldByRunId = (() => {
      // Signal 1: canonical in progress.
      for (const r of runs) {
        const startedAt = r?.resume_worker?.xai_canonical_started_at;
        const finishedAt = r?.resume_worker?.xai_canonical_finished_at;
        if (startedAt && !finishedAt) return asString(r.session_id).trim();
      }
      // Signal 2: lock acquired but not released.
      for (const r of runs) {
        const acquiredAt = Date.parse(r?.resume_worker?.xai_lock_acquired_at || "") || 0;
        const releasedAt = Date.parse(r?.resume_worker?.xai_lock_released_at || "") || 0;
        if (acquiredAt && (!releasedAt || acquiredAt > releasedAt)) {
          return asString(r.session_id).trim();
        }
      }
      // Signal 3: explicit "held" status string (laggy fallback).
      for (const r of runs) {
        const s = r?.resume_worker?.xai_lock_status;
        if (s === "held") return asString(r.session_id).trim();
      }
      // Signals 4 + 5: pick the most-likely candidate among in-flight rows.
      // With XAI_CONCURRENCY=1, ONE of them MUST hold the lock — even if
      // none of signals 1-3 have surfaced yet (early startup window where
      // patches haven't landed).
      const candidates = runs
        .map((r) => ({
          sessionId: asString(r?.session_id).trim(),
          waitStartedAt: Date.parse(r?.resume_worker?.xai_lock_wait_started_at || "") || 0,
          startedAt: Date.parse(r?.startedAt || "") || 0,
          completed: Boolean(r?.completed || r?.stopped || r?.timedOut),
        }))
        .filter((c) => c.sessionId && !c.completed);
      if (candidates.length === 0) return "";
      candidates.sort((a, b) => {
        if (a.waitStartedAt && b.waitStartedAt && a.waitStartedAt !== b.waitStartedAt) {
          return a.waitStartedAt - b.waitStartedAt;
        }
        return a.startedAt - b.startedAt;
      });
      return candidates[0].sessionId;
    })();

    return successionQueue.map((item, i) => {
      const result = successionResults.find((r) => r.index === i);
      const run = result?.sessionId ? runs.find((r) => r.session_id === result.sessionId) : null;
      const companyName =
        run?.saved_companies?.[0]?.company_name ||
        run?.items?.[0]?.company_name ||
        run?.query ||
        item.companyName ||
        item.companyUrl ||
        `Company ${i + 1}`;
      // Phase 3.5.1 — accurate slot detection. Pre-3.5.1 the shadow row was
      // matched only by `i === successionIndex + 1` which broke when primary
      // had already advanced (or finished) past the shadow's index. Now we
      // match each slot's actual current index directly.
      const isCurrent = isPrimaryRunning && i === successionIndex;
      const isShadow = SUCCESSION_CONCURRENCY >= 2
        && shadowSessionId
        && (
          (isShadowRunning && successionShadowIndex >= 0 && i === successionShadowIndex)
          // Edge case: shadow's index has been cleared (-1) but its session
          // is still being polled. Look up which queue item corresponds to
          // the shadow session id and badge that row.
          || (isShadowRunning && successionShadowIndex < 0 && successionResults.every((r) => r.sessionId !== shadowSessionId) && (run?.session_id === shadowSessionId))
        );
      let status = result ? result.status : (isCurrent || isShadow) ? "running" : "pending";

      // Phase 3.1.3 — differentiate "actively talking to xAI" from "waiting
      // for the xAI lock". With XAI_CONCURRENCY=1 (or even 2 when there are
      // 3+ companies in flight), multiple companies show stage_beacon=
      // enrichment_queued but only ONE is doing xAI work; others are
      // polling the lock. resume_worker.xai_lock_status tells us which.
      //
      // Phase 3.8 — expanded the trigger to also fire when xai_lock_status
      // is null/undefined but another session DOES hold the lock.
      //
      // Phase 3.8.1 — STRICT lock-holder rule. With heldByRunId now based
      // on canonical timestamps (Phase 3.5.2) instead of the laggy
      // xai_lock_status patch, we can trust it. So: a row is "running"
      // ONLY if it IS the lock-holder. Any other in-flight row is
      // "waiting_for_xai". This eliminates the case where two rows show
      // amber hourglass simultaneously because both had stale "waiting"
      // status — heldByRunId is now derived from a reliable signal.
      const xaiLockStatus = run?.resume_worker?.xai_lock_status || null;
      const sessionId = asString(run?.session_id).trim();
      const isLockHolder = Boolean(heldByRunId && sessionId === heldByRunId);
      // Phase 3.8.2 — strict rule. With heldByRunId now guaranteed to
      // identify ONE in-flight row (via the priority chain above), any
      // other in-flight row is by definition waiting. We no longer need
      // the secondary "explicit waiting" fallback that previously caused
      // the stale-patch bug where both rows flipped to waiting_for_xai.
      if (status === "running" && heldByRunId && !isLockHolder) {
        status = "waiting_for_xai";
      }

      // Timing data from run history
      let startedAt = null;
      let updatedAt = null;
      let trt = null;
      let trtSource = null;        // Phase 3.5.2 — track which signal we used
      let lockWaitMs = null;       // Phase 3.5.2 — surface for tooltip
      if (run) {
        startedAt = run.startedAt ? new Date(run.startedAt) : null;
        updatedAt = run.updatedAt ? new Date(run.updatedAt) : null;

        // Phase 3.5.2 — TRT priority chain. Highest signal wins:
        //   1. resume_worker.xai_canonical_elapsed_ms — the precise xAI
        //      call duration (start of runCanonicalImportCall → end). This
        //      is the "real" backend work for THIS company. Pre-3.5.2 the
        //      UI used (updatedAt - startedAt) which conflated lock-wait
        //      with canonical work — Solo Stove showed TRT 5:09 when its
        //      actual canonical was only 1:54 (3:15 lock-wait + 1:54 work).
        //   2. run.elapsed_ms — backend session elapsed (includes lock-wait
        //      for resume-worker mode; still better than wall-clock).
        //   3. (updatedAt - startedAt) — frontend wall-clock fallback.
        const canonicalElapsedMs = Number(run?.resume_worker?.xai_canonical_elapsed_ms);
        lockWaitMs = Number.isFinite(Number(run?.resume_worker?.xai_lock_wait_ms))
          ? Number(run.resume_worker.xai_lock_wait_ms)
          : null;

        if (canonicalElapsedMs > 0) {
          const totalSec = Math.round(canonicalElapsedMs / 1000);
          const m = Math.floor(totalSec / 60);
          const s = totalSec % 60;
          trt = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
          trtSource = "canonical";
        } else if (startedAt && updatedAt && (run.completed || run.stopped || run.timedOut)) {
          const ms = (run.elapsed_ms > 0 ? run.elapsed_ms : null) ?? (updatedAt - startedAt);
          if (ms > 0) {
            const totalSec = Math.round(ms / 1000);
            const m = Math.floor(totalSec / 60);
            const s = totalSec % 60;
            trt = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
            trtSource = run.elapsed_ms > 0 ? "session" : "wallclock";
          }
        }
      }

      return {
        index: i,
        companyName,
        companyUrl: item.companyUrl,
        status,
        sessionId: result?.sessionId || null,
        startedAt,
        updatedAt,
        trt,
        trtSource,                                                   // Phase 3.5.2
        lockWaitMs,                                                  // Phase 3.5.2
        xaiLockStatus,                                              // Phase 3.1.3
        xaiLockWaitMs: run?.resume_worker?.xai_lock_wait_ms ?? null, // Phase 3.1.3
        // Phase 4.9 — surface start_error / dispatcher-timeout details so
        // the error-row tooltip can show "running 312s, cap 300s" etc.
        startError: run?.start_error || null,
        startErrorDetails: run?.start_error_details || null,
        timedOut: Boolean(run?.timedOut),
      };
    });
  }, [
    showSuccessionPanel,
    successionQueue,
    successionResults,
    successionIndex,
    runs,
    isSuccessionRunning,
    isPrimaryRunning,
    isShadowRunning,
    successionShadowIndex,
    shadowSessionId,
  ]);

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

  // Shadow slot polling (slot B) — simplified version of schedulePoll for concurrent succession.
  // Uses its own timer, attempts counter, and status setter. pollProgress is reused since it
  // updates runs[] by session_id and is fully parameterized.
  const stopShadowPolling = useCallback(() => {
    if (shadowPollTimerRef.current) {
      clearTimeout(shadowPollTimerRef.current);
      shadowPollTimerRef.current = null;
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

        // For succession imports, advance after the resume-worker completes at least
        // one enrichment cycle.  This gives logo, reviews, and geocoding a chance to
        // populate before we move on.  The resume-worker continues enriching in the
        // background after advancement.
        const resumeCycleCount = Number(body?.resume_cycle_count ?? body?.resume?.cycle_count ?? 0);
        // Disabled: succession now waits for full enrichment (isTerminalComplete).
        // Previously this advanced after a single resume-worker cycle (~3s), causing
        // the next company to start before enrichment even began.  The user requires
        // each company to be fully enriched before the next one starts.
        const isSuccessionAdvanceReady = false;

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
                    ? `Enriching in background\u2026`
                    : r.progress_notice,
              updatedAt: new Date().toISOString(),
            };
          })
        );

        // Phase 3.5 — mark this session as actively importing (or release it
        // when terminal). The Companies dashboard reads this state to render
        // an "Importing…" badge on rows that are currently being processed,
        // distinguishing them from rows that are genuinely Stub-0%.
        try {
          const verifiedId = Array.isArray(body?.saved_company_ids_verified) && body.saved_company_ids_verified.length > 0
            ? asString(body.saved_company_ids_verified[0]).trim()
            : Array.isArray(body?.saved_company_ids) && body.saved_company_ids.length > 0
              ? asString(body.saved_company_ids[0]).trim()
              : "";

          if (isTerminalError || (isTerminalComplete && !shouldBackoffForResume)) {
            markImportInactive({ session_id, company_id: verifiedId });
          } else {
            markImportActive({
              session_id,
              company_id: verifiedId,
              status: shouldBackoffForResume ? "enriching" : (isTerminalComplete ? "complete_pending_resume" : "running"),
            });
          }
        } catch { /* never break the polling loop on telemetry errors */ }

        // Succession early advance: company is saved + enrichment partial + resume-worker is
        // filling in remaining fields.  Advance the queue so the next company can start importing
        // while the resume-worker continues enriching this one in the background.
        if (isSuccessionAdvanceReady) {
          try {
            setActiveStatus((prev) => (prev === "running" ? "done" : prev));
          } catch {}
          return { shouldStop: true, body };
        }

        if (isTerminalError) {
          try {
            setActiveStatus((prev) => (prev === "running" ? "error" : prev));
          } catch {}
          return { shouldStop: true, body };
        }

        if (isTerminalComplete) {
          // During succession, delay terminal completion until at least one
          // resume-worker cycle finishes — logo, reviews, and geocoding are
          // populated by the worker, not by import-start.  Time-limited so
          // the succession doesn't stall if the worker never triggers.
          if (isSuccessionRunningRef.current && resumeCycleCount < 1) {
            if (!successionTerminalGateRef.current) successionTerminalGateRef.current = Date.now();
            const waited = Date.now() - successionTerminalGateRef.current;
            if (waited < 180_000) {
              // Continue polling — fall through to shouldStop: false below
            } else {
              // 3-minute timeout — advance anyway
              successionTerminalGateRef.current = 0;
              try {
                setActiveStatus((prev) => (prev === "running" ? "done" : prev));
              } catch {}
              return { shouldStop: true, body };
            }
          } else {
            successionTerminalGateRef.current = 0;
            try {
              setActiveStatus((prev) => (prev === "running" ? "done" : prev));
            } catch {}
            return { shouldStop: true, body };
          }
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
  const RESUME_POLL_IN_PROGRESS_MS = [3_000, 5_000, 5_000, 10_000, 10_000];
  // When resume is queued but worker not yet triggered, use slower backoff.
  const RESUME_POLL_QUEUED_BACKOFF_MS = [15_000, 30_000, 60_000, 120_000];
  // General backoff when enrichment is actively running (not resume-specific).
  // Progression: 3s → 5s → 8s → 12s → 18s → 25s → 30s (capped)
  const GENERAL_RUNNING_BACKOFF_MS = [3_000, 5_000, 8_000, 12_000, 18_000, 25_000, 30_000];
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

          // General backoff: if enrichment is still running (no resume path),
          // back off gradually instead of hammering at 2.5s.
          // During succession, cap at 10s so completion is detected quickly
          // (reduces inter-pair gap from ~25s to ~10s).
          const statusStr = asString(latestBody?.status).trim().toLowerCase();
          if (statusStr === "running" || statusStr === "in_progress" || statusStr === "enriching") {
            const maxBackoffMs = isSuccessionRunningRef.current ? 10_000 : undefined;
            const backoffArray = GENERAL_RUNNING_BACKOFF_MS;
            const currentIndex = pollBackoffRef.current.get(sid) || 0;
            const idx = Math.max(0, Math.min(currentIndex, backoffArray.length - 1));
            pollBackoffRef.current.set(sid, Math.min(idx + 1, backoffArray.length - 1));
            const delayMs = backoffArray[idx];
            return maxBackoffMs ? Math.min(delayMs, maxBackoffMs) : delayMs;
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

  // Shadow poll scheduler — simplified version of schedulePoll for slot B.
  // Reuses pollProgress (which updates runs[] by session_id). Only difference:
  // sets shadowStatus instead of activeStatus, uses shadow timer/attempts refs.
  const scheduleShadowPoll = useCallback(
    ({ session_id, delayMs } = {}) => {
      const sid = asString(session_id).trim();
      if (!sid) return;

      stopShadowPolling();

      const initialDelay = Number.isFinite(Number(delayMs)) ? Math.max(500, Number(delayMs)) : DEFAULT_POLL_INTERVAL_MS;

      shadowPollTimerRef.current = setTimeout(async () => {
        const prevAttempts = shadowPollAttemptsRef.current.get(sid) || 0;
        const nextAttempts = prevAttempts + 1;
        shadowPollAttemptsRef.current.set(sid, nextAttempts);

        const result = await pollProgress({ session_id: sid }).catch((e) => ({ shouldStop: false, error: e }));

        // Max attempts — treat as done
        if (nextAttempts > POLL_MAX_ATTEMPTS) {
          setShadowStatus("done");
          stopShadowPolling();
          return;
        }

        if (result?.shouldStop) {
          stopShadowPolling();
          shadowPollBackoffRef.current.delete(sid);
          const body = result?.body;
          const status = asString(body?.status).trim();
          const stageBeacon = asString(body?.stage_beacon).trim();
          const isError = status === "error" || stageBeacon === "error";
          setShadowStatus(isError ? "error" : "done");
          return;
        }

        // Compute next delay with backoff (capped at 10s during succession)
        const latestBody = result?.body || null;
        const statusStr = asString(latestBody?.status).trim().toLowerCase();
        let nextDelayMs = DEFAULT_POLL_INTERVAL_MS;
        if (statusStr === "running" || statusStr === "in_progress" || statusStr === "enriching") {
          const currentIndex = shadowPollBackoffRef.current.get(sid) || 0;
          const idx = Math.max(0, Math.min(currentIndex, GENERAL_RUNNING_BACKOFF_MS.length - 1));
          shadowPollBackoffRef.current.set(sid, Math.min(idx + 1, GENERAL_RUNNING_BACKOFF_MS.length - 1));
          nextDelayMs = Math.min(GENERAL_RUNNING_BACKOFF_MS[idx], 10_000);
        }

        scheduleShadowPoll({ session_id: sid, delayMs: nextDelayMs });
      }, initialDelay);
    },
    [pollProgress, stopShadowPolling]
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
        ? "primary → products → reviews → location → save → expand"
        : "primary → products → location → save → expand",
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
        company_url_hint:
          asString(companyUrl).trim() && looksLikeUrlOrDomain(asString(companyUrl).trim())
            ? asString(companyUrl).trim()
            : undefined,
        location: asString(location).trim() || undefined,
        limit: normalizedLimit,
        expand_if_few: true,
        dry_run: dryRun,
        fields_to_enrich: enrichFields.length < ALL_ENRICH_FIELD_KEYS.length ? enrichFields : undefined,
        batch_industries: batchIndustries.trim() || undefined,
        batch_keywords: batchKeywords.trim() || undefined,
      };

      // Pre-warm: fire a lightweight request to wake up the Function App before the heavy import.
      // SWA cold-starts frequently cause 500 "Backend call failure". This non-blocking ping gives
      // the Function App a head-start on initialization.
      // Skip pre-warm during succession — Function App is already warm from previous imports.
      if (!isSuccessionRunningRef.current) {
        try {
          fetch(`${API_BASE}/import/status?session_id=warmup&_t=${Date.now()}`, {
            method: "GET",
            signal: AbortSignal.timeout(8000),
          }).catch(() => {});
          // Wait 3s for the warm-up to take effect before starting the import
          await sleep(3000);
        } catch {}
      }

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

        // Phase 4.10 — pre-send breadcrumb. Logs the EXACT moment the frontend
        // attempts to fire an import-start fetch. Pairs with the backend's
        // [import-start] entry log. When a slot stalls (Asics-style: no backend
        // log at all), this breadcrumb tells us whether the frontend tried to
        // send the request. Three diagnostic outcomes possible next time:
        //   1. Breadcrumb present + backend log present → request landed
        //   2. Breadcrumb present + backend log absent → request lost in transit
        //      (network, CORS preflight, Azure routing)
        //   3. Breadcrumb absent → frontend never reached this code path
        //      (early validation failure, async deadlock, dispatcher bug)
        try {
          console.info("[admin-import] fetch_start_attempt", {
            slot: "primary",
            sid: canonicalSessionId,
            query: payload.query,
            url_hint: payload.company_url_hint || null,
            stage: stage || null,
            ts: new Date().toISOString(),
          });
        } catch { /* console may be unavailable in some test envs */ }

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

        // Surface the auto-triggered homepage + logo backfill jobs so admin
        // can monitor them. Each backfill writes to its own admin page.
        const homepageBackfillJobId = asString(
          lastStageBody?.homepage_backfill_job_id ||
          lastStageBody?.result?.homepage_backfill_job_id
        ).trim();
        const logoBackfillJobId = asString(
          lastStageBody?.logo_backfill_job_id ||
          lastStageBody?.result?.logo_backfill_job_id
        ).trim();
        if (homepageBackfillJobId) {
          toast.success("Homepage capture started — view progress in Backfill Homepages", {
            action: {
              label: "View",
              onClick: () => window.open("/admin/backfill-homepages", "_blank"),
            },
          });
        }
        if (logoBackfillJobId) {
          toast.success("Logo backfill started — view progress in Backfill Logos", {
            action: {
              label: "View",
              onClick: () => window.open("/admin/backfill-logos", "_blank"),
            },
          });
        }
      } else {
        // Keep the run in a non-terminal state until /import/status confirms completion.
        const savedVerifiedLabel = (snapshotSavedVerifiedCount ?? snapshotVerifiedIds.length) || 0;
        const label = snapshotResumeNeeded ? `Saved (verified): ${savedVerifiedLabel}. Enrichment in progress…` : "Import started";
        toast.success(label);
      }
    } catch (e) {
      const msg = e?.name === "AbortError" ? "Import aborted" : toErrorString(e) || "Import failed";
      // Phase 4.10 — surface AbortError to the console for diagnostics. Pre-4.10
      // primary slot set status=idle on AbortError, which prevented the bulk
      // dispatcher (which advances on done/error) from picking up the next
      // company. In succession mode this stalled the slot until Phase 4.9's
      // watchdog timed it out 5 minutes later. Now we log the abort and set
      // status=error so the dispatcher advances immediately.
      if (e?.name === "AbortError") {
        try {
          console.warn("[admin-import] fetch_aborted", {
            slot: "primary",
            // eslint-disable-next-line no-undef -- canonicalSessionId is defined in the try block above
            sid: canonicalSessionId,
            abort_reason: e?.message || "AbortError (no message)",
            ts: new Date().toISOString(),
          });
        } catch { /* console may be unavailable in some test envs */ }
      }
      // eslint-disable-next-line no-undef -- canonicalSessionId is defined in the try block above (line ~1614)
      setRuns((prev) => prev.map((r) => (r.session_id === canonicalSessionId ? {
        ...r,
        start_error: msg,
        ...(e?.name === "AbortError"
          ? { start_error_details: { phase: "4.10", reason: "request_aborted", abort_message: e?.message || null, slot: "primary" } }
          : {}),
      } : r)));
      // Phase 4.10 — AbortError now flips to "error" instead of "idle", so the
      // succession dispatcher's Phase 2.18.A2 slot-advance gate fires
      // (`primaryDone = activeStatus === "error" || ...`). For standalone
      // (non-batch) imports, the error display is informative ("Import aborted")
      // rather than misleadingly silent.
      setActiveStatus("error");
      if (e?.name !== "AbortError") toast.error(msg);
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
    batchIndustries,
    batchKeywords,
    enrichFields,
    companyUrl,
  ]);

  // Shadow import (slot B) — simplified version of beginImport for concurrent succession.
  // Does NOT touch activeSessionId, activeStatus, or primary poll state.
  const beginImportShadow = useCallback(async (shadowCompanyName, shadowCompanyUrl) => {
    if (!importConfigured) return;

    const sid = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const selectedTypes = Array.isArray(queryTypes) && queryTypes.length > 0 ? queryTypes : ["product_keyword"];

    const newRun = {
      session_id: sid,
      session_id_confirmed: false,
      ui_session_id_before: sid,
      query: shadowCompanyName,
      queryTypes: selectedTypes,
      location: asString(location).trim() || "",
      limit: 1,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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

    setRuns((prev) => [newRun, ...prev]);
    setShadowSessionId(sid);
    setShadowStatus("running");

    shadowAbortRef.current?.abort?.();
    const abort = new AbortController();
    shadowAbortRef.current = abort;

    try {
      const urlHint =
        shadowCompanyUrl && looksLikeUrlOrDomain(shadowCompanyUrl)
          ? shadowCompanyUrl
          : undefined;

      const requestPayload = {
        session_id: sid,
        query: shadowCompanyName,
        queryTypes: selectedTypes,
        company_url_hint: urlHint,
        location: asString(location).trim() || undefined,
        limit: 1,
        expand_if_few: true,
        dry_run: false,
        fields_to_enrich: enrichFields.length < ALL_ENRICH_FIELD_KEYS.length ? enrichFields : undefined,
        batch_industries: batchIndustries.trim() || undefined,
        batch_keywords: batchKeywords.trim() || undefined,
      };

      setRuns((prev) =>
        prev.map((r) => (r.session_id === sid ? { ...r, start_request_payload: requestPayload } : r))
      );

      // Phase 4.10 — pre-send breadcrumb (shadow slot). See primary-slot
      // breadcrumb above for the diagnostic rationale.
      try {
        console.info("[admin-import] fetch_start_attempt", {
          slot: "shadow",
          sid,
          query: shadowCompanyName,
          url_hint: urlHint || null,
          ts: new Date().toISOString(),
        });
      } catch { /* console may be unavailable in some test envs */ }

      const { res } = await apiFetchWithFallback(["/import/start", "/import-start"], {
        method: "POST",
        body: requestPayload,
        signal: abort.signal,
      });

      const body = await readJsonOrText(res);

      // Reconcile session ID if backend returns a different one
      const headerSid = (() => {
        try {
          return String(res?.headers?.get?.("x-session-id") || "").trim();
        } catch { return ""; }
      })();
      const canonicalSid = headerSid || asString(body?.session_id).trim() || sid;

      if (canonicalSid !== sid) {
        setRuns((prev) =>
          prev.map((r) =>
            r.session_id === sid
              ? { ...r, session_id: canonicalSid, session_id_confirmed: true }
              : r
          )
        );
        setShadowSessionId(canonicalSid);
      }

      if (!res.ok && !(body && typeof body === "object" && body.ok !== false)) {
        const msg = toErrorString(body?.error || body?.message || `Shadow import failed (HTTP ${res.status})`);
        setRuns((prev) =>
          prev.map((r) => (r.session_id === (canonicalSid || sid) ? { ...r, start_error: msg } : r))
        );
        setShadowStatus("error");
        return;
      }

      // Start shadow polling
      shadowPollAttemptsRef.current.set(canonicalSid, 0);
      shadowPollBackoffRef.current.delete(canonicalSid);
      scheduleShadowPoll({ session_id: canonicalSid, delayMs: 3000 });
    } catch (e) {
      // Phase 4.10 — surface AbortError to the console for diagnostics. Pre-4.10
      // the shadow slot returned silently on AbortError, leaving shadowStatus
      // stuck at "running" forever. The bulk dispatcher (Phase 2.17) only
      // advances slots on done/error, so the slot would hang until Phase 4.9's
      // watchdog timed it out 5 minutes later. Now we log + flip to error so
      // the dispatcher advances immediately.
      if (e?.name === "AbortError") {
        try {
          console.warn("[admin-import] fetch_aborted", {
            slot: "shadow",
            sid,
            abort_reason: e?.message || "AbortError (no message)",
            ts: new Date().toISOString(),
          });
        } catch { /* console may be unavailable in some test envs */ }
        setRuns((prev) =>
          prev.map((r) => (r.session_id === sid ? {
            ...r,
            start_error: "Import aborted",
            start_error_details: {
              phase: "4.10",
              reason: "request_aborted",
              abort_message: e?.message || null,
              slot: "shadow",
            },
          } : r))
        );
        setShadowStatus("error");
        return;
      }
      const msg = toErrorString(e) || "Shadow import failed";
      setRuns((prev) =>
        prev.map((r) => (r.session_id === sid ? { ...r, start_error: msg } : r))
      );
      setShadowStatus("error");
    }
  }, [importConfigured, queryTypes, location, enrichFields, scheduleShadowPoll, batchIndustries, batchKeywords]);

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

  const [applyingBatchFields, setApplyingBatchFields] = useState(false);
  const applyBatchFields = useCallback(async () => {
    const industries = batchIndustries.trim().split(",").map((s) => s.trim()).filter(Boolean);
    const keywords = batchKeywords.trim().split(",").map((s) => s.trim()).filter(Boolean);
    if (industries.length === 0 && keywords.length === 0) {
      toast.error("Enter industries or products to apply.");
      return;
    }
    const rows = successionRows.filter(
      (r) => r.companyName.trim() || r.companyUrl.trim()
    );
    if (rows.length === 0) {
      toast.error("No companies listed to apply to.");
      return;
    }
    setApplyingBatchFields(true);
    let ok = 0;
    let fail = 0;
    const failedNames = [];
    for (const row of rows) {
      const domain = row.companyUrl.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/^www\./, "").toLowerCase();
      const name = row.companyName.trim();
      try {
        // Search by domain first, fall back to name
        let items = [];
        for (const q of [domain, name].filter(Boolean)) {
          const { res: searchRes } = await apiFetchWithFallback([`/xadmin-api-companies?search=${encodeURIComponent(q)}&take=20`]);
          if (!searchRes.ok) continue;
          const data = await searchRes.json().catch(() => ({}));
          items = data?.items || [];
          if (items.length > 0) break;
        }
        const match = items.find((c) => {
          const d = String(c.normalized_domain || "").toLowerCase().replace(/^www\./, "");
          if (domain && d === domain) return true;
          const n = String(c.company_name || "").toLowerCase();
          if (name && n === name.toLowerCase()) return true;
          // Fuzzy: name contains or is contained
          if (name && (n.includes(name.toLowerCase()) || name.toLowerCase().includes(n))) return true;
          return false;
        });
        if (!match) { fail++; failedNames.push(name || domain); toast.warning(`Not found: ${name || domain}`); continue; }
        const existing = match;
        const patch = {};
        if (industries.length > 0) {
          const cur = Array.isArray(existing.industries) ? existing.industries : [];
          const merged = Array.from(new Set([...cur, ...industries]));
          patch.industries = merged;
        }
        if (keywords.length > 0) {
          const cur = Array.isArray(existing.product_keywords || existing.keywords) ? (existing.product_keywords || existing.keywords) : [];
          const merged = Array.from(new Set([...cur, ...keywords]));
          patch.keywords = merged;
          patch.product_keywords = merged;
        }
        const { res: putRes } = await apiFetchWithFallback([`/xadmin-api-companies/${encodeURIComponent(existing.id)}`], {
          method: "PUT",
          body: JSON.stringify({ company: { ...existing, ...patch } }),
        });
        if (putRes.ok) {
          ok++;
          toast.success(`✓ ${name || domain}`);
        } else {
          fail++;
          failedNames.push(name || domain);
          toast.error(`Failed to save: ${name || domain}`);
        }
      } catch (e) { fail++; failedNames.push(name || domain); toast.error(`Error: ${name || domain}`); }
    }
    setApplyingBatchFields(false);
    if (ok > 0) toast.success(`Applied to ${ok} compan${ok === 1 ? "y" : "ies"}.`);
    if (fail > 0) toast.warning(`${fail} not found or failed: ${failedNames.join(", ")}`);
  }, [batchIndustries, batchKeywords, successionRows]);

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

      // Stop shadow slot too if active
      stopShadowPolling();
      shadowAbortRef.current?.abort?.();
      if (shadowSessionId) {
        try {
          await apiFetch("/import/stop", {
            method: "POST",
            body: { session_id: shadowSessionId },
          });
        } catch {}
        setRuns((prev) =>
          prev.map((r) =>
            r.session_id === shadowSessionId
              ? { ...r, stopped: true, progress_notice: "Import stopped by user" }
              : r
          )
        );
      }
      setShadowSessionId(null);
      setShadowStatus("idle");

      // Brief delay to show "Stopping..." state, then set to idle
      setTimeout(() => {
        stopPolling();
        setActiveStatus("idle");
      }, 1500);

    } catch (e) {
      toast.error(toErrorString(e) || "Stop failed");
      setActiveStatus("running"); // Revert on error
    }
  }, [activeSessionId, shadowSessionId, stopPolling, stopShadowPolling]);

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
        body: JSON.stringify({
          url,
          fields_to_enrich: enrichFields.length < ALL_ENRICH_FIELD_KEYS.length ? enrichFields : undefined,
        }),
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

      if (body.completed && !body.resume_needed) {
        // Fully complete — no enrichment pending
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
        // Import still running or enrichment pending — start polling
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
                  saved_verified_count: computedSaved,
                  saved_company_ids_verified: savedVerifiedIds.length > 0 ? savedVerifiedIds : r.saved_company_ids_verified,
                  saved_companies: savedCompanies.length > 0 ? savedCompanies : r.saved_companies,
                  resume_needed: Boolean(body.resume_needed),
                  progress_notice: body.resume_needed
                    ? `Saved (${computedSaved}). Enrichment in progress\u2026`
                    : null,
                  updatedAt: new Date().toISOString(),
                }
              : r
          )
        );

        if (body.resume_needed && computedSaved > 0) {
          toast.success(`Saved (${computedSaved}). Enrichment in progress\u2026`);
        } else {
          toast.info("Import started, polling for completion...");
        }
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

    // Check if preflight found any duplicate matches
    const hasDuplicates = Array.isArray(preflightResults) &&
      preflightResults.some((r) => r.status === "exact_match" || r.status === "fuzzy_match");

    if (hasDuplicates) {
      setDuplicateDialogOpen(true);
      return; // Don't start import yet — show dialog first
    }

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

    // Phase 2.17 — rolling-pool init.
    // Slot A (primary) takes index 0, slot B (shadow) takes index 1.
    // The "next to dispatch" pointer starts at 2 — when EITHER slot
    // finishes, it claims index 2 next, and so on.
    setSuccessionShadowIndex(SUCCESSION_CONCURRENCY >= 2 && validRows.length > 1 ? 1 : -1);
    nextDispatchIndexRef.current = SUCCESSION_CONCURRENCY >= 2 && validRows.length > 1 ? 2 : 1;
    lastProcessedPrimaryIndexRef.current = -1;
    lastProcessedShadowIndexRef.current = -1;

    const first = validRows[0];
    setQuery(first.companyName);
    setCompanyUrl(first.companyUrl);
    successionTriggerRef.current = true;

    // Launch shadow slot (slot B) for second company with 2s stagger
    if (SUCCESSION_CONCURRENCY >= 2 && validRows.length > 1) {
      const second = validRows[1];
      setTimeout(() => {
        beginImportShadow(second.companyName, second.companyUrl);
      }, 2000);
    }
  }, [successionCount, successionRows, startImportDisabled, handleStartImportStaged, preflightResults, beginImportShadow, SUCCESSION_CONCURRENCY]);

  // Import Now: proceeds with import after duplicate dialog confirmation
  const handleImportNow = useCallback(() => {
    setDuplicateDialogOpen(false);

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

    // Phase 2.17 — rolling-pool init (mirror of handleStartSuccession).
    setSuccessionShadowIndex(SUCCESSION_CONCURRENCY >= 2 && validRows.length > 1 ? 1 : -1);
    nextDispatchIndexRef.current = SUCCESSION_CONCURRENCY >= 2 && validRows.length > 1 ? 2 : 1;
    lastProcessedPrimaryIndexRef.current = -1;
    lastProcessedShadowIndexRef.current = -1;

    const first = validRows[0];
    setQuery(first.companyName);
    setCompanyUrl(first.companyUrl);
    successionTriggerRef.current = true;

    // Launch shadow slot (slot B) for second company with 2s stagger
    if (SUCCESSION_CONCURRENCY >= 2 && validRows.length > 1) {
      const second = validRows[1];
      setTimeout(() => {
        beginImportShadow(second.companyName, second.companyUrl);
      }, 2000);
    }
  }, [successionCount, successionRows, handleStartImportStaged, beginImportShadow, SUCCESSION_CONCURRENCY]);

  // Succession import: trigger effect — fires the import after state has updated
  useEffect(() => {
    if (successionIndex < 0 || successionIndex >= successionQueue.length) return;
    if (!successionTriggerRef.current) return;

    successionTriggerRef.current = false;
    successionTerminalGateRef.current = 0;
    handleStartImportStaged();
  }, [successionIndex, query, companyUrl, handleStartImportStaged, successionQueue]);

  // Phase 2.17 — rolling-pool dispatcher.
  //
  // Each slot independently advances when ITS status flips to done/error,
  // claiming the next available company from a shared atomic counter
  // (nextDispatchIndexRef). This eliminates the pair-batched bottleneck
  // where Steger+Verloop had to wait for RockDove's 6:43 to finish before
  // they could even start.
  //
  // Two effects (one per slot) plus a completion detector that fires when
  // the queue is exhausted AND both slots are idle.

  // Helper: fire-and-forget enrichment verification poll. Called when ANY
  // slot's session completes — triggers the resume-worker watchdog/HTTP
  // self-invocation as a safety net for sessions whose enrichment was
  // queued but the worker never picked up.
  const verifyEnrichment = useCallback((sessionId) => {
    if (!sessionId) return;
    const statusUrl = join(API_BASE, `/import-status?session_id=${encodeURIComponent(sessionId)}`);
    apiFetch(statusUrl).then(() => {}).catch(() => {});
    setTimeout(() => { apiFetch(statusUrl).then(() => {}).catch(() => {}); }, 15_000);
  }, []);

  // Phase 2.18.A2 — strict completion check helper.
  //
  // Phase 2.18.1 HOTFIX (2026-05-09 23:46): the original A2 also required
  // !run.resume_needed but the runs[] state has
  // `resume_needed: snapshotResumeNeeded || Boolean(r.resume_needed)`
  // (monotonic OR — once true, never flips false). That made the gate
  // unreachable for any session that ever had resume_needed: true,
  // which is every session via the 202 fast-path. Result: slots stuck
  // forever after the first pair completes. Glerups + Haflinger
  // finished at 23:43, but Kyrgies + Sorel never started because the
  // gate blocked slot advance.
  //
  // Removed the resume_needed check. The safety-net (A1) provides the
  // structural protection against lost queue messages — even if the
  // dispatcher advances "prematurely" for a session whose enrichment
  // hasn't actually run, the safety-net fires the resume-worker 90s
  // later and recovers. The strict gate is now: completed === true AND
  // saved > 0 (or explicit error).
  //
  // For genuinely failed imports (activeStatus === "error"), the slot
  // still advances immediately — no point waiting on a failure.
  const isRunStrictlyComplete = useCallback((sessionId) => {
    const sid = asString(sessionId).trim();
    if (!sid) return false;
    const run = runs.find((r) => asString(r?.session_id).trim() === sid);
    if (!run) return false;
    if (Number(run.saved) <= 0) return false;
    if (run.completed !== true) return false;
    return true;
  }, [runs]);

  // Primary slot advance — fires when activeStatus transitions to
  // done/error. Records the completion, then atomically claims the next
  // queue index and re-starts primary on that company.
  useEffect(() => {
    if (successionIndex < 0) return;
    // Guard: trigger effect fires in same commit as start; setActiveStatus
    // is batched and not yet committed. Skip while a start is in flight.
    if (startImportRequestInFlightRef.current) return;

    // Phase 2.18.A2 — strict completion gate. Don't advance just because
    // activeStatus flipped — require either genuine completion or
    // explicit error. This blocks the Dearfoams pattern where polling
    // briefly reported "done" before enrichment had actually run.
    const primaryDone =
      activeStatus === "error" ||
      (activeStatus === "done" && isRunStrictlyComplete(activeSessionId));
    if (!primaryDone) return;

    // Idempotency guard: each succession-index slot completion is processed
    // exactly once. Without this, every re-render after "done" would re-fire.
    if (lastProcessedPrimaryIndexRef.current === successionIndex) return;
    const completedIndex = successionIndex;
    lastProcessedPrimaryIndexRef.current = completedIndex;

    setSuccessionResults((prev) => [...prev, {
      index: completedIndex,
      status: activeStatus === "done" ? "done" : "error",
      sessionId: activeSessionId,
    }]);
    verifyEnrichment(activeSessionId);

    // Phase 2.19.8 — dispatch a window-level event so other open admin views
    // (CompanyDashboard list, etc.) can refetch their data immediately when
    // an import completes. Without this, list views stay stale until the
    // tab-visibility refetch (Phase 2.13.A) or the 60s poll fires —
    // empirically (Early California, 2026-05-10) the list showed Stub-0%
    // for several minutes even though Cosmos had all 6 fields populated.
    try {
      window.dispatchEvent(new CustomEvent("tabarnam:import-complete", {
        detail: { sessionId: activeSessionId, status: activeStatus === "done" ? "done" : "error", slot: "primary" },
      }));
    } catch { /* ignore in non-browser env */ }

    // Phase 3.5 — clear active-imports state so the Companies dashboard
    // immediately drops the "Importing…" badge on this row.
    try {
      const completedRun = runs.find((r) => asString(r?.session_id).trim() === asString(activeSessionId).trim());
      const completedVerifiedId = Array.isArray(completedRun?.saved_company_ids_verified) && completedRun.saved_company_ids_verified.length > 0
        ? asString(completedRun.saved_company_ids_verified[0]).trim()
        : "";
      markImportInactive({ session_id: activeSessionId, company_id: completedVerifiedId });
    } catch { /* never break the dispatcher on telemetry errors */ }

    // Atomically claim next index from the shared counter. Refs update
    // synchronously, so even if shadow's effect fires in the same tick
    // they can't both grab the same index.
    const nextIdx = nextDispatchIndexRef.current;
    if (nextIdx >= successionQueue.length) {
      // No more companies to dispatch — primary slot goes idle.
      // Sentinel: -1 marks the slot as exhausted.
      setSuccessionIndex(-1);
      return;
    }
    nextDispatchIndexRef.current = nextIdx + 1;

    const next = successionQueue[nextIdx];
    setQuery(next.companyName);
    setCompanyUrl(next.companyUrl);
    setSuccessionIndex(nextIdx);
    successionTriggerRef.current = true;
  }, [activeStatus, successionIndex, successionQueue, activeSessionId, verifyEnrichment, isRunStrictlyComplete]);

  // Shadow slot advance — symmetric to primary. Fires when shadowStatus
  // transitions to done/error. Records, claims next, re-starts via
  // beginImportShadow.
  useEffect(() => {
    if (successionShadowIndex < 0) return;
    // Phase 2.18.A2 — same strict completion gate as primary.
    const shadowDone =
      shadowStatus === "error" ||
      (shadowStatus === "done" && isRunStrictlyComplete(shadowSessionId));
    if (!shadowDone) return;

    if (lastProcessedShadowIndexRef.current === successionShadowIndex) return;
    const completedIndex = successionShadowIndex;
    lastProcessedShadowIndexRef.current = completedIndex;

    setSuccessionResults((prev) => [...prev, {
      index: completedIndex,
      status: shadowStatus === "done" ? "done" : "error",
      sessionId: shadowSessionId,
    }]);
    verifyEnrichment(shadowSessionId);

    // Phase 2.19.8 — same import-complete event as primary slot.
    try {
      window.dispatchEvent(new CustomEvent("tabarnam:import-complete", {
        detail: { sessionId: shadowSessionId, status: shadowStatus === "done" ? "done" : "error", slot: "shadow" },
      }));
    } catch { /* ignore in non-browser env */ }

    // Phase 3.5 — clear active-imports state for the shadow slot's session.
    try {
      const completedRun = runs.find((r) => asString(r?.session_id).trim() === asString(shadowSessionId).trim());
      const completedVerifiedId = Array.isArray(completedRun?.saved_company_ids_verified) && completedRun.saved_company_ids_verified.length > 0
        ? asString(completedRun.saved_company_ids_verified[0]).trim()
        : "";
      markImportInactive({ session_id: shadowSessionId, company_id: completedVerifiedId });
    } catch { /* never break the dispatcher on telemetry errors */ }

    // Reset shadow state before re-starting
    stopShadowPolling();
    setShadowSessionId(null);

    const nextIdx = nextDispatchIndexRef.current;
    if (nextIdx >= successionQueue.length) {
      // Queue exhausted — shadow slot goes idle.
      setSuccessionShadowIndex(-1);
      setShadowStatus("idle");
      return;
    }
    nextDispatchIndexRef.current = nextIdx + 1;

    const next = successionQueue[nextIdx];
    setSuccessionShadowIndex(nextIdx);
    setShadowStatus("idle"); // briefly idle to allow next status flip
    setTimeout(() => beginImportShadow(next.companyName, next.companyUrl), 1000);
  }, [shadowStatus, successionShadowIndex, successionQueue, shadowSessionId, beginImportShadow, stopShadowPolling, verifyEnrichment, isRunStrictlyComplete]);

  // Phase 4.9 — slot-startedAt tracker. When a slot transitions to "running"
  // OR its session id changes while still "running", record Date.now() so
  // the watchdog can compare elapsed time against the timeout threshold.
  // Cleared when slot transitions to a terminal state (done/error/idle).
  useEffect(() => {
    if (activeStatus === "running") {
      primarySlotStartedAtRef.current = Date.now();
    } else {
      primarySlotStartedAtRef.current = null;
    }
  }, [activeStatus, activeSessionId]);

  useEffect(() => {
    if (shadowStatus === "running") {
      shadowSlotStartedAtRef.current = Date.now();
    } else {
      shadowSlotStartedAtRef.current = null;
    }
  }, [shadowStatus, shadowSessionId]);

  // Phase 4.9 — watchdog. Polls every 30s. Forces error state on any slot
  // that has been "running" longer than the configured timeout. The
  // existing slot-advance dispatcher effect picks up the error and
  // claims the next company from the queue. Net effect: a stuck slot
  // unblocks the batch within ~30s of crossing the timeout threshold.
  useEffect(() => {
    const rawTimeout = Number(import.meta.env?.VITE_BULK_DISPATCH_TIMEOUT_MS);
    const TIMEOUT_MS = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 300_000; // 5 min default
    // VITE_BULK_DISPATCH_TIMEOUT_MS=0 disables the watchdog (debug only)
    if (rawTimeout === 0) return;

    const interval = setInterval(() => {
      const now = Date.now();

      // Primary slot timeout
      if (activeStatus === "running" && primarySlotStartedAtRef.current) {
        const elapsed = now - primarySlotStartedAtRef.current;
        if (elapsed > TIMEOUT_MS) {
          // eslint-disable-next-line no-console
          console.warn("[bulk-dispatcher] Phase 4.9 — primary slot timeout, forcing error to unblock batch", {
            session_id: activeSessionId,
            elapsed_ms: elapsed,
            timeout_ms: TIMEOUT_MS,
          });
          const sid = activeSessionId;
          setRuns((prev) =>
            prev.map((r) =>
              asString(r?.session_id).trim() === asString(sid).trim()
                ? {
                    ...r,
                    timedOut: true,
                    start_error: r.start_error || "dispatcher_timeout",
                    start_error_details: r.start_error_details || {
                      phase: "4.9",
                      reason: "dispatcher_timeout",
                      elapsed_ms: elapsed,
                      timeout_ms: TIMEOUT_MS,
                      slot: "primary",
                    },
                  }
                : r
            )
          );
          setActiveStatus("error");
          primarySlotStartedAtRef.current = null;
          // Abort any in-flight start request for this slot
          startFetchAbortRef.current?.abort?.();
        }
      }

      // Shadow slot timeout
      if (shadowStatus === "running" && shadowSlotStartedAtRef.current) {
        const elapsed = now - shadowSlotStartedAtRef.current;
        if (elapsed > TIMEOUT_MS) {
          // eslint-disable-next-line no-console
          console.warn("[bulk-dispatcher] Phase 4.9 — shadow slot timeout, forcing error to unblock batch", {
            session_id: shadowSessionId,
            elapsed_ms: elapsed,
            timeout_ms: TIMEOUT_MS,
          });
          const sid = shadowSessionId;
          setRuns((prev) =>
            prev.map((r) =>
              asString(r?.session_id).trim() === asString(sid).trim()
                ? {
                    ...r,
                    timedOut: true,
                    start_error: r.start_error || "dispatcher_timeout",
                    start_error_details: r.start_error_details || {
                      phase: "4.9",
                      reason: "dispatcher_timeout",
                      elapsed_ms: elapsed,
                      timeout_ms: TIMEOUT_MS,
                      slot: "shadow",
                    },
                  }
                : r
            )
          );
          setShadowStatus("error");
          shadowSlotStartedAtRef.current = null;
          shadowAbortRef.current?.abort?.();
        }
      }
    }, 30_000); // check every 30s

    return () => clearInterval(interval);
  }, [activeStatus, shadowStatus, activeSessionId, shadowSessionId]);

  // Completion detector — fires the success toast once when both slots
  // have idled (sentinel -1) and the queue is exhausted. Decoupled from
  // either slot's advance effect so the toast doesn't double-fire.
  //
  // Phase 4.13 — relaxed the result-accounting gate. Pre-4.13 required
  // `successionResults.length === successionQueue.length` (i.e. every
  // queued company has a recorded result). Empirical (2026-05-15, 128-
  // company batch): the batch completed all the canonical work, both
  // slots reached idle, queue was exhausted, but 10 companies were lost
  // between dispatch and final_state (3 never dispatched + 7 lost in
  // flight). Those 10 never pushed to successionResults, so the gate
  // returned early and the toast never fired. UI hung at "Importing 56
  // of 128 companies" indefinitely until the user reloaded the page.
  //
  // Both-slots-idle AND queue-exhausted IS terminal regardless of
  // accounting completeness — the work is finished. Surface unaccounted
  // count in the toast so admins can see if any imports vanished.
  // Phase 4.9's watchdog already converts most stuck slots into recorded
  // errors; this fix handles the residual cases where the result never
  // got pushed.
  const successionToastFiredRef = useRef(false);
  useEffect(() => {
    if (successionIndex >= 0) return;             // primary still running
    if (successionShadowIndex >= 0) return;        // shadow still running
    if (successionResults.length === 0) return;    // nothing started yet
    if (successionToastFiredRef.current) return;   // already toasted
    if (nextDispatchIndexRef.current < successionQueue.length) return; // still queued
    // Phase 4.13: removed `successionResults.length < successionQueue.length`
    // gate. Both slots idle + queue exhausted is sufficient.
    successionToastFiredRef.current = true;
    const completedCount = successionResults.length;
    const queueLength = successionQueue.length;
    const unaccountedCount = Math.max(0, queueLength - completedCount);
    const errorCount = successionResults.filter((r) => r?.status === "error").length;
    const doneCount = successionResults.filter((r) => r?.status === "done").length;
    if (unaccountedCount > 0) {
      // Some companies finished work without producing a recorded result
      // (lost between dispatch and final_state). Surface the gap so the
      // user knows the batch terminated but some imports may need manual
      // attention.
      toast.warning(
        `Succession import complete: ${doneCount} done${errorCount > 0 ? `, ${errorCount} error` : ""}, ${unaccountedCount} unaccounted (of ${queueLength} queued)`,
        { duration: 12000 }, // longer dwell so admins notice the unaccounted count
      );
    } else if (errorCount > 0) {
      toast.success(
        `Succession import complete: ${doneCount} done, ${errorCount} error (of ${queueLength} queued)`,
      );
    } else {
      toast.success(`Succession import complete: ${completedCount} imports processed`);
    }
  }, [successionIndex, successionShadowIndex, successionResults, successionQueue.length]);

  // Reset toast-fired flag when a new succession kicks off (so the next
  // batch can fire its own completion toast).
  useEffect(() => {
    if (successionIndex === 0 && successionResults.length === 0) {
      successionToastFiredRef.current = false;
    }
  }, [successionIndex, successionResults.length]);

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
    setBulkEnqueueLoading(true);
    try {
      const res = await fetch(`${API_BASE}/bulk-import/enqueue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          urls,
          fields_to_enrich: enrichFields.length < ALL_ENRICH_FIELD_KEYS.length ? enrichFields : undefined,
        }),
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

  // Poll for batch status with exponential backoff (5s → 10s → 20s → 30s cap)
  useEffect(() => {
    if (!activeBatchId) return;
    let cancelled = false;
    let timer = null;

    const pollBatchStatus = async () => {
      try {
        const res = await fetch(`${API_BASE}/bulk-import/status?batch_id=${activeBatchId}`);
        const data = await res.json();
        if (data.ok && data.jobs) {
          setBatchJobs(data.jobs);
          if (data.summary?.queued === 0 && data.summary?.running === 0) {
            return true; // Done polling
          }
        }
      } catch (err) {
        console.warn("[bulk-import] Failed to fetch batch status:", err);
      }
      return false;
    };

    const BATCH_POLL_INITIAL_MS = 5_000;
    const BATCH_POLL_MAX_MS = 30_000;
    const BATCH_POLL_FACTOR = 1.5;

    const scheduleNext = (delayMs) => {
      if (cancelled) return;
      timer = setTimeout(async () => {
        if (cancelled) return;
        const done = await pollBatchStatus();
        if (!done && !cancelled) {
          scheduleNext(Math.min(delayMs * BATCH_POLL_FACTOR, BATCH_POLL_MAX_MS));
        }
      }, delayMs);
    };

    // Initial poll, then start backoff
    pollBatchStatus().then((done) => {
      if (!done && !cancelled) scheduleNext(BATCH_POLL_INITIAL_MS);
    });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
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
            lastPlayed={lastPlayed}
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
                <div className="flex gap-2">
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
                    className="w-20"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="whitespace-nowrap text-xs"
                    disabled={isSuccessionRunning}
                    onClick={() => setSpreadsheetPasteOpen((v) => !v)}
                  >
                    {spreadsheetPasteOpen ? "Cancel paste" : "Paste from spreadsheet"}
                  </Button>
                </div>
              </div>
            </div>

            {spreadsheetPasteOpen ? (
              <div className="rounded border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30 p-4 space-y-3">
                <div className="text-sm text-slate-700 dark:text-muted-foreground">
                  Paste rows from your spreadsheet (<span className="font-medium">Company Name</span> &rarr; <span className="font-medium">URL</span>, tab-separated).
                </div>
                <textarea
                  value={spreadsheetPasteText}
                  onChange={(e) => setSpreadsheetPasteText(e.target.value)}
                  placeholder={"Faribault Mill\tfaribaultmill.com\nAmana Woolen Mill\tamanawoolenmill.com\nBerkshire Blanket\tberkshireblanket.com"}
                  className="w-full h-36 rounded border border-slate-300 dark:border-border bg-white dark:bg-card px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autoFocus
                />
                <div className="flex items-center justify-between">
                  <div className="text-xs text-slate-500 dark:text-muted-foreground">
                    {spreadsheetPasteRowCount} row{spreadsheetPasteRowCount !== 1 ? "s" : ""} detected
                    {spreadsheetPasteRowCount > SUCCESSION_MAX ? ` (will truncate to ${SUCCESSION_MAX})` : ""}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => { setSpreadsheetPasteOpen(false); setSpreadsheetPasteText(""); }}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={spreadsheetPasteRowCount === 0}
                      onClick={() => handleSpreadsheetPaste(spreadsheetPasteText)}
                    >
                      Import {spreadsheetPasteRowCount} row{spreadsheetPasteRowCount !== 1 ? "s" : ""}
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}

            {successionCount > 1 ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium text-slate-700 dark:text-muted-foreground">Import queue ({successionCount} companies)</div>
                  <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-muted-foreground select-none">
                    <input
                      type="checkbox"
                      checked={preflightEnabled}
                      onChange={(e) => setPreflightEnabled(e.target.checked)}
                      className="rounded"
                    />
                    Check for duplicates
                    {preflightLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                  </label>
                </div>
                {preflightError ? (
                  <div className="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-2 text-xs text-red-800 dark:text-red-300">
                    <AlertTriangle className="h-3 w-3 inline mr-1" />
                    Preflight check failed: {preflightError}
                  </div>
                ) : null}
                {successionRows.map((row, i) => {
                  const pfResult = preflightResults?.find((r) => r.index === i) || null;
                  // Phase 4.18 — once a row has been imported by THIS session,
                  // show "Imported ✓" instead of the dup-check status. After
                  // import completes, the company exists in Cosmos so the
                  // dup-check correctly returns "exact_match" — but that
                  // looks like a warning when it's actually a success.
                  // Override only when the row finished cleanly in this
                  // session (status === "done"); errored rows keep their
                  // dup-check context visible so the admin sees what hit.
                  const completedInSession = successionResults.some(
                    (r) => r.index === i && r.status === "done"
                  );
                  return (
                    <div key={i} className="grid grid-cols-[2rem_2fr_1fr_auto] gap-2 items-end">
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
                      <div className="flex items-end pb-0.5 min-w-[140px]">
                        {completedInSession ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 dark:bg-emerald-900/30 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400 whitespace-nowrap">
                            <Check className="h-3 w-3" />
                            Imported
                          </span>
                        ) : pfResult ? (
                          pfResult.status === "no_match" ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 dark:bg-emerald-900/30 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400 whitespace-nowrap">
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                              Clear
                            </span>
                          ) : pfResult.status === "exact_match" ? (
                            <div className="flex flex-col gap-0.5 min-w-0">
                              <span className="inline-flex items-center gap-1 rounded-full bg-red-100 dark:bg-red-900/30 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-400 whitespace-nowrap">
                                <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
                                Exact match
                              </span>
                              <a
                                href={`/admin?company_id=${encodeURIComponent(pfResult.match?.id || "")}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-blue-600 dark:text-blue-400 hover:underline truncate max-w-[160px]"
                                title={pfResult.match?.company_name}
                              >
                                {pfResult.match?.company_name || pfResult.match?.normalized_domain || "View"}
                              </a>
                              <button
                                type="button"
                                className="text-xs text-red-600 dark:text-red-400 hover:underline text-left"
                                onClick={() => removeSuccessionRow(i)}
                              >
                                Remove
                              </button>
                            </div>
                          ) : pfResult.status === "fuzzy_match" ? (
                            <div className="flex flex-col gap-0.5 min-w-0">
                              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 dark:bg-amber-900/30 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400 whitespace-nowrap">
                                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                                Possible match
                              </span>
                              <a
                                href={`/admin?company_id=${encodeURIComponent(pfResult.match?.id || "")}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-blue-600 dark:text-blue-400 hover:underline truncate max-w-[160px]"
                                title={pfResult.match?.company_name}
                              >
                                {pfResult.match?.company_name || pfResult.match?.normalized_domain || "View"}
                              </a>
                              <span className="text-xs opacity-50">
                                via {pfResult.match?.match_type === "fuzzy_name" ? "name similarity" : pfResult.match?.match_type === "domain_substring" ? "domain" : pfResult.match?.match_type || "match"}
                              </span>
                              <button
                                type="button"
                                className="text-xs text-red-600 dark:text-red-400 hover:underline text-left"
                                onClick={() => removeSuccessionRow(i)}
                              >
                                Remove
                              </button>
                            </div>
                          ) : null
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}

            {/* Single-entry preflight result */}
            {successionCount <= 1 && preflightEnabled ? (
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-muted-foreground select-none">
                  <input
                    type="checkbox"
                    checked={preflightEnabled}
                    onChange={(e) => setPreflightEnabled(e.target.checked)}
                    className="rounded"
                  />
                  Check for duplicates
                  {preflightLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                </label>
                {preflightError ? (
                  <div className="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-2 text-xs text-red-800 dark:text-red-300">
                    <AlertTriangle className="h-3 w-3 inline mr-1" />
                    Preflight check failed: {preflightError}
                  </div>
                ) : null}
                {preflightResults && preflightResults.length > 0 ? (() => {
                  const r = preflightResults[0];
                  if (r.status === "no_match") {
                    return (
                      <div className="rounded-lg border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 p-3 text-sm text-emerald-800 dark:text-emerald-300">
                        No existing match found — safe to import.
                      </div>
                    );
                  }
                  if (r.status === "exact_match") {
                    return (
                      <div className="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-800 dark:text-red-300">
                        Exact match found:{" "}
                        <a
                          href={`/admin?company_id=${encodeURIComponent(r.match?.id || "")}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium underline"
                        >
                          {r.match?.company_name || r.match?.normalized_domain || "View"}
                        </a>
                        {" "}(matched by {r.match?.match_type || "unknown"})
                      </div>
                    );
                  }
                  if (r.status === "fuzzy_match") {
                    return (
                      <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-800 dark:text-amber-300">
                        Possible match found:{" "}
                        <a
                          href={`/admin?company_id=${encodeURIComponent(r.match?.id || "")}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium underline"
                        >
                          {r.match?.company_name || r.match?.normalized_domain || "View"}
                        </a>
                        {" "}(via {r.match?.match_type === "fuzzy_name" ? "name similarity" : r.match?.match_type === "domain_substring" ? "domain" : r.match?.match_type || "match"})
                      </div>
                    );
                  }
                  return null;
                })() : null}
              </div>
            ) : successionCount <= 1 && !preflightEnabled ? (
              <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-muted-foreground select-none">
                <input
                  type="checkbox"
                  checked={preflightEnabled}
                  onChange={(e) => setPreflightEnabled(e.target.checked)}
                  className="rounded"
                />
                Check for duplicates
              </label>
            ) : null}

            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700 dark:text-muted-foreground">Query types</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {[
                  { key: "product_keyword", label: "Product" },
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

            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700 dark:text-muted-foreground">Fields to enrich</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {ENRICH_FIELDS_OPTIONS.map((opt) => {
                  const costColor =
                    opt.cost === "highest" ? "text-red-500" :
                    opt.cost === "high" ? "text-orange-500" :
                    opt.cost === "medium" ? "text-yellow-500" :
                    "text-emerald-500";
                  const costDots =
                    opt.cost === "highest" ? 4 :
                    opt.cost === "high" ? 3 :
                    opt.cost === "medium" ? 2 : 1;
                  return (
                    <label
                      key={opt.key}
                      className="flex items-center gap-2 rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted px-3 py-2 text-sm text-slate-800 dark:text-foreground"
                    >
                      <input
                        type="checkbox"
                        checked={enrichFields.includes(opt.key)}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setEnrichFields((prev) => {
                            const list = Array.isArray(prev) ? prev : [];
                            if (checked) return Array.from(new Set([...list, opt.key]));
                            const next = list.filter((v) => v !== opt.key);
                            return next.length > 0 ? next : [opt.key]; // prevent empty
                          });
                        }}
                      />
                      <span className="flex-1">{opt.label}</span>
                      <span className={`${costColor} text-xs leading-none`} title={`xAI cost: ${opt.cost}`}>
                        {"●".repeat(costDots)}
                      </span>
                    </label>
                  );
                })}
              </div>
              <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-muted-foreground">
                <button
                  type="button"
                  className="underline hover:text-slate-700 dark:hover:text-foreground"
                  onClick={() => {
                    const allSelected = ALL_ENRICH_FIELD_KEYS.every((k) => enrichFields.includes(k));
                    setEnrichFields(allSelected ? [] : [...ALL_ENRICH_FIELD_KEYS]);
                  }}
                >
                  {ALL_ENRICH_FIELD_KEYS.every((k) => enrichFields.includes(k)) ? "Deselect all" : "Select all"}
                </button>
                <span className="ml-auto flex items-center gap-1.5">
                  <span className="text-emerald-500">●</span>low
                  <span className="text-yellow-500">●●</span>med
                  <span className="text-orange-500">●●●</span>high
                  <span className="text-red-500">●●●●</span>highest
                </span>
              </div>
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

            {showSuccessionPanel ? (
              <div
                className={`rounded-lg border px-4 py-3 space-y-3 ${
                  isSuccessionRunning
                    ? "border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30"
                    : "border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30"
                }`}
              >
                {/* Header */}
                <div className="flex items-center justify-between">
                  <div
                    className={`text-sm font-semibold ${
                      isSuccessionRunning ? "text-blue-900 dark:text-blue-200" : "text-emerald-900 dark:text-emerald-200"
                    }`}
                  >
                    {isSuccessionRunning
                      ? (() => {
                          // Phase 3.5.1 — header text reflects BOTH slots so
                          // the user can see when the primary has advanced
                          // but the shadow is still finishing a long-running
                          // company. Use the lowest active index in either
                          // slot for the "Importing X" position.
                          const completedCount = successionResults.length;
                          const totalCount = successionQueue.length;

                          // Both slots active and pointing at different indices.
                          if (isPrimaryRunning && isShadowRunning && successionIndex !== successionShadowIndex && successionShadowIndex >= 0) {
                            const lo = Math.min(successionIndex, successionShadowIndex) + 1;
                            const hi = Math.max(successionIndex, successionShadowIndex) + 1;
                            return `Importing ${lo}-${hi} of ${totalCount} companies`;
                          }

                          // Primary still running.
                          if (isPrimaryRunning) {
                            return `Importing ${successionIndex + 1} of ${totalCount} companies`;
                          }

                          // Only shadow still running — primary already advanced
                          // off the end. Show "Finishing X of N" to make it
                          // clear that work continues even though the queue is
                          // out of new dispatches.
                          if (isShadowRunning) {
                            const idx = successionShadowIndex >= 0 ? successionShadowIndex + 1 : completedCount + 1;
                            return `Finishing ${idx} of ${totalCount} companies (${completedCount} done)`;
                          }

                          return `Importing ${completedCount + 1} of ${totalCount} companies`;
                        })()
                      : `Succession complete: ${successionResults.length} imports processed`}
                  </div>
                  <div className="flex items-center gap-1">
                    {successionCompleted ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => {
                          const header = "Name\tWebsite\tDate\tStart\tEnd\tTRT";
                          const rows = successionRunDetails
                            .filter((item) => item.status === "done" || item.status === "error")
                            .map((item) => {
                              const date = item.startedAt ? item.startedAt.toLocaleDateString() : "";
                              const start = item.startedAt ? item.startedAt.toLocaleTimeString() : "";
                              const end = item.updatedAt ? item.updatedAt.toLocaleTimeString() : "";
                              return `${item.companyName}\t${item.companyUrl || ""}\t${date}\t${start}\t${end}\t${item.trt || ""}`;
                            });
                          navigator.clipboard.writeText([header, ...rows].join("\n")).then(() => {
                            // Brief visual feedback via button text swap
                            const btn = document.activeElement;
                            if (btn) { const orig = btn.textContent; btn.textContent = "Copied!"; setTimeout(() => { btn.textContent = orig; }, 1500); }
                          }).catch(() => {});
                        }}
                      >
                        Copy table
                      </Button>
                    ) : null}
                    {successionCompleted ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => {
                          setSuccessionResults([]);
                          setSuccessionQueue([]);
                        }}
                      >
                        Dismiss
                      </Button>
                    ) : null}
                  </div>
                </div>

                {/* Progress bar */}
                <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2 overflow-hidden">
                  <div
                    className={`h-2 rounded-full transition-all duration-500 ${
                      isSuccessionRunning ? "bg-blue-500" : "bg-emerald-500"
                    }`}
                    style={{
                      width: `${Math.round(
                        ((successionResults.length + (isSuccessionRunning ? (shadowSessionId ? 1 : 0.5) : 0)) / successionQueue.length) * 100
                      )}%`,
                    }}
                  />
                </div>

                {/* Per-company list */}
                <div className="space-y-1">
                  {successionRunDetails.map((item) => (
                    <div
                      key={item.index}
                      className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm ${
                        item.status === "running"
                          ? "bg-blue-100 dark:bg-blue-900/30"
                          : item.status === "waiting_for_xai"
                            ? "bg-amber-50 dark:bg-amber-900/20"
                            : item.status === "done"
                              ? "bg-white/60 dark:bg-white/5"
                              : item.status === "error"
                                ? "bg-red-50 dark:bg-red-900/20"
                                : "opacity-50"
                      }`}
                    >
                      {/* Status icon */}
                      <div className="shrink-0 w-5 text-center">
                        {item.status === "done" ? (
                          <span className="text-emerald-600 dark:text-emerald-400">&#10003;</span>
                        ) : item.status === "error" ? (
                          <span
                            className="text-red-600 dark:text-red-400"
                            title={(() => {
                              // Phase 4.9 — surface the error reason in a tooltip
                              // so admins can distinguish dispatcher_timeout from
                              // start_request_failed / other transport errors.
                              const reason = item.startError || item.startErrorDetails?.reason || "";
                              if (reason === "dispatcher_timeout") {
                                const elapsedSec = Math.round((item.startErrorDetails?.elapsed_ms || 0) / 1000);
                                const timeoutSec = Math.round((item.startErrorDetails?.timeout_ms || 0) / 1000);
                                return `Import failed: dispatcher timed out (running ${elapsedSec}s, cap ${timeoutSec}s)`;
                              }
                              return reason ? `Import failed: ${reason}` : "Import failed";
                            })()}
                          >&#10007;</span>
                        ) : item.status === "running" ? (
                          <Loader2 className="inline h-3.5 w-3.5 animate-spin text-blue-600 dark:text-blue-400" />
                        ) : item.status === "waiting_for_xai" ? (
                          // Phase 3.8.2 — throbbing Tabarnam logo replaces
                          // the U+23F3 hourglass for waiting rows. Same
                          // semantic (not actively talking to xAI yet) but
                          // visually distinguishable from the active row's
                          // blue spinner and clearly different from a
                          // static "pending" bullet.
                          <img
                            src="/pwa/icon-192.png"
                            alt="Waiting for xAI lock"
                            title="Queued · waiting for xAI"
                            className="inline h-3.5 w-3.5 phase-3-8-2-throb"
                          />
                        ) : (
                          <span className="text-slate-400 dark:text-slate-500">&#8226;</span>
                        )}
                      </div>

                      {/* Company name + URL + timing */}
                      <div className="flex-1 min-w-0 truncate">
                        <span
                          className={`font-medium ${
                            item.status === "running"
                              ? "text-blue-900 dark:text-blue-200"
                              : item.status === "waiting_for_xai"
                                ? "text-amber-900 dark:text-amber-200"
                                : item.status === "error"
                                  ? "text-red-800 dark:text-red-300"
                                  : "text-slate-800 dark:text-foreground"
                          }`}
                        >
                          {item.companyName}
                        </span>
                        {item.status === "waiting_for_xai" && item.xaiLockWaitMs != null ? (
                          <span className="ml-2 text-xs text-amber-700 dark:text-amber-400">
                            Queued · waiting for xAI ({Math.round(item.xaiLockWaitMs / 1000)}s)
                          </span>
                        ) : null}
                        {item.companyUrl ? (
                          <span className="ml-2 text-xs text-slate-500 dark:text-muted-foreground">
                            {item.companyUrl}
                          </span>
                        ) : null}
                        {item.startedAt && item.updatedAt && item.trt ? (
                          <span className="ml-3 text-xs text-slate-400 dark:text-muted-foreground">
                            {item.startedAt.toLocaleDateString()}{" "}
                            {item.startedAt.toLocaleTimeString()}
                            {" \u2192 "}
                            {item.updatedAt.toLocaleTimeString()}
                            <span
                              className="ml-1.5 font-mono text-emerald-600 dark:text-emerald-400"
                              title={(() => {
                                // Phase 3.5.2 \u2014 tooltip shows what the TRT is
                                // measuring + lock-wait context when present.
                                if (item.trtSource === "canonical") {
                                  const lockSec = Number.isFinite(item.lockWaitMs) && item.lockWaitMs > 0
                                    ? Math.round(item.lockWaitMs / 1000)
                                    : 0;
                                  if (lockSec > 0) {
                                    const m = Math.floor(lockSec / 60);
                                    const s = lockSec % 60;
                                    return `xAI canonical call duration. Also waited ${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")} for the xAI lock before this call started.`;
                                  }
                                  return "xAI canonical call duration (from start of runCanonicalImportCall to end).";
                                }
                                if (item.trtSource === "session") {
                                  return "Backend session elapsed (includes lock-wait + canonical + post-processing).";
                                }
                                return "Wall-clock from import-start to last status update.";
                              })()}
                            >
                              TRT: {item.trt}
                              {item.trtSource === "canonical" && Number.isFinite(item.lockWaitMs) && item.lockWaitMs >= 5000 ? (
                                <span className="ml-1 text-amber-600 dark:text-amber-400">
                                  {" "}(+{Math.floor(item.lockWaitMs / 60000)}:{String(Math.floor((item.lockWaitMs % 60000) / 1000)).padStart(2, "0")} lock-wait)
                                </span>
                              ) : null}
                            </span>
                          </span>
                        ) : null}
                      </div>

                      {/* Session link */}
                      {item.sessionId ? (
                        <button
                          type="button"
                          className="shrink-0 text-xs text-blue-700 dark:text-blue-400 hover:underline"
                          onClick={() => setActiveSessionId(item.sessionId)}
                        >
                          View session
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-700 dark:text-muted-foreground">Batch industries</label>
                <input
                  type="text"
                  placeholder="e.g. Spices, Seasonings"
                  value={batchIndustries}
                  onChange={(e) => setBatchIndustries(e.target.value)}
                  className="w-full rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted px-3 py-1.5 text-sm text-slate-800 dark:text-foreground placeholder:text-slate-400 dark:placeholder:text-muted-foreground"
                />
                <div className="text-xs text-slate-500 dark:text-muted-foreground">Applied to all companies in this batch (comma-separated)</div>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-700 dark:text-muted-foreground">Batch products</label>
                <input
                  type="text"
                  placeholder="e.g. chili powder, cumin, paprika"
                  value={batchKeywords}
                  onChange={(e) => setBatchKeywords(e.target.value)}
                  className="w-full rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted px-3 py-1.5 text-sm text-slate-800 dark:text-foreground placeholder:text-slate-400 dark:placeholder:text-muted-foreground"
                />
                <div className="text-xs text-slate-500 dark:text-muted-foreground">Added to all companies in this batch (comma-separated)</div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button type="button" onClick={handleStartSuccession} disabled={startImportDisabled || isSuccessionRunning || applyingBatchFields}>
                <Play className="h-4 w-4 mr-2" />
                {isSuccessionRunning
                  ? `Running ${successionIndex + 1}/${successionQueue.length}…`
                  : activeStatus === "running"
                    ? "Running…"
                    : successionCount > 1
                      ? `Start ${successionCount} imports`
                      : "Start import"}
              </Button>

              <div className="flex-1" />

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

              <div className="flex-1" />

              <Button
                type="button"
                variant="outline"
                onClick={applyBatchFields}
                disabled={applyingBatchFields || (!batchIndustries.trim() && !batchKeywords.trim())}
                className="border-teal-600 text-teal-400 hover:bg-teal-900/30 hover:text-teal-300"
              >
                {applyingBatchFields ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Applying…
                  </>
                ) : (
                  <>
                    <Tags className="h-4 w-4 mr-2" />
                    Apply Industries/Products
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
          <details className="group">
            <summary className="cursor-pointer text-sm font-medium text-slate-700 dark:text-muted-foreground hover:text-slate-900 dark:hover:text-foreground transition-colors py-2">
              Import report
            </summary>
            <ImportReportSection
              activeRun={activeRun}
              activeReportPayload={activeReportPayload}
              activeReportText={activeReportText}
              activeDebugText={activeDebugText}
              importReportRef={importReportRef}
            />
          </details>
        </main>
      </div>

      {/* Duplicate confirmation dialog */}
      <AlertDialog open={duplicateDialogOpen} onOpenChange={setDuplicateDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Possible Duplicates Detected</AlertDialogTitle>
            <AlertDialogDescription>
              {(() => {
                const exactCount = (preflightResults || []).filter(r => r.status === "exact_match").length;
                const fuzzyCount = (preflightResults || []).filter(r => r.status === "fuzzy_match").length;
                const parts = [];
                if (exactCount > 0) parts.push(`${exactCount} exact match${exactCount > 1 ? "es" : ""}`);
                if (fuzzyCount > 0) parts.push(`${fuzzyCount} possible match${fuzzyCount > 1 ? "es" : ""}`);
                return `Found ${parts.join(" and ")} with existing companies. Review the flagged entries or import anyway.`;
              })()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="destructive"
              onClick={() => setDuplicateDialogOpen(false)}
            >
              Review Dups
            </Button>
            <Button
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
              onClick={handleImportNow}
            >
              Import Now
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
