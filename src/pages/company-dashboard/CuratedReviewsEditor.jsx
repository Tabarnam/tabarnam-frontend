import React, { useCallback } from "react";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { normalizeExternalUrl } from "@/lib/externalUrl";

import {
  asString,
  normalizeIsPublicFlag,
} from "./dashboardUtils";

export default function CuratedReviewsEditor({ value, onChange, disabled }) {
  const list = Array.isArray(value) ? value : [];

  const addReview = useCallback(() => {
    const now = new Date().toISOString();
    const id = `admin_manual_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    onChange([
      {
        id,
        source: "admin_manual",
        source_name: "",
        author: "",
        title: "",
        source_url: "",
        url: "",
        excerpt: "",
        abstract: "",
        content: "",
        date: "",
        rating: null,
        include_on_save: true,
        show_to_users: true,
        is_public: true,
        created_at: now,
        last_updated_at: now,
      },
      ...list,
    ]);
  }, [list, onChange]);

  const removeReview = useCallback(
    (idx) => {
      onChange(list.filter((_, i) => i !== idx));
    },
    [list, onChange]
  );

  const moveReview = useCallback(
    (idx, dir) => {
      const next = [...list];
      const to = idx + dir;
      if (to < 0 || to >= next.length) return;
      const tmp = next[idx];
      next[idx] = next[to];
      next[to] = tmp;
      onChange(next);
    },
    [list, onChange]
  );

  const updateReview = useCallback(
    (idx, patch) => {
      const now = new Date().toISOString();
      onChange(
        list.map((r, i) => {
          if (i !== idx) return r;
          const base = r && typeof r === "object" ? r : {};
          const merged = { ...base, ...(patch || {}), include_on_save: true, last_updated_at: now };

          if (Object.prototype.hasOwnProperty.call(patch || {}, "show_to_users")) {
            merged.is_public = Boolean(patch.show_to_users);
          }
          if (Object.prototype.hasOwnProperty.call(patch || {}, "is_public")) {
            merged.show_to_users = Boolean(patch.is_public);
          }

          const urlRaw = asString(merged.source_url || merged.url).trim();
          merged.source_url = urlRaw;
          merged.url = urlRaw;

          const text = asString(merged.excerpt || merged.abstract || merged.content).trim();
          merged.excerpt = text;
          merged.abstract = text;
          merged.content = text;

          return merged;
        })
      );
    },
    [list, onChange]
  );

  const hasAny = list.length > 0;

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 dark:border-border bg-white dark:bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-slate-900 dark:text-foreground">Admin reviews</div>
          <div className="mt-1 text-xs text-slate-600 dark:text-muted-foreground">
            Create/edit curated reviews. These can appear on the public company page when <code>show_to_users</code> is enabled.
          </div>
        </div>
        <Button type="button" size="sm" onClick={addReview} disabled={disabled}>
          <Plus className="h-4 w-4 mr-2" />
          Add review
        </Button>
      </div>

      {!hasAny ? (
        <div className="rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-3 text-xs text-slate-600 dark:text-muted-foreground">
          No curated reviews yet.
        </div>
      ) : (
        <div className="space-y-3">
          {list.map((review, idx) => {
            const showToUsers = normalizeIsPublicFlag(
              review?.show_to_users ?? review?.showToUsers ?? review?.is_public ?? review?.visible_to_users ?? review?.visible,
              true
            );

            const urlRaw = asString(review?.source_url || review?.url).trim();
            const normalizedUrl = normalizeExternalUrl(urlRaw);
            const urlIsInvalid = Boolean(urlRaw) && !normalizedUrl;

            return (
              <div key={asString(review?.id).trim() || `manual-${idx}`} className="rounded-lg border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-900 dark:text-foreground truncate">
                      {asString(review?.source_name || review?.author || review?.source || "Review").trim() || "Review"}
                    </div>
                    <div className="mt-0.5 text-[11px] text-slate-500 dark:text-muted-foreground">
                      {showToUsers ? "show_to_users" : "hidden"}
                      {urlIsInvalid ? " • invalid URL" : ""}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => moveReview(idx, -1)}
                      disabled={disabled || idx === 0}
                      title="Move up"
                    >
                      ↑
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => moveReview(idx, 1)}
                      disabled={disabled || idx === list.length - 1}
                      title="Move down"
                    >
                      ↓
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="border-red-600 text-red-600 hover:bg-red-600 hover:text-white"
                      onClick={() => removeReview(idx)}
                      disabled={disabled}
                      title="Delete review"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-slate-700 dark:text-muted-foreground">Source name</label>
                    <Input
                      value={asString(review?.source_name)}
                      onChange={(e) => updateReview(idx, { source_name: e.target.value })}
                      disabled={disabled}
                      placeholder="Architectural Digest"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-slate-700 dark:text-muted-foreground">Author</label>
                    <Input
                      value={asString(review?.author)}
                      onChange={(e) => updateReview(idx, { author: e.target.value })}
                      disabled={disabled}
                      placeholder="(optional)"
                    />
                  </div>

                  <div className="space-y-1 md:col-span-2">
                    <label className="text-[11px] font-medium text-slate-700 dark:text-muted-foreground">Source URL</label>
                    <Input
                      value={asString(review?.source_url || review?.url)}
                      onChange={(e) => updateReview(idx, { source_url: e.target.value, url: e.target.value })}
                      disabled={disabled}
                      placeholder="https://..."
                    />
                    {urlIsInvalid ? <div className="text-[11px] text-amber-800">URL is not a valid http(s) link.</div> : null}
                  </div>

                  <div className="space-y-1 md:col-span-2">
                    <label className="text-[11px] font-medium text-slate-700 dark:text-muted-foreground">Title</label>
                    <Input
                      value={asString(review?.title)}
                      onChange={(e) => updateReview(idx, { title: e.target.value })}
                      disabled={disabled}
                      placeholder="(optional)"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-slate-700 dark:text-muted-foreground">Date</label>
                    <Input
                      value={asString(review?.date)}
                      onChange={(e) => updateReview(idx, { date: e.target.value })}
                      disabled={disabled}
                      placeholder="YYYY-MM-DD"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-slate-700 dark:text-muted-foreground">Rating</label>
                    <Input
                      value={review?.rating == null ? "" : String(review.rating)}
                      onChange={(e) => {
                        const raw = e.target.value;
                        const parsed = raw.trim() ? Number(raw) : null;
                        updateReview(idx, { rating: parsed != null && Number.isFinite(parsed) ? parsed : null });
                      }}
                      disabled={disabled}
                      placeholder="(optional)"
                    />
                  </div>

                  <div className="md:col-span-2">
                    <label className="flex items-start gap-2 text-sm text-slate-800 dark:text-foreground">
                      <Checkbox
                        checked={Boolean(showToUsers)}
                        onCheckedChange={(v) => updateReview(idx, { show_to_users: Boolean(v) })}
                        disabled={disabled}
                      />
                      <span>Show to users</span>
                    </label>
                  </div>

                  <div className="space-y-1 md:col-span-2">
                    <label className="text-[11px] font-medium text-slate-700 dark:text-muted-foreground">Excerpt</label>
                    <Textarea
                      value={asString(review?.excerpt || review?.abstract || review?.content)}
                      onChange={(e) => updateReview(idx, { excerpt: e.target.value, abstract: e.target.value, content: e.target.value })}
                      disabled={disabled}
                      className="min-h-[110px]"
                      placeholder="Write the review snippet..."
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
