import React, { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import AdminHeader from "@/components/AdminHeader";
import { getAssignableOwnerEmails } from "@/lib/azureAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  RefreshCw,
  Loader2,
  AlertTriangle,
  ArrowUp,
  ArrowDown,
  Clock,
} from "lucide-react";

// Admin activity log — who changed what, when.
//
// Sorting and filtering are SERVER-side. Sorting a fetched page in the browser
// would look identical to a real sort while only ordering the rows already on
// screen, which is how a wrong answer gets trusted.

// Named windows. The tooltip carries the definition so the label can stay
// short without becoming a guessing game.
const WINDOW_PRESETS = [
  { label: "biduum", hours: 48, title: "Biduum — 2 days" },
  { label: "fortnight", hours: 24 * 14, title: "Fortnight — 14 nights" },
  { label: "lunation", hours: 29.5 * 24, title: "Lunation — 29.5 days, one lunar month" },
  {
    label: "forever ever?",
    hours: null,
    allTime: true,
    title: "Forever ever — the entire history, no lower bound. Slower: this is the one query that walks the whole log.",
  },
];

const COLUMNS = [
  { key: "created_at", label: "When", sortable: true, width: "w-44" },
  { key: "actor_email", label: "Who", sortable: true, width: "w-56" },
  { key: "action", label: "Action", sortable: true, width: "w-40" },
  { key: "company_id", label: "Company", sortable: true },
  { key: "changed_fields", label: "Changed", sortable: false },
  { key: "source", label: "Source", sortable: false, width: "w-32" },
];

const ACTION_PILL = {
  create: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400",
  update: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  delete: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
};

function ActionBadge({ action }) {
  const cls = ACTION_PILL[action] || "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {action || "—"}
    </span>
  );
}

