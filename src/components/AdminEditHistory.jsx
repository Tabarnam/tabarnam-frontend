import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Loader2, Search } from "lucide-react";

import { apiFetch, getUserFacingConfigMessage, toErrorString } from "@/lib/api";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function pretty(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return asString(value);
  }
}

async function copyToClipboard(text) {
  const value = asString(text);
  if (!value) return false;

  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // ignore
  }

  try {
    const el = document.createElement("textarea");
    el.value = value;
    el.style.position = "fixed";
    el.style.left = "-10000px";
    el.style.top = "0";
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

function ValueBlock({ value }) {
  const text = useMemo(() => pretty(value), [value]);
  const [expanded, setExpanded] = useState(false);

  const limit = 220;
  const isLong = text.length > limit;
  const shown = expanded || !isLong ? text : text.slice(0, limit) + "…";

  return (
    <div className="space-y-2">
      <pre className="whitespace-pre-wrap break-words rounded-md border border-slate-200 bg-slate-50 p-2 text-xs text-slate-900">
        {shown}
      </pre>
      {isLong ? (
        <button type="button" className="text-xs text-slate-600 hover:underline" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

function formatLocalTime(iso) {
  const s = asString(iso).trim();
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString();
}

export default function AdminEditHistory({ companyId }) {
  const id = asString(companyId).trim();

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [nextCursor, setNextCursor] = useState(null);

  const [fieldFilter, setFieldFilter] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  const debounceRef = useRef(null);

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    debounceRef.current = window.setTimeout(() => {
      setSearchQuery(searchInput.trim());
    }, 250);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = null;
    };
  }, [searchInput]);

  const fieldOptions = useMemo(() => {
    const set = new Set();
    for (const it of items) {
      const fields = Array.isArray(it?.changed_fields) ? it.changed_fields : [];
      for (const f of fields) {
        const s = asString(f).trim();
        if (s) set.add(s);
      }
    }
    return Array.from(set).sort();
  }, [items]);

  const buildUrl = useCallback(
    (cursor = null) => {
      const params = new URLSearchParams();
      params.set("limit", "25");
      if (cursor) params.set("cursor", cursor);
      if (fieldFilter) params.set("field", fieldFilter);
      if (searchQuery) params.set("q", searchQuery);
      return `/admin/companies/${encodeURIComponent(id)}/history?${params.toString()}`;
    },
    [fieldFilter, id, searchQuery]
  );

  const loadFirstPage = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError("");
    setItems([]);
    setNextCursor(null);

    try {
      const res = await apiFetch(buildUrl(null));
      const body = await res.json().catch(() => ({}));

      if (!res.ok || body?.ok !== true) {
        const msg = toErrorString((await getUserFacingConfigMessage(res)) || body?.error || body?.message || body?.text || `Failed to load history (${res.status})`);
        setError(msg);
        return;
      }

      setItems(Array.isArray(body?.items) ? body.items : []);
      setNextCursor(body?.next_cursor || null);
    } catch (e) {
      setError(toErrorString(e) || "Failed to load history");
    } finally {
      setLoading(false);
    }
  }, [buildUrl, id]);

  const loadMore = useCallback(async () => {
    if (!id || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError("");

    try {
      const res = await apiFetch(buildUrl(nextCursor));
      const body = await res.json().catch(() => ({}));

      if (!res.ok || body?.ok !== true) {
        const msg = toErrorString((await getUserFacingConfigMessage(res)) || body?.error || body?.message || body?.text || `Failed to load history (${res.status})`);
        setError(msg);
        return;
      }

      const more = Array.isArray(body?.items) ? body.items : [];
      setItems((prev) => [...prev, ...more]);
      setNextCursor(body?.next_cursor || null);
    } catch (e) {
      setError(toErrorString(e) || "Failed to load history");
    } finally {
      setLoadingMore(false);
    }
  }, [buildUrl, id, loadingMore, nextCursor]);

  useEffect(() => {
    if (!id) return;
    loadFirstPage();
  }, [id, fieldFilter, searchQuery, loadFirstPage]);

  const headerRight = (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
      <div className="flex items-center gap-2">
        <label className="text-xs text-slate-600">Filter field</label>
        <select
          className="h-9 rounded-md border border-slate-200 bg-white px-2 text-sm"
          value={fieldFilter}
          onChange={(e) => setFieldFilter(e.target.value)}
        >
          <option value="">All</option>
          {fieldOptions.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative">
          <Search className="h-4 w-4 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search history…"
            className="h-9 pl-8 w-[240px]"
          />
        </div>
      </div>
    </div>
  );

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-900">Edit History</div>
          <div className="text-xs text-slate-600">UTC stored • shown in your local time</div>
        </div>
        {headerRight}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-slate-700">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading history…
        </div>
      ) : null}

      {error ? <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-900">{error}</div> : null}

      {!loading && !error && items.length === 0 ? (
        <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">No edits yet.</div>
      ) : null}

      <div className="space-y-3">
        {items.map((entry) => {
          const when = formatLocalTime(entry?.created_at);
          const actor = asString(entry?.actor_email || entry?.actor_user_id).trim() || "unknown";
          const action = asString(entry?.action).trim() || "update";
          const source = asString(entry?.source).trim();
          const changed = Array.isArray(entry?.changed_fields) ? entry.changed_fields.map((f) => asString(f).trim()).filter(Boolean) : [];
          const diff = entry?.diff && typeof entry.diff === "object" ? entry.diff : {};

          return (
            <div key={asString(entry?.id) || `${entry?.created_at}-${actor}-${action}`} className="rounded-lg border border-slate-200">
              <div className="p-3 bg-slate-50 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-sm font-semibold text-slate-900">{action}</div>
                    {source ? (
                      <span className="rounded-full bg-white border border-slate-200 px-2 py-0.5 text-[11px] text-slate-700">
                        {source}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1 text-xs text-slate-600">{when ? `${when}` : asString(entry?.created_at)}</div>
                  <div className="mt-1 text-xs text-slate-600">By: {actor}</div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {changed.length > 0 ? (
                      changed.slice(0, 12).map((f) => (
                        <span key={f} className="rounded bg-white border border-slate-200 px-2 py-0.5 text-[11px] text-slate-700">
                          {f}
                        </span>
                      ))
                    ) : (
                      <span className="text-xs text-slate-500">No changed fields recorded.</span>
                    )}
                    {changed.length > 12 ? (
                      <span className="text-[11px] text-slate-500">+{changed.length - 12} more</span>
                    ) : null}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      const ok = await copyToClipboard(pretty(entry));
                      if (ok) toast.success("Copied entry JSON");
                      else toast.error("Copy failed");
                    }}
                    title="Copy entry JSON"
                  >
                    <Copy className="h-4 w-4 mr-2" />
                    Copy JSON
                  </Button>
                </div>
              </div>

              <div className="p-3">
                <details>
                  <summary className="cursor-pointer select-none text-sm text-slate-800">Details</summary>
                  <div className="mt-3 space-y-3">
                    {Object.keys(diff).length === 0 ? (
                      <div className="text-sm text-slate-600">No detailed diff available.</div>
                    ) : (
                      Object.entries(diff).map(([field, change]) => (
                        <div key={field} className="rounded border border-slate-200 bg-white p-3">
                          <div className="text-sm font-medium text-slate-900">{field}</div>
                          <div className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-3">
                            <div>
                              <div className="text-xs font-medium text-slate-700">Before</div>
                              <div className="mt-1">
                                <ValueBlock value={change?.before} />
                              </div>
                            </div>
                            <div>
                              <div className="text-xs font-medium text-slate-700">After</div>
                              <div className="mt-1">
                                <ValueBlock value={change?.after} />
                              </div>
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </details>
              </div>
            </div>
          );
        })}
      </div>

      {nextCursor ? (
        <div className="flex justify-center pt-2">
          <Button type="button" variant="outline" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
