import React, { useState } from "react";
import { ChevronDown, ChevronRight, Sparkles, Loader2, X } from "lucide-react";

import { apiFetch, readJsonOrText } from "@/lib/api";
import { calculateInitialRating, clampStarValue, normalizeRating } from "@/lib/stars/calculateRating";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  normalizeRatingIconType,
  computeAutoRatingInput,
} from "./dashboardUtils";

// Render bullet-point reasoning as a compact list (mirrors results-page helper)
function ReasoningList({ text }) {
  if (!text) return <span className="text-muted-foreground italic">(none)</span>;
  const bullets = String(text)
    .split(/\n+/)
    .map((line) => line.replace(/^\s*[-•*]\s*/, "").trim())
    .filter(Boolean);
  if (bullets.length === 0) return <span className="text-muted-foreground italic">(none)</span>;
  return (
    <ul className="list-disc list-inside space-y-0.5 leading-snug">
      {bullets.map((b, i) => <li key={i}>{b}</li>)}
    </ul>
  );
}

const STARS = [
  { key: "star1", label: "Mfg", fullLabel: "Manufacturing", hasAuto: true },
  { key: "star2", label: "HQ", fullLabel: "HQ/Home", hasAuto: true },
  { key: "star3", label: "Reviews", fullLabel: "Reviews", hasAuto: true },
  { key: "star4", label: "Reputation", fullLabel: "Reputation", hasAuto: false, hasReasoning: true },
  { key: "star5", label: "Quality", fullLabel: "Quality", hasAuto: false, hasReasoning: true },
];

