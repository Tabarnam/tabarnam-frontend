import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownAZ, ArrowUpZA, Filter, FilterX, Check } from "lucide-react";

// Excel-style column filter: sort, search, tick the values you want, OK.
//
// The selection is applied SERVER-SIDE by the caller, not by hiding rows that
// were already fetched. Excel filters a whole sheet because the sheet is all
// the data; here the table is one page of a much larger query, so a
// client-side checkbox filter would silently narrow only what is on screen
// while looking exactly like it narrowed the query.
//
// Draft state is local until OK. Cancel discards it — ticking six boxes and
// then changing your mind should not fire six queries.

export default function ColumnFilterMenu({
  label,
  values,
  selected,
  onApply,
  onSort,
  sortDir,
  loading,
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState(new Set(selected));
  const ref = useRef(null);

  // Reopen with the applied selection, not with whatever was abandoned last time.
  useEffect(() => {
    if (open) {
      setDraft(new Set(selected));
      setSearch("");
    }
  }, [open, selected]);

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onEsc = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q ? values.filter((v) => String(v).toLowerCase().includes(q)) : values;
    return list;
  }, [values, search]);

  // An empty selection means "no filter", which is also what every box ticked
  // means. Treating them as the same thing keeps the URL and the SQL clean.
  const allVisibleChecked = visible.length > 0 && visible.every((v) => draft.has(v));
  const active = selected.length > 0;

  const toggle = (v) => {
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  };

  const toggleAllVisible = () => {
    setDraft((prev) => {
      const next = new Set(prev);
      if (allVisibleChecked) visible.forEach((v) => next.delete(v));
      else visible.forEach((v) => next.add(v));
      return next;
    });
  };

  const apply = () => {
    const picked = [...draft];
    onApply(picked.length === values.length ? [] : picked);
    setOpen(false);
  };

  return (
    <span className="relative inline-flex items-center" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={active ? `${label}: ${selected.length} selected` : `Filter and sort ${label}`}
        aria-label={`Filter ${label}`}
        className={`ml-1 inline-flex items-center rounded p-0.5 transition-colors ${
          active
            ? "text-primary"
            : "text-muted-foreground hover:text-foreground"
        }`}
      >
        {active ? <FilterX className="h-3 w-3" /> : <Filter className="h-3 w-3" />}
      </button>

      {open && (
        <div className="absolute left-0 top-6 z-50 w-64 rounded-md border border-slate-200 dark:border-border bg-white dark:bg-card shadow-lg text-sm">
          {onSort && (
            <div className="border-b border-slate-200 dark:border-border py-1">
              <button
                type="button"
                onClick={() => {
                  onSort("asc");
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800 ${
                  sortDir === "asc" ? "text-primary" : "text-foreground"
                }`}
              >
                <ArrowDownAZ className="h-4 w-4" /> Sort A to Z
              </button>
              <button
                type="button"
                onClick={() => {
                  onSort("desc");
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800 ${
                  sortDir === "desc" ? "text-primary" : "text-foreground"
                }`}
              >
                <ArrowUpZA className="h-4 w-4" /> Sort Z to A
              </button>
            </div>
          )}

          <div className="p-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search"
              className="w-full h-8 rounded border border-slate-200 dark:border-border bg-white dark:bg-background px-2 text-sm text-foreground"
            />
          </div>

          <div className="max-h-56 overflow-y-auto border-t border-slate-200 dark:border-border">
            {loading && (
              <div className="px-3 py-3 text-xs text-muted-foreground">Loading values…</div>
            )}

            {!loading && values.length === 0 && (
              <div className="px-3 py-3 text-xs text-muted-foreground">
                No values in the current results.
              </div>
            )}

            {!loading && visible.length > 0 && (
              <label className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer">
                <input type="checkbox" checked={allVisibleChecked} onChange={toggleAllVisible} />
                <span className="text-foreground">(Select All)</span>
              </label>
            )}

            {!loading &&
              visible.map((v) => (
                <label
                  key={v}
                  className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                >
                  <input type="checkbox" checked={draft.has(v)} onChange={() => toggle(v)} />
                  <span className="truncate text-foreground" title={v}>
                    {v}
                  </span>
                </label>
              ))}
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-slate-200 dark:border-border p-2">
            <button
              type="button"
              onClick={() => {
                onApply([]);
                setOpen(false);
              }}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Clear filter
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded border border-slate-200 dark:border-border px-3 py-1 text-xs text-foreground hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={apply}
                className="inline-flex items-center gap-1 rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90"
              >
                <Check className="h-3 w-3" /> OK
              </button>
            </div>
          </div>
        </div>
      )}
    </span>
  );
}
