import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { RefreshCcw, Copy, Volume2 } from "lucide-react";

import useNotificationSound from "@/hooks/useNotificationSound";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/lib/toast";
import { apiFetch, getCachedBuildId, getLastApiRequestExplain, getUserFacingConfigMessage } from "@/lib/api";

import {
  asString,
  prettyJson,
  getResponseHeadersForDebug,
  normalizeBuildIdString,
  normalizeHttpStatusNumber,
  fetchStaticBuildId,
  isCuratedReviewPubliclyVisible,
  getReviewRating,
  formatProposedReviewForClipboard,
  copyToClipboard,
  normalizeIsPublicFlag,
} from "./dashboardUtils";

const ReviewsImportPanel = React.forwardRef(function ReviewsImportPanel(
  { companyId, existingCuratedReviews, disabled, onApply },
  ref
) {
  const stableId = asString(companyId).trim();
  const { play: playNotification, replay: replayNotification } = useNotificationSound();
  const [take, setTake] = useState(1);
  const [includeExisting, setIncludeExisting] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [items, setItems] = useState([]);
  const [lastRefreshAttempt, setLastRefreshAttempt] = useState(null);

  const itemsRef = useRef([]);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useImperativeHandle(
    ref,
    () => ({
      getSelectedReviews: () =>
        itemsRef.current.filter((r) => Boolean(r?.include_on_save ?? r?.include)),
      getProposedReviewCount: () => itemsRef.current.length,
    }),
    []
  );

  const existingList = Array.isArray(existingCuratedReviews) ? existingCuratedReviews : [];
  const existingCount = existingList.length;
  const existingVisibleCount = existingList.filter(isCuratedReviewPubliclyVisible).length;
  const selectedCount = items.reduce((sum, r) => sum + (Boolean(r?.include_on_save ?? r?.include) ? 1 : 0), 0);

  const refreshOutcome = useMemo(() => {
    if (!lastRefreshAttempt) return null;

    const saved = Number(lastRefreshAttempt.saved_count ?? 0) || 0;
    const fetched = Number(lastRefreshAttempt.fetched_count ?? 0) || 0;

    const upstreamStatus = normalizeHttpStatusNumber(lastRefreshAttempt.upstream_status);

    const upstreamIsZero = upstreamStatus === 0;

    const okByContract = lastRefreshAttempt.ok === true && (saved > 0 || fetched > 0) && !upstreamIsZero;
    if (okByContract) return { kind: "ok", label: "ok" };

    if (lastRefreshAttempt.ok == null) return { kind: "pending", label: "" };

    const retryable = Boolean(lastRefreshAttempt.retryable);
    if (retryable || upstreamIsZero) return { kind: "warning", label: "warning" };

    return { kind: "failed", label: "failed" };
  }, [lastRefreshAttempt]);

  const upstreamStatusForDisplay = useMemo(
    () => normalizeHttpStatusNumber(lastRefreshAttempt?.upstream_status),
    [lastRefreshAttempt]
  );

  const fetchReviews = useCallback(async () => {
    const id = asString(stableId).trim();
    if (!id) {
      toast.error("Save the company first.");
      return;
    }

    const requestedTake = Math.max(1, Math.min(200, Math.trunc(Number(take) || 1)));

    const startedAt = new Date().toISOString();
    console.log("[reviews-refresh] start", { company_id: id });

    setLastRefreshAttempt({
      at: startedAt,
      company_id: id,
      ok: null,
      retryable: null,
      root_cause: "",
      upstream_status: null,
      build_id: "",
      saved_count: null,
      fetched_count: null,
      warnings: [],
      attempts_count: null,
      attempts: [],
      upstream_body_diagnostics: null,
      upstream_error_body: null,
    });

    setLoading(true);
    setError(null);
    setItems([]);

    try {
      const refreshPaths = ["/xadmin-api-refresh-reviews", "/admin-refresh-reviews"];
      const attempts = [];

      const requestPayload = {
        company_id: id,
        take: requestedTake,
        include_existing_in_context: Boolean(includeExisting),
        // Keep this below SWA gateway time budgets. The backend will further clamp.
        timeout_ms: 20000,
        deadline_ms: 20000,
      };

      let res;
      let usedPath = refreshPaths[0];

      for (const path of refreshPaths) {
        usedPath = path;
        res = await apiFetch(path, {
          method: "POST",
          body: requestPayload,
        });

        const requestExplain = getLastApiRequestExplain();

        attempts.push({
          path,
          status: res.status,
          request: requestExplain,
          request_payload: requestPayload,
          response_headers: getResponseHeadersForDebug(res),
          api_fetch_error: res && typeof res === "object" ? res.__api_fetch_error : null,
          api_fetch_fallback: res && typeof res === "object" ? res.__api_fetch_fallback : null,
        });
        if (res.status !== 404) break;
      }

      if (!res) throw new Error("Request failed: no response");

      const apiBuildId = normalizeBuildIdString(res.headers.get("x-api-build-id"));
      const cachedBuildId = getCachedBuildId();

      if (attempts.length && attempts.every((a) => a.status === 404)) {
        const staticBuildId = apiBuildId || cachedBuildId ? "" : await fetchStaticBuildId();
        const buildId = apiBuildId || cachedBuildId || staticBuildId;
        const msg = `Reviews API missing in prod build${buildId ? ` (build ${buildId})` : ""}`;

        setError({
          status: 404,
          message: msg,
          url: `/api${usedPath}`,
          attempts,
          build_id: buildId,
          response: { error: "both refresh endpoints returned 404" },
          debug_bundle: {
            kind: "refresh_reviews",
            endpoint_url: `/api${usedPath}`,
            request_payload: requestPayload,
            request_explain: attempts.length ? attempts[attempts.length - 1]?.request : null,
            attempts,
            response: null,
            build: {
              api_build_id: buildId || null,
              cached_build_id: getCachedBuildId() || null,
            },
          },
        });

        const doneLog = {
          ok: false,
          retryable: false,
          saved_count: 0,
          fetched_count: 0,
          warnings: [],
          root_cause: "endpoint_missing",
          upstream_status: 404,
          build_id: buildId,
        };
        console.log("[reviews-refresh] done", doneLog);
        setLastRefreshAttempt((prev) => ({
          ...(prev && typeof prev === "object" ? prev : {}),
          ok: false,
          retryable: false,
          root_cause: doneLog.root_cause,
          upstream_status: doneLog.upstream_status,
          build_id: String(buildId || ""),
          saved_count: 0,
          fetched_count: 0,
          warnings: [],
        }));

        toast.error(msg);
        return;
      }

      const jsonBody = await res
        .clone()
        .json()
        .catch(() => null);
      const textBody =
        jsonBody == null
          ? await res
              .clone()
              .text()
              .catch(() => "")
          : null;

      const apiFetchError = res && typeof res === "object" ? res.__api_fetch_error : null;
      const apiFetchErrorBody = apiFetchError && typeof apiFetchError === "object" ? apiFetchError.response_body : null;
      const apiFetchErrorText = apiFetchError && typeof apiFetchError === "object" ? apiFetchError.response_text : null;

      const isJsonObject = jsonBody && typeof jsonBody === "object";

      const body =
        (isJsonObject ? jsonBody : null) ||
        (apiFetchErrorBody && typeof apiFetchErrorBody === "object" ? apiFetchErrorBody : null) ||
        {};

      const rawText =
        typeof textBody === "string" && textBody.trim() ? textBody : typeof apiFetchErrorText === "string" ? apiFetchErrorText : "";

      // Contract guard: if the API responds with non-JSON, surface a clear message.
      if (!isJsonObject && rawText) {
        const responseBuildId = apiBuildId || cachedBuildId;
        const msg = `Bad response: not JSON (HTTP ${res.status})${responseBuildId ? `, build ${responseBuildId}` : ""}`;

        setError({
          status: res.status,
          message: msg,
          url: `/api${usedPath}`,
          attempts,
          build_id: responseBuildId,
          response: rawText.trim().slice(0, 500),
          debug_bundle: {
            kind: "refresh_reviews",
            endpoint_url: `/api${usedPath}`,
            request_payload: requestPayload,
            request_explain: attempts.length ? attempts[attempts.length - 1]?.request : null,
            attempts,
            response: {
              status: res.status,
              ok: res.ok,
              headers: getResponseHeadersForDebug(res),
              body_json: null,
              body_text: rawText || "",
            },
            build: {
              api_build_id: responseBuildId || null,
              cached_build_id: getCachedBuildId() || null,
            },
          },
        });

        const doneLog = {
          ok: false,
          retryable: false,
          saved_count: 0,
          fetched_count: 0,
          warnings: [],
          root_cause: "bad_response_not_json",
          upstream_status: res.status,
          build_id: responseBuildId,
        };
        console.log("[reviews-refresh] done", doneLog);
        setLastRefreshAttempt((prev) => ({
          ...(prev && typeof prev === "object" ? prev : {}),
          ok: false,
          retryable: false,
          root_cause: doneLog.root_cause,
          upstream_status: res.status,
          build_id: String(responseBuildId || ""),
          saved_count: 0,
          fetched_count: 0,
          warnings: [],
        }));

        toast.error(msg);
        return;
      }

      if (!res.ok || body?.ok !== true) {
        const rootCause = asString(body?.root_cause).trim();
        const upstreamStatus = normalizeHttpStatusNumber(body?.upstream_status);

        const retryable = Boolean(body?.retryable);

        const baseMsg =
          (await getUserFacingConfigMessage(res)) ||
          body?.message ||
          body?.error ||
          (rawText ? rawText.trim().slice(0, 500) : "") ||
          res.statusText ||
          `Reviews fetch failed (${res.status})`;

        const suffixParts = [];
        if (rootCause) suffixParts.push(`root_cause: ${rootCause}`);
        if (upstreamStatus != null) suffixParts.push(`upstream_status: HTTP ${upstreamStatus}`);

        const msg = suffixParts.length ? `${asString(baseMsg).trim()} (${suffixParts.join(", ")})` : baseMsg;

        const responseBuildId = normalizeBuildIdString(body?.build_id) || apiBuildId || cachedBuildId;

        setError({
          status: res.status,
          message: asString(msg).trim() || `Reviews fetch failed (${res.status})`,
          url: `/api${usedPath}`,
          attempts,
          build_id: responseBuildId,
          response: body && Object.keys(body).length ? body : rawText,
          debug_bundle: {
            kind: "refresh_reviews",
            endpoint_url: `/api${usedPath}`,
            request_payload: requestPayload,
            request_explain: attempts.length ? attempts[attempts.length - 1]?.request : null,
            attempts,
            response: {
              status: res.status,
              ok: res.ok,
              headers: getResponseHeadersForDebug(res),
              body_json: body && typeof body === "object" ? body : null,
              body_text: rawText || "",
            },
            build: {
              api_build_id: responseBuildId || null,
              cached_build_id: getCachedBuildId() || null,
            },
          },
        });

        const toastMsg = `${asString(msg).trim() || "Reviews fetch failed"} (${usedPath} → HTTP ${res.status}${responseBuildId ? `, build ${responseBuildId}` : ""})`;

        const doneLog = {
          ok: false,
          retryable,
          saved_count: Number(body?.saved_count ?? 0) || 0,
          fetched_count: Array.isArray(body?.proposed_reviews) ? body.proposed_reviews.length : Array.isArray(body?.reviews) ? body.reviews.length : 0,
          warnings: Array.isArray(body?.warnings) ? body.warnings : [],
          root_cause: rootCause,
          upstream_status: upstreamStatus,
          build_id: responseBuildId,
        };
        console.log("[reviews-refresh] done", doneLog);
        setLastRefreshAttempt((prev) => ({
          ...(prev && typeof prev === "object" ? prev : {}),
          ok: false,
          retryable,
          root_cause: asString(rootCause).trim(),
          upstream_status: doneLog.upstream_status,
          build_id: String(responseBuildId || ""),
          saved_count: doneLog.saved_count,
          fetched_count: doneLog.fetched_count,
          warnings: Array.isArray(doneLog.warnings) ? doneLog.warnings : [],
          attempts_count: Number(body?.attempts_count ?? 0) || null,
          attempts: Array.isArray(body?.attempts) ? body.attempts : [],
          upstream_body_diagnostics:
            body?.upstream_body_diagnostics && typeof body.upstream_body_diagnostics === "object" ? body.upstream_body_diagnostics : null,
          upstream_error_body: body?.upstream_error_body && typeof body.upstream_error_body === "object" ? body.upstream_error_body : null,
        }));

        if (retryable) toast.warning(toastMsg);
        else toast.error(toastMsg);

        return;
      }

      const warnings = Array.isArray(body?.warnings) ? body.warnings : [];
      const savedCount = Number(body?.saved_count ?? 0) || 0;

      const proposed =
        Array.isArray(body?.proposed_reviews)
          ? body.proposed_reviews
          : Array.isArray(body?.reviews)
            ? body.reviews
            : [];

      const normalized = proposed
        .map((r, idx) => {
          const source_url = asString(r?.source_url || r?.url).trim();
          const title = asString(r?.title).trim();
          const excerpt = asString(r?.excerpt ?? r?.abstract ?? r?.text).trim();
          const author = asString(r?.author).trim();
          const date = asString(r?.date).trim();
          const rating = getReviewRating(r);
          const duplicate = Boolean(r?.duplicate);

          if (!source_url && !title && !excerpt) return null;

          const link_status = asString(r?.link_status).trim();
          const match_confidence =
            typeof r?.match_confidence === "number"
              ? r.match_confidence
              : typeof r?.match_confidence === "string" && r.match_confidence.trim()
                ? Number(r.match_confidence)
                : null;

          return {
            id: asString(r?.id).trim() || `${Date.now()}_${idx}_${Math.random().toString(36).slice(2)}`,
            source: asString(r?.source).trim() || "professional_review",
            source_url,
            title,
            excerpt,
            author,
            date: date || null,
            rating,
            duplicate,
            link_status: link_status || null,
            match_confidence: typeof match_confidence === "number" && Number.isFinite(match_confidence) ? match_confidence : null,
            visibility: "public",
            include_on_save: true,
            include: true,
          };
        })
        .filter(Boolean);

      setItems(normalized);

      // If the backend persisted reviews during this call, keep the editor draft in sync
      // so subsequent saves don't overwrite the newly saved curated_reviews.
      if (savedCount >= 1 && typeof onApply === "function" && normalized.length > 0) {
        try {
          onApply(normalized);
        } catch {
          // ignore
        }
      }

      const responseBuildId = normalizeBuildIdString(body?.build_id) || apiBuildId || cachedBuildId;
      const fetchedCount = Number(body?.fetched_count ?? normalized.length) || 0;

      const isBackendInconsistent = savedCount === 0 && fetchedCount === 0;
      const clientNote = isBackendInconsistent ? "No results returned (possible backend inconsistency)" : "";

      const doneLog = {
        ok: true,
        retryable: isBackendInconsistent,
        saved_count: savedCount,
        fetched_count: fetchedCount,
        warnings,
        root_cause: isBackendInconsistent ? "backend_inconsistent_no_results" : "",
        upstream_status: null,
        build_id: responseBuildId,
        ...(clientNote ? { client_note: clientNote } : {}),
      };
      console.log("[reviews-refresh] done", doneLog);
      setLastRefreshAttempt((prev) => ({
        ...(prev && typeof prev === "object" ? prev : {}),
        ok: true,
        retryable: isBackendInconsistent,
        root_cause: isBackendInconsistent ? "backend_inconsistent_no_results" : "",
        client_note: clientNote,
        upstream_status: null,
        build_id: String(responseBuildId || ""),
        saved_count: savedCount,
        fetched_count: fetchedCount,
        warnings: Array.isArray(warnings) ? warnings : [],
        attempts_count: Number(body?.attempts_count ?? 0) || null,
        attempts: Array.isArray(body?.attempts) ? body.attempts : [],
        upstream_body_diagnostics:
          body?.upstream_body_diagnostics && typeof body.upstream_body_diagnostics === "object" ? body.upstream_body_diagnostics : null,
        upstream_error_body: body?.upstream_error_body && typeof body.upstream_error_body === "object" ? body.upstream_error_body : null,
      }));

      if (normalized.length === 0) {
        if (isBackendInconsistent) toast.warning(clientNote);
        else toast.success("No reviews found");
      } else if (savedCount >= 1) {
        if (warnings.length > 0) toast.warning(`Saved ${savedCount} review${savedCount === 1 ? "" : "s"} with warnings`);
        else toast.success(`Saved ${savedCount} review${savedCount === 1 ? "" : "s"}`);
      } else {
        toast.success(`Fetched ${normalized.length} review${normalized.length === 1 ? "" : "s"}`);
      }
      playNotification();
    } catch (e) {
      const msg = asString(e?.message).trim() || "Reviews fetch failed";
      const buildIdForToast = getCachedBuildId();

      console.log("[reviews-refresh] threw", { message: msg });
      setLastRefreshAttempt((prev) => ({
        ...(prev && typeof prev === "object" ? prev : {}),
        ok: false,
        retryable: true,
        root_cause: "client_exception",
        upstream_status: null,
        build_id: String(buildIdForToast || ""),
        saved_count: 0,
        fetched_count: 0,
        warnings: [],
      }));

      setError({ status: 0, message: msg, url: "(request failed)", build_id: buildIdForToast || null, response: { error: msg } });
      toast.error(`${msg}${buildIdForToast ? ` (build ${buildIdForToast})` : ""}`);
    } finally {
      setLoading(false);
    }
  }, [includeExisting, onApply, playNotification, stableId, take]);

  const copyAll = useCallback(async () => {
    if (items.length === 0) return;
    const text = items.map(formatProposedReviewForClipboard).join("\n\n---\n\n");
    const ok = await copyToClipboard(text);
    if (ok) toast.success("Copied all");
    else toast.error("Copy failed");
  }, [items]);

  const applySelected = useCallback(() => {
    const selected = items.filter((r) => Boolean(r?.include_on_save ?? r?.include));
    if (selected.length === 0) {
      toast.error("No reviews selected.");
      return;
    }

    const res = typeof onApply === "function" ? onApply(selected) : null;
    const added = Number(res?.addedCount ?? 0) || 0;
    const skipped = Number(res?.skippedDuplicates ?? 0) || 0;

    toast.success(
      `Applied ${added} review${added === 1 ? "" : "s"}${skipped ? ` (skipped ${skipped} duplicate${skipped === 1 ? "" : "s"})` : ""}`
    );

    setItems((prev) => prev.map((r) => ({ ...(r || {}), include_on_save: false, include: false, duplicate: true })));
  }, [items, onApply]);

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 dark:border-border bg-white dark:bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-slate-900 dark:text-foreground">Reviews import</div>
          <div className="text-xs text-slate-500 dark:text-muted-foreground">Fetch editorial/pro reviews without running company enrichment.</div>
          <div className="mt-1 text-xs text-slate-600 dark:text-muted-foreground">
            Existing imported reviews: <span className="font-medium">{existingCount}</span>
            <span className="mx-1">•</span>
            Publicly visible: <span className="font-medium">{existingVisibleCount}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-slate-700 dark:text-muted-foreground">Count</label>
            <Input
              type="number"
              min={1}
              max={200}
              value={String(take)}
              onChange={(e) => {
                const next = Math.max(1, Math.min(200, Math.trunc(Number(e.target.value) || 1)));
                setTake(next);
              }}
              className="w-[90px]"
              disabled={!stableId || loading || disabled}
            />
          </div>

          <Button type="button" onClick={fetchReviews} disabled={!stableId || loading || disabled}>
            <RefreshCcw className="h-4 w-4 mr-2" />
            {loading ? "Fetching…" : "Fetch more reviews"}
          </Button>
        </div>
      </div>

      <label className="flex items-start gap-2 text-sm text-slate-800 dark:text-foreground">
        <Checkbox
          checked={includeExisting}
          onCheckedChange={(v) => setIncludeExisting(Boolean(v))}
          disabled={!stableId || loading || disabled}
        />
        <span>
          Include existing imported reviews in context <span className="text-xs text-slate-500 dark:text-muted-foreground">(recommended)</span>
        </span>
      </label>

      {/* ─── Fetch more reviews status banner ─── */}
      {lastRefreshAttempt ? (() => {
        const isOk = lastRefreshAttempt.ok === true;
        const isFail = lastRefreshAttempt.ok === false;
        const saved = Number(lastRefreshAttempt.saved_count ?? 0) || 0;
        const fetched = Number(lastRefreshAttempt.fetched_count ?? 0) || 0;
        const at = lastRefreshAttempt.at ? new Date(lastRefreshAttempt.at).toLocaleString() : "";
        const retryable = Boolean(lastRefreshAttempt.retryable);

        if (isOk && saved > 0) {
          return (
            <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 flex items-center gap-4">
              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500 text-white">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-emerald-900">
                  {saved} review{saved !== 1 ? "s" : ""} saved
                </div>
                <div className="text-xs text-emerald-700 mt-0.5">
                  {fetched > saved ? `${fetched} fetched, ${saved} saved` : `${saved} saved`}
                  {at ? ` · ${at}` : ""}
                </div>
              </div>
              <button
                type="button"
                onClick={replayNotification}
                className="shrink-0 rounded-md p-1.5 text-emerald-600 hover:bg-emerald-100 transition-colors"
                title="Replay notification sound"
              >
                <Volume2 className="h-4 w-4" />
              </button>
            </div>
          );
        }

        if (isOk && saved === 0) {
          return (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 flex items-center gap-4">
              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-amber-500 text-white">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-amber-900">
                  No new reviews found
                </div>
                <div className="text-xs text-amber-700 mt-0.5">
                  {fetched > 0 ? `${fetched} fetched but none were new` : "No reviews returned"}
                  {at ? ` · ${at}` : ""}
                </div>
              </div>
            </div>
          );
        }

        if (isFail) {
          const rootCause = asString(lastRefreshAttempt.root_cause).trim();
          const friendlyReason =
            rootCause === "upstream_rate_limited" ? "Rate limited — try again in a moment"
              : rootCause === "upstream_unreachable" || rootCause === "upstream_http_0" ? "Service unreachable — try again"
              : rootCause === "upstream_5xx" ? "Server error — try again"
              : rootCause === "upstream_4xx" ? "Request rejected by upstream"
              : rootCause === "bad_response_not_json" ? "Unexpected response format"
              : rootCause.startsWith("client_") ? "Request error"
              : rootCause ? rootCause.replace(/_/g, " ")
              : "Unknown error";

          return (
            <div className="rounded-lg border border-red-300 bg-red-50 p-4 flex items-center gap-4">
              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-red-500 text-white">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-red-900">
                  Reviews fetch failed{retryable ? " — retryable" : ""}
                </div>
                <div className="text-xs text-red-700 mt-0.5">
                  {friendlyReason}
                  {at ? ` · ${at}` : ""}
                </div>
              </div>
            </div>
          );
        }

        return null;
      })() : null}

      {!stableId ? (
        <div className="rounded-lg border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-3 text-xs text-slate-600 dark:text-muted-foreground">
          Save the company first to generate a <code className="text-[11px]">company_id</code>.
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 flex items-center gap-4">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-red-500 text-white">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-red-900">Reviews fetch failed</div>
            <div className="text-xs text-red-700 mt-0.5 break-words">{asString(error.message)}</div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="bg-white dark:bg-card shrink-0"
            onClick={async () => {
              const payloadObj = error?.debug_bundle && typeof error.debug_bundle === "object" ? error.debug_bundle : error;
              const ok = await copyToClipboard(prettyJson(payloadObj));
              if (ok) toast.success("Copied error");
              else toast.error("Copy failed");
            }}
          >
            <Copy className="h-4 w-4 mr-1" />
            Copy
          </Button>
        </div>
      ) : loading ? (
        <div className="rounded-lg border border-blue-300 bg-blue-50 p-4 flex items-center gap-4">
          <div className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-3 w-3 bg-blue-500"></span>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-blue-900">Fetching reviews…</div>
            <div className="text-xs text-blue-700 mt-0.5">Searching for editorial and third-party reviews</div>
          </div>
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-3 text-xs text-slate-600 dark:text-muted-foreground">
          No proposed reviews yet. Click <span className="font-medium">Fetch more reviews</span>.
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-slate-600 dark:text-muted-foreground">
              Proposed reviews: <span className="font-medium">{items.length}</span> • Selected: <span className="font-medium">{selectedCount}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="outline" onClick={copyAll} disabled={items.length === 0}>
                <Copy className="h-4 w-4 mr-2" />
                Copy all
              </Button>
              <Button type="button" size="sm" onClick={applySelected} disabled={selectedCount === 0 || disabled}>
                Apply selected reviews to company
              </Button>
            </div>
          </div>

          <div className="space-y-3">
            {items.map((review) => (
              <div key={review.id} className="rounded-lg border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-3 space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex items-start gap-2">
                    <Checkbox
                      checked={Boolean(review.include_on_save ?? review.include)}
                      onCheckedChange={(v) =>
                        setItems((prev) =>
                          prev.map((r) =>
                            r.id === review.id
                              ? {
                                  ...(r || {}),
                                  include_on_save: Boolean(v),
                                  include: Boolean(v),
                                }
                              : r
                          )
                        )
                      }
                      disabled={disabled}
                      aria-label="Include on save"
                    />
                    <div className="min-w-0">
                      <div className="text-xs text-slate-600 dark:text-muted-foreground">
                        Include on save
                        {review.duplicate ? (
                          <span className="ml-2 inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-900">
                            duplicate
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <div className="space-y-1">
                          <label className="text-[11px] font-medium text-slate-700 dark:text-muted-foreground">Title</label>
                          <Input
                            value={asString(review.title)}
                            onChange={(e) =>
                              setItems((prev) => prev.map((r) => (r.id === review.id ? { ...(r || {}), title: e.target.value } : r)))
                            }
                            disabled={disabled}
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-[11px] font-medium text-slate-700 dark:text-muted-foreground">Source URL</label>
                          <Input
                            value={asString(review.source_url)}
                            onChange={(e) =>
                              setItems((prev) =>
                                prev.map((r) => (r.id === review.id ? { ...(r || {}), source_url: e.target.value } : r))
                              )
                            }
                            disabled={disabled}
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      const ok = await copyToClipboard(formatProposedReviewForClipboard(review));
                      if (ok) toast.success("Copied");
                      else toast.error("Copy failed");
                    }}
                    disabled={disabled}
                    title="Copy"
                  >
                    <Copy className="h-4 w-4 mr-2" />
                    Copy
                  </Button>
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-slate-700 dark:text-muted-foreground">Excerpt</label>
                  <Textarea
                    value={asString(review.excerpt)}
                    onChange={(e) =>
                      setItems((prev) => prev.map((r) => (r.id === review.id ? { ...(r || {}), excerpt: e.target.value } : r)))
                    }
                    disabled={disabled}
                    className="min-h-[100px]"
                  />
                </div>

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-slate-700 dark:text-muted-foreground">Author</label>
                    <Input
                      value={asString(review.author)}
                      onChange={(e) =>
                        setItems((prev) => prev.map((r) => (r.id === review.id ? { ...(r || {}), author: e.target.value } : r)))
                      }
                      disabled={disabled}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-slate-700 dark:text-muted-foreground">Date</label>
                    <Input
                      value={asString(review.date)}
                      onChange={(e) =>
                        setItems((prev) => prev.map((r) => (r.id === review.id ? { ...(r || {}), date: e.target.value } : r)))
                      }
                      disabled={disabled}
                      placeholder="YYYY-MM-DD"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-slate-700 dark:text-muted-foreground">Rating</label>
                    <Input
                      value={review.rating == null ? "" : String(review.rating)}
                      onChange={(e) => {
                        const raw = e.target.value;
                        const parsed = raw.trim() ? Number(raw) : null;
                        setItems((prev) =>
                          prev.map((r) =>
                            r.id === review.id
                              ? { ...(r || {}), rating: parsed != null && Number.isFinite(parsed) ? parsed : null }
                              : r
                          )
                        );
                      }}
                      disabled={disabled}
                      placeholder="(optional)"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

export default ReviewsImportPanel;
