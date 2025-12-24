import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Play, Square, RefreshCcw, Copy, AlertTriangle, Save } from "lucide-react";

import AdminHeader from "@/components/AdminHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/toast";
import {
  API_BASE,
  FUNCTIONS_BASE,
  apiFetch,
  getLastApiRequestExplain,
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

  const [explainResponseText, setExplainResponseText] = useState("");
  const [explainLoading, setExplainLoading] = useState(false);

  const pollTimerRef = useRef(null);
  const startFetchAbortRef = useRef(null);
  const pollAttemptsRef = useRef(new Map());

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

        if (!res.ok || (body && typeof body === "object" && body.ok === false)) {
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
        const saved = Number(body?.saved ?? body?.count ?? items.length ?? 0);

        const status = asString(body?.status).trim();
        const jobState = asString(body?.job_state || body?.primary_job_state || body?.primary_job?.job_state).trim();
        const stageBeacon = asString(body?.stage_beacon).trim();
        const lastError = body?.last_error || null;

        const completed = state === "complete" ? true : Boolean(body?.completed);
        const timedOut = Boolean(body?.timedOut);
        const stopped = state === "failed" || state === "complete" ? true : Boolean(body?.stopped);

        const isTerminalError = state === "failed" || status === "error" || jobState === "error";
        const isTerminalComplete = state === "complete" || status === "complete" || jobState === "complete" || completed;

        const lastErrorCode = asString(lastError?.code).trim();
        const userFacingError =
          lastErrorCode === "primary_timeout"
            ? "Primary import timed out (120s hard cap)."
            : lastErrorCode === "no_candidates_found"
              ? "No candidates found after 60s."
              : asString(lastError?.message).trim() || "Import failed.";

        setRuns((prev) =>
          prev.map((r) => {
            if (r.session_id !== session_id) return r;
            return {
              ...r,
              items: mergeById(r.items, items),
              lastCreatedAt: asString(body?.lastCreatedAt || r.lastCreatedAt),
              saved: Number.isFinite(saved) ? saved : Number(r.saved ?? 0) || 0,
              completed: isTerminalComplete,
              timedOut,
              stopped: isTerminalError || isTerminalComplete ? true : stopped,
              stage_beacon: stageBeacon || asString(r.stage_beacon),
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
              progress_error: isTerminalError ? userFacingError : r.progress_error,
              updatedAt: new Date().toISOString(),
            };
          })
        );

        if (isTerminalError) return { shouldStop: true, body };
        if (isTerminalComplete) return { shouldStop: true, body };
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

  const schedulePoll = useCallback(
    ({ session_id }) => {
      stopPolling();
      setPollingSessionId(asString(session_id).trim());
      pollTimerRef.current = setTimeout(async () => {
        const prevAttempts = pollAttemptsRef.current.get(session_id) || 0;
        const nextAttempts = prevAttempts + 1;
        pollAttemptsRef.current.set(session_id, nextAttempts);

        if (nextAttempts > POLL_MAX_ATTEMPTS) {
          const msg = `Polling stopped after ${POLL_MAX_ATTEMPTS} attempts.`;
          toast.error(msg);
          setRuns((prev) => prev.map((r) => (r.session_id === session_id ? { ...r, progress_error: msg } : r)));
          return;
        }

        const { shouldStop } = await pollProgress({ session_id });
        if (shouldStop) return;
        schedulePoll({ session_id });
      }, 2500);
    },
    [pollProgress, stopPolling]
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
    const bestEffort = runMode === "best_effort";

    const session_id = (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`);

    const normalizedLimit = normalizeImportLimit(limitInput);

    const selectedTypes = Array.isArray(queryTypes) && queryTypes.length > 0 ? queryTypes : ["product_keyword"];

    const newRun = {
      session_id,
      query: q,
      queryTypes: selectedTypes,
      location: asString(location).trim() || "",
      limit: normalizedLimit,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      items: [],
      saved: 0,
      completed: false,
      timedOut: false,
      stopped: false,
      stage_beacon: "",
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
      save_result: null,
      save_error: null,
    };

    setRuns((prev) => [newRun, ...prev]);
    setActiveSessionId(session_id);
    setActiveStatus("running");

    startFetchAbortRef.current?.abort?.();
    const abort = new AbortController();
    startFetchAbortRef.current = abort;

    try {
      const requestPayload = {
        session_id,
        query: q,
        queryTypes: selectedTypes,
        location: asString(location).trim() || undefined,
        limit: normalizedLimit,
        expand_if_few: true,
      };

      let canonicalSessionId = session_id;
      const syncCanonicalSessionId = (value) => {
        const sid = extractSessionId(value);
        if (sid) {
          canonicalSessionId = sid;
          requestPayload.session_id = sid;
        }
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
            `Import failed (${res.status})`
        );

        const detailsForCopy = {
          status: res.status,
          session_id: canonicalSessionId,
          request_id: requestId,
          request_payload: requestPayload,
          response_body: body,
          api_fetch_error: res && res.__api_fetch_error ? res.__api_fetch_error : null,
          ...(extra && typeof extra === "object" ? extra : {}),
        };

        setRuns((prev) =>
          prev.map((r) =>
            r.session_id === session_id
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
            ? `${msg} (code: ${errorObj.code}${errorObj.step ? `, step: ${errorObj.step}` : ""}${requestId ? `, request_id: ${requestId}` : ""})`
            : msg
        );
      };

      const updateRunCompanies = (companies, extra) => {
        const list = normalizeItems(companies);
        setRuns((prev) =>
          prev.map((r) => {
            if (r.session_id !== session_id) return r;
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

        const { res, usedPath } = await apiFetchWithFallback(paths, {
          method: "POST",
          body: payload,
          signal: abort.signal,
        });

        const body = await readJsonOrText(res);
        return { res, body, usedPath, payload };
      };

      if (bestEffort) {
        const { res, body, usedPath, payload } = await callImportStage({ stage: "", skipStages: [], companies: [] });

        if (!res.ok || body?.ok === false) {
          await recordStartErrorAndToast(res, body, { usedPath, mode: "best_effort" });
          return;
        }

        const finalCompanies = updateRunCompanies(body?.companies, { completed: true });
        setActiveStatus("done");
        toast.success(`Import finished (${finalCompanies.length} companies)`);
        return;
      }

      const stageSequence = ["primary", "keywords", "reviews", "location", "expand"];
      let companiesForNextStage = [];

      const recordStatusFailureAndToast = (body, extra) => {
        const state = asString(body?.state).trim();
        const status = asString(body?.status).trim();
        const reason = asString(body?.reason).trim();
        const stageBeacon = asString(body?.stage_beacon).trim();

        const lastErrorCode = asString(body?.last_error?.code).trim();
        const mappedMsg =
          lastErrorCode === "primary_timeout"
            ? "Primary import timed out (120s hard cap)."
            : lastErrorCode === "no_candidates_found"
              ? "No candidates found after 60s."
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
            r.session_id === session_id
              ? {
                  ...r,
                  start_error: msg,
                  start_error_details: {
                    session_id,
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

          const stageReady =
            completed ||
            jobState === "complete" ||
            primaryJobState === "complete" ||
            items.length > 0 ||
            companiesCount > 0;

          if (stageReady) return { kind: "ready", body };

          await sleep(2500);
        }

        return {
          kind: "failed",
          body: {
            ok: true,
            status: "error",
            state: "failed",
            job_state: "error",
            stage_beacon: stage === "primary" ? "primary_timeout" : `stage_${stage}_timeout`,
            last_error: {
              code: stage === "primary" ? "primary_timeout" : "stage_timeout",
              message:
                stage === "primary" ? "Primary import timed out (120s hard cap)." : `Stage \"${stage}\" did not reach a terminal state.`,
            },
            error: stage === "primary" ? "Primary import timed out (120s hard cap)." : `Stage \"${stage}\" did not reach a terminal state.`,
          },
        };
      };

      for (let stageIndex = 0; stageIndex < stageSequence.length; stageIndex += 1) {
        const stage = stageSequence[stageIndex];
        const skipStages = stageSequence.slice(0, stageIndex);

        if (abort.signal.aborted) {
          const aborted = new Error("Aborted");
          aborted.name = "AbortError";
          throw aborted;
        }

        const { res, body, usedPath, payload } = await callImportStage({
          stage,
          skipStages,
          companies: companiesForNextStage,
        });

        syncCanonicalSessionId(body);

        if (stageIndex === 0) {
          resetPollAttempts(canonicalSessionId);
          schedulePoll({ session_id: canonicalSessionId });
        }

        if (res.status === 202 || body?.accepted === true) {
          const stageBeacon = asString(body?.stage_beacon).trim();
          const isAsyncPrimary =
            body?.reason === "primary_async_enqueued" ||
            stageBeacon.startsWith("primary_") ||
            stageBeacon.startsWith("xai_primary_fetch_");
          const timeoutMsUsed = Number(body?.timeout_ms_used);
          const timeoutMsForUi = Number.isFinite(timeoutMsUsed) && timeoutMsUsed > 0 ? timeoutMsUsed : null;

          setRuns((prev) =>
            prev.map((r) =>
              r.session_id === session_id
                ? {
                    ...r,
                    updatedAt: new Date().toISOString(),
                    start_error: null,
                    async_primary_active: stage === "primary" && isAsyncPrimary,
                    async_primary_timeout_ms: stage === "primary" && isAsyncPrimary ? timeoutMsForUi : r.async_primary_timeout_ms ?? null,
                  }
                : r
            )
          );

          const waitResult = await waitForAsyncStatus({ stage });
          resetPollAttempts(canonicalSessionId);
          schedulePoll({ session_id: canonicalSessionId });

          if (waitResult.kind === "failed") {
            recordStatusFailureAndToast(waitResult.body, { stage, mode: "staged", stage_index: stageIndex });
            return;
          }

          const asyncCompanies = normalizeItems(waitResult.body?.items || waitResult.body?.companies);
          const stageCompanies = updateRunCompanies(asyncCompanies, { async_primary_active: false });
          if (stageCompanies.length > 0) companiesForNextStage = stageCompanies;
          continue;
        }

        if (!res.ok || body?.ok === false) {
          await recordStartErrorAndToast(res, body, {
            usedPath,
            stage,
            mode: "staged",
            stage_index: stageIndex,
            stage_payload: payload,
          });
          return;
        }

        const stageCompanies = updateRunCompanies(body?.companies, { async_primary_active: false });
        if (stageCompanies.length > 0) companiesForNextStage = stageCompanies;
      }

      setRuns((prev) => prev.map((r) => (r.session_id === session_id ? { ...r, completed: true, updatedAt: new Date().toISOString() } : r)));
      setActiveStatus("done");
      toast.success(`Import finished (staged, ${companiesForNextStage.length} companies)`);
    } catch (e) {
      const msg = e?.name === "AbortError" ? "Import aborted" : toErrorString(e) || "Import failed";
      setRuns((prev) => prev.map((r) => (r.session_id === session_id ? { ...r, start_error: msg } : r)));
      if (e?.name === "AbortError") {
        setActiveStatus("idle");
      } else {
        setActiveStatus("error");
        toast.error(msg);
      }
    } finally {
      stopPolling();
    }
  }, [importConfigured, limitInput, location, query, queryTypes, resetPollAttempts, schedulePoll, stopPolling, urlTypeValidationError]);

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
      const { res } = await apiFetchWithFallback(["/import/start?explain=1", "/import-start?explain=1"], {
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
        body: { companies },
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
    };
  }, [stopPolling]);

  const activeItemsCount = activeRun?.items?.length || 0;
  const canSaveActive = Boolean(
    activeRun &&
      (activeRun.completed || activeRun.timedOut || activeRun.stopped) &&
      Array.isArray(activeRun.items) &&
      activeRun.items.length > 0
  );

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

    if (lastErrorCode === "no_candidates_found") return `No candidates found after 60s.${suffix}`;
    if (lastErrorCode === "primary_timeout" || stageBeacon === "primary_timeout") {
      return `Primary import timed out (120s hard cap).${suffix}`;
    }

    if (stageBeacon === "primary_candidate_found") return `Company candidate found. Finalizing…${suffix}`;
    if (stageBeacon === "primary_expanding_candidates") return `Expanding search…${suffix}`;
    if (stageBeacon === "primary_early_exit") return `Match found (single-company import). Finalizing…${suffix}`;
    if (stageBeacon === "primary_complete") return `Finalizing…${suffix}`;

    return `Searching for companies…${suffix}`;
  }, [activeRun]);

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
              <Button onClick={startDebugImport} disabled={debugStartLoading}>
                {debugStartLoading ? "Starting…" : "Start Import"}
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
                <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. running shoes" />
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

            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => beginImport()}
                disabled={!API_BASE || activeStatus === "running" || activeStatus === "stopping"}
              >
                <Play className="h-4 w-4 mr-2" />
                {activeStatus === "running" ? "Running…" : "Start import (staged)"}
              </Button>

              <Button
                variant="outline"
                onClick={() => beginImport({ mode: "best_effort" })}
                disabled={!API_BASE || activeStatus === "running" || activeStatus === "stopping"}
              >
                Run all stages (best effort)
              </Button>

              <Button
                variant="outline"
                onClick={explainImportPayload}
                disabled={!API_BASE || explainLoading}
              >
                Explain payload
              </Button>

              <Button
                variant="outline"
                onClick={() => {
                  if (!activeSessionId) {
                    toast.error("No active session");
                    return;
                  }
                  resetPollAttempts(activeSessionId);
                  schedulePoll({ session_id: activeSessionId });
                  toast.success("Polling refresh started");
                }}
                disabled={!activeSessionId}
              >
                <RefreshCcw className="h-4 w-4 mr-2" />
                Poll now
              </Button>

              <Button
                variant="outline"
                className="border-red-600 text-red-600 hover:bg-red-600 hover:text-white"
                onClick={stopImport}
                disabled={!activeSessionId || activeStatus !== "running"}
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

              {activeSessionId ? (
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
                  Session: <code className="rounded bg-slate-100 px-1 py-0.5">{activeSessionId}</code>
                </div>
              ) : null}

              {activeSummary ? <div className="text-sm text-slate-600">{activeSummary}</div> : null}
            </div>

            {activeAsyncPrimaryMessage ? (
              <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
                {activeAsyncPrimaryMessage}
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
              ) : (
                <div className="mt-4 space-y-2 max-h-[520px] overflow-auto">
                  {(() => {
                    const items = Array.isArray(activeRun?.items) ? activeRun.items.slice() : [];
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
                    const keywords = asString(c?.product_keywords).trim();

                    const issues = [];
                    if (!url) issues.push("missing url");
                    if (!keywords) issues.push("missing keywords");

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

                        {keywords ? (
                          <div className="mt-2 text-xs text-slate-600">{keywords}</div>
                        ) : null}
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
                  runs.map((r) => (
                    <button
                      key={r.session_id}
                      className={`w-full text-left rounded border p-3 transition ${
                        r.session_id === activeSessionId
                          ? "border-slate-900 bg-slate-50"
                          : "border-slate-200 bg-white hover:bg-slate-50"
                      }`}
                      onClick={() => setActiveSessionId(r.session_id)}
                      type="button"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-semibold text-slate-900 truncate">{r.query}</div>
                        <div className="flex items-center gap-2 text-xs text-slate-600">
                          <span>{r.items.length} items</span>
                          {r.save_result?.ok === true ? (
                            <span className="rounded border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-800">
                              saved {Number(r.save_result.saved ?? 0) || 0}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <div className="mt-1 text-xs text-slate-600">
                        <code className="rounded bg-slate-100 px-1 py-0.5">{r.session_id}</code>
                      </div>
                      <div className="mt-1 text-xs text-slate-500">{new Date(r.startedAt).toLocaleString()}</div>
                    </button>
                  ))
                )}
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
        </main>
      </div>
    </>
  );
}
