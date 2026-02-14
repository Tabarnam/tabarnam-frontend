import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { ChevronDown, ChevronRight, Loader2, CheckCircle2, XCircle, Circle, Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/lib/toast";
import { apiFetch } from "@/lib/api";
import { normalizeReviewDedupUrl } from "./dashboardUtils";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Parse textarea content into an array of valid http(s):// URLs. */
function parseUrls(text) {
  return String(text || "")
    .split(/[\n\r]+/)
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\/.+/i.test(line));
}

/** Remove duplicate URLs using normalized comparison. */
function deduplicateUrls(urls) {
  const seen = new Set();
  const unique = [];
  for (const u of urls) {
    const key = normalizeReviewDedupUrl(u) || u;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(u);
  }
  return unique;
}

/** Build a review object from scrape response data. */
function buildReviewObject(data, originalUrl) {
  const now = new Date().toISOString();
  return {
    id: `admin_link_import_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    source: "admin_link_import",
    source_name: data.source_name || "",
    author: data.author || "",
    title: data.title || "",
    source_url: data.source_url || originalUrl,
    url: data.source_url || originalUrl,
    excerpt: data.excerpt || "",
    abstract: data.excerpt || "",
    content: data.excerpt || "",
    date: data.date || "",
    rating: data.rating ?? null,
    show_to_users: true,
    is_public: true,
    include_on_save: true,
    created_at: now,
    last_updated_at: now,
  };
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function ReviewLinkFetcher({ onAddReview, disabled }) {
  const [isOpen, setIsOpen] = useState(false);
  const [inputText, setInputText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [fields, setFields] = useState(null);

  // Batch mode state
  const [batchMode, setBatchMode] = useState(false);
  const [batchItems, setBatchItems] = useState([]);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchComplete, setBatchComplete] = useState(false);

  const cancelRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const parsedUrls = useMemo(() => deduplicateUrls(parseUrls(inputText)), [inputText]);
  const urlCount = parsedUrls.length;

  /* ---------- Single-URL fetch (existing behavior) ---------- */

  const handleSingleFetch = useCallback(
    async (targetUrl) => {
      setLoading(true);
      setError(null);
      setResult(null);
      setFields(null);

      try {
        const r = await apiFetch("/review-scrape", {
          method: "POST",
          body: { url: targetUrl },
        });

        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.ok) {
          throw new Error(data.error || "Could not extract review data from this page");
        }

        if (!mountedRef.current) return;
        setResult(data);
        setFields({
          source_name: data.source_name || "",
          author: data.author || "",
          title: data.title || "",
          source_url: data.source_url || targetUrl,
          excerpt: data.excerpt || "",
          date: data.date || "",
          rating: data.rating,
        });
        toast.success("Review data extracted!");
      } catch (e) {
        if (!mountedRef.current) return;
        const msg = e?.message || "Failed to fetch review data";
        setError(msg);
        toast.error(msg);
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [],
  );

  /* ---------- Batch fetch (multiple URLs) ---------- */

  const handleBatchFetch = useCallback(
    async (urls) => {
      const items = urls.map((u) => ({ url: u, status: "pending", error: null }));

      setBatchMode(true);
      setBatchItems(items);
      setBatchRunning(true);
      setBatchComplete(false);
      cancelRef.current = false;

      let doneCount = 0;
      let failedCount = 0;

      for (let i = 0; i < items.length; i++) {
        if (!mountedRef.current) return;

        if (cancelRef.current) {
          setBatchItems((prev) =>
            prev.map((item, idx) =>
              idx >= i && item.status === "pending" ? { ...item, status: "skipped" } : item,
            ),
          );
          break;
        }

        // Mark current as processing
        setBatchItems((prev) =>
          prev.map((item, idx) => (idx === i ? { ...item, status: "processing" } : item)),
        );

        try {
          const r = await apiFetch("/review-scrape", {
            method: "POST",
            body: { url: items[i].url },
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok || !data.ok) {
            throw new Error(data.error || "Could not extract review data");
          }

          if (!mountedRef.current) return;

          const review = buildReviewObject(data, items[i].url);
          if (typeof onAddReview === "function") onAddReview(review);
          doneCount++;

          setBatchItems((prev) =>
            prev.map((item, idx) => (idx === i ? { ...item, status: "done" } : item)),
          );
        } catch (e) {
          if (!mountedRef.current) return;
          failedCount++;
          setBatchItems((prev) =>
            prev.map((item, idx) =>
              idx === i ? { ...item, status: "failed", error: e?.message || "Failed" } : item,
            ),
          );
        }
      }

      if (!mountedRef.current) return;

      setBatchRunning(false);
      setBatchComplete(true);

      const skippedCount = cancelRef.current ? items.length - doneCount - failedCount : 0;
      if (failedCount === 0 && skippedCount === 0) {
        toast.success(`All ${doneCount} review${doneCount === 1 ? "" : "s"} added successfully`);
      } else {
        toast.info(
          `Batch complete: ${doneCount} added, ${failedCount} failed${skippedCount > 0 ? `, ${skippedCount} skipped` : ""}`,
        );
      }
    },
    [onAddReview],
  );

  /* ---------- Dispatcher ---------- */

  const handleFetch = useCallback(() => {
    if (urlCount === 0) {
      toast.error("No valid URLs found. Enter one URL per line starting with http:// or https://");
      return;
    }
    if (urlCount === 1) {
      handleSingleFetch(parsedUrls[0]);
    } else {
      handleBatchFetch(parsedUrls);
    }
  }, [urlCount, parsedUrls, handleSingleFetch, handleBatchFetch]);

  /* ---------- Single-URL: add review ---------- */

  const handleAddReview = useCallback(() => {
    if (!fields || typeof onAddReview !== "function") return;

    onAddReview(buildReviewObject(fields, fields.source_url));

    toast.success("Review added to curated list (save to persist)");
    setResult(null);
    setFields(null);
    setInputText("");
  }, [fields, onAddReview]);

  const handleDiscard = useCallback(() => {
    setResult(null);
    setFields(null);
  }, []);

  const updateField = useCallback((key, value) => {
    setFields((prev) => (prev ? { ...prev, [key]: value } : prev));
  }, []);

  /* ---------- Batch: clear ---------- */

  const handleClearBatch = useCallback(() => {
    setBatchMode(false);
    setBatchItems([]);
    setBatchRunning(false);
    setBatchComplete(false);
    setInputText("");
    cancelRef.current = false;
  }, []);

  /* ---------- Derived ---------- */

  const batchProcessedCount = batchItems.filter(
    (i) => i.status === "done" || i.status === "failed",
  ).length;

  /* ================================================================ */
  /*  Render                                                           */
  /* ================================================================ */

  return (
    <div className="border border-blue-200 dark:border-blue-800 rounded-lg bg-blue-50 dark:bg-blue-950/40 overflow-hidden mb-4">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-4 hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-colors"
      >
        <div className="flex items-center gap-2 text-blue-700 dark:text-blue-300">
          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          <span className="font-semibold text-sm">Fetch Review From Link</span>
        </div>
      </button>

      {isOpen && (
        <div className="p-4 border-t border-blue-200 dark:border-blue-800 space-y-4">
          {/* ---------- URL Input ---------- */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-700 dark:text-muted-foreground">
              Review URL(s) — one per line
            </label>
            <Textarea
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder={"https://example.com/review-article\nhttps://another.com/review\n(one URL per line)"}
              className="min-h-[60px] font-mono text-xs"
              rows={Math.min(6, Math.max(2, inputText.split("\n").length))}
              disabled={loading || batchRunning || disabled}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                  e.preventDefault();
                  handleFetch();
                }
              }}
            />
            <div className="text-[10px] text-slate-400 dark:text-muted-foreground">
              {urlCount === 0
                ? "Paste one or more URLs"
                : urlCount === 1
                  ? "1 URL detected — will show editable preview"
                  : `${urlCount} URLs detected — will process as batch`}
            </div>
          </div>

          {/* ---------- Fetch / Cancel buttons ---------- */}
          <div className="flex items-center gap-2">
            {!batchRunning ? (
              <Button
                type="button"
                size="sm"
                onClick={handleFetch}
                disabled={loading || batchRunning || urlCount === 0 || disabled}
              >
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Fetching…
                  </>
                ) : urlCount <= 1 ? (
                  "Fetch Review Data"
                ) : (
                  `Fetch All (${urlCount} URLs)`
                )}
              </Button>
            ) : (
              <>
                <Button type="button" size="sm" disabled>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Processing {batchProcessedCount + 1}/{batchItems.length}…
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    cancelRef.current = true;
                  }}
                  className="text-red-600 border-red-300 hover:bg-red-50 dark:text-red-400 dark:border-red-800 dark:hover:bg-red-950/40"
                >
                  Cancel
                </Button>
              </>
            )}
            {error && !batchMode && <div className="text-xs text-red-600">{error}</div>}
          </div>

          {/* ---------- Batch progress panel ---------- */}
          {batchMode && (
            <div className="mt-4 p-3 rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted/50 space-y-3">
              <div className="text-xs font-semibold text-slate-900 dark:text-foreground flex items-center justify-between">
                <span>
                  Batch Progress
                  {batchComplete && (
                    <span className="ml-2 font-normal text-slate-500 dark:text-muted-foreground">
                      — {batchItems.filter((i) => i.status === "done").length} added
                      {batchItems.some((i) => i.status === "failed") &&
                        `, ${batchItems.filter((i) => i.status === "failed").length} failed`}
                      {batchItems.some((i) => i.status === "skipped") &&
                        `, ${batchItems.filter((i) => i.status === "skipped").length} skipped`}
                    </span>
                  )}
                </span>
                {batchComplete && (
                  <Button type="button" size="sm" variant="outline" onClick={handleClearBatch}>
                    Clear
                  </Button>
                )}
              </div>

              <div className="max-h-[300px] overflow-y-auto space-y-1">
                {batchItems.map((item, idx) => (
                  <div
                    key={idx}
                    className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs ${
                      item.status === "processing" ? "bg-blue-50 dark:bg-blue-950/30" : ""
                    }`}
                  >
                    {/* Status icon */}
                    {item.status === "pending" && (
                      <Circle className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                    )}
                    {item.status === "processing" && (
                      <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin shrink-0" />
                    )}
                    {item.status === "done" && (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                    )}
                    {item.status === "failed" && (
                      <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
                    )}
                    {item.status === "skipped" && (
                      <Ban className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                    )}

                    {/* URL */}
                    <span
                      className={`truncate flex-1 font-mono ${
                        item.status === "failed"
                          ? "text-red-600 dark:text-red-400"
                          : item.status === "done"
                            ? "text-emerald-700 dark:text-emerald-400"
                            : item.status === "skipped"
                              ? "text-slate-400 dark:text-muted-foreground line-through"
                              : "text-slate-700 dark:text-slate-300"
                      }`}
                      title={item.url}
                    >
                      {item.url}
                    </span>

                    {/* Error message */}
                    {item.status === "failed" && item.error && (
                      <span
                        className="text-[10px] text-red-500 dark:text-red-400 truncate max-w-[200px] shrink-0"
                        title={item.error}
                      >
                        {item.error}
                      </span>
                    )}
                  </div>
                ))}
              </div>

              <div className="text-[10px] text-amber-600 dark:text-amber-500 italic">
                * Reviews are prepended to the curated reviews list. Save the company to persist.
              </div>
            </div>
          )}

          {/* ---------- Single-URL editable fields (existing) ---------- */}
          {fields && !batchMode && (
            <div className="mt-4 p-3 rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted/50 space-y-3">
              <div className="text-xs font-semibold text-slate-900 dark:text-foreground">
                Extracted Review Data
                <span className="ml-2 font-normal text-slate-500 dark:text-muted-foreground">
                  (editable before adding)
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-slate-700 dark:text-muted-foreground">
                    Source name
                  </label>
                  <Input
                    value={fields.source_name}
                    onChange={(e) => updateField("source_name", e.target.value)}
                    placeholder="Publication name"
                    disabled={disabled}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-slate-700 dark:text-muted-foreground">
                    Author
                  </label>
                  <Input
                    value={fields.author}
                    onChange={(e) => updateField("author", e.target.value)}
                    placeholder="(optional)"
                    disabled={disabled}
                  />
                </div>

                <div className="space-y-1 md:col-span-2">
                  <label className="text-[11px] font-medium text-slate-700 dark:text-muted-foreground">
                    Title
                  </label>
                  <Input
                    value={fields.title}
                    onChange={(e) => updateField("title", e.target.value)}
                    placeholder="Article title"
                    disabled={disabled}
                  />
                </div>

                <div className="space-y-1 md:col-span-2">
                  <label className="text-[11px] font-medium text-slate-700 dark:text-muted-foreground">
                    Source URL
                  </label>
                  <Input
                    value={fields.source_url}
                    onChange={(e) => updateField("source_url", e.target.value)}
                    placeholder="https://..."
                    disabled={disabled}
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-slate-700 dark:text-muted-foreground">
                    Date
                  </label>
                  <Input
                    value={fields.date}
                    onChange={(e) => updateField("date", e.target.value)}
                    placeholder="YYYY-MM-DD"
                    disabled={disabled}
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-slate-700 dark:text-muted-foreground">
                    Rating
                  </label>
                  <Input
                    value={fields.rating == null ? "" : String(fields.rating)}
                    onChange={(e) => {
                      const raw = e.target.value;
                      const parsed = raw.trim() ? Number(raw) : null;
                      updateField("rating", parsed != null && Number.isFinite(parsed) ? parsed : null);
                    }}
                    placeholder="(optional)"
                    disabled={disabled}
                  />
                </div>

                <div className="space-y-1 md:col-span-2">
                  <label className="text-[11px] font-medium text-slate-700 dark:text-muted-foreground">
                    Excerpt
                  </label>
                  <Textarea
                    value={fields.excerpt}
                    onChange={(e) => updateField("excerpt", e.target.value)}
                    placeholder="Review snippet or summary…"
                    className="min-h-[100px]"
                    disabled={disabled}
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <Button
                  type="button"
                  size="sm"
                  className="bg-emerald-600 hover:bg-emerald-700 text-white"
                  onClick={handleAddReview}
                  disabled={disabled}
                >
                  Add as Curated Review
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={handleDiscard}>
                  Discard
                </Button>
              </div>

              <div className="text-[10px] text-amber-600 dark:text-amber-500 italic">
                * Review will be prepended to the curated reviews list. Save the company to persist.
              </div>
              <div className="text-[10px] text-slate-400 dark:text-muted-foreground uppercase">
                Extraction strategy: {result?.strategy || "unknown"}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
