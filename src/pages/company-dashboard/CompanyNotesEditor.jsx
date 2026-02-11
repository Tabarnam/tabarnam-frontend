import React, { useCallback, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  asString,
  normalizeCompanyNotes,
} from "./dashboardUtils";

export default function CompanyNotesEditor({ value, onChange, TextWithLinks }) {
  const notes = normalizeCompanyNotes(value);

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [isPublic, setIsPublic] = useState(false);

  const canAdd = Boolean(asString(title).trim() || asString(body).trim());

  const add = useCallback(() => {
    const t = asString(title).trim();
    const b = asString(body).trim();
    if (!t && !b) return;

    const now = new Date().toISOString();
    const entry = {
      id: `note_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      title: t,
      body: b,
      is_public: isPublic,
      created_at: now,
      updated_at: now,
      created_by: "admin_ui",
    };

    onChange([entry, ...notes]);
    setTitle("");
    setBody("");
    setIsPublic(false);
    setOpen(false);
  }, [body, isPublic, notes, onChange, title]);

  const remove = useCallback(
    (idx) => {
      onChange(notes.filter((_, i) => i !== idx));
    },
    [notes, onChange]
  );

  const update = useCallback(
    (idx, patch) => {
      const next = notes.map((n, i) => {
        if (i !== idx) return n;
        const updated_at = new Date().toISOString();
        return { ...n, ...(patch || {}), updated_at };
      });
      onChange(next);
    },
    [notes, onChange]
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm text-slate-700 dark:text-muted-foreground font-medium">Manual note (admin)</div>
        <Button type="button" onClick={() => setOpen((v) => !v)}>
          <Plus className="h-4 w-4 mr-2" />
          Note
        </Button>
      </div>

      {open && (
        <div className="rounded-lg border border-slate-200 dark:border-border bg-white dark:bg-card p-3 space-y-2">
          <div className="grid grid-cols-1 gap-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-700 dark:text-muted-foreground">Title</label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short title…" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-700 dark:text-muted-foreground">Body</label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                className="min-h-[120px] w-full rounded-md border border-slate-200 dark:border-border bg-white dark:bg-card px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                placeholder="Write details…"
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-muted-foreground">
              <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
              Public
            </label>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="button" onClick={add} disabled={!canAdd}>
                Add note
              </Button>
            </div>
          </div>
        </div>
      )}

      {notes.length === 0 ? (
        <div className="rounded-lg border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-3 text-xs text-slate-600 dark:text-muted-foreground">No notes yet.</div>
      ) : (
        <div className="space-y-3">
          {notes.map((n, idx) => (
            <div key={n.id} className="rounded-lg border border-slate-200 dark:border-border bg-white dark:bg-card p-3 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <Input
                    value={asString(n.title)}
                    onChange={(e) => update(idx, { title: e.target.value })}
                    placeholder="Title"
                    className="font-medium"
                  />
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-600 dark:text-muted-foreground">
                    <span>{n.is_public ? "Public" : "Private"}</span>
                    <span>·</span>
                    <span>{n.created_at ? new Date(n.created_at).toLocaleString() : ""}</span>
                  </div>
                </div>

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="border-red-600 text-red-600 hover:bg-red-600 hover:text-white"
                  onClick={() => remove(idx)}
                  title="Delete note"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>

              <textarea
                value={asString(n.body)}
                onChange={(e) => update(idx, { body: e.target.value })}
                className="min-h-[100px] w-full rounded-md border border-slate-200 dark:border-border bg-white dark:bg-card px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                placeholder="Body"
              />

              {/* Preview with clickable URLs */}
              {asString(n.body).includes("http") && (
                <div className="rounded-md border border-slate-100 dark:border-border bg-slate-50 dark:bg-muted px-3 py-2 text-sm text-slate-700 dark:text-muted-foreground whitespace-pre-wrap">
                  <div className="text-xs text-slate-500 dark:text-muted-foreground mb-1">Preview (clickable links):</div>
                  <TextWithLinks text={asString(n.body)} />
                </div>
              )}

              <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-muted-foreground">
                <input
                  type="checkbox"
                  checked={Boolean(n.is_public)}
                  onChange={(e) => update(idx, { is_public: e.target.checked })}
                />
                Public
              </label>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
