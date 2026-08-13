import React, { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import AdminHeader from "@/components/AdminHeader";
import { getAuthorizedAdminEmails } from "@/lib/azureAuth";
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

const WINDOW_PRESETS = [
  { label: "72 hours", hours: 72 },
  { label: "7 days", hours: 24 * 7 },
  { label: "30 days", hours: 24 * 30 },
  { label: "90 days", hours: 24 * 90 },
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

  const [windowHours, setWindowHours] = useState(72);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const [actorFilter, setActorFilter] = useState("");
  const [companyFilter, setCompanyFilter] = useState("");

  const [sortField, setSortField] = useState("created_at");
  const [sortDir, setSortDir] = useState("desc");

  const [cursor, setCursor] = useState(null);
  const [meta, setMeta] = useState(null);

  const people = useMemo(() => getAuthorizedAdminEmails(), []);

  const buildParams = useCallback(
    (nextCursor) => {
      const params = new URLSearchParams();

      if (customFrom || customTo) {
        if (customFrom) params.set("from", new Date(customFrom).toISOString());
        if (customTo) params.set("to", new Date(customTo).toISOString());
      } else if (windowHours) {
        const from = new Date(Date.now() - windowHours * 60 * 60 * 1000);
        params.set("from", from.toISOString());
      }

      if (actorFilter) params.set("actor_email", actorFilter);
      if (companyFilter.trim()) params.set("company_id", companyFilter.trim());

      params.set("sort", sortField);
      params.set("dir", sortDir);
      params.set("limit", "100");

      if (nextCursor) params.set("cursor", nextCursor);

      return params.toString();
    },
    [windowHours, customFrom, customTo, actorFilter, companyFilter, sortField, sortDir]
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
    const preset = WINDOW_PRESETS.find((p) => p.hours === windowHours);
    return preset ? `last ${preset.label}` : `last ${windowHours} hours`;
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
                {WINDOW_PRESETS.map((preset) => (
                  <button
                    key={preset.hours}
                    onClick={() => {
                      setCustomFrom("");
                      setCustomTo("");
                      setWindowHours(preset.hours);
                    }}
                    className={`px-3 py-1.5 rounded text-sm border transition-colors ${
                      !customFrom && !customTo && windowHours === preset.hours
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-white dark:bg-card border-slate-200 dark:border-border text-foreground hover:bg-slate-50 dark:hover:bg-slate-800"
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
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
