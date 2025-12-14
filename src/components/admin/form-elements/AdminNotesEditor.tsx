import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { apiFetch } from "@/lib/api";
import { toast } from "@/lib/toast";
import { Eye, EyeOff, Plus, Trash2, RefreshCw } from "lucide-react";

type AdminNote = {
  id: string;
  company_id: string;
  text: string;
  is_public?: boolean;
  created_at?: string;
  updated_at?: string;
  actor?: string | null;
};

function formatDateTime(value: string | undefined) {
  const s = (value || "").trim();
  if (!s) return "";
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return s;
  return d.toLocaleString();
}

function normalizeAdminNote(input: any): AdminNote | null {
  if (!input || typeof input !== "object") return null;
  const id = String(input.id || "").trim();
  const company_id = String(input.company_id || input.companyId || "").trim();
  const text = String(input.text || "").trim();
  if (!id || !company_id || !text) return null;
  return {
    id,
    company_id,
    text,
    is_public: input.is_public === true || String(input.is_public).toLowerCase() === "true",
    created_at: typeof input.created_at === "string" ? input.created_at : undefined,
    updated_at: typeof input.updated_at === "string" ? input.updated_at : undefined,
    actor: typeof input.actor === "string" ? input.actor : null,
  };
}

export default function AdminNotesEditor({
  companyId,
  actor,
}: {
  companyId: string | null | undefined;
  actor: string | null | undefined;
}) {
  const resolvedCompanyId = useMemo(() => {
    const s = String(companyId || "").trim();
    return s || null;
  }, [companyId]);

  const resolvedActor = useMemo(() => {
    const s = String(actor || "").trim();
    return s || "Admin";
  }, [actor]);

  const [notes, setNotes] = useState<AdminNote[]>([]);
  const [newNoteText, setNewNoteText] = useState("");
  const [newNotePublic, setNewNotePublic] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!resolvedCompanyId) {
      setNotes([]);
      return;
    }

    setLoading(true);
    try {
      const res = await apiFetch(
        `/xadmin-api-notes?company_id=${encodeURIComponent(resolvedCompanyId)}&kind=admin`
      );
      const data = await res.json().catch(() => ({ items: [] }));
      if (!res.ok) {
        throw new Error(data?.error || res.statusText || "Failed to load admin notes");
      }
      const items = Array.isArray(data?.items) ? data.items : [];
      const normalized = items.map(normalizeAdminNote).filter(Boolean) as AdminNote[];
      setNotes(normalized);
    } catch (e: any) {
      toast.error(e?.message || "Failed to load admin notes");
    } finally {
      setLoading(false);
    }
  }, [resolvedCompanyId]);

  useEffect(() => {
    load();
  }, [load]);

  const addNote = useCallback(async () => {
    if (!resolvedCompanyId) {
      toast.error("Save the company first to add notes");
      return;
    }
    const text = newNoteText.trim();
    if (!text) {
      toast.error("Note text cannot be empty");
      return;
    }

    setLoading(true);
    try {
      const res = await apiFetch("/xadmin-api-notes?kind=admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          note: {
            company_id: resolvedCompanyId,
            text,
            is_public: newNotePublic,
            actor: resolvedActor,
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.note) {
        throw new Error(data?.error || res.statusText || "Failed to add note");
      }
      const normalized = normalizeAdminNote(data.note);
      if (normalized) {
        setNotes((prev) => [normalized, ...prev]);
      }
      setNewNoteText("");
      setNewNotePublic(false);
      toast.success("Note added");
    } catch (e: any) {
      toast.error(e?.message || "Failed to add note");
    } finally {
      setLoading(false);
    }
  }, [newNotePublic, newNoteText, resolvedActor, resolvedCompanyId]);

  const togglePublic = useCallback(
    async (noteId: string) => {
      const note = notes.find((n) => n.id === noteId);
      if (!note) return;
      setLoading(true);
      try {
        const res = await apiFetch("/xadmin-api-notes?kind=admin", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            note: {
              ...note,
              is_public: !note.is_public,
              actor: resolvedActor,
            },
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.note) {
          throw new Error(data?.error || res.statusText || "Failed to update note");
        }
        const normalized = normalizeAdminNote(data.note);
        if (normalized) {
          setNotes((prev) => prev.map((n) => (n.id === noteId ? normalized : n)));
        }
      } catch (e: any) {
        toast.error(e?.message || "Failed to update note");
      } finally {
        setLoading(false);
      }
    },
    [notes, resolvedActor]
  );

  const deleteNote = useCallback(
    async (noteId: string) => {
      if (!resolvedCompanyId) return;
      setLoading(true);
      try {
        const res = await apiFetch("/xadmin-api-notes?kind=admin", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: noteId, company_id: resolvedCompanyId }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data?.ok !== true) {
          throw new Error(data?.error || res.statusText || "Failed to delete note");
        }
        setNotes((prev) => prev.filter((n) => n.id !== noteId));
        toast.success("Note deleted");
      } catch (e: any) {
        toast.error(e?.message || "Failed to delete note");
      } finally {
        setLoading(false);
      }
    },
    [resolvedCompanyId]
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">Admin Notes</CardTitle>
            <p className="text-sm text-slate-600 mt-1">
              Add internal notes. Toggle Public to show them on the public results page.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={load}
            disabled={loading || !resolvedCompanyId}
            className="shrink-0"
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!resolvedCompanyId ? (
          <div className="text-sm text-slate-600">Save the company first to add notes.</div>
        ) : (
          <>
            <div className="space-y-2">
              <Label className="text-sm font-semibold text-slate-900 block">Add a note</Label>
              <textarea
                value={newNoteText}
                onChange={(e) => setNewNoteText(e.target.value)}
                placeholder="Write a note…"
                rows={3}
                className="w-full px-3 py-2 border border-slate-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newNotePublic}
                    onChange={(e) => setNewNotePublic(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-300"
                  />
                  <span className="text-slate-700">Public</span>
                </label>
                <Button
                  type="button"
                  size="sm"
                  onClick={addNote}
                  disabled={loading || !newNoteText.trim()}
                  className="bg-blue-600 hover:bg-blue-700 text-white"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Add Note
                </Button>
              </div>
            </div>

            {notes.length > 0 ? (
              <div className="space-y-2">
                <Label className="text-xs text-slate-600 block">Notes</Label>
                {notes.map((n) => {
                  const timestamp = formatDateTime(n.updated_at || n.created_at);
                  const who = (n.actor || "Admin").toString().trim() || "Admin";
                  const isPublic = n.is_public === true;

                  return (
                    <div key={n.id} className="p-3 bg-slate-50 border border-slate-200 rounded space-y-2">
                      <p className="text-sm text-slate-800 whitespace-pre-wrap">{n.text}</p>
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs text-slate-600">
                        <span>
                          {who ? `by ${who}` : "by Admin"}
                          {timestamp ? ` • ${timestamp}` : ""}
                        </span>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => togglePublic(n.id)}
                            disabled={loading}
                            className="inline-flex items-center gap-1 text-slate-600 hover:text-slate-900 transition"
                            title={isPublic ? "Click to make private" : "Click to make public"}
                          >
                            {isPublic ? (
                              <>
                                <Eye className="h-3.5 w-3.5" />
                                <span>Public</span>
                              </>
                            ) : (
                              <>
                                <EyeOff className="h-3.5 w-3.5" />
                                <span>Private</span>
                              </>
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteNote(n.id)}
                            disabled={loading}
                            className="inline-flex items-center gap-1 text-red-600 hover:text-red-800 transition"
                            title="Delete note"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-sm text-slate-500">No notes yet.</div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
