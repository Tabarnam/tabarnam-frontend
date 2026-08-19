import React, { useCallback, useMemo, useState } from "react";
import { AlertTriangle, Check, Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";

// Structured street addresses for one company. Each entry describes ONE
// physical place that a page-scrape or xAI enrichment surfaced, kept
// alongside (never replacing) the normalized headquarters_location /
// manufacturing_locations strings that feed the pins index.
//
// See api/_addresses.js for the persisted shape and the trusted-source rule
// that stamps is_public at capture time.
//
// PRESENTATION RULE, learned the hard way: a role is a PROPERTY of an
// address, and this panel must never let it look like a view switch. The
// previous layout put a Type dropdown at the top-left of a single card —
// the exact position and shape of a tab control — so an admin looking for
// the manufacturing address flipped it, saw the street fields sit still,
// and read that as "the HQ address persisted". What had actually happened
// was the company's only address being silently reclassified; and because
// addressKey includes type, a later import re-adds the original as a
// duplicate rather than restoring it. Roles are therefore SECTIONS, always
// both rendered (an empty one is the answer to "where is the other one?"),
// and changing a role is a named action that visibly moves the card.

const TYPES = [
  { value: "hq", label: "Headquarters", short: "HQ" },
  { value: "manufacturing", label: "Manufacturing", short: "Mfg" },
];

function asString(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function trim(v) {
  return asString(v).trim();
}

function coerceType(raw) {
  const t = trim(raw).toLowerCase();
  return t === "manufacturing" ? "manufacturing" : "hq";
}

function otherType(t) {
  return t === "manufacturing" ? "hq" : "manufacturing";
}

function labelFor(t) {
  return (TYPES.find((x) => x.value === t) || TYPES[0]).label;
}

// Identity of an address. Mirrors addressKey in api/_addresses.js — type is
// PART of the key there, because the same building can legitimately be both
// a head office and a factory and both rows are kept. Leaving type out here
// made two such rows indistinguishable to this component.
function rowKey(entry) {
  return [
    trim(entry?.street).toLowerCase(),
    trim(entry?.locality).toLowerCase(),
    trim(entry?.postal_code).toLowerCase(),
    coerceType(entry?.type),
  ].join("|");
}

/** Same building, ignoring which role it is filed under. */
function placeKey(entry) {
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

/** Second line of the read-only display: "Sanford, NC 27330, USA". */
function formatLocalityLine(entry) {
  const left = [trim(entry?.locality), trim(entry?.region)].filter(Boolean).join(", ");
  const right = [trim(entry?.postal_code), trim(entry?.country)].filter(Boolean).join(" ");
  return [left, right].filter(Boolean).join(" ");
}

function hostOf(url) {
  const u = trim(url);
  if (!u) return "";
  try {
    return new URL(u).host.replace(/^www\./, "");
  } catch {
    return u.replace(/^https?:\/\//, "").split("/")[0];
  }
}

function formatDate(raw) {
  const s = trim(raw);
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
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

/**
 * The normalized location strings this address should agree with. These are
 * the load-bearing fields (they feed the pins index and place scoping); the
 * structured address is additive, so a disagreement is worth surfacing but
 * is never resolved automatically.
 */
function normalizedCandidates(type, hqLocation, manufacturingLocations) {
  if (type === "hq") {
    return trim(hqLocation) ? [trim(hqLocation)] : [];
  }
  const arr = Array.isArray(manufacturingLocations) ? manufacturingLocations : [];
  return arr
    .map((m) => {
      if (typeof m === "string") return trim(m);
      if (!m || typeof m !== "object") return "";
      // Entries arrive in a few shapes across import vintages.
      return (
        trim(m.location) ||
        trim(m.address) ||
        [trim(m.city), trim(m.state) || trim(m.region), trim(m.country)].filter(Boolean).join(", ")
      );
    })
    .filter(Boolean);
}

/**
 * Does this street address sit in the place the normalized field claims?
 * Compared on locality, which is the part both sides always carry.
 */
function agreement(entry, candidates) {
  const loc = trim(entry.locality).toLowerCase();
  if (!loc) return null; // nothing comparable — stay quiet rather than guess
  if (!candidates.length) return { state: "missing" };
  const hit = candidates.find((c) => c.toLowerCase().includes(loc));
  return hit ? { state: "ok", text: hit } : { state: "differs", text: candidates.join("; ") };
}

export default function AddressesEditor({
  value,
  onChange,
  // The normalized fields this panel cross-checks against. Optional: without
  // them the panel simply omits the agreement line.
  hqLocation = "",
  manufacturingLocations = [],
}) {
  const entries = useMemo(() => {
    const arr = Array.isArray(value) ? value : [];
    return arr.map(normalize).filter(Boolean);
  }, [value]);

  const [copiedKey, setCopiedKey] = useState("");
  const [editingIdx, setEditingIdx] = useState(null);

  const patchAt = useCallback(
    (idx, patch) => {
      onChange(entries.map((e, i) => (i === idx ? { ...e, ...patch } : e)));
    },
    [entries, onChange]
  );

  const removeAt = useCallback(
    (idx) => {
      setEditingIdx((cur) => (cur === idx ? null : cur));
      onChange(entries.filter((_, i) => i !== idx));
    },
    [entries, onChange]
  );

  const addEntry = useCallback(
    (type) => {
      onChange([
        ...entries,
        {
          street: "",
          locality: "",
          region: "",
          postal_code: "",
          country: "",
          type: coerceType(type),
          source_url: "",
          fetched_at: "",
          is_public: false,
        },
      ]);
      // A blank row has nothing to read, so open it for typing straight away.
      setEditingIdx(entries.length);
    },
    [entries, onChange]
  );

  const copyLine = useCallback((entry) => {
    const line = formatOneLine(entry);
    if (!line) return;
    const k = rowKey(entry);
    const done = () => {
      setCopiedKey(k);
      setTimeout(() => setCopiedKey((cur) => (cur === k ? "" : cur)), 1200);
    };
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(line).then(done).catch(done);
    } else {
      done();
    }
  }, []);

  // Which buildings appear under both roles, so a legitimate dual-role
  // address doesn't read as a duplicate somebody should delete.
  const dualRolePlaces = useMemo(() => {
    const byPlace = new Map();
    for (const e of entries) {
      const p = placeKey(e);
      if (!byPlace.has(p)) byPlace.set(p, new Set());
      byPlace.get(p).add(e.type);
    }
    return new Set([...byPlace.entries()].filter(([, t]) => t.size > 1).map(([p]) => p));
  }, [entries]);

  const publicCount = entries.filter((e) => e.is_public).length;

  const renderCard = (entry, idx) => {
    const k = rowKey(entry);
    const isEditing = editingIdx === idx;
    const oneLine = formatOneLine(entry);
    const agree = agreement(
      entry,
      normalizedCandidates(entry.type, hqLocation, manufacturingLocations)
    );
    const host = hostOf(entry.source_url);
    const fetched = formatDate(entry.fetched_at);
    const isDual = dualRolePlaces.has(placeKey(entry));

    return (
      <div
        key={`${k}-${idx}`}
        className="rounded border border-slate-200 dark:border-border p-3 space-y-2 bg-white dark:bg-card/40"
      >
        {isEditing ? (
          <>
            <Input
              value={entry.street}
              onChange={(e) => patchAt(idx, { street: e.target.value })}
              placeholder="Street (e.g. 2127 Boone Trail Road)"
              className="text-sm"
            />
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
          </>
        ) : (
          <div className="text-sm">
            <div className="font-medium text-slate-800 dark:text-foreground">
              {entry.street || <span className="italic text-slate-400 dark:text-muted-foreground">No street</span>}
            </div>
            <div className="text-slate-600 dark:text-muted-foreground">
              {formatLocalityLine(entry) || "—"}
            </div>
          </div>
        )}

        {/* Does the street address land where the load-bearing field says? */}
        {agree ? (
          <div className="flex items-start gap-1.5 text-[11px]">
            {agree.state === "ok" ? (
              <>
                <Check className="h-3 w-3 mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <span className="text-emerald-700 dark:text-emerald-400">
                  agrees with {labelFor(entry.type)} location “{agree.text}”
                </span>
              </>
            ) : (
              <>
                <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
                <span className="text-amber-700 dark:text-amber-400">
                  {agree.state === "missing"
                    ? `no ${labelFor(entry.type)} location on file to check against`
                    : `${labelFor(entry.type)} location says “${agree.text}”`}
                </span>
              </>
            )}
          </div>
        ) : null}

        {(host || fetched || isDual) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500 dark:text-muted-foreground">
            {host ? (
              <a
                href={entry.source_url}
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-slate-700 dark:hover:text-foreground truncate max-w-[22rem]"
                title={entry.source_url}
              >
                {host}
              </a>
            ) : null}
            {fetched ? <span>fetched {fetched}</span> : null}
            {isDual ? (
              <span className="rounded bg-slate-100 dark:bg-muted px-1.5 py-0.5">
                also filed under {labelFor(otherType(entry.type))}
              </span>
            ) : null}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-slate-100 dark:border-border/60">
          <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-muted-foreground">
            <Checkbox
              checked={Boolean(entry.is_public)}
              onCheckedChange={(v) => patchAt(idx, { is_public: Boolean(v) })}
            />
            <span>Public</span>
          </label>
          <span className="text-[11px] text-slate-400 dark:text-muted-foreground/70">
            set at capture from the source — override here
          </span>

          <div className="ml-auto flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setEditingIdx(isEditing ? null : idx)}
              className="h-7 gap-1 text-xs"
            >
              {isEditing ? <Check className="h-3 w-3" /> : <Pencil className="h-3 w-3" />}
              {isEditing ? "Done" : "Edit"}
            </Button>
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
            {/* Named, and it visibly moves the card to the other section —
                the whole point of not shipping this as a dropdown. */}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => patchAt(idx, { type: otherType(entry.type) })}
              className="h-7 text-xs"
              title={`File this address under ${labelFor(otherType(entry.type))} instead`}
            >
              Move to {labelFor(otherType(entry.type))}
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
      </div>
    );
  };

  const renderSection = (type) => {
    // Index is kept from the source array so edits address the right entry.
    const rows = entries.map((e, idx) => ({ e, idx })).filter(({ e }) => e.type === type);
    const label = labelFor(type);
    const hasNormalized = normalizedCandidates(type, hqLocation, manufacturingLocations).length > 0;

    return (
      <div key={type} className="space-y-2">
        <div className="flex items-center gap-2">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-muted-foreground">
            {label}
          </div>
          <div className="text-[11px] text-slate-400 dark:text-muted-foreground/70">
            {rows.length === 0 ? "— none" : `— ${rows.length}`}
          </div>
          {/* Named per section: two buttons both reading "Add" are ambiguous
              to anyone not seeing which heading they sit under. */}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => addEntry(type)}
            aria-label={`Add ${label.toLowerCase()} address`}
            className="ml-auto h-6 gap-1 text-[11px]"
          >
            <Plus className="h-3 w-3" /> Add
          </Button>
        </div>

        {rows.length === 0 ? (
          // The empty section is the feature: it answers "where is the other
          // one?" in the place the question gets asked.
          <div className="rounded border border-dashed border-slate-300 dark:border-border px-3 py-3 text-xs text-slate-500 dark:text-muted-foreground">
            No {label.toLowerCase()} address captured.
            {!hasNormalized ? (
              <span className="block mt-0.5 text-slate-400 dark:text-muted-foreground/70">
                This company has no {label.toLowerCase()} location on file either.
              </span>
            ) : null}
          </div>
        ) : (
          <div className="space-y-2">{rows.map(({ e, idx }) => renderCard(e, idx))}</div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-2">
        <div className="text-sm font-medium text-slate-800 dark:text-foreground">Addresses</div>
        <div className="text-xs text-slate-500 dark:text-muted-foreground">
          {entries.length === 0
            ? "none captured"
            : `${entries.length} captured · ${publicCount} public`}
        </div>
      </div>

      <p className="text-xs text-slate-500 dark:text-muted-foreground -mt-1">
        Street addresses captured from sources. They sit alongside the HQ / Manufacturing
        location fields above and never replace them. Users never see an address unless it is
        marked Public.
      </p>

      <div className="space-y-4">{TYPES.map((t) => renderSection(t.value))}</div>
    </div>
  );
}
