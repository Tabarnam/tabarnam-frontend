import React, { useCallback, useMemo, useState } from "react";
import { ChevronRight, ClipboardPaste, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  asString,
  normalizeStructuredLocationList,
  normalizeStructuredLocationEntry,
  formatStructuredLocation,
  getLocationGeocodeStatus,
} from "./dashboardUtils";

/**
 * Parse a semicolon-separated paragraph of locations into structured entries.
 * Format: "City, State/Province, Country; City2, State2, Country2; ..."
 * Each location's parts are comma-separated (1-3 parts: city[, region][, country]).
 */
function parseBulkLocations(text) {
  if (!text || typeof text !== "string") return [];
  return text
    .split(";")
    .map((chunk) => {
      const parts = chunk.split(",").map((p) => p.trim()).filter(Boolean);
      if (parts.length === 0) return null;
      const [city = "", region = "", country = ""] = parts;
      return normalizeStructuredLocationEntry({ city, region, state: region, country });
    })
    .filter(Boolean);
}

export default function StructuredLocationListEditor({ label, value, onChange, LocationStatusBadge }) {
  const list = normalizeStructuredLocationList(value);

  const [city, setCity] = useState("");
  const [region, setRegion] = useState("");
  const [country, setCountry] = useState("");

  // Bulk paste state
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");

  const parsedBulk = useMemo(() => parseBulkLocations(bulkText), [bulkText]);

  const addEntry = useCallback(() => {
    const next = normalizeStructuredLocationEntry({ city, region, state: region, country });
    if (!next) return;

    onChange([...list, next]);
    setCity("");
    setRegion("");
    setCountry("");
  }, [city, country, list, onChange, region]);

  const onKeyDown = useCallback(
    (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      addEntry();
    },
    [addEntry]
  );

  const removeEntry = useCallback(
    (idx) => {
      const next = list.filter((_, i) => i !== idx);
      onChange(next);
    },
    [list, onChange]
  );

  const applyBulk = useCallback(() => {
    if (parsedBulk.length === 0) return;
    onChange([...list, ...parsedBulk]);
    setBulkText("");
    setBulkOpen(false);
  }, [list, onChange, parsedBulk]);

  return (
    <div className="space-y-2">
      <div className="text-sm text-slate-700 dark:text-muted-foreground font-medium">{label}</div>

      <div className="rounded-lg border border-slate-200 dark:border-border bg-white dark:bg-card">
        {list.length === 0 ? (
          <div className="p-3 text-xs text-slate-500 dark:text-muted-foreground">No locations yet.</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {list.map((loc, idx) => {
              const display = formatStructuredLocation(loc) || "\u2014";
              return (
                <div key={idx} className="flex items-center gap-2 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-slate-900 dark:text-foreground">{display}</div>
                    <div className="mt-1 flex items-center gap-2">
                      <LocationStatusBadge loc={loc} />
                      {asString(loc?.geocode_source).trim() ? (
                        <span className="text-[11px] text-slate-500 dark:text-muted-foreground">{asString(loc.geocode_source).trim()}</span>
                      ) : null}
                    </div>
                  </div>

                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="border-red-600 text-red-600 hover:bg-red-600 hover:text-white"
                    onClick={() => removeEntry(idx)}
                    title="Remove"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        {/* ── Bulk paste disclosure ─────────────────────────────── */}
        <div className="border-t border-slate-200 dark:border-border">
          <button
            type="button"
            onClick={() => setBulkOpen((o) => !o)}
            className="flex w-full items-center gap-1.5 px-3 py-2 text-xs text-slate-500 dark:text-muted-foreground hover:text-slate-700 dark:hover:text-foreground transition-colors"
          >
            <ChevronRight className={`h-3 w-3 transition-transform ${bulkOpen ? "rotate-90" : ""}`} />
            <ClipboardPaste className="h-3 w-3" />
            <span>Bulk paste</span>
          </button>

          {bulkOpen && (
            <div className="px-3 pb-3 space-y-2">
              <textarea
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                rows={3}
                placeholder="City, State, Country; City, State, Country; ..."
                className="w-full rounded-md border border-slate-200 dark:border-border bg-white dark:bg-card px-3 py-2 text-sm text-slate-900 dark:text-foreground placeholder:text-slate-400 dark:placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 resize-y"
              />
              <Button
                type="button"
                size="sm"
                onClick={applyBulk}
                disabled={parsedBulk.length === 0}
              >
                <Plus className="h-4 w-4 mr-1" />
                {parsedBulk.length === 0
                  ? "Add locations"
                  : `Add ${parsedBulk.length} location${parsedBulk.length === 1 ? "" : "s"}`}
              </Button>
            </div>
          )}
        </div>

        {/* ── Single-entry add form ────────────────────────────── */}
        <div className="border-t border-slate-200 dark:border-border p-3">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-4 md:items-end">
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-700 dark:text-muted-foreground">City</label>
              <Input value={city} onChange={(e) => setCity(e.target.value)} onKeyDown={onKeyDown} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-700 dark:text-muted-foreground">Region/State</label>
              <Input value={region} onChange={(e) => setRegion(e.target.value)} onKeyDown={onKeyDown} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-700 dark:text-muted-foreground">Country</label>
              <Input value={country} onChange={(e) => setCountry(e.target.value)} onKeyDown={onKeyDown} />
            </div>
            <Button type="button" onClick={addEntry} disabled={!normalizeStructuredLocationEntry({ city, region, state: region, country })}>
              <Plus className="h-4 w-4 mr-2" />
              Add
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
