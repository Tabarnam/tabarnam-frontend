import React, { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Eye, EyeOff, Trash2, Plus, Heart, Star as StarIcon } from "lucide-react";
import { CompanyRating, StarUnit, RatingIconType, StarNote } from "@/types/company";
import { clampStarValue, calculateTotalScore } from "@/lib/stars/calculateRating";
import { toast } from "sonner";

interface StarRatingEditorProps {
  rating: CompanyRating;
  iconType: RatingIconType;
  onRatingChange: (rating: CompanyRating) => void;
  onIconTypeChange: (iconType: RatingIconType) => void;
}

const STAR_LABELS = {
  star1: { label: "★ Manufacturing Locations", description: "1.0 if manufacturing locations exist" },
  star2: { label: "★ Headquarters/Home Location", description: "1.0 if HQ/Home location exists" },
  star3: { label: "★ Reviews Present", description: "1.0 if reviews exist" },
  star4: { label: "★ Admin Discretionary #1", description: "Manual admin adjustment (0.0 - 1.0)" },
  star5: { label: "★ Admin Discretionary #2", description: "Manual admin adjustment (0.0 - 1.0)" },
};

const INCREMENTS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

export const StarRatingEditor: React.FC<StarRatingEditorProps> = ({
  rating,
  iconType,
  onRatingChange,
  onIconTypeChange,
}) => {
  const [expandedStar, setExpandedStar] = useState<string | null>(null);
  const [newNoteText, setNewNoteText] = useState<Record<string, string>>({});
  const [newNotePublic, setNewNotePublic] = useState<Record<string, boolean>>({});

  const handleStarValueChange = (starKey: keyof CompanyRating, value: number) => {
    const clamped = clampStarValue(value);
    const updated = { ...rating };
    updated[starKey].value = clamped;
    onRatingChange(updated);
  };

  const handleAddNote = (starKey: keyof CompanyRating) => {
    const text = newNoteText[starKey]?.trim();
    if (!text) {
      toast.error("Note text cannot be empty");
      return;
    }

    const note: StarNote = {
      id: `note_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      text,
      is_public: newNotePublic[starKey] ?? false,
      created_at: new Date().toISOString(),
    };

    const updated = { ...rating };
    updated[starKey].notes = [...updated[starKey].notes, note];
    onRatingChange(updated);

    setNewNoteText({ ...newNoteText, [starKey]: "" });
    setNewNotePublic({ ...newNotePublic, [starKey]: false });
    toast.success("Note added");
  };

  const handleDeleteNote = (starKey: keyof CompanyRating, noteId: string) => {
    const updated = { ...rating };
    updated[starKey].notes = updated[starKey].notes.filter((n) => n.id !== noteId);
    onRatingChange(updated);
    toast.success("Note deleted");
  };

  const handleToggleNotePublic = (starKey: keyof CompanyRating, noteId: string) => {
    const updated = { ...rating };
    const noteIndex = updated[starKey].notes.findIndex((n) => n.id === noteId);
    if (noteIndex >= 0) {
      updated[starKey].notes[noteIndex].is_public = !updated[starKey].notes[noteIndex].is_public;
      onRatingChange(updated);
    }
  };

  const totalScore = calculateTotalScore(rating);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Star Rating System</CardTitle>
            <p className="text-sm text-slate-600 mt-1">
              Configure individual star values and per-star notes
            </p>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="text-2xl font-bold text-slate-900">{totalScore.toFixed(1)}</div>
              <div className="text-xs text-slate-600">/5.0</div>
            </div>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Icon Type Selector */}
        <div className="border-b pb-6">
          <Label className="text-sm font-semibold text-slate-900 mb-3 block">
            Rating Icon Type
          </Label>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => onIconTypeChange("star")}
              className={`flex items-center gap-2 px-4 py-2 rounded-md transition ${
                iconType === "star"
                  ? "bg-slate-900 text-white"
                  : "bg-slate-100 text-slate-700 hover:bg-slate-200"
              }`}
            >
              <StarIcon size={16} />
              <span>Stars</span>
            </button>
            <button
              type="button"
              onClick={() => onIconTypeChange("heart")}
              className={`flex items-center gap-2 px-4 py-2 rounded-md transition ${
                iconType === "heart"
                  ? "bg-slate-900 text-white"
                  : "bg-slate-100 text-slate-700 hover:bg-slate-200"
              }`}
            >
              <Heart size={16} />
              <span>Hearts</span>
            </button>
          </div>
        </div>

        {/* Individual Stars */}
        {(["star1", "star2", "star3", "star4", "star5"] as const).map((starKey) => {
          const star = rating[starKey];
          const isExpanded = expandedStar === starKey;
          const metadata = STAR_LABELS[starKey];
          const isAutomatic = starKey !== "star4" && starKey !== "star5";

          return (
            <div key={starKey} className="border rounded-lg overflow-hidden">
              {/* Star Header */}
              <button
                type="button"
                onClick={() => setExpandedStar(isExpanded ? null : starKey)}
                className="w-full px-4 py-3 bg-slate-50 hover:bg-slate-100 flex items-center justify-between text-left transition"
              >
                <div className="flex-1">
                  <div className="font-semibold text-slate-900">{metadata.label}</div>
                  <div className="text-xs text-slate-600">{metadata.description}</div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <div className="font-bold text-slate-900">{star.value.toFixed(1)}</div>
                    <div className="text-xs text-slate-600">value</div>
                  </div>
                  {isAutomatic && (
                    <span className="text-xs font-semibold px-2 py-1 bg-blue-100 text-blue-700 rounded">
                      Auto
                    </span>
                  )}
                  <div className="text-slate-600">
                    {isExpanded ? "▼" : "▶"}
                  </div>
                </div>
              </button>

              {/* Star Value and Notes (Expanded) */}
              {isExpanded && (
                <div className="px-4 py-4 bg-white space-y-4 border-t">
                  {/* Value Input */}
                  <div>
                    <Label htmlFor={`${starKey}_value`} className="text-sm font-medium">
                      Value (0.0 - 1.0)
                    </Label>
                    <div className="mt-2 flex flex-col gap-3">
                      <Input
                        id={`${starKey}_value`}
                        type="number"
                        min="0"
                        max="1"
                        step="0.1"
                        value={star.value}
                        onChange={(e) => handleStarValueChange(starKey, parseFloat(e.target.value) || 0)}
                        className="w-full"
                      />
                      {/* Quick Select Buttons */}
                      <div className="grid grid-cols-6 gap-1">
                        {INCREMENTS.map((inc) => (
                          <button
                            key={inc}
                            type="button"
                            onClick={() => handleStarValueChange(starKey, inc)}
                            className={`py-1 px-2 text-xs rounded transition ${
                              Math.abs(star.value - inc) < 0.01
                                ? "bg-slate-900 text-white font-semibold"
                                : "bg-slate-200 text-slate-700 hover:bg-slate-300"
                            }`}
                          >
                            {inc.toFixed(1)}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Notes Section */}
                  <div className="border-t pt-4 space-y-3">
                    <Label className="text-sm font-semibold text-slate-900 block">
                      Notes for {metadata.label}
                    </Label>

                    {/* Add New Note */}
                    <div className="space-y-2 bg-slate-50 p-3 rounded">
                      <textarea
                        value={newNoteText[starKey] || ""}
                        onChange={(e) =>
                          setNewNoteText({ ...newNoteText, [starKey]: e.target.value })
                        }
                        placeholder={`Add a note explaining ${metadata.label.toLowerCase()}...`}
                        rows={2}
                        className="w-full px-3 py-2 border border-slate-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                      <div className="flex items-center justify-between">
                        <label className="flex items-center gap-2 text-sm cursor-pointer">
                          <input
                            type="checkbox"
                            checked={newNotePublic[starKey] ?? false}
                            onChange={(e) =>
                              setNewNotePublic({ ...newNotePublic, [starKey]: e.target.checked })
                            }
                            className="w-4 h-4 rounded border-slate-300"
                          />
                          <span className="text-slate-700">Show to users</span>
                        </label>
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => handleAddNote(starKey)}
                          disabled={!newNoteText[starKey]?.trim()}
                          className="bg-blue-600 hover:bg-blue-700 text-white"
                        >
                          <Plus size={14} className="mr-1" />
                          Add Note
                        </Button>
                      </div>
                    </div>

                    {/* Existing Notes */}
                    {star.notes.length > 0 && (
                      <div className="space-y-2">
                        <Label className="text-xs text-slate-600 block">Existing Notes</Label>
                        {star.notes.map((note) => (
                          <div
                            key={note.id}
                            className="p-3 bg-slate-50 border border-slate-200 rounded space-y-2"
                          >
                            <p className="text-sm text-slate-800">{note.text}</p>
                            <div className="flex items-center justify-between text-xs text-slate-600">
                              <span>
                                {new Date(note.created_at || "").toLocaleDateString()}
                              </span>
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => handleToggleNotePublic(starKey, note.id)}
                                  className="inline-flex items-center gap-1 text-slate-600 hover:text-slate-900 transition"
                                  title={
                                    note.is_public
                                      ? "Click to hide from users"
                                      : "Click to show to users"
                                  }
                                >
                                  {note.is_public ? (
                                    <>
                                      <Eye size={14} />
                                      <span>Public</span>
                                    </>
                                  ) : (
                                    <>
                                      <EyeOff size={14} />
                                      <span>Private</span>
                                    </>
                                  )}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteNote(starKey, note.id)}
                                  className="text-red-600 hover:text-red-800 transition"
                                  title="Delete note"
                                >
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* Info Box */}
        <div className="bg-blue-50 border border-blue-200 rounded p-3 text-sm text-blue-800">
          <p className="font-semibold mb-1">Auto Stars (1, 2, 3):</p>
          <ul className="list-disc list-inside space-y-1 text-xs">
            <li>Star 1: Automatically set to 1.0 if manufacturing locations exist</li>
            <li>Star 2: Automatically set to 1.0 if headquarters location exists</li>
            <li>Star 3: Automatically set to 1.0 if reviews exist</li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
};

export default StarRatingEditor;
