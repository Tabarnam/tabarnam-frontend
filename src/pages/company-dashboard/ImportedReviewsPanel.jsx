import React, { useCallback, useEffect, useState } from "react";
import { AlertCircle, RefreshCcw, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import { apiFetch, getUserFacingConfigMessage } from "@/lib/api";
import { normalizeExternalUrl } from "@/lib/externalUrl";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

import {
  asString,
  isCuratedReviewPubliclyVisible,
  normalizeImportedReviewsPayload,
  getReviewSourceName,
  getReviewText,
  getReviewUrl,
  getReviewDate,
  getReviewRating,
  extractReviewMetadata,
  normalizeIsPublicFlag,
  toDisplayDate,
  truncateMiddle,
} from "./dashboardUtils";

export default function ImportedReviewsPanel({
  companyId,
  companyName,
  existingCuratedReviews,
  disabled,
  onDeleteSavedReview,
  onUpdateSavedReview,
}) {
  const stableId = asString(companyId).trim();
  const stableCompanyName = asString(companyName).trim();
  const savedItems = Array.isArray(existingCuratedReviews) ? existingCuratedReviews : [];
  const savedVisibleCount = savedItems.filter(isCuratedReviewPubliclyVisible).length;

  const [visibilitySavingById, setVisibilitySavingById] = useState({});

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [items, setItems] = useState([]);

  const [deleteReviewOpen, setDeleteReviewOpen] = useState(false);
  const [deleteReviewTarget, setDeleteReviewTarget] = useState(null);

  const openDeleteReviewConfirm = useCallback(
    (review, index) => {
      if (disabled) return;
      setDeleteReviewTarget({ review, index });
      setDeleteReviewOpen(true);
    },
    [disabled]
  );

  const confirmDeleteReview = useCallback(() => {
    const target = deleteReviewTarget;
    if (!target) return;

    const reviewId = asString(target?.review?.id).trim();
    onDeleteSavedReview?.(reviewId, target.index);

    setDeleteReviewOpen(false);
    setDeleteReviewTarget(null);
    toast.success("Review removed from this draft. Click Save changes to persist.");
  }, [deleteReviewTarget, onDeleteSavedReview]);

  const load = useCallback(async () => {
    const id = asString(stableId).trim();
    if (!id) {
      setItems([]);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await apiFetch(`/get-reviews?company_id=${encodeURIComponent(id)}`);
      const data = await res.json().catch(() => ({ items: [], reviews: [] }));
      if (!res.ok) {
        throw new Error(asString(data?.error).trim() || res.statusText || "Failed to load imported reviews");
      }

      const normalized = normalizeImportedReviewsPayload(data);
      const list = Array.isArray(normalized.items) ? normalized.items : [];
      setItems(list);
    } catch (e) {
      setError({ message: asString(e?.message).trim() || "Failed to load imported reviews" });
    } finally {
      setLoading(false);
    }
  }, [stableId]);

  const toggleSavedReviewVisibility = useCallback(
    async (review, nextVisible) => {
      if (disabled) return;
      const reviewId = asString(review?.id).trim();
      if (!stableId || !reviewId) {
        toast.error("Missing company_id or review id");
        return;
      }

      setVisibilitySavingById((prev) => ({ ...(prev || {}), [reviewId]: true }));
      try {
        const res = await apiFetch("/xadmin-api-reviews", {
          method: "PUT",
          body: {
            company_id: stableId,
            ...(stableCompanyName ? { company: stableCompanyName } : {}),
            review_id: reviewId,
            show_to_users: Boolean(nextVisible),
          },
        });

        const body = await res.json().catch(() => ({}));
        if (!res.ok || body?.ok !== true) {
          const msg =
            asString(body?.error).trim() ||
            asString(body?.message).trim() ||
            (await getUserFacingConfigMessage(res)) ||
            `Update failed (${res.status})`;
          toast.error(msg);
          return;
        }

        const updated = body?.review && typeof body.review === "object" ? body.review : null;
        if (updated) {
          onUpdateSavedReview?.(reviewId, updated);
        } else {
          onUpdateSavedReview?.(reviewId, { show_to_users: Boolean(nextVisible), is_public: Boolean(nextVisible) });
        }

        toast.success(Boolean(nextVisible) ? "Review is now visible" : "Review is now hidden");
        await load();
      } catch (e) {
        toast.error(asString(e?.message).trim() || "Update failed");
      } finally {
        setVisibilitySavingById((prev) => {
          const next = { ...(prev || {}) };
          delete next[asString(review?.id).trim()];
          return next;
        });
      }
    },
    [disabled, load, onUpdateSavedReview, stableCompanyName, stableId]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!stableId) {
        setItems([]);
        setError(null);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const res = await apiFetch(`/get-reviews?company_id=${encodeURIComponent(stableId)}`);
        const data = await res.json().catch(() => ({ items: [], reviews: [] }));
        if (!res.ok) {
          throw new Error(asString(data?.error).trim() || res.statusText || "Failed to load imported reviews");
        }

        const normalized = normalizeImportedReviewsPayload(data);
        const list = Array.isArray(normalized.items) ? normalized.items : [];
        if (!cancelled) setItems(list);
      } catch (e) {
        if (!cancelled) {
          setError({ message: asString(e?.message).trim() || "Failed to load imported reviews" });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [stableId]);

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 dark:border-border bg-white dark:bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-slate-900 dark:text-foreground">Imported reviews (read only)</div>
          <div className="mt-1 text-xs text-slate-600 dark:text-muted-foreground">
            Saved on company record: <span className="font-medium">{savedItems.length}</span>
            <span className="mx-1">•</span>
            Publicly visible: <span className="font-medium">{savedVisibleCount}</span>
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-muted-foreground">
            Public list fetched from <code className="text-[11px]">/api/get-reviews?company_id=…</code>
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-muted-foreground">To remove a curated review, click the red trash icon, then Save changes.</div>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={load} disabled={!stableId || loading}>
          <RefreshCcw className="h-4 w-4 mr-2" />
          {loading ? "Loading…" : "Retry"}
        </Button>
      </div>

      <AlertDialog
        open={deleteReviewOpen}
        onOpenChange={(open) => {
          if (disabled) return;
          setDeleteReviewOpen(open);
          if (!open) setDeleteReviewTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete review</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the selected review from <code className="text-xs">company.curated_reviews</code>. You still need to click
              <span className="font-medium"> Save changes</span> to persist it.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-1 text-sm text-slate-700 dark:text-muted-foreground">
            <div>
              Review:
              <span className="font-semibold"> {asString(getReviewSourceName(deleteReviewTarget?.review) || "Unknown source")}</span>
            </div>
            {asString(deleteReviewTarget?.review?.id).trim() ? (
              <div>
                id: <code className="text-xs">{asString(deleteReviewTarget?.review?.id).trim()}</code>
              </div>
            ) : null}
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={disabled}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                confirmDeleteReview();
              }}
              disabled={disabled || !deleteReviewTarget}
              className="bg-red-600 hover:bg-red-600/90"
            >
              Delete review
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {!stableId ? (
        <div className="rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-3 text-xs text-slate-600 dark:text-muted-foreground">
          Save the company first to generate a <code className="text-[11px]">company_id</code>.
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="text-xs font-medium text-slate-700 dark:text-muted-foreground">Saved curated reviews (company.curated_reviews)</div>
            {savedItems.length === 0 ? (
              <div className="rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-3 text-xs text-slate-600 dark:text-muted-foreground">
                No curated reviews are saved on this company record.
              </div>
            ) : (
              <div className="space-y-3">
                {savedItems.map((review, idx) => {
                  const reviewId = asString(review?.id).trim();
                  const sourceName = getReviewSourceName(review) || "Unknown source";
                  const text = getReviewText(review);
                  const urlRaw = getReviewUrl(review);
                  const url = normalizeExternalUrl(urlRaw);
                  const date = getReviewDate(review);
                  const rating = getReviewRating(review);

                  const publishable = isCuratedReviewPubliclyVisible(review);
                  const showToUsersFlag =
                    review?.show_to_users ??
                    review?.showToUsers ??
                    review?.is_public ??
                    review?.visible_to_users ??
                    review?.visible;

                  const showToUsers = normalizeIsPublicFlag(showToUsersFlag, true);
                  const linkStatus = asString(review?.link_status ?? review?.linkStatus).trim();

                  const mcRaw = review?.match_confidence ?? review?.matchConfidence;
                  const mc =
                    typeof mcRaw === "number" ? mcRaw : typeof mcRaw === "string" && mcRaw.trim() ? Number(mcRaw) : null;

                  return (
                    <div
                      key={asString(review?.id).trim() || `${stableId}-saved-${idx}`}
                      className="rounded-lg border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-3 space-y-2"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-slate-900 dark:text-foreground truncate">{sourceName}</div>
                          {date ? <div className="text-xs text-slate-500 dark:text-muted-foreground">{toDisplayDate(date)}</div> : null}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={
                              publishable
                                ? "inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-900"
                                : "inline-flex items-center rounded-full border border-slate-200 dark:border-border bg-white dark:bg-card px-2 py-0.5 text-[11px] text-slate-700 dark:text-muted-foreground"
                            }
                            title={publishable ? "Returned by /api/get-reviews" : "Not returned by /api/get-reviews"}
                          >
                            {publishable ? "Public" : "Not public"}
                          </span>

                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 rounded-full px-2 py-0 text-[11px]"
                            onClick={() => toggleSavedReviewVisibility(review, !showToUsers)}
                            disabled={disabled || !reviewId || Boolean(visibilitySavingById?.[reviewId])}
                            title="Toggle whether this review can appear on the public site"
                          >
                            {Boolean(visibilitySavingById?.[reviewId]) ? "Saving…" : showToUsers ? "show_to_users" : "hidden"}
                          </Button>

                          {linkStatus ? (
                            <span className="inline-flex items-center rounded-full border border-slate-200 dark:border-border bg-white dark:bg-card px-2 py-0.5 text-[11px] text-slate-700 dark:text-muted-foreground">
                              link_status: {linkStatus}
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-900">
                              link_status: missing
                            </span>
                          )}

                          {typeof mc === "number" && Number.isFinite(mc) ? (
                            <span className="inline-flex items-center rounded-full border border-slate-200 dark:border-border bg-white dark:bg-card px-2 py-0.5 text-[11px] text-slate-700 dark:text-muted-foreground">
                              match: {mc.toFixed(2)}
                            </span>
                          ) : null}

                          {rating != null ? (
                            <span className="inline-flex items-center rounded-full border border-slate-200 dark:border-border bg-white dark:bg-card px-2 py-0.5 text-[11px] text-slate-700 dark:text-muted-foreground">
                              Rating: {rating}
                            </span>
                          ) : null}

                          <Button
                            type="button"
                            variant="destructive"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => openDeleteReviewConfirm(review, idx)}
                            disabled={disabled}
                            title="Delete curated review"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>

                      {asString(review?.title).trim() ? (
                        <div className="text-xs font-medium text-slate-800 dark:text-foreground">{asString(review.title).trim()}</div>
                      ) : null}

                      {text ? (
                        <div className="text-sm text-slate-800 dark:text-foreground whitespace-pre-wrap break-words">{text}</div>
                      ) : (
                        <div className="text-xs text-slate-500 dark:text-muted-foreground">(No text snippet saved)</div>
                      )}

                      {url ? (
                        <div className="text-xs">
                          <a
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-700 hover:underline break-all"
                            title={urlRaw}
                          >
                            {truncateMiddle(urlRaw, 90)}
                          </a>
                        </div>
                      ) : (
                        <div className="text-xs text-slate-500 dark:text-muted-foreground">(No valid URL)</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div className="text-xs font-medium text-slate-700 dark:text-muted-foreground">Public reviews (returned by /api/get-reviews)</div>

            {error ? (
              <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-900">
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 mt-0.5" />
                  <div className="min-w-0">
                    <div className="font-medium">Public reviews failed to load</div>
                    <div className="text-xs mt-1 break-words">{asString(error.message)}</div>
                  </div>
                </div>
              </div>
            ) : loading ? (
              <div className="rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-3 text-xs text-slate-700 dark:text-muted-foreground">Loading public reviews…</div>
            ) : items.length === 0 ? (
              <div className="rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-3 text-xs text-slate-600 dark:text-muted-foreground">
                No public reviews returned for this company_id.
                {savedItems.length > 0 && savedVisibleCount === 0 ? (
                  <div className="mt-2 text-[11px] text-slate-500 dark:text-muted-foreground">
                    Note: curated reviews are saved, but are not publishable until they have a valid URL, <code>link_status</code> set to <code>ok</code>, and (optionally) a high <code>match_confidence</code>.
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="space-y-3">
                {items.map((review, idx) => {
                  const sourceName = getReviewSourceName(review) || "Unknown source";
                  const text = getReviewText(review);
                  const urlRaw = getReviewUrl(review);
                  const url = normalizeExternalUrl(urlRaw);
                  const date = getReviewDate(review);
                  const rating = getReviewRating(review);
                  const metadata = extractReviewMetadata(review);

                  return (
                    <div
                      key={asString(review?.id).trim() || `${stableId}-public-${idx}`}
                      className="rounded-lg border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-3 space-y-2"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-slate-900 dark:text-foreground truncate">{sourceName}</div>
                          {date ? <div className="text-xs text-slate-500 dark:text-muted-foreground">{toDisplayDate(date)}</div> : null}
                        </div>
                        <div className="flex items-center gap-2">
                          {rating != null ? (
                            <span className="inline-flex items-center rounded-full border border-slate-200 dark:border-border bg-white dark:bg-card px-2 py-0.5 text-[11px] text-slate-700 dark:text-muted-foreground">
                              Rating: {rating}
                            </span>
                          ) : null}
                          {asString(review?.type).trim() ? (
                            <span className="inline-flex items-center rounded-full border border-slate-200 dark:border-border bg-white dark:bg-card px-2 py-0.5 text-[11px] text-slate-700 dark:text-muted-foreground">
                              {asString(review.type).trim()}
                            </span>
                          ) : null}
                        </div>
                      </div>

                      {text ? (
                        <div className="text-sm text-slate-800 dark:text-foreground whitespace-pre-wrap break-words">{text}</div>
                      ) : (
                        <div className="text-xs text-slate-500 dark:text-muted-foreground">(No text snippet returned)</div>
                      )}

                      {url ? (
                        <div className="text-xs">
                          <a
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-700 hover:underline break-all"
                            title={urlRaw}
                          >
                            {truncateMiddle(urlRaw, 90)}
                          </a>
                        </div>
                      ) : null}

                      {metadata.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {metadata.map(([k, v]) => (
                            <span
                              key={k}
                              className="inline-flex items-center rounded-full border border-slate-200 dark:border-border bg-white dark:bg-card px-2 py-0.5 text-[11px] text-slate-700 dark:text-muted-foreground"
                              title={`${k}: ${v}`}
                            >
                              {k}: {truncateMiddle(v, 40)}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
