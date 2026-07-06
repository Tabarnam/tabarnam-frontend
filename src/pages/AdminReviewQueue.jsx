// src/pages/AdminReviewQueue.jsx
//
// Admin moderation queue for user-submitted reviews. Lists pending (and, via
// the filter, decided) reviews and lets an admin approve or reject each one
// with an optional response that feeds the automated decision email. Approving
// publishes the review, recalculates the company's Reputation/Quality scores,
// and emails the submitter.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Check, X, RefreshCw, Loader2, Bot } from "lucide-react";

import AdminHeader from "@/components/AdminHeader";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { RatingDots } from "@/components/Stars";
import { apiFetch } from "@/lib/api";

const STATUS_TABS = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "all", label: "All" },
];

function formatDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toLocaleString();
}

function StatusBadge({ status }) {
  const map = {
    pending: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
    approved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
    rejected: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  };
  const cls = map[status] || "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300";
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${cls}`}>{status || "—"}</span>;
}

export default function AdminReviewQueue() {
  const [statusFilter, setStatusFilter] = useState("pending");
  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState({}); // id -> admin response text
  const [actingId, setActingId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiFetch(`/xadmin-api-review-queue?status=${encodeURIComponent(statusFilter)}`);
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data?.ok) throw new Error(data?.error || r.statusText || "Failed to load");
      setReviews(Array.isArray(data.reviews) ? data.reviews : []);
    } catch (e) {
      toast.error(e?.message || "Failed to load review queue");
      setReviews([]);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const decide = async (review, decision) => {
    setActingId(review.id);
    try {
      const r = await apiFetch("/xadmin-api-review-decide", {
        method: "POST",
        body: {
          id: review.id,
          company: review.company || review.company_name,
          decision,
          admin_message: (messages[review.id] || "").trim(),
        },
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data?.ok) throw new Error(data?.error || r.statusText || "Action failed");

      if (decision === "approved") {
        const scored =
          typeof data.star4 === "number"
            ? ` Scores updated (rep ${data.star4.toFixed(2)}, quality ${data.star5.toFixed(2)}).`
            : "";
        toast.success(`Review approved.${scored}`);
      } else {
        toast.success("Review rejected.");
      }

      setMessages((m) => {
        const next = { ...m };
        delete next[review.id];
        return next;
      });
      load();
    } catch (e) {
      toast.error(e?.message || "Action failed");
    } finally {
      setActingId(null);
    }
  };

  const pendingCount = useMemo(
    () => reviews.filter((r) => r.status === "pending").length,
    [reviews]
  );

  return (
    <div className="min-h-screen bg-background">
      <AdminHeader />
      <div className="mx-auto max-w-5xl px-4 py-6">
        <div className="mb-4 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Review Queue</h1>
            <p className="text-sm text-muted-foreground">
              Approve or reject user-submitted reviews. Approving publishes the review, recalculates the
              company scores, and emails the submitter.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          {STATUS_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setStatusFilter(t.key)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                statusFilter === t.key
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-accent"
              }`}
            >
              {t.label}
            </button>
          ))}
          {statusFilter === "pending" && !loading && (
            <span className="ml-2 text-sm text-muted-foreground">{pendingCount} pending</span>
          )}
        </div>

        {loading ? (
          <div className="flex items-center gap-2 py-12 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : reviews.length === 0 ? (
          <div className="rounded border border-border bg-card p-8 text-center text-muted-foreground">
            No {statusFilter === "all" ? "" : statusFilter} reviews.
          </div>
        ) : (
          <ul className="space-y-4">
            {reviews.map((review) => {
              const isActing = actingId === review.id;
              const isPending = review.status === "pending";
              return (
                <li key={review.id} className="rounded-lg border border-border bg-card p-4 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="font-semibold text-foreground">
                        {review.company_name || review.company || "Unknown company"}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {review.user_name || "Anonymous"}
                        {review.user_email ? ` · ${review.user_email}` : ""}
                        {review.created_at ? ` · ${formatDate(review.created_at)}` : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {review.flagged_bot && (
                        <span
                          className="inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
                          title={review.bot_reason || "Flagged as possible automated content"}
                        >
                          <Bot className="h-3 w-3" /> bot?
                        </span>
                      )}
                      <StatusBadge status={review.status} />
                    </div>
                  </div>

                  {review.subject && (
                    <div className="mt-2 text-sm font-semibold text-foreground">{review.subject}</div>
                  )}

                  {review.rating != null && (
                    <div className="mt-1 flex items-center gap-2">
                      <RatingDots value={Number(review.rating)} size={14} />
                      <span className="text-sm text-muted-foreground">{Number(review.rating)}/5</span>
                    </div>
                  )}

                  <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{review.text}</p>

                  {isPending ? (
                    <div className="mt-3 space-y-2">
                      <Textarea
                        rows={2}
                        placeholder="Optional response to the reviewer (included in the approval/rejection email)…"
                        value={messages[review.id] || ""}
                        onChange={(e) => setMessages((m) => ({ ...m, [review.id]: e.target.value }))}
                      />
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          onClick={() => decide(review, "approved")}
                          disabled={isActing}
                          className="bg-emerald-600 hover:bg-emerald-700 text-white"
                        >
                          {isActing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => decide(review, "rejected")}
                          disabled={isActing}
                          className="border-red-500 text-red-600 hover:bg-red-600 hover:text-white"
                        >
                          <X className="mr-2 h-4 w-4" />
                          Reject
                        </Button>
                      </div>
                    </div>
                  ) : (
                    (review.admin_message || review.reason) && (
                      <div className="mt-3 rounded border border-border bg-muted/50 p-2 text-xs text-muted-foreground">
                        <span className="font-medium">Response sent:</span>{" "}
                        {review.admin_message || review.reason}
                        {review.decided_by ? ` — ${review.decided_by}` : ""}
                      </div>
                    )
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
