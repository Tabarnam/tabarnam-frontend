import React, { useState, useCallback } from "react";
import { ChevronDown, ChevronRight, Loader2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/lib/toast";
import { apiFetch } from "@/lib/api";

export default function ReviewLinkFetcher({ onAddReview, disabled }) {
  const [isOpen, setIsOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [fields, setFields] = useState(null);

  const handleFetch = useCallback(async () => {
    const trimmed = url.trim();
    if (!trimmed) {
      toast.error("URL is required");
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);
    setFields(null);

    try {
      const r = await apiFetch("/review-scrape", {
        method: "POST",
        body: { url: trimmed },
      });

      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        throw new Error(data.error || "Could not extract review data from this page");
      }

      setResult(data);
      setFields({
        source_name: data.source_name || "",
        author: data.author || "",
        title: data.title || "",
        source_url: data.source_url || trimmed,
        excerpt: data.excerpt || "",
        date: data.date || "",
        rating: data.rating,
      });
      toast.success("Review data extracted!");
    } catch (e) {
      const msg = e?.message || "Failed to fetch review data";
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [url]);

  const handleAddReview = useCallback(() => {
    if (!fields || typeof onAddReview !== "function") return;

    const now = new Date().toISOString();
    onAddReview({
      id: `admin_link_import_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      source: "admin_link_import",
      source_name: fields.source_name,
      author: fields.author,
      title: fields.title,
      source_url: fields.source_url,
      url: fields.source_url,
      excerpt: fields.excerpt,
      abstract: fields.excerpt,
      content: fields.excerpt,
      date: fields.date,
      rating: fields.rating,
      show_to_users: true,
      is_public: true,
      include_on_save: true,
      created_at: now,
      last_updated_at: now,
    });

    toast.success("Review added to curated list (save to persist)");
    setResult(null);
    setFields(null);
    setUrl("");
  }, [fields, onAddReview]);

  const handleDiscard = useCallback(() => {
    setResult(null);
    setFields(null);
  }, []);

  const updateField = useCallback((key, value) => {
    setFields((prev) => (prev ? { ...prev, [key]: value } : prev));
  }, []);

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
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-700 dark:text-muted-foreground">
              Review article URL (required)
            </label>
            <div className="flex gap-2">
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/review-article"
                className="flex-1"
                disabled={loading || disabled}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && url.trim()) handleFetch();
                }}
              />
              {url.trim() && (
                <a
                  href={url.trim().startsWith("http") ? url.trim() : `https://${url.trim()}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center h-9 w-9 rounded-md border border-slate-200 dark:border-border hover:bg-slate-50 dark:hover:bg-muted text-slate-500"
                  title="Open URL"
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={handleFetch}
              disabled={loading || !url.trim() || disabled}
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Fetching…
                </>
              ) : (
                "Fetch Review Data"
              )}
            </Button>
            {error && <div className="text-xs text-red-600">{error}</div>}
          </div>

          {fields && (
            <div className="mt-4 p-3 rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted/50 space-y-3">
              <div className="text-xs font-semibold text-slate-900 dark:text-foreground">
                Extracted Review Data
                <span className="ml-2 font-normal text-slate-500 dark:text-muted-foreground">(editable before adding)</span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-slate-700 dark:text-muted-foreground">Source name</label>
                  <Input
                    value={fields.source_name}
                    onChange={(e) => updateField("source_name", e.target.value)}
                    placeholder="Publication name"
                    disabled={disabled}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-slate-700 dark:text-muted-foreground">Author</label>
                  <Input
                    value={fields.author}
                    onChange={(e) => updateField("author", e.target.value)}
                    placeholder="(optional)"
                    disabled={disabled}
                  />
                </div>

                <div className="space-y-1 md:col-span-2">
                  <label className="text-[11px] font-medium text-slate-700 dark:text-muted-foreground">Title</label>
                  <Input
                    value={fields.title}
                    onChange={(e) => updateField("title", e.target.value)}
                    placeholder="Article title"
                    disabled={disabled}
                  />
                </div>

                <div className="space-y-1 md:col-span-2">
                  <label className="text-[11px] font-medium text-slate-700 dark:text-muted-foreground">Source URL</label>
                  <Input
                    value={fields.source_url}
                    onChange={(e) => updateField("source_url", e.target.value)}
                    placeholder="https://..."
                    disabled={disabled}
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-slate-700 dark:text-muted-foreground">Date</label>
                  <Input
                    value={fields.date}
                    onChange={(e) => updateField("date", e.target.value)}
                    placeholder="YYYY-MM-DD"
                    disabled={disabled}
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-slate-700 dark:text-muted-foreground">Rating</label>
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
                  <label className="text-[11px] font-medium text-slate-700 dark:text-muted-foreground">Excerpt</label>
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
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleDiscard}
                >
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
