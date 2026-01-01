import { useCallback, useEffect, useMemo, useState } from "react";

import { Loader2, Search } from "lucide-react";

import { apiFetch, getUserFacingConfigMessage, toErrorString } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v) => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
}

function uniqueByLowercase(list) {
  const seen = new Set();
  const next = [];

  for (const item of normalizeStringArray(list)) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(item);
  }

  return next;
}

function parseApiList(payload) {
  if (Array.isArray(payload)) return normalizeStringArray(payload);
  if (!payload || typeof payload !== "object") return [];

  if (Array.isArray(payload.industries)) return normalizeStringArray(payload.industries);
  if (Array.isArray(payload.keywords)) return normalizeStringArray(payload.keywords);
  if (Array.isArray(payload.items)) return normalizeStringArray(payload.items);

  return [];
}

export function DrawInSelectorDialog({
  open,
  onOpenChange,
  title,
  endpoint,
  existingItems,
  suggestedItems,
  onApply,
}) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(() => new Set());

  const canonicalByLower = useMemo(() => {
    const map = new Map();
    for (const item of normalizeStringArray(items)) {
      map.set(item.toLowerCase(), item);
    }
    return map;
  }, [items]);

  const existingSet = useMemo(() => {
    const set = new Set();
    for (const item of normalizeStringArray(existingItems)) {
      set.add(item.toLowerCase());
    }
    return set;
  }, [existingItems]);

  const suggestedCanonical = useMemo(() => {
    const raw = uniqueByLowercase(suggestedItems);
    const next = [];

    for (const item of raw) {
      const canonical = canonicalByLower.get(item.toLowerCase());
      if (!canonical) continue;
      if (existingSet.has(canonical.toLowerCase())) continue;
      next.push(canonical);
    }

    return uniqueByLowercase(next);
  }, [canonicalByLower, existingSet, suggestedItems]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => item.toLowerCase().includes(q));
  }, [items, search]);

  const selectedCount = selected.size;

  const toggleSelection = useCallback(
    (item, nextChecked) => {
      const canonical = asString(item).trim();
      if (!canonical) return;

      setSelected((prev) => {
        const next = new Set(prev);
        const key = canonical.toLowerCase();

        if (nextChecked) {
          next.add(key);
        } else {
          next.delete(key);
        }

        return next;
      });
    },
    [setSelected]
  );

  const isSelected = useCallback((item) => selected.has(asString(item).trim().toLowerCase()), [selected]);

  const fetchList = useCallback(
    async (signal) => {
      const safeEndpoint = asString(endpoint).trim();
      if (!safeEndpoint) {
        setItems([]);
        return;
      }

      const res = await apiFetch(safeEndpoint, { signal });

      if (!res.ok) {
        const configMsg = await getUserFacingConfigMessage(res);
        throw new Error(configMsg || `Request failed (${res.status})`);
      }

      const data = await res.json().catch(() => null);
      const list = uniqueByLowercase(parseApiList(data));
      setItems(list);
    },
    [endpoint]
  );

  useEffect(() => {
    if (!open) return;

    const controller = new AbortController();

    setSearch("");
    setSelected(new Set());
    setLoadError("");
    setLoading(true);

    fetchList(controller.signal)
      .catch((err) => {
        if (controller.signal.aborted) return;
        setItems([]);
        setLoadError(toErrorString(err));
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        setLoading(false);
      });

    return () => controller.abort();
  }, [fetchList, open]);

  const handleCancel = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const handleApply = useCallback(() => {
    if (!onApply) {
      onOpenChange(false);
      return;
    }

    const next = [];
    for (const [lower, canonical] of canonicalByLower.entries()) {
      if (!selected.has(lower)) continue;
      next.push(canonical);
    }

    onApply(next);
    onOpenChange(false);
  }, [canonicalByLower, onApply, onOpenChange, selected]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search…"
                className="pl-9"
              />
            </div>

            <div className="text-xs text-slate-600 sm:text-right">
              Selected: <span className="font-semibold text-slate-900">{selectedCount}</span>
            </div>
          </div>

          {loadError ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{loadError}</div>
          ) : null}

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-slate-700">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading list…
            </div>
          ) : null}

          {!loading && suggestedCanonical.length > 0 ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="text-xs font-semibold text-slate-800">Suggested</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {suggestedCanonical.map((item) => {
                  const lower = item.toLowerCase();
                  const checked = isSelected(item);

                  return (
                    <label key={`suggested-${lower}`} className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-800">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) => toggleSelection(item, Boolean(v))}
                        aria-label={`Select ${item}`}
                      />
                      <span>{item}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          ) : null}

          <div className="rounded-lg border border-slate-200 bg-white">
            <div className="max-h-[360px] overflow-auto p-3 space-y-2">
              {!loading && filtered.length === 0 ? (
                <div className="text-xs text-slate-500">No matches.</div>
              ) : null}

              {filtered.map((item) => {
                const lower = item.toLowerCase();
                const alreadyAdded = existingSet.has(lower);
                const checked = alreadyAdded || isSelected(item);

                return (
                  <label
                    key={lower}
                    className={`flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm ${
                      alreadyAdded ? "border-slate-200 bg-slate-50" : "border-slate-200 bg-white hover:bg-slate-50"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <Checkbox
                        checked={checked}
                        disabled={alreadyAdded}
                        onCheckedChange={(v) => toggleSelection(item, Boolean(v))}
                        aria-label={`Select ${item}`}
                      />
                      <span className="text-slate-900">{item}</span>
                    </span>

                    {alreadyAdded ? <span className="text-xs text-slate-500">Added</span> : null}
                  </label>
                );
              })}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button onClick={handleApply} disabled={selectedCount === 0}>
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
