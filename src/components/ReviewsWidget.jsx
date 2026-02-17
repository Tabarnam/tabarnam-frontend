// src/components/ReviewsWidget.jsx
import React, { useEffect, useMemo, useState } from "react";
import { ArrowDownUp } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { withAmazonAffiliate } from "@/lib/amazonAffiliate";
import { normalizeExternalUrl } from "@/lib/externalUrl";
import { RatingDots } from "@/components/Stars";

function pickReviewDate(review) {
  if (!review || typeof review !== "object") return "";
  const raw =
    String(review.date || "").trim() ||
    String(review.published_at || "").trim() ||
    String(review.updated_at || "").trim() ||
    String(review.last_updated_at || "").trim() ||
    String(review.imported_at || "").trim() ||
    String(review.created_at || "").trim();
  return raw;
}

const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function formatReviewDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  // Avoid timezone shifts for date-only strings (admin uses YYYY-MM-DD).
  const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) {
    const y = Number(ymd[1]);
    const m = Number(ymd[2]);
    const d = Number(ymd[3]);
    return `${y}  ${SHORT_MONTHS[m - 1]}  ${d}`;
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return `${parsed.getFullYear()}  ${SHORT_MONTHS[parsed.getMonth()]}  ${parsed.getDate()}`;
  }

  return raw;
}