// Azure stores UTC; the operator works in Pacific.
function formatWhen(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function ChangedFields({ row }) {
  if (row.is_batch_summary) {
    const n = row.summary?.companies ?? row.summary?.count;
    return (
      <span className="text-muted-foreground italic">
        batch{typeof n === "number" ? ` · ${n} companies` : ""}
      </span>
    );
  }

  const fields = row.changed_fields || [];
  if (fields.length === 0) return <span className="text-muted-foreground">—</span>;

  const shown = fields.slice(0, 4);
  const rest = fields.length - shown.length;

  return (
    <span className="flex flex-wrap gap-1">
      {shown.map((f) => (
        <code
          key={f}
          className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-[11px] text-foreground"
        >
          {f}
        </code>
      ))}
      {rest > 0 && <span className="text-xs text-muted-foreground self-center">+{rest} more</span>}
    </span>
  );
}

export default function AdminAuditLog() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");

  const [windowHours, setWindowHours] = useState(48);
  const [allTime, setAllTime] = useState(false);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const [actorFilter, setActorFilter] = useState("");
  const [companyFilter, setCompanyFilter] = useState("");
  const [companyNameQuery, setCompanyNameQuery] = useState("");
  // null = no name filter active. [] = searched and matched nothing.
  const [resolvedCompanyIds, setResolvedCompanyIds] = useState(null);
  const [resolvingName, setResolvingName] = useState(false);
  // Everyone who has EVER acted, not just who currently has access.
  const [actors, setActors] = useState([]);

  const [sortField, setSortField] = useState("created_at");
  const [sortDir, setSortDir] = useState("desc");

  const [cursor, setCursor] = useState(null);
  const [meta, setMeta] = useState(null);

  // The person filter lists everyone who has ever written to the log, unioned
  // with everyone who currently has access. Building it from the live roster
  // alone made a departed contributor's name vanish from the filter while
  // their entries stayed in the log — unreachable through the UI.
  const people = useMemo(
    () => [...new Set([...actors, ...getAssignableOwnerEmails()])].sort(),
    [actors]
  );

  const buildParams = useCallback(
    (nextCursor) => {
      const params = new URLSearchParams();

      if (customFrom || customTo) {
        if (customFrom) params.set("from", new Date(customFrom).toISOString());
        if (customTo) params.set("to", new Date(customTo).toISOString());
      } else if (allTime) {
        params.set("all", "1");
      } else if (windowHours) {
        const from = new Date(Date.now() - windowHours * 60 * 60 * 1000);
        params.set("from", from.toISOString());
      }

      if (actorFilter) params.set("actor_email", actorFilter);
      if (companyFilter.trim()) params.set("company_id", companyFilter.trim());

      // Company NAME resolves to ids client-side against the same endpoint the
      // /admin list searches, so "name" means here exactly what it means in
      // that search box. `__none__` is the deliberate signal for "the name
      // matched nothing" — dropping an empty list would show ALL activity and
      // read as "nobody ever touched this company".
      if (resolvedCompanyIds !== null) {
        params.set("company_ids", resolvedCompanyIds.length ? resolvedCompanyIds.join(",") : "__none__");
      }

      params.set("sort", sortField);
      params.set("dir", sortDir);
      params.set("limit", "100");

      if (nextCursor) params.set("cursor", nextCursor);

      return params.toString();
    },
    [windowHours, allTime, customFrom, customTo, actorFilter, companyFilter, resolvedCompanyIds, sortField, sortDir]
  );

  const load = useCallback(
    async (nextCursor = null) => {
      const append = Boolean(nextCursor);
      append ? setLoadingMore(true) : setLoading(true);
      setError("");

      try {
        const res = await apiFetch(`/xadmin-api-audit-log?${buildParams(nextCursor)}`);
        const data = await res.json().catch(() => null);

        if (!res.ok || !data?.ok) {
          setError(data?.error || `Request failed (${res.status})`);
          if (!append) setRows([]);
          return;
        }

        setRows((prev) => (append ? [...prev, ...(data.items || [])] : data.items || []));
        setCursor(data.next_cursor || null);
        setMeta(data);
      } catch (e) {
        setError(e?.message || "Request failed");
        if (!append) setRows([]);
      } finally {
        append ? setLoadingMore(false) : setLoading(false);
      }
    },
    [buildParams]
  );

  // Refetch whenever anything that shapes the query changes. Paging resets,
  // because a cursor is only valid for the query that produced it.
  useEffect(() => {
    setCursor(null);
    load(null);
  }, [load]);

  // Fetch the historical actor list once. Cached server-side for an hour, so
  // this is cheap despite being a DISTINCT over the whole log.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch("/xadmin-api-audit-actors");
        if (!res.ok) return;
        const data = await res.json().catch(() => null);
        if (!cancelled && data?.ok && Array.isArray(data.actors)) setActors(data.actors);
      } catch {
        // Non-fatal: the filter falls back to the current roster alone.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Resolve a typed company NAME to ids using the SAME endpoint the /admin list
  // searches, rather than reimplementing matching here. Debounced, because it
  // fires per keystroke.
  useEffect(() => {
    const q = companyNameQuery.trim();

    if (!q) {
      setResolvedCompanyIds(null);
      return undefined;
    }

    let cancelled = false;
    setResolvingName(true);

    const timer = window.setTimeout(async () => {
      try {
        const res = await apiFetch(`/xadmin-api-companies?search=${encodeURIComponent(q)}&take=60`);
        const data = await res.json().catch(() => null);
        const rows = data?.items || data?.companies || [];
        if (!cancelled) {
          setResolvedCompanyIds(rows.map((r) => r.company_id || r.id).filter(Boolean));
        }
      } catch {
        if (!cancelled) setResolvedCompanyIds([]);
      } finally {
        if (!cancelled) setResolvingName(false);
      }
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [companyNameQuery]);

  const toggleSort = (field) => {
    if (field === sortField) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  };

  const windowLabel = (() => {
    if (customFrom || customTo) return "custom range";
    if (allTime) return "all time";
    const preset = WINDOW_PRESETS.find((p) => p.hours === windowHours);
    return preset ? `the last ${preset.label}` : `the last ${windowHours} hours`;
  })();

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-background">
      <AdminHeader />

      <div className="max-w-[1600px] mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Activity Log</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Every admin edit, import and deletion. Times shown in Pacific.
            </p>
          </div>

          <Button variant="outline" onClick={() => load(null)} disabled={loading}>
            {loading ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-2" />
            )}
            Refresh
          </Button>
        </div>

        {/* Controls */}
        <div className="bg-white dark:bg-card rounded-lg border border-slate-200 dark:border-border p-4 mb-4">
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                Time range
              </label>
              <div className="flex gap-1">
                {WINDOW_PRESETS.map((preset) => {
                  const active =
                    !customFrom && !customTo &&
                    (preset.allTime ? allTime : !allTime && windowHours === preset.hours);

                  return (
                    <button
                      key={preset.label}
                      title={preset.title}
                      onClick={() => {
                        setCustomFrom("");
                        setCustomTo("");
                        setAllTime(Boolean(preset.allTime));
                        if (!preset.allTime) setWindowHours(preset.hours);
                      }}
                      className={`px-3 py-1.5 rounded text-sm border transition-colors ${
                        active
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-white dark:bg-card border-slate-200 dark:border-border text-foreground hover:bg-slate-50 dark:hover:bg-slate-800"
                      }`}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                From (custom)
              </label>
              <Input
                type="datetime-local"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="w-52"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                To (custom)
              </label>
              <Input
                type="datetime-local"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="w-52"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                Person
              </label>
              <select
                value={actorFilter}
                onChange={(e) => setActorFilter(e.target.value)}
                className="h-10 px-3 rounded-md border border-slate-200 dark:border-border bg-white dark:bg-card text-foreground text-sm w-56"
              >
                <option value="">All users</option>
                {people.map((email) => (
                  <option key={email} value={email}>
                    {email}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                Company name
              </label>
              <Input
                value={companyNameQuery}
                onChange={(e) => setCompanyNameQuery(e.target.value)}
                placeholder="Search by name…"
                title="Matches the same way as the search box on the Companies page"
                className="w-56"
              />
              {companyNameQuery.trim() && (
                <div className="text-[11px] text-muted-foreground mt-1">
                  {resolvingName
                    ? "matching…"
                    : resolvedCompanyIds === null
                      ? ""
                      : resolvedCompanyIds.length === 0
                        ? "no company matched"
                        : `${resolvedCompanyIds.length} compan${resolvedCompanyIds.length === 1 ? "y" : "ies"} matched`}
                </div>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                Company ID
              </label>
              <Input
                value={companyFilter}
                onChange={(e) => setCompanyFilter(e.target.value)}
                placeholder="company_..."
                className="w-56"
              />
            </div>

            {(customFrom || customTo) && (
              <Button
                variant="ghost"
                onClick={() => {
                  setCustomFrom("");
                  setCustomTo("");
                }}
              >
                Clear custom range
              </Button>
            )}
          </div>
        </div>

        {/* Window statement — a table must never look like the whole history
            when it is a window. */}
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-3">
          <Clock className="h-4 w-4" />
          <span>
            Showing <strong className="text-foreground">{windowLabel}</strong>
            {meta?.window?.from && (
              <> · from {formatWhen(meta.window.from)} to {formatWhen(meta.window.to)} PT</>
            )}
            {rows.length > 0 && <> · {rows.length} entries loaded</>}
          </span>
        </div>

        {meta?.ordering === "degraded_no_composite_index" && (
          <div className="flex items-start gap-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3 mb-3">
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
            <div className="text-sm text-amber-800 dark:text-amber-300">
              Sorted by <strong>{sortField}</strong> only — rows sharing a value are in
              arbitrary order. The composite index for this sort is still building
              (migration 0003). Sorting by time is unaffected.
            </div>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 mb-3">
            <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
            <div className="text-sm text-red-800 dark:text-red-300">{error}</div>
          </div>
        )}

        {/* Table */}
        <div className="bg-white dark:bg-card rounded-lg border border-slate-200 dark:border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-900/50 border-b border-slate-200 dark:border-border">
                <tr>
                  {COLUMNS.map((col) => (
                    <th
                      key={col.key}
                      className={`text-left px-4 py-2.5 font-medium text-muted-foreground ${col.width || ""}`}
                    >
                      {col.sortable ? (
                        <button
                          onClick={() => toggleSort(col.key)}
                          className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
                        >
                          {col.label}
                          {sortField === col.key &&
                            (sortDir === "desc" ? (
                              <ArrowDown className="h-3 w-3" />
                            ) : (
                              <ArrowUp className="h-3 w-3" />
                            ))}
                        </button>
                      ) : (
                        col.label
                      )}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {loading && rows.length === 0 && (
                  <tr>
                    <td colSpan={COLUMNS.length} className="px-4 py-12 text-center text-muted-foreground">
                      <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
                      Loading activity…
                    </td>
                  </tr>
                )}

                {!loading && rows.length === 0 && !error && (
                  <tr>
                    <td colSpan={COLUMNS.length} className="px-4 py-12 text-center text-muted-foreground">
                      No activity in {windowLabel}.
                    </td>
                  </tr>
                )}

                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-slate-100 dark:border-border/50 hover:bg-slate-50 dark:hover:bg-slate-800/40"
                  >
                    <td className="px-4 py-2.5 text-foreground whitespace-nowrap">
                      {formatWhen(row.created_at)}
                    </td>
                    <td className="px-4 py-2.5 text-foreground">
                      {row.actor_email || (
                        <span className="text-muted-foreground italic">system</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <ActionBadge action={row.action} />
                    </td>
                    <td className="px-4 py-2.5 text-foreground">
                      {row.company_name || row.company_id || (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <ChangedFields row={row} />
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground text-xs">
                      {row.source || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {cursor && (
            <div className="border-t border-slate-200 dark:border-border p-3 text-center">
              <Button variant="outline" onClick={() => load(cursor)} disabled={loadingMore}>
                {loadingMore ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Loading…
                  </>
                ) : (
                  "Load more"
                )}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
