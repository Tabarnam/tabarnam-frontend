import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Play, Square, RefreshCcw, Copy, AlertTriangle, Save } from "lucide-react";

import AdminHeader from "@/components/AdminHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/toast";
import { apiFetch, getResponseRequestId, getUserFacingConfigMessage, readJsonOrText } from "@/lib/api";

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

  const [importConfigLoading, setImportConfigLoading] = useState(true);
  const [importReady, setImportReady] = useState(true);
  const [importConfigMessage, setImportConfigMessage] = useState("");

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
  const [debugStartResponse, setDebugStartResponse] = useState(null);
  const [debugStatusResponse, setDebugStatusResponse] = useState(null);
  const [debugStartLoading, setDebugStartLoading] = useState(false);
  const [debugStatusLoading, setDebugStatusLoading] = useState(false);

  const pollTimerRef = useRef(null);
  const startFetchAbortRef = useRef(null);

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
      const take = 500;
      try {
        const res = await apiFetch(`/import/status?session_id=${encodeURIComponent(session_id)}&take=${take}`);
        const body = await readJsonOrText(res);

        if (!res.ok) {
          const msg = (await getUserFacingConfigMessage(res)) || body?.error || `Status failed (${res.status})`;
          toast.error(msg);
          setRuns((prev) => prev.map((r) => (r.session_id === session_id ? { ...r, progress_error: msg } : r)));
          return { shouldStop: false };
        }

        const items = normalizeItems(body?.items || body?.companies);
        const completed = Boolean(body?.completed);
        const timedOut = Boolean(body?.timedOut);
        const stopped = Boolean(body?.stopped);
        const saved = Number(body?.saved ?? body?.count ?? items.length ?? 0);

        setRuns((prev) =>
          prev.map((r) => {
            if (r.session_id !== session_id) return r;
            return {
              ...r,
              items: mergeById(r.items, items),
              lastCreatedAt: asString(body?.lastCreatedAt || r.lastCreatedAt),
              saved: Number.isFinite(saved) ? saved : Number(r.saved ?? 0) || 0,
              completed,
              timedOut,
              stopped,
              updatedAt: new Date().toISOString(),
            };
          })
        );

        return { shouldStop: completed || timedOut || stopped };
      } catch (e) {
        setRuns((prev) =>
          prev.map((r) => (r.session_id === session_id ? { ...r, progress_error: e?.message || "Progress failed" } : r))
        );
        return { shouldStop: false };
      }
    },
    []
  );

  const schedulePoll = useCallback(
    ({ session_id }) => {
      stopPolling();
      pollTimerRef.current = setTimeout(async () => {
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
    setDebugStartResponse(null);
    setDebugStatusResponse(null);
    setDebugSessionId("");

    try {
      const res = await apiFetch("/import/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, limit }),
      });

      const body = await readJsonOrText(res);
      setDebugStartResponse(body);

      const sid = typeof body?.session_id === "string" ? body.session_id.trim() : "";
      if (sid) setDebugSessionId(sid);

      if (!res.ok || body?.ok === false) {
        const msg = (await getUserFacingConfigMessage(res)) || body?.error || body?.message || `Import start failed (${res.status})`;
        toast.error(typeof msg === "string" ? msg : "Import start failed");
        return;
      }

      if (!sid) {
        toast.error("Import start response missing session_id");
        return;
      }

      toast.success("Import started");
    } catch (e) {
      toast.error(e?.message || "Import start failed");
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
      const res = await apiFetch(`/import/status?session_id=${encodeURIComponent(sid)}`);
      const body = await readJsonOrText(res);
      setDebugStatusResponse(body);

      if (!res.ok) {
        const msg = (await getUserFacingConfigMessage(res)) || body?.error || body?.message || `Status failed (${res.status})`;
        toast.error(typeof msg === "string" ? msg : "Status failed");
      }
    } catch (e) {
      toast.error(e?.message || "Status failed");
    } finally {
      setDebugStatusLoading(false);
    }
  }, [debugSessionId]);

  const beginImport = useCallback(async () => {
    const q = query.trim();
    if (!q) {
      toast.error("Enter a query to import.");
      return;
    }

    if (urlTypeValidationError) {
      toast.error(urlTypeValidationError);
      return;
    }

    if (!importConfigLoading && !importReady) {
      toast.error(importConfigMessage || "Import is not configured.");
      return;
    }

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

    schedulePoll({ session_id });

    try {
      const requestPayload = {
        session_id,
        query: q,
        queryTypes: selectedTypes,
        location: asString(location).trim() || undefined,
        limit: normalizedLimit,
        expand_if_few: true,
      };

      if (import.meta.env.DEV) {
        // Dev-only: makes malformed payloads obvious while debugging
        console.log("[AdminImport] /import/start payload", requestPayload);
      }

      const res = await apiFetch("/import/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload),
        signal: abort.signal,
      });

      const body = await readJsonOrText(res);

      if (!res.ok || body?.ok === false) {
        const configMsg = await getUserFacingConfigMessage(res);
        const errorObj = body?.error && typeof body.error === "object" ? body.error : null;
        const requestId =
          (errorObj?.request_id && String(errorObj.request_id)) ||
          (body?.request_id && String(body.request_id)) ||
          getResponseRequestId(res) ||
          "";

        const msg =
          configMsg ||
          errorObj?.message ||
          body?.legacy_error ||
          body?.message ||
          (typeof body?.error === "string" ? body.error : "") ||
          `Import failed (${res.status})`;

        const detailsForCopy = {
          status: res.status,
          session_id,
          request_id: requestId,
          request_payload: requestPayload,
          response_body: body,
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
        return;
      }

      const finalCompanies = normalizeItems(body?.companies);
      setRuns((prev) =>
        prev.map((r) => {
          if (r.session_id !== session_id) return r;
          return {
            ...r,
            items: mergeById(r.items, finalCompanies),
            completed: true,
            updatedAt: new Date().toISOString(),
          };
        })
      );

      setActiveStatus("done");
      toast.success(`Import finished (${finalCompanies.length} companies)`);
    } catch (e) {
      const msg = e?.name === "AbortError" ? "Import aborted" : e?.message || "Import failed";
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
  }, [importConfigLoading, importConfigMessage, importReady, limitInput, location, query, queryTypes, schedulePoll, stopPolling, urlTypeValidationError]);

  const stopImport = useCallback(async () => {
    if (!activeSessionId) return;

    setActiveStatus("stopping");
    startFetchAbortRef.current?.abort?.();

    try {
      const res = await apiFetch("/import/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: activeSessionId }),
      });

      const body = await readJsonOrText(res);
      if (!res.ok) {
        const msg = (await getUserFacingConfigMessage(res)) || body?.error || `Stop failed (${res.status})`;
        toast.error(msg);
      } else {
        toast.success("Stop signal sent");
      }
    } catch (e) {
      toast.error(e?.message || "Stop failed");
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companies }),
      });

      const body = await readJsonOrText(res);

      if (!res.ok || body?.ok !== true) {
        const msg = (await getUserFacingConfigMessage(res)) || body?.error || `Save failed (${res.status})`;
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
      const msg = e?.message || "Save failed";
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
        setApiVersion({ ok: false, error: e?.message || "Failed to load version" });
      } finally {
        if (!cancelled) setApiVersionLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setImportConfigLoading(true);
      try {
        const res = await apiFetch("/xadmin-api-bulk-import-config");
        const body = await readJsonOrText(res);

        if (cancelled) return;

        if (!res.ok || body?.ok !== true) {
          const msg = (await getUserFacingConfigMessage(res)) || body?.error || `Config check failed (${res.status})`;
          setImportReady(false);
          setImportConfigMessage(msg);
          return;
        }

        const ready = Boolean(body?.config?.status?.import_ready);
        setImportReady(ready);

        if (!ready) {
          const recs = Array.isArray(body?.config?.recommendations) ? body.config.recommendations : [];
          const critical = recs.find((r) => String(r?.severity || "").toLowerCase() === "critical");
          setImportConfigMessage(
            critical?.message
              ? String(critical.message)
              : "Import is not ready. Configure XAI and Cosmos DB environment variables."
          );
        } else {
          setImportConfigMessage("");
        }
      } catch (e) {
        if (cancelled) return;
        setImportReady(false);
        setImportConfigMessage(e?.message || "Config check failed");
      } finally {
        if (!cancelled) setImportConfigLoading(false);
      }
    })();

    return () => {
      cancelled = true;
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

  const activeSummary = useMemo(() => {
    if (!activeRun) return null;
    const flags = [];
    if (activeRun.completed) flags.push("completed");
    if (activeRun.timedOut) flags.push("timed out");
    if (activeRun.stopped) flags.push("stopped");
    if (activeRun.start_error) flags.push("error");
    return flags.join(" · ");
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
              <div className="text-xs text-slate-500">Calls /api/import/start and /api/import/status directly.</div>
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

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={startDebugImport} disabled={debugStartLoading}>
                {debugStartLoading ? "Starting…" : "Start Import"}
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
              </div>

              <div className="rounded border border-slate-200 bg-slate-50 p-3">
                <div className="text-xs font-medium text-slate-700">Start response</div>
                <pre className="mt-2 max-h-48 overflow-auto rounded bg-white p-2 text-[11px] leading-relaxed text-slate-900">
                  {debugStartResponse ? JSON.stringify(debugStartResponse, null, 2) : "—"}
                </pre>
              </div>
            </div>

            <div className="rounded border border-slate-200 bg-slate-50 p-3">
              <div className="text-xs font-medium text-slate-700">Status response</div>
              <pre className="mt-2 max-h-64 overflow-auto rounded bg-white p-2 text-[11px] leading-relaxed text-slate-900">
                {debugStatusResponse ? JSON.stringify(debugStatusResponse, null, 2) : "—"}
              </pre>
            </div>
          </section>

          {!importConfigLoading && !importReady ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 mt-0.5" />
              <div className="space-y-1">
                <div className="font-semibold">Import is not configured</div>
                <div className="text-amber-900/90">{importConfigMessage || "Configure XAI and Cosmos DB to enable imports."}</div>
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
                onClick={beginImport}
                disabled={
                  importConfigLoading ||
                  !importReady ||
                  activeStatus === "running" ||
                  activeStatus === "stopping"
                }
              >
                <Play className="h-4 w-4 mr-2" />
                {activeStatus === "running" ? "Running…" : "Start import"}
              </Button>

              <Button
                variant="outline"
                onClick={() => {
                  if (!activeSessionId) {
                    toast.error("No active session");
                    return;
                  }
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

            {activeRun?.start_error ? (
              <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-900 space-y-2">
                <div className="font-semibold">Import failed</div>
                <div>{activeRun.start_error}</div>
                {(() => {
                  const responseBody = activeRun?.start_error_details?.response_body;
                  const bodyObj = responseBody && typeof responseBody === "object" ? responseBody : null;
                  const err = bodyObj?.error && typeof bodyObj.error === "object" ? bodyObj.error : null;

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

                  if (!code && !message && !step && !stage && !requestId && !upstreamStatus && !upstreamRequestId && !upstreamTextPreview) {
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
                    <div className="rounded border border-red-200 bg-white/60 p-2 text-xs text-red-900 space-y-1">
                      <Row label="error.code" value={code} />
                      <Row label="error.message" value={message} />
                      <Row label="error.step" value={step} />
                      <Row label="stage" value={stage} />
                      <Row label="request_id" value={requestId} />
                      <Row label="upstream_status" value={upstreamStatus} />
                      <Row label="upstream_request_id" value={upstreamRequestId} />
                      <Row label="upstream_url" value={upstreamUrl} />
                      {upstreamTextPreview ? (
                        <div>
                          <div className="font-medium">upstream_text_preview:</div>
                          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-red-100 p-2 text-[11px] leading-snug text-red-950">{String(upstreamTextPreview)}</pre>
                        </div>
                      ) : null}
                    </div>
                  );
                })()}
              </div>
            ) : null}

            {activeRun?.progress_error ? (
              <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{activeRun.progress_error}</div>
            ) : null}

            {activeRun?.save_error ? (
              <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-900">{activeRun.save_error}</div>
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
        </main>
      </div>
    </>
  );
}
