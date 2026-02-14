import React, { useState, useCallback } from "react";
import { ChevronDown, ChevronRight, Search, Check, Trash2, ExternalLink, AlertCircle, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "@/lib/toast";
import { apiFetch } from "@/lib/api";
import { asString } from "./dashboardUtils";

export default function WebReviewFetcher({ company, onApply, disabled }) {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [companyName, setCompanyName] = useState(asString(company?.company_name || company?.name).trim());
  const [websiteUrl, setWebsiteUrl] = useState(asString(company?.website_url || company?.url).trim());
  const [keywords, setKeywords] = useState("");
  const [sources, setSources] = useState({ youtube: true, blogs: true, news: true });
  const [results, setResults] = useState([]);

  const handleFetch = async () => {
    if (!companyName) {
      toast.error("Company Name is required");
      return;
    }

    setLoading(true);
    try {
      const response = await apiFetch("/xadmin-api-refresh-reviews", {
        method: "POST",
        body: {
          company_id: company.id || company.company_id,
          company_name: companyName,
          website_url: websiteUrl,
          keywords,
          sources,
          take: 10, // Fetch more for discovery
          timeout_ms: 25000,
        },
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || "Failed to fetch reviews");
      }

      const data = await response.json();
      const reviews = (data.reviews || data.proposed_reviews || []).map((r, idx) => ({
        ...r,
        id: r.id || `web_${Date.now()}_${idx}`,
        approved: true,
      }));

      if (reviews.length === 0) {
        toast.info("No reviews found for the given criteria.");
      } else {
        toast.success(`Found ${reviews.length} reviews.`);
      }
      setResults(reviews);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  const toggleApproval = (id) => {
    setResults((prev) =>
      prev.map((r) => (r.id === id ? { ...r, approved: !r.approved } : r))
    );
  };

  const removeResult = (id) => {
    setResults((prev) => prev.filter((r) => r.id !== id));
  };

  const updateTitle = (id, newTitle) => {
    setResults((prev) =>
      prev.map((r) => (r.id === id ? { ...r, title: newTitle } : r))
    );
  };

  const handleSave = () => {
    const approved = results.filter((r) => r.approved);
    if (approved.length === 0) {
      toast.error("No reviews selected for saving.");
      return;
    }

    // Validate links (basic check)
    const invalid = approved.filter(r => !r.source_url || !r.source_url.startsWith('http'));
    if (invalid.length > 0) {
      toast.error("Some selected reviews have invalid URLs.");
      return;
    }

    onApply(approved.map(r => ({
      ...r,
      include: true,
      include_on_save: true,
      visibility: "public"
    })));
    
    toast.success(`Added ${approved.length} reviews to draft.`);
    setResults([]); // Clear after applying
  };

  return (
    <div className="border border-slate-200 dark:border-border rounded-lg bg-white dark:bg-card overflow-hidden mb-4">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-4 hover:bg-slate-50 dark:hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          <span className="font-semibold text-sm">Fetch Reviews From Web</span>
        </div>
        {!isOpen && results.length > 0 && (
          <span className="text-xs bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 px-2 py-0.5 rounded-full">
            {results.length} found
          </span>
        )}
      </button>

      {isOpen && (
        <div className="p-4 border-t border-slate-200 dark:border-border space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-700 dark:text-muted-foreground">Company Name (required)</label>
              <Input
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder="Enter company name"
                disabled={loading || disabled}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-700 dark:text-muted-foreground">Website URL (recommended)</label>
              <Input
                value={websiteUrl}
                onChange={(e) => setWebsiteUrl(e.target.value)}
                placeholder="https://example.com"
                disabled={loading || disabled}
              />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-slate-700 dark:text-muted-foreground">Search Keywords (e.g., "review", "unboxing")</label>
            <Input
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              placeholder='e.g., "review", "unboxing", "GMP", "independent review"'
              disabled={loading || disabled}
            />
          </div>

          <div className="flex flex-wrap items-center gap-6 py-2">
            <label className="text-xs font-medium text-slate-700 dark:text-muted-foreground">Sources:</label>
            <div className="flex items-center gap-2">
              <Checkbox
                id="source-youtube"
                checked={sources.youtube}
                onCheckedChange={(v) => setSources((s) => ({ ...s, youtube: !!v }))}
                disabled={loading || disabled}
              />
              <label htmlFor="source-youtube" className="text-sm cursor-pointer">YouTube</label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="source-blogs"
                checked={sources.blogs}
                onCheckedChange={(v) => setSources((s) => ({ ...s, blogs: !!v }))}
                disabled={loading || disabled}
              />
              <label htmlFor="source-blogs" className="text-sm cursor-pointer">Blogs</label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="source-news"
                checked={sources.news}
                onCheckedChange={(v) => setSources((s) => ({ ...s, news: !!v }))}
                disabled={loading || disabled}
              />
              <label htmlFor="source-news" className="text-sm cursor-pointer">News / Magazines</label>
            </div>
          </div>

          <div className="flex justify-end">
            <Button
              type="button"
              onClick={handleFetch}
              disabled={loading || disabled || !companyName}
              className="gap-2"
            >
              {loading ? <RefreshCcw className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              Search & Fetch Reviews
            </Button>
          </div>

          {results.length > 0 && (
            <div className="mt-6 space-y-4 border-t pt-4 border-slate-100 dark:border-border/50">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold">Preview Results</h4>
                <div className="flex items-center gap-2">
                   <span className="text-xs text-muted-foreground">
                     {results.filter(r => r.approved).length} selected
                   </span>
                   <Button size="sm" onClick={handleSave} disabled={disabled}>
                     Apply to Draft
                   </Button>
                </div>
              </div>

              <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2">
                {results.map((review) => (
                  <div key={review.id} className="p-3 border rounded-lg bg-slate-50 dark:bg-muted/30 group">
                    <div className="flex items-start gap-3">
                      <Checkbox
                        checked={review.approved}
                        onCheckedChange={() => toggleApproval(review.id)}
                        disabled={disabled}
                      />
                      <div className="flex-1 min-w-0 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <Input
                            value={review.title || ""}
                            onChange={(e) => updateTitle(review.id, e.target.value)}
                            className="h-7 text-sm font-medium bg-transparent border-transparent hover:border-slate-300 focus:bg-white"
                            placeholder="Review Title"
                            disabled={disabled}
                          />
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <a
                              href={review.source_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="p-1 hover:bg-slate-200 dark:hover:bg-muted rounded text-slate-500"
                              title="Open link"
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                            <button
                              onClick={() => removeResult(review.id)}
                              className="p-1 hover:bg-red-100 dark:hover:bg-red-900/30 text-red-500 rounded"
                              title="Remove"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="font-semibold text-slate-700 dark:text-slate-300">Source:</span>
                          <span className="truncate">{review.source_name || "Unknown"}</span>
                          <span className="mx-1">•</span>
                          <span className="truncate max-w-[200px]" title={review.source_url}>{review.source_url}</span>
                        </div>
                        {review.excerpt && (
                           <div className="text-xs text-slate-600 dark:text-slate-400 italic line-clamp-2">
                             "{review.excerpt}"
                           </div>
                        )}
                        {review.duplicate && (
                          <div className="flex items-center gap-1 text-[10px] text-amber-600 bg-amber-50 dark:bg-amber-900/20 px-1.5 py-0.5 rounded w-fit">
                            <AlertCircle className="h-3 w-3" />
                            Duplicate of existing review
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
