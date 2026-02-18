import React from "react";
import { AlertTriangle, RefreshCcw, Copy, Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import {
  asString,
  looksLikeUrlOrDomain,
  isMeaningfulString,
  normalizeStringList,
  isPrimarySkippedCompanyUrl,
  importMissingReasonLabel,
  mergeUniqueStrings,
  toPrettyJsonText,
  downloadJsonFile,
} from "./importUtils";

export default function ImportResultsPanels({
  activeRun,
  activeSessionId,
  setActiveSessionId,
  activeStatus,
  activeItemsCount,
  activeIsTerminal,
  activeSavedCount,
  activeResults,
  showSavedResults,
  keywordsStageSkipped,
  plainEnglishProgress,
  runs,
  setRuns,
  statusRefreshSessionId,
  setStatusRefreshSessionId,
  clearTerminalRefresh,
  pollProgress,
  retryResumeWorker,
  retryingResumeSessionId,
  setRetryingResumeSessionId,
  runXaiDiag,
  resumeDebugText,
  resumeDebugPayload,
}) {
  return (
    <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="rounded-lg border border-slate-200 dark:border-border bg-white dark:bg-card p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-foreground">Active results</h2>
          <div className="text-sm text-slate-600 dark:text-muted-foreground">{activeItemsCount} companies</div>
        </div>

        {!activeSessionId ? (
          <div className="mt-4 text-sm text-slate-600 dark:text-muted-foreground">Start an import to see results.</div>
        ) : activeIsTerminal && activeSavedCount === 0 ? (
          <div className="mt-4 rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-3 text-sm text-slate-700 dark:text-muted-foreground space-y-1">
            {(() => {
              const stageBeacon = asString(activeRun?.final_stage_beacon || activeRun?.stage_beacon || activeRun?.last_stage_beacon).trim();
              const isSkipped = isPrimarySkippedCompanyUrl(stageBeacon);
              const failureCode = asString(activeRun?.last_error?.code).trim();
              const failureMessage = asString(activeRun?.last_error?.message).trim();
              const failureLine = failureMessage
                ? `Save failed${failureCode ? ` (${failureCode})` : ""}: ${failureMessage}`
                : "";
              return (
                <>
                  <div className="font-medium">{isSkipped ? "Skipped: company not persisted" : "Completed: no company persisted"}</div>
                  <div className="text-slate-600 dark:text-muted-foreground">{plainEnglishProgress.reasonText || "No company was saved for this run."}</div>
                  {failureLine ? <div className="text-red-700 break-words">{failureLine}</div> : null}
                  {isSkipped ? <div className="text-slate-600 dark:text-muted-foreground">Reviews stage did not run (company was never saved).</div> : null}
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
              const urlRaw = asString(c?.canonical_url || c?.website_url || c?.url).trim();
              const queryUrlRaw = asString(activeRun?.query).trim();
              const queryLooksLikeUrl = looksLikeUrlOrDomain(queryUrlRaw);
              const queryUrlNormalized = queryLooksLikeUrl
                ? /^https?:\/\//i.test(queryUrlRaw)
                  ? queryUrlRaw
                  : `https://${queryUrlRaw}`
                : "";

              const displayUrl = urlRaw || queryUrlNormalized;

              const isCompanyUrlRun = Array.isArray(activeRun?.queryTypes) && activeRun.queryTypes.includes("company_url");
              const hasSavedVerified =
                (typeof activeRun?.saved_verified_count === "number" && Number.isFinite(activeRun.saved_verified_count)
                  ? activeRun.saved_verified_count
                  : Array.isArray(activeRun?.saved_company_ids_verified)
                    ? activeRun.saved_company_ids_verified.length
                    : 0) > 0;

              const hasCompanyUrl = isMeaningfulString(c?.company_url);
              const hasWebsiteUrl = isMeaningfulString(c?.website_url || c?.canonical_url || c?.url);

              const seedMissingBug = Boolean(isCompanyUrlRun && showSavedResults && hasSavedVerified && !hasCompanyUrl && !hasWebsiteUrl);

              const keywordsCanonical =
                Array.isArray(c?.keywords) && c.keywords.length > 0
                  ? c.keywords
                  : Array.isArray(c?.keyword_tags) && c.keyword_tags.length > 0
                    ? c.keyword_tags
                    : c?.product_keywords ?? c?.keyword_list;

              const keywordsList = normalizeStringList(keywordsCanonical);
              const keywordsText = keywordsList.join(", ");

              const issues = [];
              if (!displayUrl) issues.push("missing url");
              if (seedMissingBug) issues.push("seed missing (bug)");

              // Truthfulness: do not flag missing keywords based on seed/pre-save items.
              // Only evaluate keywords once we're rendering saved (persisted) company docs.
              const shouldEvaluateKeywords = showSavedResults && !keywordsStageSkipped;
              if (shouldEvaluateKeywords && keywordsList.length === 0) issues.push("missing keywords");

              return (
                <div key={asString(c?.id || c?.company_id)} className="rounded border border-slate-200 dark:border-border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-semibold text-slate-900 dark:text-foreground">{name}</div>
                      {displayUrl ? (
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <a
                            className="text-sm text-blue-700 underline break-all"
                            href={displayUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {displayUrl}
                          </a>
                          {seedMissingBug ? (
                            <span className="rounded border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] text-rose-800">
                              Seed missing (bug)
                            </span>
                          ) : null}
                        </div>
                      ) : (
                        <div className="text-sm text-slate-500 dark:text-muted-foreground">No URL</div>
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
                    <div className="mt-2 text-xs text-slate-600 dark:text-muted-foreground">{keywordsText}</div>
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
                            : "border-slate-200 dark:border-border bg-slate-50 dark:bg-muted text-slate-700 dark:text-muted-foreground";

                    if (!companyId && !stageStatus && reviewCount === 0) return null;

                    return (
                      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
                        <span className="rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted px-2 py-0.5 text-slate-700 dark:text-muted-foreground">
                          review_count: {reviewCount}
                        </span>
                        {stageStatus ? (
                          <span className={`rounded border px-2 py-0.5 ${badgeClass}`}>
                            reviews_stage_status: {stageStatus}
                          </span>
                        ) : null}
                        {(() => {
                          const isExhausted = Boolean(
                            c?.review_cursor?.exhausted === true ||
                            c?.import_missing_reason?.reviews === "exhausted"
                          );
                          if (isExhausted && reviewCount === 0) {
                            return (
                              <span className="text-[11px] text-slate-500 dark:text-muted-foreground italic">
                                No third-party reviews could be found for this company.
                              </span>
                            );
                          }
                          if (isExhausted && reviewCount > 0 && reviewCount < 3) {
                            return (
                              <span className="text-[11px] text-slate-500 dark:text-muted-foreground italic">
                                Only {reviewCount} review{reviewCount === 1 ? "" : "s"} found (target: 3–5).
                              </span>
                            );
                          }
                          return null;
                        })()}
                        {companyId ? (
                          <a
                            className="rounded border border-slate-200 dark:border-border bg-white dark:bg-card px-2 py-0.5 text-slate-700 dark:text-muted-foreground hover:bg-slate-50 dark:bg-muted dark:hover:bg-accent"
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

      <div className="rounded-lg border border-slate-200 dark:border-border bg-white dark:bg-card p-5">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-foreground">Run history</h2>
        <div className="mt-4 space-y-2 max-h-[520px] overflow-auto">
          {runs.length === 0 ? (
            <div className="text-sm text-slate-600 dark:text-muted-foreground">No runs yet.</div>
          ) : (
            runs.map((r) => {
              const savedCompanies = Array.isArray(r.saved_companies) ? r.saved_companies : [];
              const primarySaved = savedCompanies.length > 0 ? savedCompanies[0] : null;

              const verifiedCount =
                typeof r.saved_verified_count === "number" && Number.isFinite(r.saved_verified_count)
                  ? r.saved_verified_count
                  : null;

              const verifiedIds = Array.isArray(r.saved_company_ids_verified)
                ? r.saved_company_ids_verified
                : Array.isArray(r.saved_company_ids)
                  ? r.saved_company_ids
                  : [];

              const unverifiedIds = Array.isArray(r.saved_company_ids_unverified) ? r.saved_company_ids_unverified : [];
              const persistedIds = mergeUniqueStrings(verifiedIds, unverifiedIds);

              const savedVerifiedCount = verifiedCount != null ? verifiedCount : verifiedIds.length;

              const savedCount = Math.max(
                persistedIds.length,
                Number.isFinite(Number(r.saved)) ? Number(r.saved) : 0,
                savedCompanies.length
              );

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
                  // Add logo status to issues if logo_url is missing
                  const logoUrl = c?.logo_url;
                  const logoStatus = asString(c?.logo_stage_status || c?.logo_status || "").toLowerCase();
                  if (!logoUrl && !missing.has("logo")) {
                    if (logoStatus === "not_found_on_site" || logoStatus === "not_found" || logoStatus === "not_found_terminal") {
                      missing.add("logo (not found)");
                    } else if (!logoStatus || logoStatus === "incomplete" || logoStatus === "deferred") {
                      missing.add("logo");
                    }
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
                  : savedCount > 0
                    ? "Saved (verified) — company doc missing"
                    : "Company candidate";

              const websiteUrlRaw = asString(
                primaryCandidate?.canonical_url || primaryCandidate?.website_url || primaryCandidate?.url
              ).trim();

              const queryUrlRaw = asString(r.query).trim();
              const queryLooksLikeUrl = looksLikeUrlOrDomain(queryUrlRaw);
              const queryUrlNormalized = queryLooksLikeUrl
                ? /^https?:\/\//i.test(queryUrlRaw)
                  ? queryUrlRaw
                  : `https://${queryUrlRaw}`
                : "";

              const primaryDoc =
                r.primary_company_doc && typeof r.primary_company_doc === "object" ? r.primary_company_doc : null;

              const websiteUrlFromDoc = asString(primaryDoc?.website_url || primaryDoc?.canonical_url).trim();
              const websiteUrl = websiteUrlRaw || websiteUrlFromDoc || queryUrlNormalized;

              const isCompanyUrlRun = Array.isArray(r.queryTypes) ? r.queryTypes.includes("company_url") : false;
              const hasResolvedCompanyRecord = Boolean(primaryCandidate || primaryDoc);

              const hasCompanyUrl = isMeaningfulString(primaryCandidate?.company_url || primaryDoc?.company_url);
              const hasWebsiteUrl = isMeaningfulString(
                primaryCandidate?.website_url ||
                  primaryCandidate?.canonical_url ||
                  primaryCandidate?.url ||
                  primaryDoc?.website_url ||
                  primaryDoc?.canonical_url
              );

              const seedMissingBug = Boolean(isCompanyUrlRun && savedCount > 0 && hasResolvedCompanyRecord && !hasCompanyUrl && !hasWebsiteUrl);
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

              const resumeNeeded = Boolean(r.resume_needed);

              const stageBeaconValues =
                r.stage_beacon_values && typeof r.stage_beacon_values === "object" ? r.stage_beacon_values : {};
              const retryableMissingCount = Number(stageBeaconValues.status_resume_missing_retryable);
              const resumeStatus = asString(r.resume?.status || r.report?.resume?.status).trim().toLowerCase();
              const terminalComplete = Boolean(
                stageBeaconForStatus === "complete" ||
                  (resumeStatus === "complete" && Number.isFinite(retryableMissingCount) && retryableMissingCount === 0)
              );

              const statusLabel = isFailed
                ? "Failed"
                : isSkipped
                  ? "Skipped"
                  : terminalComplete && savedCount > 0
                    ? enrichmentMissingFields.length > 0
                      ? "Completed (terminal)"
                      : "Completed"
                    : resumeNeeded && savedCount > 0
                      ? "Resume needed"
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
                  : terminalComplete && savedCount > 0
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                    : resumeNeeded && savedCount > 0
                      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                      : isCompleteWithSave
                        ? hasWarnings
                          ? "border-amber-200 bg-amber-50 text-amber-900"
                          : "border-emerald-200 bg-emerald-50 text-emerald-800"
                        : isCompleteNoSave
                          ? "border-slate-200 dark:border-border bg-slate-50 dark:bg-muted text-slate-700 dark:text-muted-foreground"
                          : "border-sky-200 bg-sky-50 text-sky-800";

              return (
                <div
                  key={r.session_id}
                  role="button"
                  tabIndex={0}
                  className={`w-full text-left rounded border p-3 transition cursor-pointer ${
                    r.session_id === activeSessionId
                      ? "border-slate-900 bg-slate-50 dark:bg-muted"
                      : "border-slate-200 dark:border-border bg-white dark:bg-card hover:bg-slate-50 dark:bg-muted dark:hover:bg-accent"
                  }`}
                  onClick={() => setActiveSessionId(r.session_id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") setActiveSessionId(r.session_id);
                  }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-900 dark:text-foreground truncate">{companyName}</div>
                      {websiteUrl ? (
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <a
                            className="text-xs text-blue-700 underline break-all"
                            href={websiteUrl}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {websiteUrl}
                          </a>
                          {seedMissingBug ? (
                            <span className="rounded border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] text-rose-800">
                              Seed missing (bug)
                            </span>
                          ) : null}
                        </div>
                      ) : (
                        <div className="mt-1 text-xs text-slate-500 dark:text-muted-foreground">No URL</div>
                      )}
                      <div className="mt-1 text-xs text-slate-600 dark:text-muted-foreground truncate">Query: {r.query}</div>
                    </div>

                    <div className="flex flex-col items-end gap-2 text-xs text-slate-600 dark:text-muted-foreground">
                      <div className="flex items-center gap-2">
                        <span>Persisted: {savedCount}</span>
                        <span className="text-slate-500 dark:text-muted-foreground">Verified: {savedVerifiedCount}</span>
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

                  <div className="mt-2 text-xs text-slate-600 dark:text-muted-foreground">
                    <code className="rounded bg-slate-100 dark:bg-muted px-1 py-0.5">{r.session_id}</code>
                  </div>
                  <div className="mt-1 text-xs text-slate-500 dark:text-muted-foreground">{new Date(r.startedAt).toLocaleString()}</div>
                </div>
              );
            })
          )}

          {activeRun ? (
            <div className="mt-4 rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-3 text-sm text-slate-800 dark:text-foreground space-y-2">
              {(() => {
                const savedCompanies = Array.isArray(activeRun.saved_companies) ? activeRun.saved_companies : [];
                const primarySaved = savedCompanies.length > 0 ? savedCompanies[0] : null;

                const primaryDoc =
                  activeRun.primary_company_doc && typeof activeRun.primary_company_doc === "object"
                    ? activeRun.primary_company_doc
                    : null;
                const primaryDocError =
                  activeRun.primary_company_doc_error && typeof activeRun.primary_company_doc_error === "object"
                    ? activeRun.primary_company_doc_error
                    : null;

                const verifiedCount = Number.isFinite(activeRun.saved_verified_count) ? activeRun.saved_verified_count : null;
                const verifiedIds = Array.isArray(activeRun.saved_company_ids_verified)
                  ? activeRun.saved_company_ids_verified
                  : Array.isArray(activeRun.saved_company_ids)
                    ? activeRun.saved_company_ids
                    : [];
                const savedVerifiedCount = verifiedCount != null ? verifiedCount : verifiedIds.length;

                const unverifiedIds = Array.isArray(activeRun.saved_company_ids_unverified)
                  ? activeRun.saved_company_ids_unverified
                  : [];
                const persistedIds = mergeUniqueStrings(verifiedIds, unverifiedIds);

                const persistedCount = Math.max(
                  persistedIds.length,
                  Number.isFinite(Number(activeRun.saved)) ? Number(activeRun.saved) : 0,
                  savedCompanies.length,
                  savedVerifiedCount
                );

                const stageBeacon = asString(activeRun.final_stage_beacon || activeRun.stage_beacon || activeRun.last_stage_beacon).trim();
                const stageBeaconValues =
                  activeRun.stage_beacon_values && typeof activeRun.stage_beacon_values === "object" ? activeRun.stage_beacon_values : {};
                const retryableMissingCount = Number(stageBeaconValues.status_resume_missing_retryable);
                const resumeStatus = asString(activeRun.resume?.status || activeRun.report?.resume?.status).trim().toLowerCase();
                const terminalComplete = Boolean(
                  (!activeRun.resume_needed && stageBeacon === "complete") ||
                    (resumeStatus === "complete" && Number.isFinite(retryableMissingCount) && retryableMissingCount === 0)
                );

                const persistedDetected = persistedCount > 0 || stageBeacon === "cosmos_write_done";

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
                  asString(primaryDoc?.company_id).trim() ||
                  asString(primarySaved?.company_id).trim() ||
                  (Array.isArray(activeRun.saved_company_ids_verified) ? asString(activeRun.saved_company_ids_verified[0]).trim() : "") ||
                  (Array.isArray(activeRun.saved_company_ids) ? asString(activeRun.saved_company_ids[0]).trim() : "");
                const companyName =
                  asString(primaryDoc?.company_name).trim() ||
                  (primaryCandidate
                    ? asString(primaryCandidate?.company_name || primaryCandidate?.name).trim() || "Company candidate"
                    : explicitNoPersist
                      ? "No company persisted"
                      : persistedCount > 0
                        ? "Saved but cannot read company doc"
                        : "Company candidate");
                const websiteUrlRaw = asString(
                  primaryDoc?.canonical_url ||
                    primaryDoc?.website_url ||
                    primaryCandidate?.canonical_url ||
                    primaryCandidate?.website_url ||
                    primaryCandidate?.url
                ).trim();

                const queryUrlRaw = asString(activeRun.query).trim();
                const queryLooksLikeUrl = looksLikeUrlOrDomain(queryUrlRaw);
                const queryUrlNormalized = queryLooksLikeUrl
                  ? /^https?:\/\//i.test(queryUrlRaw)
                    ? queryUrlRaw
                    : `https://${queryUrlRaw}`
                  : "";

                const websiteUrl = websiteUrlRaw || queryUrlNormalized;
                const isCompanyUrlRun = Array.isArray(activeRun.queryTypes) ? activeRun.queryTypes.includes("company_url") : false;
                const seedMissingBug = isCompanyUrlRun && Boolean(queryUrlNormalized && !websiteUrlRaw);

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
                    // Add logo status to issues if logo_url is missing
                    const logoUrl = c?.logo_url;
                    const logoStatus = asString(c?.logo_stage_status || c?.logo_status || "").toLowerCase();
                    if (!logoUrl && !missing.has("logo")) {
                      if (logoStatus === "not_found_on_site" || logoStatus === "not_found" || logoStatus === "not_found_terminal") {
                        missing.add("logo (not found)");
                      } else if (!logoStatus || logoStatus === "incomplete" || logoStatus === "deferred") {
                        missing.add("logo");
                      }
                    }
                  }
                  return Array.from(missing);
                })();

                return (
                  <>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-semibold text-slate-900 dark:text-foreground">{companyName}</div>
                        {websiteUrl ? (
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <a
                              className="text-sm text-blue-700 underline break-all"
                              href={websiteUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {websiteUrl}
                            </a>
                            {seedMissingBug ? (
                              <span className="rounded border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] text-rose-800">
                                Seed missing (bug)
                              </span>
                            ) : null}
                          </div>
                        ) : (
                          <div className="mt-1 text-sm text-slate-600 dark:text-muted-foreground">No URL</div>
                        )}

                        {primaryDocError && persistedCount > 0 ? (
                          <div className="mt-1 text-xs text-amber-900 break-words">
                            Saved but cannot read company doc: {asString(primaryDocError.message).trim() || "unknown error"}
                          </div>
                        ) : null}
                      </div>
                      <div className="text-sm text-slate-700 dark:text-muted-foreground">
                        Persisted: {persistedCount} <span className="text-slate-500 dark:text-muted-foreground">(verified: {savedVerifiedCount})</span>
                      </div>
                    </div>

                    {enrichmentMissingFields.length > 0 ? (
                      <div className="mt-2 text-sm text-amber-900 space-y-2">
                        <div>
                          Enrichment incomplete: {enrichmentMissingFields.slice(0, 4).join(", ")}
                          {enrichmentMissingFields.length > 4 ? ` (+${enrichmentMissingFields.length - 4})` : ""}
                        </div>

                        {Array.isArray(primarySaved?.import_warnings) && primarySaved.import_warnings.length > 0 ? (
                          <div className="rounded border border-amber-200 bg-amber-50 p-3">
                            <div className="text-xs font-medium text-amber-900">Required-fields checklist</div>
                            <div className="mt-1 text-[11px] text-amber-900/90">
                              Shows why each missing field was defaulted (placeholder) and which stage failed.
                            </div>

                            <ul className="mt-2 space-y-1 text-[11px] text-amber-950">
                              {primarySaved.import_warnings.slice(0, 8).map((w, idx) => {
                                const field = asString(w?.field).trim();
                                const stage = asString(w?.stage).trim();
                                const reason = asString(w?.missing_reason).trim();
                                const msg = asString(w?.message).trim();

                                return (
                                  <li key={`${field || "field"}-${idx}`} className="flex flex-wrap items-start justify-between gap-2">
                                    <span className="font-medium">{field || "(field)"}</span>
                                    <span className="text-amber-900/90">
                                      {importMissingReasonLabel(reason) || "missing"}
                                      {stage ? ` · ${stage}` : ""}
                                      {msg ? ` · ${msg}` : ""}
                                    </span>
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    {companyId ? (
                      <div>
                        <a className="text-sm text-blue-700 underline" href={`/admin?company_id=${encodeURIComponent(companyId)}`}>
                          Open company in admin
                        </a>
                      </div>
                    ) : null}

                    {primaryDoc ? (
                      <details className="mt-2 rounded border border-slate-200 dark:border-border bg-white dark:bg-card p-3">
                        <summary className="cursor-pointer text-xs font-medium text-slate-800 dark:text-foreground">
                          Location sources (admin debug)
                        </summary>
                        {(() => {
                          const locationSources = Array.isArray(primaryDoc?.location_sources) ? primaryDoc.location_sources : [];
                          const debugSources =
                            primaryDoc?.enrichment_debug &&
                            typeof primaryDoc.enrichment_debug === "object" &&
                            primaryDoc.enrichment_debug.location_sources &&
                            typeof primaryDoc.enrichment_debug.location_sources === "object"
                              ? primaryDoc.enrichment_debug.location_sources
                              : null;

                          const hqUrls = Array.isArray(debugSources?.hq_source_urls) ? debugSources.hq_source_urls : [];
                          const mfgUrls = Array.isArray(debugSources?.mfg_source_urls) ? debugSources.mfg_source_urls : [];

                          if (locationSources.length === 0 && hqUrls.length === 0 && mfgUrls.length === 0) {
                            return <div className="mt-2 text-xs text-slate-600 dark:text-muted-foreground">No location sources recorded.</div>;
                          }

                          return (
                            <div className="mt-2 space-y-3">
                              {locationSources.length > 0 ? (
                                <div>
                                  <div className="text-xs font-medium text-slate-800 dark:text-foreground">location_sources</div>
                                  <ul className="mt-1 space-y-1 text-xs text-slate-700 dark:text-muted-foreground">
                                    {locationSources.slice(0, 20).map((s, idx) => {
                                      const location = asString(s?.location).trim();
                                      const type = asString(s?.location_type).trim();
                                      const url = asString(s?.source_url).trim();
                                      return (
                                        <li key={`${type || "loc"}-${idx}`} className="break-words">
                                          <span className="font-medium">{type || "loc"}</span>
                                          {location ? `: ${location}` : ""}
                                          {url ? (
                                            <>
                                              {" "}
                                              ·{" "}
                                              <a className="text-blue-700 underline" href={url} target="_blank" rel="noreferrer">
                                                {url}
                                              </a>
                                            </>
                                          ) : null}
                                        </li>
                                      );
                                    })}
                                  </ul>
                                </div>
                              ) : null}

                              {hqUrls.length > 0 ? (
                                <div>
                                  <div className="text-xs font-medium text-slate-800 dark:text-foreground">enrichment_debug.location_sources.hq_source_urls</div>
                                  <ul className="mt-1 space-y-1 text-xs text-slate-700 dark:text-muted-foreground">
                                    {hqUrls.slice(0, 12).map((url, idx) => {
                                      const u = asString(url).trim();
                                      return u ? (
                                        <li key={`hq-${idx}`} className="break-words">
                                          <a className="text-blue-700 underline" href={u} target="_blank" rel="noreferrer">
                                            {u}
                                          </a>
                                        </li>
                                      ) : null;
                                    })}
                                  </ul>
                                </div>
                              ) : null}

                              {mfgUrls.length > 0 ? (
                                <div>
                                  <div className="text-xs font-medium text-slate-800 dark:text-foreground">enrichment_debug.location_sources.mfg_source_urls</div>
                                  <ul className="mt-1 space-y-1 text-xs text-slate-700 dark:text-muted-foreground">
                                    {mfgUrls.slice(0, 12).map((url, idx) => {
                                      const u = asString(url).trim();
                                      return u ? (
                                        <li key={`mfg-${idx}`} className="break-words">
                                          <a className="text-blue-700 underline" href={u} target="_blank" rel="noreferrer">
                                            {u}
                                          </a>
                                        </li>
                                      ) : null;
                                    })}
                                  </ul>
                                </div>
                              ) : null}
                            </div>
                          );
                        })()}
                      </details>
                    ) : null}

                    {Boolean(activeRun.resume_needed) ? (
                      <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 space-y-2">
                        {(() => {
                          const resumeError =
                            asString(activeRun?.resume_error).trim() ||
                            asString(activeRun?.last_status_body?.resume_error).trim() ||
                            asString(activeRun?.resume?.trigger_error).trim();

                          const resumeErrorDetails =
                            (activeRun?.resume_error_details && typeof activeRun.resume_error_details === "object")
                              ? activeRun.resume_error_details
                              : (activeRun?.last_status_body?.resume_error_details && typeof activeRun.last_status_body.resume_error_details === "object")
                                ? activeRun.last_status_body.resume_error_details
                                : (activeRun?.resume?.trigger_error_details && typeof activeRun.resume.trigger_error_details === "object")
                                  ? activeRun.resume.trigger_error_details
                                  : null;

                          const xaiDiag =
                            activeRun?.last_xai_diag_bundle && typeof activeRun.last_xai_diag_bundle === "object"
                              ? activeRun.last_xai_diag_bundle
                              : null;

                          return (
                            <>
                              <div className="font-medium">
                                {resumeStatus === "blocked"
                                  ? "Resume blocked"
                                  : resumeStatus === "queued"
                                    ? "Resume queued"
                                    : resumeStatus === "running"
                                      ? "Resume running"
                                      : resumeStatus === "stalled"
                                        ? "Resume stalled"
                                        : "Resume needed"}
                              </div>

                              <div className="text-amber-900/90">
                                <span className="font-medium">resume.status:</span> {resumeStatus || "—"}
                                {Number.isFinite(retryableMissingCount)
                                  ? ` · retryable missing: ${retryableMissingCount}`
                                  : ""}
                                {Number.isFinite(Number(stageBeaconValues.status_resume_missing_terminal))
                                  ? ` · terminal missing: ${Number(stageBeaconValues.status_resume_missing_terminal)}`
                                  : ""}
                              </div>

                              {resumeError ? (
                                <div className="text-amber-900/90 break-words">
                                  <span className="font-medium">resume_error:</span> {resumeError}
                                </div>
                              ) : null}

                              {resumeStatus === "blocked" ? (
                                <div className="text-amber-900/90">
                                  {(() => {
                                    const nextAutoRetryAt = asString(
                                      activeRun?.resume?.next_allowed_run_at || stageBeaconValues?.status_resume_next_allowed_at || ""
                                    ).trim();

                                    return (
                                      <>
                                        Auto-retries will continue{nextAutoRetryAt ? ` (next allowed run: ${nextAutoRetryAt}).` : "."}
                                      </>
                                    );
                                  })()}
                                  {(() => {
                                    const reason = asString(
                                      stageBeaconValues?.status_resume_blocked_reason ||
                                        stageBeaconValues?.status_resume_blocked_code ||
                                        resumeError ||
                                        activeRun?.resume?.trigger_error ||
                                        ""
                                    ).trim();

                                    return reason ? (
                                      <>
                                        {" "}Reason: <span className="font-medium">{reason}</span>.
                                      </>
                                    ) : null;
                                  })()}
                                  You can click "Retry resume" to force an immediate attempt.
                                </div>
                              ) : resumeStatus === "queued" ? (
                                <div className="text-amber-900/90">Waiting for the resume worker. Polling will automatically slow down.</div>
                              ) : resumeStatus === "running" ? (
                                <div className="text-amber-900/90">Resume worker is running. Polling will automatically slow down.</div>
                              ) : resumeStatus === "stalled" ? (
                                <div className="text-amber-900/90">
                                  Auto-retry is not running because the last enqueue failed. Click "Retry resume" to enqueue a new run.
                                </div>
                              ) : (
                                <div className="text-amber-900/90">
                                  Enrichment is still in progress. You can retry the resume worker if it stalled.
                                </div>
                              )}

                              <div className="flex flex-wrap items-center gap-2">
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="h-8"
                                  disabled={retryingResumeSessionId === activeRun.session_id}
                                  onClick={async () => {
                                    const sid = activeRun.session_id;
                                    if (!sid) return;
                                    setRetryingResumeSessionId(sid);
                                    try {
                                      await retryResumeWorker({ session_id: sid });
                                    } finally {
                                      setRetryingResumeSessionId(null);
                                    }
                                  }}
                                >
                                  {retryingResumeSessionId === activeRun.session_id ? (
                                    <>
                                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                      Retrying…
                                    </>
                                  ) : (
                                    "Retry resume"
                                  )}
                                </Button>

                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="h-8"
                                  onClick={() => runXaiDiag({ session_id: activeRun.session_id })}
                                >
                                  Run xAI diag
                                </Button>
                              </div>

                              <div className="mt-1 text-xs text-amber-900/80">
                                <span className="font-medium">Last resume worker:</span>{" "}
                                {asString(activeRun?.resume_worker?.last_invoked_at).trim() || "—"} →{" "}
                                {asString(activeRun?.resume_worker?.last_finished_at).trim() || "—"} ·{" "}
                                {asString(activeRun?.resume_worker?.last_result).trim() || "—"}
                              </div>

                              <div className="mt-1 text-xs text-amber-900/80">
                                <span className="font-medium">Last enqueue:</span>{" "}
                                {asString(activeRun?.resume_worker?.last_enqueued_at).trim() || "—"}
                                {asString(activeRun?.resume_worker?.last_enqueue_reason).trim()
                                  ? ` (${asString(activeRun.resume_worker.last_enqueue_reason).trim()})`
                                  : ""}
                                {asString(activeRun?.resume_worker?.last_enqueue_ok) === "false" && asString(activeRun?.resume_worker?.last_enqueue_error).trim()
                                  ? ` · error: ${asString(activeRun.resume_worker.last_enqueue_error).trim()}`
                                  : ""}
                              </div>

                              <div className="mt-1 text-xs text-amber-900/80">
                                <span className="font-medium">Planned fields:</span>{" "}
                                {Array.isArray(activeRun?.resume_worker?.planned_fields) && activeRun.resume_worker.planned_fields.length > 0
                                  ? activeRun.resume_worker.planned_fields.join(", ")
                                  : "—"}
                                {asString(activeRun?.resume_worker?.planned_fields_reason).trim()
                                  ? ` (${asString(activeRun.resume_worker.planned_fields_reason).trim()})`
                                  : ""}
                                <span className="mx-2">·</span>
                                <span className="font-medium">Attempted fields:</span>{" "}
                                {Array.isArray(activeRun?.resume_worker?.attempted_fields) && activeRun.resume_worker.attempted_fields.length > 0
                                  ? activeRun.resume_worker.attempted_fields.join(", ")
                                  : "—"}
                                <span className="mx-2">·</span>
                                <span className="font-medium">Last field:</span>{" "}
                                {asString(activeRun?.resume_worker?.last_field_attempted).trim() || "—"}
                                {asString(activeRun?.resume_worker?.last_field_result).trim()
                                  ? ` (${asString(activeRun.resume_worker.last_field_result).trim()})`
                                  : ""}
                              </div>

                              {resumeErrorDetails ? (
                                <details className="rounded border border-amber-200 bg-amber-100/30 p-2">
                                  <summary className="cursor-pointer select-none text-xs font-medium text-amber-900">Resume error details</summary>
                                  <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words text-[11px] text-amber-950">
                                    {toPrettyJsonText(resumeErrorDetails)}
                                  </pre>
                                </details>
                              ) : null}

                              {xaiDiag?.response ? (
                                <details className="rounded border border-amber-200 bg-amber-100/30 p-2">
                                  <summary className="cursor-pointer select-none text-xs font-medium text-amber-900">Latest xAI diag</summary>
                                  <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words text-[11px] text-amber-950">
                                    {toPrettyJsonText(xaiDiag.response?.body_json || xaiDiag.response || xaiDiag)}
                                  </pre>
                                </details>
                              ) : null}
                            </>
                          );
                        })()}

                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8"
                            disabled={!resumeDebugText}
                            onClick={async () => {
                              if (!resumeDebugText) return;
                              try {
                                await navigator.clipboard.writeText(resumeDebugText);
                                toast.success("Resume debug copied");
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
                            size="sm"
                            className="h-8"
                            disabled={!resumeDebugPayload}
                            onClick={() => {
                              if (!resumeDebugPayload) return;
                              try {
                                const sid = asString(activeRun?.session_id).trim() || "session";
                                downloadJsonFile({ filename: `resume-debug-${sid}.json`, value: resumeDebugPayload });
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
                    ) : null}

                    <div className="mt-3 rounded border border-slate-200 dark:border-border bg-white dark:bg-card p-3 space-y-2">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <div className="text-sm font-medium text-slate-900 dark:text-foreground">Resume Diagnostics</div>
                          <div className="mt-0.5 text-[11px] text-slate-600 dark:text-muted-foreground">
                            Populated from <code className="rounded bg-slate-100 dark:bg-muted px-1 py-0.5">/api/import/status</code>. Click "View status" to refresh.
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8"
                            disabled={!activeRun?.last_status_body}
                            onClick={async () => {
                              const payload = activeRun?.last_status_body;
                              if (!payload) return;
                              try {
                                await navigator.clipboard.writeText(toPrettyJsonText(payload));
                                toast.success("Status JSON copied");
                              } catch {
                                toast.error("Could not copy");
                              }
                            }}
                          >
                            <Copy className="h-4 w-4 mr-2" />
                            Copy status JSON
                          </Button>
                        </div>
                      </div>

                      {(() => {
                        const statusBody = activeRun?.last_status_body && typeof activeRun.last_status_body === "object" ? activeRun.last_status_body : null;
                        const resume = activeRun?.resume && typeof activeRun.resume === "object" ? activeRun.resume : null;
                        const resumeWorker = activeRun?.resume_worker && typeof activeRun.resume_worker === "object" ? activeRun.resume_worker : null;
                        const lastAuth = resumeWorker?.last_auth && typeof resumeWorker.last_auth === "object" ? resumeWorker.last_auth : null;

                        const buildId = asString(statusBody?.build_id).trim();
                        const handlerEnteredAt = asString(resumeWorker?.handler_entered_at).trim();
                        const handlerBuildId = asString(resumeWorker?.handler_entered_build_id).trim();

                        const lastHttpStatus =
                          typeof resumeWorker?.last_http_status === "number" && Number.isFinite(resumeWorker.last_http_status)
                            ? resumeWorker.last_http_status
                            : null;

                        const lastRejectLayer = asString(resumeWorker?.last_reject_layer).trim();

                        const authOk =
                          typeof lastAuth?.auth_ok === "boolean" ? String(lastAuth.auth_ok)
                          : typeof lastAuth?.ok === "boolean" ? String(lastAuth.ok)
                          : "";

                        const authMethodUsed = asString(lastAuth?.auth_method_used || lastAuth?.auth_method).trim();
                        const secretSource = asString(lastAuth?.secret_source).trim();

                        const resumeStatus = asString(resume?.status).trim();
                        const resumeWorkerLastInvokedAt = asString(resumeWorker?.last_invoked_at).trim();
                        const resumeWorkerLastFinishedAt = asString(resumeWorker?.last_finished_at).trim();
                        const resumeWorkerLastResult = asString(resumeWorker?.last_result).trim();

                        const stageBeaconValues =
                          statusBody?.stage_beacon_values && typeof statusBody.stage_beacon_values === "object"
                            ? statusBody.stage_beacon_values
                            : {};

                        const missingRetryable = Number(stageBeaconValues.status_resume_missing_retryable);
                        const missingTerminal = Number(stageBeaconValues.status_resume_missing_terminal);

                        return (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs text-slate-700 dark:text-muted-foreground">
                            <div>
                              <span className="font-medium">build_id:</span>{" "}
                              <code className="rounded bg-slate-100 dark:bg-muted px-1 py-0.5 break-all">{buildId || "—"}</code>
                            </div>
                            <div>
                              <span className="font-medium">resume.gateway_key_attached:</span>{" "}
                              <code className="rounded bg-slate-100 dark:bg-muted px-1 py-0.5">{String(resume?.gateway_key_attached ?? "—")}</code>
                            </div>
                            <div className="md:col-span-2">
                              <span className="font-medium">resume.trigger_request_id:</span>{" "}
                              <code className="rounded bg-slate-100 dark:bg-muted px-1 py-0.5 break-all">{asString(resume?.trigger_request_id).trim() || "—"}</code>
                            </div>

                            <div>
                              <span className="font-medium">resume.status:</span>{" "}
                              <code className="rounded bg-slate-100 dark:bg-muted px-1 py-0.5">{resumeStatus || "—"}</code>
                            </div>
                            <div>
                              <span className="font-medium">resume_worker.last_result:</span>{" "}
                              <code className="rounded bg-slate-100 dark:bg-muted px-1 py-0.5">{resumeWorkerLastResult || "—"}</code>
                            </div>
                            <div className="md:col-span-2">
                              <span className="font-medium">missing fields:</span>{" "}
                              <code className="rounded bg-slate-100 dark:bg-muted px-1 py-0.5">
                                {Number.isFinite(missingRetryable) ? missingRetryable : "—"} retryable ·{" "}
                                {Number.isFinite(missingTerminal) ? missingTerminal : "—"} terminal
                                {Boolean(stageBeaconValues.status_resume_terminal_only) ? " · terminal-only" : ""}
                              </code>
                            </div>
                            <div>
                              <span className="font-medium">resume_worker.last_invoked_at:</span>{" "}
                              <code className="rounded bg-slate-100 dark:bg-muted px-1 py-0.5 break-all">{resumeWorkerLastInvokedAt || "—"}</code>
                            </div>
                            <div>
                              <span className="font-medium">resume_worker.last_finished_at:</span>{" "}
                              <code className="rounded bg-slate-100 dark:bg-muted px-1 py-0.5 break-all">{resumeWorkerLastFinishedAt || "—"}</code>
                            </div>

                            <div>
                              <span className="font-medium">resume_worker_handler_entered_at:</span>{" "}
                              <code className="rounded bg-slate-100 dark:bg-muted px-1 py-0.5 break-all">{handlerEnteredAt || "—"}</code>
                            </div>
                            <div>
                              <span className="font-medium">resume_worker_handler_build_id:</span>{" "}
                              <code className="rounded bg-slate-100 dark:bg-muted px-1 py-0.5 break-all">{handlerBuildId || "—"}</code>
                            </div>
                            <div>
                              <span className="font-medium">resume_worker_last_http_status:</span>{" "}
                              <code className="rounded bg-slate-100 dark:bg-muted px-1 py-0.5">{lastHttpStatus != null ? lastHttpStatus : "—"}</code>
                            </div>
                            <div>
                              <span className="font-medium">resume_worker_last_reject_layer:</span>{" "}
                              <code className="rounded bg-slate-100 dark:bg-muted px-1 py-0.5">{lastRejectLayer || "—"}</code>
                            </div>
                            <div>
                              <span className="font-medium">resume_worker_last_auth.auth_ok:</span>{" "}
                              <code className="rounded bg-slate-100 dark:bg-muted px-1 py-0.5">{authOk || "—"}</code>
                            </div>
                            <div>
                              <span className="font-medium">resume_worker_last_auth.auth_method_used:</span>{" "}
                              <code className="rounded bg-slate-100 dark:bg-muted px-1 py-0.5">{authMethodUsed || "—"}</code>
                            </div>
                            <div className="md:col-span-2">
                              <span className="font-medium">resume_worker_last_auth.secret_source:</span>{" "}
                              <code className="rounded bg-slate-100 dark:bg-muted px-1 py-0.5 break-all">{secretSource || "—"}</code>
                            </div>

                            {!statusBody ? (
                              <div className="md:col-span-2 text-[11px] text-slate-500 dark:text-muted-foreground">
                                No status payload captured yet — click "View status".
                              </div>
                            ) : null}
                          </div>
                        );
                      })()}

                      <details className="rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-2">
                        <summary className="cursor-pointer select-none text-xs font-medium text-slate-700 dark:text-muted-foreground">Raw status JSON</summary>
                        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-[11px] text-slate-800 dark:text-foreground">
                          {activeRun?.last_status_body ? toPrettyJsonText(activeRun.last_status_body) : "No status payload yet."}
                        </pre>
                      </details>
                    </div>
                  </>
                );
              })()}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
