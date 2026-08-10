import React, { useCallback, useEffect, useRef, useState } from "react";
import { GripVertical, Play, RotateCcw, Search } from "lucide-react";
import {
  fetchSoundManifest,
  previewSound,
  readSoundMode,
  writeSoundMode,
  readSoundOrder,
  writeSoundOrder,
  mergeOrderWithManifest,
} from "@/hooks/useNotificationSound";

// Strip the extension for display — the filenames double as the clip titles
// ("88 mph-Back To The Future.mp3").
const pretty = (f) => String(f || "").replace(/\.\w+$/, "");

/**
 * Admin panel for the import-completion notification sounds.
 *
 * Shuffle (the default) preserves the original behaviour. Switching to "my
 * order" makes each import play the next clip down the list and wrap at the
 * end, so a full drag-ordered playlist is heard in sequence across imports.
 *
 * Order is stored per browser in localStorage (same tier as the existing mute
 * toggle). Drag-and-drop uses the native HTML5 API — the same approach as
 * BookmarksDrawer — so no new dependency is added to the bundle.
 */
export default function NotificationSoundSettings() {
  const [files, setFiles] = useState([]);
  const [order, setOrder] = useState([]);
  const [mode, setMode] = useState(readSoundMode);
  const [filter, setFilter] = useState("");
  const [loadError, setLoadError] = useState("");
  const [dropIdx, setDropIdx] = useState(null);
  const dragIdxRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    fetchSoundManifest()
      .then((list) => {
        if (cancelled) return;
        const manifest = Array.isArray(list) ? list : [];
        setFiles(manifest);
        setOrder(mergeOrderWithManifest(readSoundOrder(), manifest));
        if (manifest.length === 0) setLoadError("No sound files found in the manifest.");
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e?.message || "Could not load the sound list.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback((next) => {
    setOrder(next);
    writeSoundOrder(next);
  }, []);

  const onModeChange = useCallback((next) => {
    setMode(next);
    writeSoundMode(next);
  }, []);

  const resetAlphabetical = useCallback(() => {
    const next = [...files].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    persist(next);
  }, [files, persist]);

  // Dragging is disabled while a filter is active: the visible rows are a
  // subset, so a drop index would not map to a position in the full list.
  const filtering = filter.trim().length > 0;
  const needle = filter.trim().toLowerCase();
  const visible = filtering ? order.filter((f) => f.toLowerCase().includes(needle)) : order;

  const handleDragStart = (e, idx) => {
    dragIdxRef.current = idx;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/x-sound-reorder", "1");
    e.currentTarget.style.opacity = "0.4";
  };

  const handleDragEnd = (e) => {
    e.currentTarget.style.opacity = "";
    dragIdxRef.current = null;
    setDropIdx(null);
  };

  const handleDragOver = (e, idx) => {
    if (dragIdxRef.current === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropIdx(idx);
  };

  const handleDrop = (e, toIdx) => {
    const fromIdx = dragIdxRef.current;
    dragIdxRef.current = null;
    setDropIdx(null);
    if (fromIdx === null || fromIdx === toIdx) return;
    e.preventDefault();
    const next = [...order];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    persist(next);
  };

  const move = (idx, delta) => {
    const to = idx + delta;
    if (to < 0 || to >= order.length) return;
    const next = [...order];
    const [moved] = next.splice(idx, 1);
    next.splice(to, 0, moved);
    persist(next);
  };

  return (
    <details className="rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted px-4 py-3">
      <summary className="cursor-pointer select-none text-sm font-medium text-slate-800 dark:text-foreground">
        Notification sounds{files.length ? ` (${files.length})` : ""}
      </summary>

      <div className="mt-3 space-y-3">
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-muted-foreground">
            <input
              type="radio"
              name="sound-mode"
              className="h-4 w-4 accent-emerald-600"
              checked={mode === "shuffle"}
              onChange={() => onModeChange("shuffle")}
            />
            Shuffle
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-muted-foreground">
            <input
              type="radio"
              name="sound-mode"
              className="h-4 w-4 accent-emerald-600"
              checked={mode === "ordered"}
              onChange={() => onModeChange("ordered")}
            />
            Play in my order
          </label>

          <button
            type="button"
            onClick={resetAlphabetical}
            className="ml-auto inline-flex items-center gap-1 text-xs text-slate-600 dark:text-muted-foreground hover:underline"
            title="Reset the list to alphabetical order"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset A–Z
          </button>
        </div>

        <div className="text-xs text-slate-500 dark:text-muted-foreground">
          {mode === "ordered"
            ? "Each import plays the next clip down this list, then wraps around. Drag the handles to reorder."
            : "A random clip plays on each import. Switch to “Play in my order” to use the list below."}
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter clips…"
            className="w-full rounded border border-slate-200 dark:border-border bg-white dark:bg-card py-1.5 pl-7 pr-2 text-sm text-slate-900 dark:text-foreground"
          />
        </div>
        {filtering ? (
          <div className="text-xs text-amber-700 dark:text-amber-400">
            Clear the filter to drag-reorder (use ▲▼ while filtering).
          </div>
        ) : null}

        {loadError ? <div className="text-xs text-red-600 dark:text-red-400">{loadError}</div> : null}

        <ol className="max-h-96 overflow-y-auto rounded border border-slate-200 dark:border-border divide-y divide-slate-100 dark:divide-border">
          {visible.map((file) => {
            const idx = order.indexOf(file);
            return (
              <li
                key={file}
                onDragOver={filtering ? undefined : (e) => handleDragOver(e, idx)}
                onDrop={filtering ? undefined : (e) => handleDrop(e, idx)}
                className={`flex items-center gap-2 bg-white dark:bg-card px-2 py-1.5 text-sm ${
                  dropIdx === idx ? "outline outline-2 outline-emerald-400" : ""
                }`}
              >
                <span
                  draggable={!filtering}
                  onDragStart={filtering ? undefined : (e) => handleDragStart(e, idx)}
                  onDragEnd={filtering ? undefined : handleDragEnd}
                  className={`shrink-0 px-1 text-slate-400 ${filtering ? "opacity-30" : "cursor-grab active:cursor-grabbing"}`}
                  title={filtering ? "Clear the filter to drag" : "Drag to reorder"}
                >
                  {/* Smaller glyph; the px-1 keeps the drag target easy to hit. */}
                  <GripVertical className="h-2.5 w-2.5" />
                </span>

                <span className="w-8 shrink-0 text-right text-xs tabular-nums text-slate-400">{idx + 1}</span>

                <span className="min-w-0 flex-1 truncate text-slate-800 dark:text-foreground" title={pretty(file)}>
                  {pretty(file)}
                </span>

                <button
                  type="button"
                  onClick={() => previewSound(file)}
                  className="shrink-0 rounded p-1 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/40"
                  title="Preview this clip"
                >
                  <Play className="h-3.5 w-3.5 fill-current" />
                </button>

                <div className="flex shrink-0 flex-col leading-none">
                  <button
                    type="button"
                    onClick={() => move(idx, -1)}
                    disabled={idx === 0}
                    className="px-1 text-[10px] text-slate-500 hover:text-slate-900 dark:hover:text-foreground disabled:opacity-25"
                    title="Move up"
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    onClick={() => move(idx, 1)}
                    disabled={idx === order.length - 1}
                    className="px-1 text-[10px] text-slate-500 hover:text-slate-900 dark:hover:text-foreground disabled:opacity-25"
                    title="Move down"
                  >
                    ▼
                  </button>
                </div>
              </li>
            );
          })}
        </ol>

        <div className="text-xs text-slate-500 dark:text-muted-foreground">
          Saved in this browser. New clips added to the library appear at the end of your order.
        </div>
      </div>
    </details>
  );
}
