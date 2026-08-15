import React, { useCallback, useMemo, useState } from "react";
import { Copy, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";

// A single row in the structured-address table. Each entry describes ONE
// physical location that a page-scrape or xAI enrichment surfaced, kept
// alongside (never replacing) the normalized headquarters_location /
// manufacturing_locations strings that feed the pins index.
//
// See api/_addresses.js for the persisted shape and the trusted-source rule
// that stamps is_public at import time.

const TYPES = [
  { value: "hq", label: "HQ" },
  { value: "manufacturing", label: "Mfg" },
];

function asString(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function trim(v) {
  return asString(v).trim();
}

// Two rows are the "same address" when street + locality + postal_code match
// (matches the backend's addressKey in api/_addresses.js — must stay in sync).
function rowKey(entry) {
  return [
    trim(entry?.street).toLowerCase(),
    trim(entry?.locality).toLowerCase(),
    trim(entry?.postal_code).toLowerCase(),
  ].join("|");
}

function formatOneLine(entry) {
  const parts = [
    trim(entry?.street),
    [trim(entry?.locality), trim(entry?.region)].filter(Boolean).join(", "),
    [trim(entry?.postal_code), trim(entry?.country)].filter(Boolean).join(" "),
  ].filter(Boolean);
  return parts.join(", ");
}

function coerceType(raw) {
  const t = trim(raw).toLowerCase();
  return t === "manufacturing" ? "manufacturing" : "hq";
}

function normalize(entry) {
  if (!entry || typeof entry !== "object") return null;
  return {
    street: trim(entry.street),
    locality: trim(entry.locality),
    region: trim(entry.region),
    postal_code: trim(entry.postal_code),
    country: trim(entry.country),
    type: coerceType(entry.type),
    source_url: trim(entry.source_url),
    fetched_at: trim(entry.fetched_at),
    is_public: entry.is_public === true,
  };
}

export default function AddressesEditor({ value, onChange }) {
  const entries = useMemo(() => {
    const arr = Array.isArray(value) ? value : [];
    return arr.map(normalize).filter(Boolean);
  }, [value]);

  const [copiedKey, setCopiedKey] = useState("");

  const patchAt = useCallback(
    (idx, patch) => {
      const next = entries.map((e, i) => (i === idx ? { ...e, ...patch } : e));
      onChange(next);
    },
    [entries, onChange]
  );

  const removeAt = useCallback(
    (idx) => {
      const next = entries.filter((_, i) => i !== idx);
      onChange(next);
    },
    [entries, onChange]
  );

  const addEntry = useCallback(() => {
    onChange([
      ...entries,
      {
        street: "",
        locality: "",
        region: "",
        postal_code: "",
        country: "",
        type: "hq",
        source_url: "",
        fetched_at: "",
        is_public: false,
      },
    ]);
  }, [entries, onChange]);

  const copyLine = useCallback((entry) => {
    const line = formatOneLine(entry);
    if (!line) return;
    const done = () => {
      const k = rowKey(entry);
      setCopiedKey(k);
      setTimeout(() => setCopiedKey((cur) => (cur === k ? "" : cur)), 1200);
    };
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(line).then(done).catch(() => done());
    } else {
      done();
    }
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-slate-800 dark:text-foreground">Addresses</div>
        <Button type="button" size="sm" variant="outline" onClick={addEntry} className="h-7 gap-1 text-xs">
          <Plus className="h-3 w-3" /> Add
        </Button>
      </div>

      <p className="text-xs text-slate-500 dark:text-muted-foreground -mt-1">
        Structured street addresses captured opportunistically from what an extractor already reads.
        Existing HQ / Manufacturing location fields above are unaffected.
      </p>

      {entries.length === 0 ? (
        <div className="rounded border border-dashed border-slate-300 dark:border-border px-3 py-4 text-xs text-slate-500 dark:text-muted-foreground">
          No structured addresses captured for this company.
        </div>
      ) : (
        <div className="space-y-3">
          {entries.map((entry, idx) => {
            const k = rowKey(entry);
            const oneLine = formatOneLine(entry);
            return (
              <div
                key={`${k}-${idx}`}
                className="rounded border border-slate-200 dark:border-border p-3 space-y-2"
              >
                {/* Row 1: type dropdown + is_public + delete + copy */}
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-muted-foreground">
                    <span>Type</span>
                    <select
                      value={entry.type}
                      onChange={(e) => patchAt(idx, { type: coerceType(e.target.value) })}
                      className="h-7 rounded border border-slate-300 dark:border-border bg-white dark:bg-background px-1.5 text-xs"
                    >
                      {TYPES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-muted-foreground">
                    <Checkbox
                      checked={Boolean(entry.is_public)}
                      onCheckedChange={(v) => patchAt(idx, { is_public: Boolean(v) })}
                    />
                    <span>Public</span>
                  </label>

                  <div className="ml-auto flex items-center gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => copyLine(entry)}
                      disabled={!oneLine}
                      className="h-7 gap-1 text-xs"
                      title="Copy full address"
                    >
                      <Copy className="h-3 w-3" />
                      {copiedKey === k ? "Copied" : "Copy"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => removeAt(idx)}
                      className="h-7 gap-1 text-xs text-red-600 hover:text-red-700"
                      title="Remove address"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>

                {/* Row 2: street (full width) */}
                <Input
                  value={entry.street}
                  onChange={(e) => patchAt(idx, { street: e.target.value })}
                  placeholder="Street (e.g. 61 9th Ave)"
                  className="text-sm"
                />

                {/* Row 3: locality, region, postal, country */}
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_120px_140px_120px] gap-2">
                  <Input
                    value={entry.locality}
                    onChange={(e) => patchAt(idx, { locality: e.target.value })}
                    placeholder="City"
                    className="text-sm"
                  />
                  <Input
                    value={entry.region}
                    onChange={(e) => patchAt(idx, { region: e.target.value })}
                    placeholder="State/Region"
                    className="text-sm"
                  />
                  <Input
                    value={entry.postal_code}
                    onChange={(e) => patchAt(idx, { postal_code: e.target.value })}
                    placeholder="Postal Code"
                    className="text-sm"
                  />
                  <Input
                    value={entry.country}
                    onChange={(e) => patchAt(idx, { country: e.target.value })}
                    placeholder="Country"
                    className="text-sm"
                  />
                </div>

                {/* Row 4: source + fetched_at metadata */}
                {(entry.source_url || entry.fetched_at) && (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500 dark:text-muted-foreground">
                    {entry.source_url ? (
                      <span className="truncate max-w-full">
                        Source:{" "}
                        <a
                          href={entry.source_url}
                          target="_blank"
                          rel="noreferrer"
                          className="underline hover:text-slate-700 dark:hover:text-foreground"
                        >
                          {entry.source_url}
                        </a>
                      </span>
                    ) : null}
                    {entry.fetched_at ? <span>Fetched: {entry.fetched_at}</span> : null}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
