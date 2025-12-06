import React, { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Eye, EyeOff, Trash2, Plus } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { toast } from "sonner";

const StarNotesEditor = ({ companyId, starRating, onStarChange, userName }) => {
  const [notes, setNotes] = useState([]);
  const [newNoteText, setNewNoteText] = useState("");
  const [newNotePublic, setNewNotePublic] = useState(false);
  const [loading, setLoading] = useState(false);
  const [localStarRating, setLocalStarRating] = useState(starRating || 0);

  useEffect(() => {
    setLocalStarRating(starRating || 0);
  }, [starRating]);

  useEffect(() => {
    if (companyId) {
      fetchNotes();
    }
  }, [companyId]);

  const fetchNotes = async () => {
    if (!companyId) return;
    try {
      const res = await apiFetch(`/admin-api-notes?company_id=${companyId}&kind=admin`);
      if (res.ok) {
        const data = await res.json();
        setNotes(data.items || []);
      }
    } catch (error) {
      console.log("Failed to fetch notes:", error?.message);
    }
  };

  const handleAddNote = async () => {
    if (!newNoteText.trim()) {
      toast.error("Note text cannot be empty");
      return;
    }
    if (!companyId) {
      toast.error("Company ID is required");
      return;
    }

    setLoading(true);
    try {
      const res = await apiFetch("/admin-api-notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          note: {
            company_id: companyId,
            text: newNoteText.trim(),
            is_public: newNotePublic,
            actor: userName,
          },
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setNotes((prev) => [...prev, data.note]);
        setNewNoteText("");
        setNewNotePublic(false);
        toast.success("Note added successfully");
      } else {
        toast.error("Failed to add note");
      }
    } catch (error) {
      toast.error(error?.message || "Failed to add note");
    } finally {
      setLoading(false);
    }
  };

  const handleTogglePublic = async (noteId, currentPublic) => {
    setLoading(true);
    try {
      const noteToUpdate = notes.find((n) => n.id === noteId);
      if (!noteToUpdate) return;

      const res = await apiFetch("/admin-api-notes", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          note: {
            ...noteToUpdate,
            is_public: !currentPublic,
            actor: userName,
          },
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setNotes((prev) =>
          prev.map((n) => (n.id === noteId ? data.note : n))
        );
        toast.success(
          !currentPublic ? "Note made public" : "Note made private"
        );
      } else {
        toast.error("Failed to update note visibility");
      }
    } catch (error) {
      toast.error(error?.message || "Failed to update note visibility");
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteNote = async (noteId, companyIdVal) => {
    setLoading(true);
    try {
      const res = await apiFetch("/admin-api-notes", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: noteId,
          company_id: companyIdVal,
        }),
      });

      if (res.ok) {
        setNotes((prev) => prev.filter((n) => n.id !== noteId));
        toast.success("Note deleted");
      } else {
        toast.error("Failed to delete note");
      }
    } catch (error) {
      toast.error(error?.message || "Failed to delete note");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="border-t pt-4 mt-4">
      <CardHeader>
        <CardTitle className="text-sm">Star Rating & Notes</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Label htmlFor="star_rating">Star Rating (0-5)</Label>
          <div className="flex items-center gap-2 mt-2">
            <Input
              id="star_rating"
              type="number"
              min="0"
              max="5"
              step="0.5"
              value={localStarRating}
              onChange={(e) => {
                const val = Number(e.target.value);
                setLocalStarRating(val);
                onStarChange(val);
              }}
              className="w-20"
            />
            <div className="text-sm text-slate-600">
              {localStarRating > 0 && `${"⭐".repeat(Math.floor(localStarRating))}${
                localStarRating % 1 === 0.5 ? "✨" : ""
              }`}
            </div>
          </div>
        </div>

        <div className="border-t pt-4">
          <h4 className="text-sm font-semibold text-slate-900 mb-3">
            Admin Notes (Staff Only)
          </h4>

          <div className="space-y-2 mb-4">
            <div className="flex items-start gap-2">
              <div className="flex-1">
                <textarea
                  value={newNoteText}
                  onChange={(e) => setNewNoteText(e.target.value)}
                  placeholder="Add a note to explain this star rating..."
                  rows="2"
                  className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-[#B1DDE3]"
                />
              </div>
            </div>

            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={newNotePublic}
                  onChange={(e) => setNewNotePublic(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-300"
                />
                Show to users
              </label>
              <Button
                type="button"
                onClick={handleAddNote}
                disabled={loading || !newNoteText.trim()}
                size="sm"
                className="bg-[#B1DDE3] text-slate-900 hover:bg-[#A0C8D0]"
              >
                <Plus className="h-3 w-3 mr-1" />
                Add Note
              </Button>
            </div>
          </div>

          {notes.length > 0 && (
            <div className="space-y-2">
              <Label className="text-xs text-slate-600">Existing Notes</Label>
              {notes.map((note) => (
                <div
                  key={note.id}
                  className="p-3 bg-slate-50 border border-slate-200 rounded-md space-y-2"
                >
                  <div className="text-sm text-slate-800">{note.text}</div>
                  <div className="flex items-center justify-between text-xs text-slate-600">
                    <div>
                      by {note.actor || "Unknown"} •{" "}
                      {new Date(note.created_at).toLocaleDateString()}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleTogglePublic(note.id, note.is_public)}
                        disabled={loading}
                        className="inline-flex items-center gap-1 text-slate-600 hover:text-slate-900 transition"
                        title={
                          note.is_public
                            ? "Click to hide from users"
                            : "Click to show to users"
                        }
                      >
                        {note.is_public ? (
                          <>
                            <Eye className="h-3.5 w-3.5" />
                            <span className="text-xs">Public</span>
                          </>
                        ) : (
                          <>
                            <EyeOff className="h-3.5 w-3.5" />
                            <span className="text-xs">Private</span>
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteNote(note.id, companyId)}
                        disabled={loading}
                        className="inline-flex items-center gap-1 text-red-600 hover:text-red-800 transition"
                        title="Delete note"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export default StarNotesEditor;
