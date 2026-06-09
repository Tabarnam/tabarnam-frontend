// Phase 4.35 — Recent Activity panel for the AdminImport page.
//
// Collapsed-by-default `<details>` widget. Shows up to 25 most recent
// admin actions across the catalog, aggregated at the batch level:
//   - "Imported 20 companies Adox through Shanghai"
//   - "Applied 'film camera' as industry to 20 companies"
//   - "Company Lady May Tallow edited"
//
// Loads from /api/xadmin-api-recent-activity on mount. Parent can call
// the exposed refresh() method (via ref) after a batch completes.

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { RefreshCcw } from "lucide-react";
import { apiFetch } from "@/lib/api";

function asString(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function formatRelativeTime(iso) {
  const raw = asString(iso).trim();
  if (!raw) return "";
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return raw;
  const deltaMs = Date.now() - t;
  if (deltaMs < 0) return "just now";
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  try {
    return new Date(t).toLocaleDateString();
  } catch {
    return raw;
  }
}

function formatAbsoluteTime(iso) {
  const raw = asString(iso).trim();
  if (!raw) return "";
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return raw;
  try {
    return new Date(t).toLocaleString();
  } catch {
    return raw;
  }
}

/**
 * Build the user-facing one-line summary from a feed row's action +
 * summary payload (or changed_fields for per-company entries).
 */
function describeRow(row) {
  if (!row || typeof row !== "object") return "";
  const action = asString(row.action).trim();

  if (action === "bulk_import_summary") {
    const s = row.summary || {};
    const count = Number(s.count) || 0;
    const first = asString(s.first).trim();
    const last = asString(s.last).trim();
    if (count > 0 && first && last && first !== last) {
      return `Imported ${count} companies ${first} through ${last}`;
    }
    if (count > 0 && first) {
      return `Imported ${count} ${count === 1 ? "company" : "companies"} (${first})`;
    }
    if (count > 0) {
      return `Imported ${count} ${count === 1 ? "company" : "companies"}`;
    }
    return "Bulk import completed";
  }

  if (action === "apply_batch_fields_summary") {
    const s = row.summary || {};
    const count = Number(s.count) || 0;
    const ind = asString(s.batch_industries).trim();
    const prods = asString(s.batch_keywords).trim();
    const first = asString(s.first).trim();
    const last = asString(s.last).trim();
    const range =
      first && last && first !== last
        ? ` ${first} through ${last}`
        : first
          ? ` (${first})`
          : "";

    if (ind && prods) {
      return `Applied industries '${ind}' + products '${prods}' to ${count || ""} companies${range}`.replace(
        "  ",
        " "
      );
    }
    if (ind) {
      return `Applied '${ind}' as industry to ${count || ""} companies${range}`.replace(
        "  ",
        " "
      );
    }
    if (prods) {
      return `Applied '${prods}' as products to ${count || ""} companies${range}`.replace(
        "  ",
        " "
      );
    }
    return `Applied batch fields to ${count || ""} companies${range}`.trim();
  }

  if (action === "update") {
    const name = asString(row.company_name).trim() || asString(row.company_id).trim() || "(unknown)";
    return `Company ${name} edited`;
  }

  if (action === "create") {
    const name = asString(row.company_name).trim() || asString(row.company_id).trim() || "(unknown)";
    return `Company ${name} created`;
  }

  // Unknown action — show it raw so we can spot new event types.
  const name = asString(row.company_name).trim() || asString(row.company_id).trim();
  return name ? `${action || "action"} on ${name}` : action || "action";
}

const RecentActivityPanel = forwardRef(function RecentActivityPanel(props, ref) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/xadmin-api-recent-activity?limit=25");
      const data = await res.json().catch(() => ({ items: [] }));
      if (!res.ok) {
        throw new Error(asString(data?.error).trim() || res.statusText || "Failed to load");
      }
      if (mountedRef.current) {
        setItems(Array.isArray(data?.items) ? data.items : []);
      }
    } catch (e) {
      if (mountedRef.current) {
        setError(asString(e?.message).trim() || "Failed to load");
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useImperativeHandle(ref, () => ({ refresh: load }), [load]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <details className="rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted px-4 py-3">
      <summary className="cursor-pointer select-none text-sm font-medium text-slate-800 dark:text-foreground flex items-center justify-between gap-2">
        <span>
          Recent activity
          {items.length > 0 ? (
            <span className="ml-2 text-xs font-normal text-slate-500 dark:text-muted-foreground">
              ({items.length})
            </span>
          ) : null}
        </span>
        <button
          type="button"
          onClick={(e) => {
            // Don't toggle the <details> when clicking the refresh button.
            e.preventDefault();
            e.stopPropagation();
            load();
          }}
          className="inline-flex items-center gap-1 rounded border border-slate-300 dark:border-border px-2 py-0.5 text-[11px] text-slate-700 dark:text-muted-foreground hover:bg-white dark:hover:bg-card"
          title="Refresh recent activity"
          disabled={loading}
        >
          <RefreshCcw className={loading ? "h-3 w-3 animate-spin" : "h-3 w-3"} />
          Refresh
        </button>
      </summary>

      <div className="mt-3 space-y-1">
        {error ? (
          <div className="text-xs text-red-700 dark:text-red-400">
            Failed to load recent activity: {error}
          </div>
        ) : loading && items.length === 0 ? (
          <div className="text-xs text-slate-500 dark:text-muted-foreground">Loading…</div>
        ) : items.length === 0 ? (
          <div className="text-xs text-slate-500 dark:text-muted-foreground">
            No recent activity yet. Imports, edits, and batch applies will appear here as you make them.
          </div>
        ) : (
          <ul className="divide-y divide-slate-200 dark:divide-border">
            {items.map((row) => {
              const summary = describeRow(row);
              const actor = asString(row.actor_email).trim();
              const relative = formatRelativeTime(row.created_at);
              const absolute = formatAbsoluteTime(row.created_at);
              return (
                <li
                  key={row.id || `${row.created_at}-${summary}`}
                  className="py-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs"
                >
                  <span className="text-slate-800 dark:text-foreground">{summary}</span>
                  <span className="text-slate-500 dark:text-muted-foreground flex items-baseline gap-2">
                    {actor ? (
                      <span
                        className="inline-flex items-center rounded-full border border-slate-200 dark:border-border bg-white dark:bg-card px-1.5 py-0 text-[10px]"
                        title={`Actor: ${actor}`}
                      >
                        {actor}
                      </span>
                    ) : null}
                    <span title={absolute}>{relative}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </details>
  );
});

export default RecentActivityPanel;