export default function RatingEditor({ draft, onChange, StarNotesEditor }) {
  const [expandedStar, setExpandedStar] = useState(null);
  const [editingText, setEditingText] = useState({});
  const [proposing, setProposing] = useState(false);
  const [proposal, setProposal] = useState(null); // { proposal, current, company_name } or null
  const [proposeError, setProposeError] = useState(null);

  const rating = normalizeRating(draft?.rating);
  const auto = calculateInitialRating(computeAutoRatingInput(draft));
  const defaultIconType = normalizeRatingIconType(draft?.rating_icon_type, rating);
  const reviewsStarSource = String(draft?.reviews_star_source || "").toLowerCase() === "manual" ? "manual" : "auto";

  const companyId = draft?.id || draft?.company_id || "";
  const companyDomain = draft?.normalized_domain || "";
  const canPropose = Boolean(companyId && companyDomain);

  const fetchProposal = async () => {
    if (!canPropose) return;
    setProposing(true);
    setProposeError(null);
    setProposal(null);
    try {
      const res = await apiFetch("/xadmin-api-score-company", {
        method: "POST",
        body: JSON.stringify({
          company_id: companyId,
          normalized_domain: companyDomain,
          propose: true,
        }),
      });
      const data = await readJsonOrText(res);
      if (data?.ok && data?.proposal) {
        setProposal(data);
      } else {
        setProposeError(data?.reason || data?.error || "Failed to generate proposal");
      }
    } catch (e) {
      setProposeError(e?.message || "Failed to generate proposal");
    } finally {
      setProposing(false);
    }
  };

  const acceptProposal = ({ star4, star5 }) => {
    if (!proposal?.proposal) return;
    const p = proposal.proposal;
    const nextRating = { ...rating };
    if (star4) {
      nextRating.star4 = {
        ...(nextRating.star4 || {}),
        value: clampStarValue(Number(p.star4_value)),
        reasoning: p.star4_reasoning || "",
      };
    }
    if (star5) {
      nextRating.star5 = {
        ...(nextRating.star5 || {}),
        value: clampStarValue(Number(p.star5_value)),
        reasoning: p.star5_reasoning || "",
      };
    }
    onChange({ ...(draft || {}), rating: nextRating });
    setProposal(null);
  };

  const setDefaultIconType = (iconType) => {
    const next = iconType === "heart" ? "heart" : "star";
    onChange({ ...(draft || {}), rating_icon_type: next });
  };

  const matchAllStarsToDefault = () => {
    const starKeys = ["star1", "star2", "star3", "star4", "star5"];
    const nextRating = { ...rating };
    for (const k of starKeys) {
      nextRating[k] = { ...(nextRating[k] || {}), icon_type: defaultIconType };
    }
    onChange({ ...(draft || {}), rating_icon_type: defaultIconType, rating: nextRating });
  };

  const setStar = (starKey, patch) => {
    const nextRating = {
      ...rating,
      [starKey]: {
        ...(rating[starKey] || {}),
        ...(patch || {}),
      },
    };
    onChange({ ...(draft || {}), rating: nextRating });
  };

  const setStarValue = (starKey, value) => {
    if (starKey === "star3") {
      const nextRating = {
        ...rating,
        star3: { ...(rating.star3 || {}), value },
      };
      onChange({
        ...(draft || {}),
        rating: nextRating,
        reviews_star_value: value,
        reviews_star_source: "manual",
      });
      return;
    }
    setStar(starKey, { value });
  };

  const setStarAuto = (starKey, autoValue) => {
    const next = clampStarValue(Number(autoValue));
    if (starKey === "star3") {
      const nextRating = {
        ...rating,
        star3: { ...(rating.star3 || {}), value: next },
      };
      onChange({
        ...(draft || {}),
        rating: nextRating,
        reviews_star_value: next,
        reviews_star_source: "auto",
      });
      return;
    }
    setStar(starKey, { value: next });
  };

  return (
    <div className="space-y-2">
      {/* Header: label + frontend icon config */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="text-sm text-slate-700 dark:text-muted-foreground font-medium">Stars</div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            onClick={fetchProposal}
            disabled={!canPropose || proposing}
            title={canPropose ? "Propose reputation & quality scores via xAI (non-destructive preview)" : "Save the company first to enable xAI proposal"}
          >
            {proposing ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5 mr-1" />
            )}
            Propose Rep/Quality
          </Button>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground mr-0.5">Icon:</span>
          <Button
            type="button"
            size="sm"
            variant={defaultIconType === "star" ? "default" : "outline"}
            className="h-6 px-2 text-xs"
            onClick={() => setDefaultIconType("star")}
          >
            ●
          </Button>
          <Button
            type="button"
            size="sm"
            variant={defaultIconType === "heart" ? "default" : "outline"}
            className="h-6 px-2 text-xs"
            onClick={() => setDefaultIconType("heart")}
          >
            ♥
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            onClick={matchAllStarsToDefault}
          >
            Match all
          </Button>
        </div>
      </div>

      {/* Compact star table */}
      <div className="rounded-lg border border-slate-200 dark:border-border bg-white dark:bg-card overflow-hidden">
        {STARS.map(({ key: starKey, label, hasAuto, hasReasoning }, idx) => {
          const star = rating[starKey] || { value: 0, notes: [] };
          const autoValue = hasAuto ? auto[starKey]?.value : null;
          const currentValue = clampStarValue(Number(star.value ?? 0));
          const notes = Array.isArray(star.notes) ? star.notes : [];
          const isExpanded = expandedStar === starKey;

          return (
            <React.Fragment key={starKey}>
              {/* Row */}
              <div
                className={`flex items-center gap-2 px-3 py-2 ${
                  idx > 0 ? "border-t border-slate-100 dark:border-border" : ""
                }`}
              >
                {/* Star label */}
                <div className="w-[72px] flex-none">
                  <div className="text-xs font-medium text-slate-900 dark:text-foreground leading-tight">
                    {label}
                  </div>
                  <div className="text-[10px] text-muted-foreground leading-tight">
                    {hasAuto ? "auto" : "manual"}
                    {starKey === "star3" && reviewsStarSource === "manual" ? (
                      <span className="ml-1 text-amber-600">ovr</span>
                    ) : null}
                  </div>
                </div>

                {/* Value input */}
                <Input
                  value={editingText[starKey] != null ? editingText[starKey] : String(currentValue)}
                  inputMode="decimal"
                  className="w-14 h-7 text-xs text-center flex-none"
                  onChange={(e) => {
                    setEditingText((prev) => ({ ...prev, [starKey]: e.target.value }));
                  }}
                  onFocus={() => {
                    setEditingText((prev) => ({ ...prev, [starKey]: String(currentValue) }));
                  }}
                  onBlur={() => {
                    const raw = editingText[starKey];
                    if (raw != null) {
                      setStarValue(starKey, clampStarValue(Number(raw)));
                    }
                    setEditingText((prev) => { const next = { ...prev }; delete next[starKey]; return next; });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.target.blur();
                    }
                  }}
                />

                {/* Quick set buttons */}
                <div className="flex items-center gap-1 flex-none">
                  {[0, 0.5, 1].map((v) => (
                    <button
                      key={v}
                      type="button"
                      className={`h-6 w-6 rounded text-[10px] font-medium border transition-colors ${
                        currentValue === v
                          ? "bg-slate-900 text-white border-slate-900 dark:bg-foreground dark:text-background dark:border-foreground"
                          : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50 dark:bg-card dark:text-muted-foreground dark:border-border dark:hover:bg-muted"
                      }`}
                      onClick={() => setStarValue(starKey, v)}
                      title={`Set to ${v.toFixed(1)}`}
                    >
                      {v === 0.5 ? "½" : v}
                    </button>
                  ))}
                  {autoValue != null ? (
                    <button
                      type="button"
                      className={`h-6 px-1.5 rounded text-[10px] font-medium border transition-colors ${
                        starKey === "star3" && reviewsStarSource !== "manual"
                          ? "bg-emerald-600 text-white border-emerald-600"
                          : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50 dark:bg-card dark:text-muted-foreground dark:border-border dark:hover:bg-muted"
                      }`}
                      onClick={() => setStarAuto(starKey, autoValue)}
                      title="Use auto value"
                    >
                      ↻
                    </button>
                  ) : null}
                </div>

                {/* Icon toggles */}
                <div className="flex items-center gap-0.5 flex-none">
                  <button
                    type="button"
                    className={`h-6 w-6 rounded text-xs transition-colors ${
                      star.icon_type !== "heart"
                        ? "bg-slate-900 text-white dark:bg-foreground dark:text-background"
                        : "text-slate-400 hover:text-slate-600 dark:text-muted-foreground dark:hover:text-foreground"
                    }`}
                    onClick={() => setStar(starKey, { icon_type: "star" })}
                    title="Circle icon"
                  >
                    ●
                  </button>
                  <button
                    type="button"
                    className={`h-6 w-6 rounded text-xs transition-colors ${
                      star.icon_type === "heart"
                        ? "bg-slate-900 text-white dark:bg-foreground dark:text-background"
                        : "text-slate-400 hover:text-slate-600 dark:text-muted-foreground dark:hover:text-foreground"
                    }`}
                    onClick={() => setStar(starKey, { icon_type: "heart" })}
                    title="Heart icon"
                  >
                    ♥
                  </button>
                </div>

                {/* Notes expand toggle */}
                <button
                  type="button"
                  className="flex items-center gap-0.5 h-6 px-1 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-slate-50 dark:hover:bg-muted transition-colors ml-auto flex-none"
                  onClick={() => setExpandedStar(isExpanded ? null : starKey)}
                  title={`${notes.length} note${notes.length !== 1 ? "s" : ""}`}
                >
                  <span className={`font-medium ${notes.length > 0 ? "text-slate-700 dark:text-foreground" : ""}`}>
                    {notes.length}
                  </span>
                  {isExpanded
                    ? <ChevronDown className="h-3 w-3" />
                    : <ChevronRight className="h-3 w-3" />}
                </button>
              </div>

              {/* Reasoning field for star4/star5 */}
              {hasReasoning && (
                <div className="border-t border-slate-100 dark:border-border px-3 py-1.5">
                  <label className="text-[10px] text-muted-foreground block mb-0.5">Reasoning (max 250 chars — one bullet per line, start with '-')</label>
                  <textarea
                    className="w-full text-xs rounded border border-slate-200 dark:border-border bg-white dark:bg-card px-2 py-1 resize-vertical focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
                    rows={4}
                    maxLength={250}
                    value={star.reasoning || ""}
                    onChange={(e) => setStar(starKey, { reasoning: e.target.value })}
                  />
                  <div className="text-[10px] text-muted-foreground text-right">{(star.reasoning || "").length}/250</div>
                </div>
              )}

              {/* Expanded notes section */}
              {isExpanded ? (
                <div className="border-t border-slate-100 dark:border-border bg-slate-50 dark:bg-muted px-3 py-2">
                  <StarNotesEditor star={star} onChange={(nextStar) => setStar(starKey, nextStar)} />
                </div>
              ) : null}
            </React.Fragment>
          );
        })}
      </div>

      {/* xAI proposal error */}
      {proposeError && !proposal && (
        <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-400">
          xAI proposal failed: {proposeError}
        </div>
      )}

      {/* xAI proposal panel */}
      {proposal?.proposal && (
        <div className="rounded-lg border border-emerald-300 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-900/10 p-3 space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-emerald-900 dark:text-emerald-300 flex items-center gap-1.5">
              <Sparkles className="h-4 w-4" />
              xAI proposal{proposal.company_name ? ` for ${proposal.company_name}` : ""}
              {proposal.duration_ms != null ? (
                <span className="text-[10px] text-muted-foreground ml-1">
                  ({(proposal.duration_ms / 1000).toFixed(1)}s)
                </span>
              ) : null}
            </div>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setProposal(null)}
              title="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Side-by-side for each star */}
          {[
            { key: "star4", label: "Reputation", curV: proposal.current?.star4_value, curR: proposal.current?.star4_reasoning, newV: proposal.proposal.star4_value, newR: proposal.proposal.star4_reasoning },
            { key: "star5", label: "Quality", curV: proposal.current?.star5_value, curR: proposal.current?.star5_reasoning, newV: proposal.proposal.star5_value, newR: proposal.proposal.star5_reasoning },
          ].map((row) => {
            const valueChanged = Number(row.curV || 0).toFixed(2) !== Number(row.newV || 0).toFixed(2);
            return (
              <div key={row.key} className="rounded border border-emerald-200 dark:border-emerald-900/40 bg-white dark:bg-card p-2 space-y-2">
                <div className="text-xs font-medium text-foreground">{row.label}</div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="space-y-1">
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Current</div>
                    <div className="text-foreground">
                      Score: <span className="font-medium">{row.curV != null ? Number(row.curV).toFixed(2) : "—"}</span>
                    </div>
                    <div className="text-muted-foreground"><ReasoningList text={row.curR} /></div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-[10px] text-emerald-700 dark:text-emerald-400 uppercase tracking-wide">Proposed</div>
                    <div className="text-foreground">
                      Score: <span className={`font-medium ${valueChanged ? "text-emerald-700 dark:text-emerald-400" : ""}`}>
                        {row.newV != null ? Number(row.newV).toFixed(2) : "—"}
                      </span>
                    </div>
                    <div className="text-foreground"><ReasoningList text={row.newR} /></div>
                  </div>
                </div>
              </div>
            );
          })}

          <div className="flex items-center gap-2 pt-1">
            <Button
              type="button"
              size="sm"
              onClick={() => acceptProposal({ star4: true, star5: true })}
            >
              Accept both
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => acceptProposal({ star4: true, star5: false })}
            >
              Accept Reputation only
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => acceptProposal({ star4: false, star5: true })}
            >
              Accept Quality only
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setProposal(null)}
            >
              Dismiss
            </Button>
            <span className="text-[10px] text-muted-foreground ml-auto">
              Accepting stages changes in the draft — click Save to persist.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