function parseReviewTimestamp(value) {
  const raw = String(value || "").trim();
  if (!raw) return 0;
  const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) return Date.UTC(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

export default function ReviewsWidget({ companyId, companyName, displayName }) {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [rating, setRating] = useState(5);
  const [text, setText] = useState("");
  const [userName, setUserName] = useState("");
  const [userLocation, setUserLocation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [sortDateDir, setSortDateDir] = useState(null); // null = default, "newest" | "oldest"

  async function load() {
    const id = String(companyId || "").trim();
    if (!id) {
      setList([]);
      return;
    }

    setLoading(true);
    setError("");
    try {
      const qs = `company_id=${encodeURIComponent(id)}`;
      const r = await apiFetch(`/get-reviews?${qs}`);
      const data = await r.json().catch(() => ({ items: [], reviews: [] }));
      if (!r.ok) throw new Error(data?.error || r.statusText || "Failed to load");
      const reviews = Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data?.reviews)
          ? data.reviews
          : [];
      setList(reviews);
    } catch (e) {
      setError(e?.message || "Failed to load reviews");
    } finally { setLoading(false); }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  async function submit() {
    setError("");
    if (!companyName) { setError("No company selected."); return; }
    if (!text.trim() || text.trim().length < 10) {
      setError("Please write a longer review (at least 10 characters)."); return;
    }
    setSubmitting(true);
    try {
      const r = await apiFetch("/submit-review", {
        method: "POST",
        body: {
          company_name: companyName,
          rating: Number(rating),
          text: text.trim(),
          user_name: userName.trim() || null,
          user_location: userLocation.trim() || null,
        },
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data?.ok) throw new Error(data?.error || r.statusText || "Submit failed");
      setList(prev => [data.review, ...prev]);
      setText(""); setUserName(""); setUserLocation(""); setRating(5);
    } catch (e) { setError(e?.message || "Submit failed"); }
    finally { setSubmitting(false); }
  }

  const titleName = String(displayName || companyName || "").trim();

  const sortedList = useMemo(() => {
    if (!sortDateDir) return list;
    return [...list].sort((a, b) => {
      const ta = parseReviewTimestamp(pickReviewDate(a));
      const tb = parseReviewTimestamp(pickReviewDate(b));
      return sortDateDir === "newest" ? tb - ta : ta - tb;
    });
  }, [list, sortDateDir]);

  const cycleSortDate = () => {
    setSortDateDir((prev) => {
      if (prev === null) return "newest";
      if (prev === "newest") return "oldest";
      return null;
    });
  };

  return (
    <div className="mt-3 border border-border rounded p-3 bg-muted/50">
      <div className="flex items-center justify-between mb-2">
        <div className="font-semibold">{titleName ? `Features & Reviews for ${titleName}` : "Features & Reviews"}</div>
        {list.length > 1 && (
          <button
            type="button"
            onClick={cycleSortDate}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors py-1 px-2 rounded-md hover:bg-muted border border-transparent hover:border-border"
            title={sortDateDir === "newest" ? "Sorted: newest first" : sortDateDir === "oldest" ? "Sorted: oldest first" : "Sort by date"}
          >
            <ArrowDownUp className="h-3 w-3" />
            {sortDateDir === "newest" ? "Newest first" : sortDateDir === "oldest" ? "Oldest first" : "Sort by date"}
          </button>
        )}
      </div>

      <div className="mt-4">
        {loading ? (
          <div className="text-sm text-muted-foreground">Loading reviews…</div>
        ) : error ? (
          <div className="text-sm text-red-600">{error}</div>
        ) : !list.length ? (
          <div className="text-sm text-muted-foreground">No reviews yet.</div>
        ) : (
          <ul className="space-y-3">
            {sortedList.map((r, idx) => {
              const sourceName = r.source_name || r.source || "";
              const sourceUrl = r.source_url || r.url || null;
              const normalizedSourceUrl = normalizeExternalUrl(String(sourceUrl || ""));
              const text = r.text || r.abstract || "";
              const author = (r.author || "").toString().trim();
              const title = (r.title || "").toString().trim();
              const truncateUrl = (url, maxLen = 40) => {
                if (!url) return null;
                return url.length > maxLen ? url.substring(0, maxLen) + "…" : url;
              };

              return (
                <li key={r.id || `${companyName || companyId || "company"}-${idx}`} className="bg-card border border-border rounded p-3">
                  <div className="flex items-center justify-between">
                    {normalizedSourceUrl ? (
                      <a
                        href={withAmazonAffiliate(normalizedSourceUrl)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-amber-600 hover:text-amber-700 dark:hover:text-amber-500 hover:underline transition-colors"
                        onClick={(e) => e.stopPropagation()}
                        title={`View on ${sourceName || "source"}`}
                      >
                        {sourceName || "Unknown Source"}
                      </a>
                    ) : (
                      <div className="font-medium text-amber-600">{sourceName || "Unknown Source"}</div>
                    )}
                    <div className="text-xs text-muted-foreground">
                      {formatReviewDate(pickReviewDate(r))}
                    </div>
                  </div>

                  {author && (
                    <div className="text-xs text-muted-foreground mt-0.5">by {author}</div>
                  )}

                  {title && (
                    <div className="font-semibold text-sm text-foreground mt-1">{title}</div>
                  )}

                  <div className="mt-2">
                    <p className="text-sm text-foreground mb-2">{text}</p>

                    {r.rating != null && (
                      <div className="flex items-center gap-2 mb-2">
                        <RatingDots value={Number(r.rating)} size={14} />
                        <div className="text-sm font-medium text-[#649BA0]">{Number(r.rating)}/5</div>
                      </div>
                    )}

                    {normalizedSourceUrl && (
                      <div className="text-xs mt-1">
                        <a
                          href={withAmazonAffiliate(normalizedSourceUrl)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 py-1.5 px-3 rounded-md border border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/40 hover:border-blue-300 dark:hover:border-blue-700 transition-colors"
                          title={withAmazonAffiliate(normalizedSourceUrl)}
                          onClick={(e) => e.stopPropagation()}
                        >
                          View on {sourceName || "source"}
                          <span className="text-blue-400 dark:text-blue-500">↗</span>
                        </a>
                      </div>
                    )}
                  </div>

                  {r.type === "user" && r.source.includes("(") && (
                    <div className="mt-2 text-xs text-muted-foreground">User submitted</div>
                  )}

                  {r.flagged_bot && (
                    <div className="mt-2 text-xs text-amber-700 bg-amber-50 inline-block px-2 py-1 rounded">
                      Flagged: {r.bot_reason || "possible automated content"}
                    </div>
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
