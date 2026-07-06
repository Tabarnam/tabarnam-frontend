// src/pages/company-dashboard/ScoreHistoryViewer.jsx
//
// Per-company score-change audit log, shown in the company editor's Stars
// section. Reads the existing company_edit_history (filtered to rating changes)
// and renders each entry as: when / who / what triggered it (which community
// review, a manual rescore, or an admin editing the stars) plus a per-star
// before→after for the six points. Lazy-loaded to avoid 404 noise on builds
// without the history endpoint.

import React, { useCallback, useState } from "react";
import { apiFetch } from "@/lib/api";
import { toast } from "sonner";

const STAR_LABELS = {
  star1: "Manufacturing",
  star2: "HQ",
  star3: "Reviews",
  star4: "Reputation",
  star5: "Quality",
  star6: "Overall",
};
const STAR_KEYS = ["star1", "star2", "star3", "star4", "star5", "star6"];

// Session flag: once the endpoint 404s, stop retrying automatically.
let historyUnsupported = false;

function fmtTime(iso) {
  const s = String(iso || "").trim();
  if (!s) return "";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtVal(v) {
  return v == null ? "—" : v.toFixed(2);
}

function triggerLabel(entry) {
  const t = entry && typeof entry.trigger === "object" ? entry.trigger : null;
  if (t) {
    const subj = t.review_subject ? `: “${t.review_subject}”` : "";
    switch (t.type) {
      case "review_approved": return `Community review approved${subj}`;
      case "review_rejected": return `Community review rejected${subj}`;
      case "review_edited": return `Community review edited${subj}`;
      case "review_removed": return `Community review removed${subj}`;
      case "manual_rescore": return "Manual rescore";
      default: return t.type || "Score update";
    }
  }
  const source = String(entry?.source || "").trim();
  if (source === "admin-ui") return "Admin edited scores";
  return String(entry?.action || "Score update");
}

function ratingRows(entry) {
  const d = entry?.diff?.rating;
  if (!d || typeof d !== "object") return [];
  const before = d.before && typeof d.before === "object" ? d.before : {};
  const after = d.after && typeof d.after === "object" ? d.after : {};
  const rows = [];
  for (const key of STAR_KEYS) {
    const b = numOrNull(before?.[key]?.value);
    const a = numOrNull(after?.[key]?.value);
    if (b == null && a == null) continue;
    rows.push({ key, label: STAR_LABELS[key], before: b, after: a, changed: b !== a });
  }
  return rows;
}

export default function ScoreHistoryViewer({ companyId }) {
  const id = String(companyId || "").trim();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState(null);
  const [unavailable, setUnavailable] = useState(false);

  const fetchPage = useCallback(
    async (nextCursor) => {
      if (!id) return;
      setLoading(true);
      try {
        const p = new URLSearchParams({ limit: "25", field: "rating" });
        if (nextCursor) p.set("cursor", nextCursor);
        const r = await apiFetch(`/admin/companies/${encodeURIComponent(id)}/history?${p.toString()}`);
        if (r.status === 404) {
          historyUnsupported = true;
          setUnavailable(true);
          return;
        }
        const data = await r.json().catch(() => ({}));
        if (!r.ok || data?.ok !== true) throw new Error(data?.error || r.statusText || "Failed to load");
        setItems((prev) => (nextCursor ? [...prev, ...(data.items || [])] : data.items || []));
        setCursor(data.next_cursor || null);
      } catch (e) {
        toast.error(e?.message || "Failed to load score history");
      } finally {
        setLoading(false);
      }
    },
    [id]
  );

  const load = () => {
    setOpen(true);
    fetchPage(null);
  };

  if (!id) return null;

  return (
    <div className="rounded-md border border-slate-200 dark:border-border bg-white dark:bg-card p-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-800 dark:text-foreground">Score history</div>
        {open ? (
          <button type="button" onClick={() => fetchPage(null)} disabled={loading} className="text-xs text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground">
            {loading ? "Loading…" : "Refresh"}
          </button>
        ) : (
          <button type="button" onClick={load} disabled={historyUnsupported} className="text-xs text-blue-600 hover:underline dark:text-blue-400 disabled:opacity-50">
            Load score history
          </button>
        )}
      </div>

      {unavailable && (
        <div className="mt-2 text-xs text-slate-500 dark:text-muted-foreground">Score history isn't available on this build.</div>
      )}

      {open && !unavailable && (
        <div className="mt-3 space-y-3">
          {!loading && items.length === 0 ? (
            <div className="text-xs text-slate-500 dark:text-muted-foreground">No score changes recorded yet.</div>
          ) : null}

          {items.map((entry) => {
            const rows = ratingRows(entry);
            const actor = String(entry?.actor_email || entry?.actor_user_id || "").trim() || "system";
            return (
              <div key={entry.id} className="rounded border border-slate-200 dark:border-border p-2">
                <div className="text-xs text-slate-500 dark:text-muted-foreground">
                  {fmtTime(entry?.created_at)} · {actor}
                </div>
                <div className="mt-0.5 text-sm font-medium text-slate-800 dark:text-foreground">{triggerLabel(entry)}</div>
                {rows.length > 0 ? (
                  <table className="mt-2 w-full text-xs">
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.key} className={row.changed ? "font-medium text-slate-900 dark:text-foreground" : "text-slate-500 dark:text-muted-foreground"}>
                          <td className="py-0.5 pr-2 whitespace-nowrap">{row.label}</td>
                          <td className="py-0.5 pr-1 text-right tabular-nums">{fmtVal(row.before)}</td>
                          <td className="py-0.5 px-1 text-center">→</td>
                          <td className="py-0.5 pl-1 text-right tabular-nums">
                            {fmtVal(row.after)}
                            {row.changed ? <span className="ml-1 text-emerald-600 dark:text-emerald-400">●</span> : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="mt-1 text-xs text-slate-500 dark:text-muted-foreground">Scores recalculated.</div>
                )}
              </div>
            );
          })}

          {cursor ? (
            <button type="button" onClick={() => fetchPage(cursor)} disabled={loading} className="text-xs text-blue-600 hover:underline dark:text-blue-400">
              {loading ? "Loading…" : "Load more"}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
