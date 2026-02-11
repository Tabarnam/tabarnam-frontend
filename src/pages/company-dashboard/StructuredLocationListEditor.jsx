import React, { useCallback, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  asString,
  normalizeStructuredLocationList,
  normalizeStructuredLocationEntry,
  formatStructuredLocation,
  getLocationGeocodeStatus,
} from "./dashboardUtils";

export default function StructuredLocationListEditor({ label, value, onChange, LocationStatusBadge }) {
  const list = normalizeStructuredLocationList(value);

  const [city, setCity] = useState("");
  const [region, setRegion] = useState("");
  const [country, setCountry] = useState("");

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

  return (
    <div className="space-y-2">
      <div className="text-sm text-slate-700 dark:text-muted-foreground font-medium">{label}</div>

      <div className="rounded-lg border border-slate-200 dark:border-border bg-white dark:bg-card">
        {list.length === 0 ? (
          <div className="p-3 text-xs text-slate-500 dark:text-muted-foreground">No locations yet.</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {list.map((loc, idx) => {
              const display = formatStructuredLocation(loc) || "—";
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
