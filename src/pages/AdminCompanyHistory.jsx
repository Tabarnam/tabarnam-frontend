// Full-page edit history for one company: /admin/companies/:companyId/history
//
// Replaces the collapsible panel that used to live inside the edit dialog. That
// panel dumped raw field names and before/after JSON side by side, which told an
// admin that "amazon_url" changed but not what happened. This page renders each
// entry as a dated timeline card with one plain-English line per change, folds
// away the server-derived bookkeeping fields, and keeps the raw JSON one click
// down for when someone genuinely needs it.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, Copy, Loader2, RefreshCcw, Search } from "lucide-react";

import { apiFetch, toErrorString } from "@/lib/api";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  asString,
  dayHeading,
  describeEntry,
  fieldLabel,
  formatAbsoluteTime,
  formatRelativeTime,
  pretty,
} from "@/lib/editHistoryCopy";

const PAGE_SIZE = 25;

async function copyToClipboard(text) {
  const value = asString(text);
  if (!value) return false;
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // fall through to the execCommand path
  }
  try {
    const el = document.createElement("textarea");
    el.value = value;
    el.style.position = "fixed";
    el.style.left = "-10000px";
    document.body.appendChild(el);
    el.focus();
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

const TONE_STYLES = {
  added: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  on: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  removed: "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  off: "border-slate-400/40 bg-slate-500/10 text-slate-700 dark:text-slate-300",
  changed: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
};

const TONE_VERBS = { added: "Added", on: "On", removed: "Removed", off: "Off", changed: "Changed" };

function ChangeLine({ change }) {
  const [showRaw, setShowRaw] = useState(false);
  const tone = TONE_STYLES[change.tone] || TONE_STYLES.changed;

  return (
    <li className="py-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tone}`}>
          {TONE_VERBS[change.tone] || "Changed"}
        </span>
        <span className="text-sm font-medium text-slate-900 dark:text-foreground">{change.label}</span>
        <span className="text-sm text-slate-600 dark:text-muted-foreground">{change.summary}</span>
        <button
          type="button"
          onClick={() => setShowRaw((v) => !v)}
          className="ml-auto shrink-0 text-[11px] text-slate-500 dark:text-muted-foreground hover:underline"
        >
          {showRaw ? "Hide values" : "Values"}
        </button>
      </div>

      {showRaw ? (
        <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-2">
          <div>
            <div className="text-[11px] font-medium text-slate-500 dark:text-muted-foreground">Before</div>
            <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-2 text-[11px] text-slate-800 dark:text-foreground">
              {pretty(change.before)}
            </pre>
          </div>
          <div>
            <div className="text-[11px] font-medium text-slate-500 dark:text-muted-foreground">After</div>
            <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-2 text-[11px] text-slate-800 dark:text-foreground">
              {pretty(change.after)}
            </pre>
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function EntryCard({ entry }) {
  const { headline, changes, systemChanges, actor, source } = useMemo(() => describeEntry(entry), [entry]);
  const [showSystem, setShowSystem] = useState(false);

  const relative = formatRelativeTime(entry?.created_at);
  const absolute = formatAbsoluteTime(entry?.created_at);

  return (
    <article className="rounded-lg border border-slate-200 dark:border-border bg-white dark:bg-card">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-slate-200 dark:border-border px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-foreground">{headline}</h3>
        <span className="text-xs text-slate-600 dark:text-muted-foreground">by {actor}</span>
        {source ? (
          <span className="rounded-full border border-slate-200 dark:border-border px-2 py-0.5 text-[10px] text-slate-600 dark:text-muted-foreground">
            {source}
          </span>
        ) : null}
        <span className="ml-auto text-xs text-slate-500 dark:text-muted-foreground" title={absolute}>
          {relative}
        </span>
        <button
          type="button"
          title="Copy the raw entry as JSON"
          onClick={async () => {
            const ok = await copyToClipboard(pretty(entry));
            if (ok) toast.success("Copied entry JSON");
            else toast.error("Copy failed");
          }}
          className="shrink-0 text-slate-400 hover:text-slate-700 dark:hover:text-foreground"
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
      </header>

      <div className="px-4 py-2">
        {changes.length === 0 && systemChanges.length === 0 ? (
          <p className="py-2 text-sm text-slate-500 dark:text-muted-foreground">
            No field-level detail was recorded for this entry.
          </p>
        ) : null}

        {changes.length > 0 ? (
          <ul className="divide-y divide-slate-100 dark:divide-border/60">
            {changes.map((c) => (
              <ChangeLine key={c.key} change={c} />
            ))}
          </ul>
        ) : null}

        {systemChanges.length > 0 ? (
          <div className="mt-1 border-t border-slate-100 dark:border-border/60 pt-2 pb-1">
            <button
              type="button"
              onClick={() => setShowSystem((v) => !v)}
              className="text-[11px] text-slate-500 dark:text-muted-foreground hover:underline"
            >
              {showSystem ? "Hide" : "Show"} {systemChanges.length} automatic{" "}
              {systemChanges.length === 1 ? "update" : "updates"} (search tokens, scores, health)
            </button>
            {showSystem ? (
              <ul className="mt-1 divide-y divide-slate-100 dark:divide-border/60 opacity-70">
                {systemChanges.map((c) => (
                  <ChangeLine key={c.key} change={c} />
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

export default function AdminCompanyHistory() {
  const { companyId } = useParams();
  const [searchParams] = useSearchParams();
  const id = asString(companyId).trim();
  // The editor passes the name through so the page has a human title without a
  // second lookup; the id is the fallback when someone lands here cold.
  const companyName = asString(searchParams.get("name")).trim();

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [nextCursor, setNextCursor] = useState(null);

  const [fieldFilter, setFieldFilter] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => setSearchQuery(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const buildUrl = useCallback(
    (cursor) => {
      const params = new URLSearchParams();
      params.set("company_id", id);
      params.set("limit", String(PAGE_SIZE));
      if (cursor) params.set("cursor", cursor);
      if (fieldFilter) params.set("field", fieldFilter);
      if (searchQuery) params.set("q", searchQuery);
      // xadmin-api- prefix is required: /api/admin* is blocked at the edge.
      return `/xadmin-api-company-history?${params.toString()}`;
    },
    [fieldFilter, id, searchQuery]
  );

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError("");
    try {
      const res = await apiFetch(buildUrl(null));
      const body = await res.json().catch(() => ({}));
      if (!mountedRef.current) return;
      if (!res.ok || body?.ok !== true) {
        setError(toErrorString(body?.error || body?.message || `Failed to load history (${res.status})`));
        setItems([]);
        setNextCursor(null);
        return;
      }
      setItems(Array.isArray(body?.items) ? body.items : []);
      setNextCursor(body?.next_cursor || null);
    } catch (e) {
      if (mountedRef.current) setError(toErrorString(e) || "Failed to load history");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [buildUrl, id]);

  useEffect(() => {
    load();
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await apiFetch(buildUrl(nextCursor));
      const body = await res.json().catch(() => ({}));
      if (!mountedRef.current) return;
      if (!res.ok || body?.ok !== true) {
        setError(toErrorString(body?.error || `Failed to load history (${res.status})`));
        return;
      }
      setItems((prev) => [...prev, ...(Array.isArray(body?.items) ? body.items : [])]);
      setNextCursor(body?.next_cursor || null);
    } catch (e) {
      if (mountedRef.current) setError(toErrorString(e) || "Failed to load history");
    } finally {
      if (mountedRef.current) setLoadingMore(false);
    }
  }, [buildUrl, loadingMore, nextCursor]);

  // Field filter options come from the loaded entries, labelled the way the rest
  // of the page labels them (value stays the raw key the API filters on).
  const fieldOptions = useMemo(() => {
    const keys = new Set();
    for (const it of items) {
      for (const f of Array.isArray(it?.changed_fields) ? it.changed_fields : []) {
        const s = asString(f).trim();
        if (s) keys.add(s);
      }
    }
    return Array.from(keys)
      .map((k) => ({ value: k, label: fieldLabel(k) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [items]);

  // Group into day buckets so the timeline reads as a story, not a flat dump.
  const grouped = useMemo(() => {
    const out = [];
    for (const entry of items) {
      const heading = dayHeading(entry?.created_at);
      const last = out[out.length - 1];
      if (last && last.heading === heading) last.entries.push(entry);
      else out.push({ heading, entries: [entry] });
    }
    return out;
  }, [items]);

  if (!id) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-background p-6">
        <p className="text-sm text-slate-700 dark:text-muted-foreground">No company id in the URL.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-background">
      <header className="border-b border-slate-200 dark:border-border bg-white dark:bg-card px-4 py-3">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-2">
          <Link
            to="/admin"
            className="inline-flex items-center gap-1 text-sm text-slate-600 dark:text-muted-foreground hover:text-slate-900 dark:hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Companies
          </Link>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-slate-900 dark:text-foreground">
              {companyName || id} — edit history
            </h1>
            <p className="text-xs text-slate-500 dark:text-muted-foreground">
              Newest first · times shown in your local timezone
            </p>
          </div>
          <Button type="button" size="sm" variant="outline" className="ml-auto" onClick={load} disabled={loading}>
            <RefreshCcw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
            <span className="ml-2">Refresh</span>
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-4 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-muted-foreground">
            Field
            <select
              className="h-9 rounded-md border border-slate-200 dark:border-border bg-white dark:bg-card px-2 text-sm"
              value={fieldFilter}
              onChange={(e) => setFieldFilter(e.target.value)}
            >
              <option value="">All fields</option>
              {fieldOptions.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>

          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search by admin, field, or source…"
              className="h-9 w-[280px] pl-8"
            />
          </div>

          <span className="ml-auto text-xs text-slate-500 dark:text-muted-foreground">
            {items.length} {items.length === 1 ? "entry" : "entries"}
            {nextCursor ? "+" : ""}
          </span>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading history…
          </div>
        ) : null}

        {error ? (
          <div className="rounded border border-red-300 bg-red-50 dark:bg-red-950/30 p-3 text-sm text-red-900 dark:text-red-200">
            <div>{error}</div>
            <Button type="button" size="sm" variant="outline" className="mt-2" onClick={load}>
              Retry
            </Button>
          </div>
        ) : null}

        {!loading && !error && items.length === 0 ? (
          <div className="rounded border border-slate-200 dark:border-border bg-white dark:bg-card p-6 text-center text-sm text-slate-600 dark:text-muted-foreground">
            {fieldFilter || searchQuery
              ? "No entries match this filter."
              : "No edits recorded for this company yet."}
          </div>
        ) : null}

        {grouped.map((group) => (
          <section key={group.heading} className="space-y-2">
            <h2 className="sticky top-0 z-10 -mx-4 bg-slate-50/95 dark:bg-background/95 px-4 py-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-muted-foreground backdrop-blur">
              {group.heading}
            </h2>
            {group.entries.map((entry) => (
              <EntryCard key={asString(entry?.id) || `${entry?.created_at}-${entry?.action}`} entry={entry} />
            ))}
          </section>
        ))}

        {nextCursor ? (
          <div className="flex justify-center pt-2">
            <Button type="button" variant="outline" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Load older entries"}
            </Button>
          </div>
        ) : null}
      </main>
    </div>
  );
}
