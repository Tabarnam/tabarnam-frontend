// src/pages/company-dashboard/UserReviewsPanel.jsx
//
// Admin management of APPROVED user-submitted reviews for a company, shown in the
// company profile editor next to curated reviews. Lists reviews from the reviews
// container and lets an admin edit (subject/text/rating) or remove each one.
// Each action hits /xadmin-api-user-reviews, which keeps the reviews container,
// the company-doc embed, and the Reputation/Quality scores in sync (rescore).
//
// Self-contained: manages its own fetch + state, independent of the company
// draft save flow (user reviews have their own store + endpoint).

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api";

function fmtDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toLocaleDateString();
}

export default function UserReviewsPanel({ companyId, companyName }) {
  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [editId, setEditId] = useState(null);
  const [draft, setDraft] = useState({ subject: "", text: "", rating: "" });

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (companyId) p.set("company_id", String(companyId));
    if (companyName) p.set("company", String(companyName));
    return p.toString();
  }, [companyId, companyName]);

  const load = useCallback(async () => {
    if (!qs) {
      setReviews([]);
      return;
    }
    setLoading(true);
    try {
      const r = await apiFetch(`/xadmin-api-user-reviews?${qs}`);
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data?.ok) throw new Error(data?.error || r.statusText || "Failed to load");
      setReviews(Array.isArray(data.reviews) ? data.reviews : []);
    } catch (e) {
      toast.error(e?.message || "Failed to load user reviews");
      setReviews([]);
    } finally {
      setLoading(false);
    }
  }, [qs]);

  useEffect(() => {
    load();
  }, [load]);

  const startEdit = (rev) => {
    setEditId(rev.id);
    setDraft({
      subject: rev.subject || "",
      text: rev.text || "",
      rating: rev.rating == null ? "" : String(rev.rating),
    });
  };

  const saveEdit = async (rev) => {
    setBusyId(rev.id);
    try {
      const r = await apiFetch("/xadmin-api-user-reviews", {
        method: "PUT",
        body: {
          id: rev.id,
          company: rev.company || rev.company_name,
          subject: draft.subject,
          text: draft.text,
          rating: draft.rating === "" ? null : Number(draft.rating),
        },
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data?.ok) throw new Error(data?.error || r.statusText || "Save failed");
      const scored = typeof data.star4 === "number" ? ` Scores updated (${data.star4.toFixed(2)}/${data.star5.toFixed(2)}).` : "";
      toast.success(`Review updated.${scored}`);
      setEditId(null);
      load();
    } catch (e) {
      toast.error(e?.message || "Save failed");
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (rev) => {
    if (!window.confirm("Remove this review? It will be unpublished from the company profile and the scores recalculated.")) return;
    setBusyId(rev.id);
    try {
      const r = await apiFetch("/xadmin-api-user-reviews", {
        method: "DELETE",
        body: { id: rev.id, company: rev.company || rev.company_name },
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data?.ok) throw new Error(data?.error || r.statusText || "Remove failed");
      toast.success("Review removed.");
      load();
    } catch (e) {
      toast.error(e?.message || "Remove failed");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="rounded-md border border-slate-200 dark:border-border bg-white dark:bg-card p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-800 dark:text-foreground">
          Community reviews{reviews.length ? ` (${reviews.length})` : ""}
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="text-xs text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {reviews.length === 0 ? (
        <div className="text-xs text-slate-500 dark:text-muted-foreground py-2">
          {loading ? "Loading…" : "No approved community reviews."}
        </div>
      ) : (
        <ul className="space-y-2">
          {reviews.map((rev) => {
            const isEditing = editId === rev.id;
            const isBusy = busyId === rev.id;
            return (
              <li key={rev.id} className="rounded border border-slate-200 dark:border-border p-2">
                <div className="flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-muted-foreground">
                  <span>
                    {/* Admin-only identity — never shown to the public */}
                    {rev.user_name || "Anonymous"}
                    {rev.user_email ? ` · ${rev.user_email}${rev.show_email ? " (public)" : ""}` : ""}
                    {rev.created_at ? ` · ${fmtDate(rev.created_at)}` : ""}
                  </span>
                  {rev.flagged_bot && <span className="text-amber-600">bot?</span>}
                </div>

                {isEditing ? (
                  <div className="mt-2 space-y-2">
                    <input
                      className="w-full rounded border border-slate-300 dark:border-border bg-transparent px-2 py-1 text-sm"
                      placeholder="Subject (optional)"
                      value={draft.subject}
                      onChange={(e) => setDraft((d) => ({ ...d, subject: e.target.value }))}
                    />
                    <textarea
                      rows={3}
                      className="w-full rounded border border-slate-300 dark:border-border bg-transparent px-2 py-1 text-sm"
                      value={draft.text}
                      onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))}
                    />
                    <input
                      type="number"
                      min={0}
                      max={5}
                      step={0.1}
                      className="w-24 rounded border border-slate-300 dark:border-border bg-transparent px-2 py-1 text-sm"
                      placeholder="0–5"
                      value={draft.rating}
                      onChange={(e) => setDraft((d) => ({ ...d, rating: e.target.value }))}
                    />
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => saveEdit(rev)}
                        disabled={isBusy}
                        className="rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                      >
                        {isBusy ? "Saving…" : "Save"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditId(null)}
                        disabled={isBusy}
                        className="rounded border border-slate-300 dark:border-border px-2 py-1 text-xs"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {rev.subject && <div className="mt-1 text-sm font-medium text-slate-800 dark:text-foreground">{rev.subject}</div>}
                    <div className="mt-1 whitespace-pre-wrap text-sm text-slate-700 dark:text-foreground">{rev.text}</div>
                    {rev.rating != null && <div className="mt-1 text-xs text-slate-500 dark:text-muted-foreground">{Number(rev.rating)}/5</div>}
                    <div className="mt-2 flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => startEdit(rev)}
                        disabled={isBusy}
                        className="text-xs text-blue-600 hover:underline dark:text-blue-400"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(rev)}
                        disabled={isBusy}
                        className="text-xs text-red-600 hover:underline"
                      >
                        {isBusy ? "…" : "Remove"}
                      </button>
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
