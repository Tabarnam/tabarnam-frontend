import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import DataTable from "react-data-table-component";
import { useTheme } from "next-themes";
import {
  Save,
  Trash2,
  Pencil,
  RefreshCcw,
  AlertTriangle,
  Plus,
  AlertCircle,
  Copy,
  ChevronDown,
} from "lucide-react";

import { calculateInitialRating, normalizeRating } from "@/lib/stars/calculateRating";
import { getQQScore } from "@/lib/stars/qqRating";
import { getProfileCompleteness, getProfileCompletenessLabel } from "@/lib/profileCompleteness";

import AdminHeader from "@/components/AdminHeader";
import useNotificationSound from "@/hooks/useNotificationSound";
import ErrorBoundary from "@/components/ErrorBoundary";
import ScrollScrubber from "@/components/ScrollScrubber";
import AdminEditHistory from "@/components/AdminEditHistory";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/lib/toast";
import { API_BASE, apiFetch, apiFetchParsed, getCachedBuildId, getLastApiRequestExplain, getUserFacingConfigMessage, toErrorString } from "@/lib/api";
import { deleteLogoBlob, uploadLogoBlobFile } from "@/lib/blobStorage";
import { getCompanyLogoUrl } from "@/lib/logoUrl";
import { getAdminUser } from "@/lib/azureAuth";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

import {
  DEFAULT_TAKE,
  asString,
  prettyJson,
  getResponseHeadersForDebug,
  deepClone,
  normalizeBuildIdString,
  normalizeHttpStatusNumber,
  fetchStaticBuildId,
  normalizeLocationList,
  normalizeStringList,
  mergeStringListsCaseInsensitive,
  normalizeLocationSources,
  normalizeVisibility,
  keywordStringToList,
  keywordListToString,
  normalizeStructuredLocationEntry,
  normalizeStructuredLocationList,
  formatStructuredLocation,
  getLocationGeocodeStatus,
  getCompanyName,
  inferDisplayNameOverride,
  getCompanyUrl,
  getCompanyId,
  isDeletedCompany,
  normalizeRatingIconType,
  buildCompanyDraft,
  slugifyCompanyId,
  toNonNegativeInt,
  getComputedReviewCount,
  toLegacyIssueTags,
  getContractMissingFields,
  formatContractMissingField,
  toIssueTags,
  toDisplayDate,
  validateCompanyDraft,
  normalizeCompanyNotes,
  mergeCuratedReviews,
  copyToClipboard,
} from "./company-dashboard/dashboardUtils";

import ReviewsImportPanel from "./company-dashboard/ReviewsImportPanel";
import ImportedReviewsPanel from "./company-dashboard/ImportedReviewsPanel";
import CuratedReviewsEditor from "./company-dashboard/CuratedReviewsEditor";
import RatingEditor from "./company-dashboard/RatingEditor";
import CompanyNotesEditor from "./company-dashboard/CompanyNotesEditor";
import StructuredLocationListEditor from "./company-dashboard/StructuredLocationListEditor";

// Renders text with URLs converted to clickable links
function TextWithLinks({ text, className = "" }) {
  if (!text || typeof text !== "string") return null;

  // URL regex pattern
  const urlPattern = /(https?:\/\/[^\s<>"{}|\\^`[\]]+)/gi;
  const parts = text.split(urlPattern);

  return (
    <span className={className}>
      {parts.map((part, i) => {
        if (urlPattern.test(part)) {
          // Reset lastIndex since we're reusing the regex
          urlPattern.lastIndex = 0;
          return (
            <a
              key={i}
              href={part}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline break-all"
              onClick={(e) => e.stopPropagation()}
            >
              {part}
            </a>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </span>
  );
}

function LocationSourcesEditor({ value, onChange }) {
  const list = normalizeLocationSources(value);

  const add = useCallback(() => {
    const next = [
      ...list,
      {
        location: "",
        source_url: "",
        source_type: "official_website",
        location_type: "headquarters",
      },
    ];
    onChange(next);
  }, [list, onChange]);

  const remove = useCallback(
    (idx) => {
      onChange(list.filter((_, i) => i !== idx));
    },
    [list, onChange]
  );

  const update = useCallback(
    (idx, patch) => {
      onChange(list.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
    },
    [list, onChange]
  );

  return (
    <div className="space-y-2">
      <div className="text-sm text-slate-700 dark:text-muted-foreground font-medium">Location sources</div>
      <div className="rounded-lg border border-slate-200 dark:border-border bg-white dark:bg-card overflow-hidden">
        {list.length === 0 ? (
          <div className="p-3 text-xs text-slate-600 dark:text-muted-foreground">No sources yet.</div>
        ) : (
          <div className="p-3 space-y-3">
            {list.map((entry, idx) => (
              <div key={`${entry.location}-${idx}`} className="rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-3 space-y-2">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-slate-700 dark:text-muted-foreground">Location</label>
                    <Input
                      value={asString(entry.location)}
                      onChange={(e) => update(idx, { location: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-slate-700 dark:text-muted-foreground">Source URL</label>
                    <Input
                      value={asString(entry.source_url)}
                      onChange={(e) => update(idx, { source_url: e.target.value })}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-slate-700 dark:text-muted-foreground">Source type</label>
                    <select
                      className="h-10 w-full rounded-md border border-slate-200 dark:border-border bg-white dark:bg-card px-3 text-sm"
                      value={asString(entry.source_type || "other")}
                      onChange={(e) => update(idx, { source_type: e.target.value })}
                    >
                      <option value="official_website">Official website</option>
                      <option value="government_guide">Government guide</option>
                      <option value="b2b_directory">B2B directory</option>
                      <option value="trade_data">Trade data</option>
                      <option value="packaging">Packaging</option>
                      <option value="media">Media</option>
                      <option value="other">Other</option>
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs font-medium text-slate-700 dark:text-muted-foreground">Location type</label>
                    <select
                      className="h-10 w-full rounded-md border border-slate-200 dark:border-border bg-white dark:bg-card px-3 text-sm"
                      value={asString(entry.location_type || "headquarters")}
                      onChange={(e) => update(idx, { location_type: e.target.value })}
                    >
                      <option value="headquarters">Headquarters</option>
                      <option value="manufacturing">Manufacturing</option>
                      <option value="other">Other</option>
                    </select>
                  </div>
                </div>

                <div className="flex justify-end">
                  <Button type="button" variant="outline" size="sm" onClick={() => remove(idx)}>
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="border-t border-slate-200 dark:border-border p-3">
          <Button type="button" variant="outline" onClick={add}>
            <Plus className="h-4 w-4 mr-2" />
            Add source
          </Button>
        </div>
      </div>
    </div>
  );
}

function StringListEditor({ label, value, onChange, placeholder = "" }) {
  const list = normalizeStringList(value);
  const [draft, setDraft] = useState("");

  const add = useCallback(() => {
    const parts = asString(draft)
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);

    if (parts.length === 0) {
      // Treat comma-only / whitespace-only input as an attempted submission
      setDraft("");
      return;
    }

    const seen = new Set(list.map((v) => asString(v).trim().toLowerCase()).filter(Boolean));
    const toAdd = [];

    for (const part of parts) {
      const key = part.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      toAdd.push(part);
    }

    if (toAdd.length > 0) {
      onChange([...list, ...toAdd]);
    }

    // Clear after a submission attempt (even if everything was already present)
    setDraft("");
  }, [draft, list, onChange]);

  const onKeyDown = useCallback(
    (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      add();
    },
    [add]
  );

  const canSubmit = asString(draft)
    .split(",")
    .some((part) => part.trim().length > 0);

  const remove = useCallback(
    (idx) => {
      onChange(list.filter((_, i) => i !== idx));
    },
    [list, onChange]
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-slate-700 dark:text-muted-foreground font-medium">{label}</div>
      </div>

      <div className="rounded-lg border border-slate-200 dark:border-border bg-white dark:bg-card">
        {list.length === 0 ? (
          <div className="p-3 text-xs text-slate-500 dark:text-muted-foreground">None yet.</div>
        ) : (
          <div className="p-3 flex flex-wrap gap-2">
            {list.map((item, idx) => (
              <span
                key={`${item}-${idx}`}
                className="inline-flex items-center gap-2 rounded-full border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted px-3 py-1 text-xs text-slate-800 dark:text-foreground"
              >
                {item}
                <button
                  type="button"
                  className="text-slate-500 dark:text-muted-foreground hover:text-red-600"
                  onClick={() => remove(idx)}
                  aria-label={`Remove ${item}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="border-t border-slate-200 dark:border-border p-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[240px] flex-1 space-y-1">
              <label className="text-xs font-medium text-slate-700 dark:text-muted-foreground">Add</label>
              <Input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown} placeholder={placeholder} />
            </div>
            <Button type="button" onClick={add} disabled={!canSubmit}>
              <Plus className="h-4 w-4 mr-2" />
              Add
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function LocationStatusBadge({ loc }) {
  const status = getLocationGeocodeStatus(loc);
  const cls =
    status === "found"
      ? "bg-emerald-50 text-emerald-800 border-emerald-200"
      : status === "failed"
        ? "bg-red-50 text-red-800 border-red-200"
        : "bg-slate-50 dark:bg-muted text-slate-700 dark:text-muted-foreground border-slate-200 dark:border-border";

  const label = status === "found" ? "Found" : status === "failed" ? "Failed" : "Missing";
  const detail =
    loc && typeof loc === "object"
      ? asString(loc.geocode_error || loc.geocode_google_status || loc.geocode_source).trim()
      : "";

  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`}
      title={detail || label}
    >
      {label}
    </span>
  );
}
function StarNotesEditor({ star, onChange }) {
  const [text, setText] = useState("");
  const [isPublic, setIsPublic] = useState(false);

  const notes = star?.notes && Array.isArray(star.notes) ? star.notes : [];

  const addNote = useCallback(() => {
    const t = asString(text).trim();
    if (!t) return;

    const next = {
      id: `note_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      text: t,
      is_public: isPublic,
      created_at: new Date().toISOString(),
      created_by: "admin_ui",
    };

    onChange({ ...(star || {}), notes: [...notes, next] });
    setText("");
    setIsPublic(false);
  }, [isPublic, notes, onChange, star, text]);

  const deleteNote = useCallback(
    (idx) => {
      onChange({ ...(star || {}), notes: notes.filter((_, i) => i !== idx) });
    },
    [notes, onChange, star]
  );

  return (
    <div className="space-y-2">
      {notes.length > 0 ? (
        <div className="space-y-2">
          {notes.map((n, idx) => (
            <div key={n?.id || idx} className="rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium text-slate-700 dark:text-muted-foreground">
                    {n?.is_public ? "Public" : "Private"}
                    {n?.created_at ? ` · ${new Date(n.created_at).toLocaleString()}` : ""}
                  </div>
                  <div className="mt-1 text-sm text-slate-900 dark:text-foreground whitespace-pre-wrap break-words">{asString(n?.text)}</div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="border-red-600 text-red-600 hover:bg-red-600 hover:text-white"
                  onClick={() => deleteNote(idx)}
                  title="Delete note"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-xs text-slate-500 dark:text-muted-foreground">No notes.</div>
      )}

      <div className="rounded border border-slate-200 dark:border-border bg-white dark:bg-card p-3 space-y-2">
        <div className="text-xs font-medium text-slate-700 dark:text-muted-foreground">Add note</div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="min-h-[80px] w-full rounded-md border border-slate-200 dark:border-border bg-white dark:bg-card px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
          placeholder="Write a note…"
        />
        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-muted-foreground">
            <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
            Public
          </label>
          <Button type="button" onClick={addNote} disabled={!asString(text).trim()}>
            <Plus className="h-4 w-4 mr-2" />
            Add note
          </Button>
        </div>
      </div>
    </div>
  );
}
export default function CompanyDashboard() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { play: playNotification } = useNotificationSound();

  const [search, setSearch] = useState("");
  const [take, setTake] = useState(DEFAULT_TAKE);
  const [onlyIncomplete, setOnlyIncomplete] = useState(false);

  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState([]);
  const [lastError, setLastError] = useState(null);
  const [rowErrors, setRowErrors] = useState({});

  const [selectedRows, setSelectedRows] = useState([]);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorLoadError, setEditorLoadError] = useState(null);
  const [editorDraft, setEditorDraft] = useState(null);
  const [editorOriginalId, setEditorOriginalId] = useState(null);
  const [editorShowAdvanced, setEditorShowAdvanced] = useState(false);
  const [editorDisplayNameOverride, setEditorDisplayNameOverride] = useState("");

  const [refreshLoading, setRefreshLoading] = useState(false);
  const [refreshError, setRefreshError] = useState(null);
  const [refreshProposed, setRefreshProposed] = useState(null);
  const [refreshTaglineMeta, setRefreshTaglineMeta] = useState(null);
  const [proposedDraft, setProposedDraft] = useState(null);
  const [proposedDraftText, setProposedDraftText] = useState({});
  const [refreshSelection, setRefreshSelection] = useState({});
  const [refreshApplied, setRefreshApplied] = useState(false);

  const refreshInFlightRef = useRef(false);

  const [refreshMetaByCompany, setRefreshMetaByCompany] = useState({});

  const activeRefreshCompanyId = useMemo(() => {
    return asString(editorOriginalId || editorDraft?.company_id).trim();
  }, [editorDraft, editorOriginalId]);

  const lastRefreshMeta = useMemo(() => {
    if (!activeRefreshCompanyId) return null;
    const meta = refreshMetaByCompany?.[activeRefreshCompanyId];
    return meta && typeof meta === "object" ? meta : null;
  }, [activeRefreshCompanyId, refreshMetaByCompany]);

  const [logoFile, setLogoFile] = useState(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoUpdating, setLogoUpdating] = useState(false);
  const [logoUploadError, setLogoUploadError] = useState(null);
  const [logoDeleting, setLogoDeleting] = useState(false);
  const [logoPreviewFailed, setLogoPreviewFailed] = useState(false);

  const [notesToReviewsMode, setNotesToReviewsMode] = useState("append");
  const [notesToReviewsDryRun, setNotesToReviewsDryRun] = useState(false);
  const [notesToReviewsLoading, setNotesToReviewsLoading] = useState(false);
  const [notesToReviewsPreview, setNotesToReviewsPreview] = useState([]);
  const [notesToReviewsPreviewMeta, setNotesToReviewsPreviewMeta] = useState(null);

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search || "");
      const companyId = asString(params.get("company_id")).trim();
      if (!companyId) return;
      setEditorOriginalId(companyId);
      setEditorOpen(true);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (!editorOpen) return;

    try {
      const hash = typeof window !== "undefined" ? String(window.location.hash || "") : "";
      if (!hash || hash !== "#reviews") return;

      const el = reviewsImportRef.current;
      if (!el || typeof el.scrollIntoView !== "function") return;

      const t = window.setTimeout(() => {
        try {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
        } catch {
          // ignore
        }
      }, 50);

      return () => window.clearTimeout(t);
    } catch {
      // ignore
    }
  }, [editorOpen]);

  useEffect(() => {
    setLogoPreviewFailed(false);
  }, [asString(editorDraft?.logo_url).trim()]);

  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [deleteConfirmLoading, setDeleteConfirmLoading] = useState(false);
  const [deleteConfirmError, setDeleteConfirmError] = useState(null);

  const requestSeqRef = useRef(0);
  const abortRef = useRef(null);
  const editorFetchSeqRef = useRef(0);
  const reviewsImportRef = useRef(null);
  const editorScrollRef = useRef(null);
  const [editorScrollEl, setEditorScrollEl] = useState(null);

  const setEditorScrollNode = useCallback((node) => {
    if (editorScrollRef.current === node) return;
    editorScrollRef.current = node;
    setEditorScrollEl((prev) => (prev === node ? prev : node));
  }, []);

  const incompleteCount = useMemo(() => {
    return items.reduce((sum, c) => sum + (toIssueTags(c).length > 0 ? 1 : 0), 0);
  }, [items]);

  const filteredItems = useMemo(() => {
    if (!onlyIncomplete) return items;
    return items.filter((c) => toIssueTags(c).length > 0);
  }, [items, onlyIncomplete]);

  const loadCompanies = useCallback(
    async (opts = {}) => {
      const q = typeof opts.search === "string" ? opts.search : search;
      const t = Number.isFinite(opts.take) ? opts.take : take;

      const seq = (requestSeqRef.current += 1);
      if (abortRef.current) {
        try {
          abortRef.current.abort();
        } catch {
          // ignore
        }
      }
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setLastError(null);
      try {
        const params = new URLSearchParams();
        if (q.trim()) params.set("search", q.trim());
        params.set("take", String(Math.max(1, Math.min(500, Math.trunc(t || DEFAULT_TAKE)))));

        const res = await apiFetch(`/xadmin-api-companies?${params.toString()}`, { signal: controller.signal });
        const body = await res.json().catch(() => ({}));

        if (seq !== requestSeqRef.current) return;

        if (!res.ok) {
          const configMsg = await getUserFacingConfigMessage(res);
          const msg = toErrorString(configMsg || body?.error || body?.message || body?.text || `Failed to load companies (${res.status})`);
          const errorDetail = toErrorString(body?.detail || body?.error || body?.message || body?.text || res.statusText || "Unknown error");

          setLastError({
            status: res.status,
            message: msg,
            detail: errorDetail,
          });

          toast.error(msg);
          return;
        }

        const nextItems = Array.isArray(body?.items) ? body.items : [];
        setItems(nextItems);
        setRowErrors((prev) => {
          if (!prev || typeof prev !== "object") return {};
          const ids = new Set(nextItems.map((c) => getCompanyId(c)).filter(Boolean));
          const keep = {};
          for (const [key, value] of Object.entries(prev)) {
            if (ids.has(key)) keep[key] = value;
          }
          return keep;
        });
        setLastError(null);
      } catch (e) {
        if (controller.signal.aborted) return;
        const errMsg = toErrorString(e) || "Failed to load companies";
        setLastError({
          status: 503,
          message: errMsg,
          detail: e?.message || "Network or API unavailable",
        });
        toast.error(errMsg);
      } finally {
        if (seq === requestSeqRef.current) setLoading(false);
      }
    },
    [search, take]
  );

  useEffect(() => {
    const q = search.trim();
    const timeout = window.setTimeout(
      () => {
        loadCompanies({ search: q, take });
      },
      q ? 300 : 0
    );

    return () => {
      window.clearTimeout(timeout);
    };
  }, [loadCompanies, search, take]);

  useEffect(() => {
    return () => {
      if (abortRef.current) {
        try {
          abortRef.current.abort();
        } catch {
          // ignore
        }
      }
    };
  }, []);

  useEffect(() => {
    if (!editorOpen || !editorOriginalId) return;

    const companyId = asString(editorOriginalId).trim();
    if (!companyId) return;

    const seq = (editorFetchSeqRef.current += 1);
    const controller = new AbortController();

    setEditorLoading(true);
    setEditorLoadError(null);

    (async () => {
      try {
        // Contract: after a successful DELETE, GET /api/xadmin-api-companies/{id} returns 404 (deleted records are filtered out).
        const res = await apiFetch(`/xadmin-api-companies/${encodeURIComponent(companyId)}`, {
          signal: controller.signal,
        });
        const body = await res.json().catch(() => ({}));

        if (seq !== editorFetchSeqRef.current || controller.signal.aborted) return;

        if (res.status === 404) {
          const msg = "Company not found (it may have been deleted).";
          setEditorLoadError(msg);
          toast.error(msg);
          closeEditor();
          return;
        }

        const ok = (res.ok && body?.ok === true) || (!res.ok && body?.ok === true);
        const company = body?.company && typeof body.company === "object" ? body.company : null;

        if (!ok || !company) {
          const configMsg = await getUserFacingConfigMessage(res);
          const msg = toErrorString(
            configMsg ||
              body?.error ||
              body?.detail ||
              body?.message ||
              body?.text ||
              (!company ? "Company not found." : `Failed to load company (${res.status})`)
          );
          setEditorLoadError(msg);
          toast.error(msg);
          return;
        }

        const draft = buildCompanyDraft(company);
        setEditorDraft(draft);
        setEditorShowAdvanced(false);
        setEditorDisplayNameOverride(inferDisplayNameOverride(draft));
      } catch (e) {
        if (controller.signal.aborted) return;
        const msg = toErrorString(e) || "Failed to load company";
        setEditorLoadError(msg);
        toast.error(msg);
      } finally {
        if (seq === editorFetchSeqRef.current) setEditorLoading(false);
      }
    })();

    return () => {
      try {
        controller.abort();
      } catch {
        // ignore
      }
    };
  }, [editorOpen, editorOriginalId]);

  const closeEditor = useCallback(() => {
    setEditorOpen(false);
    setEditorDraft(null);
    setEditorOriginalId(null);
    setEditorLoadError(null);
    setEditorLoading(false);
    setEditorSaving(false);
    setEditorShowAdvanced(false);
    setEditorDisplayNameOverride("");

    setLogoFile(null);
    setLogoUploadError(null);
    setLogoUploading(false);
    setLogoUpdating(false);
    setLogoDeleting(false);

    setRefreshLoading(false);
    setRefreshError(null);
    setRefreshProposed(null);
    setRefreshTaglineMeta(null);
    setProposedDraft(null);
    setProposedDraftText({});
    setRefreshSelection({});
    setRefreshApplied(false);
  }, []);

  const handleEditorOpenChange = useCallback(
    (open) => {
      if (open) {
        setEditorOpen(true);
        return;
      }
      closeEditor();
    },
    [closeEditor]
  );

  const openEditorForCompany = useCallback((company) => {
    const id = getCompanyId(company);
    const draft = buildCompanyDraft(company);

    setEditorOriginalId(id || null);
    setEditorDraft(draft);
    setEditorShowAdvanced(false);
    setEditorDisplayNameOverride(inferDisplayNameOverride(draft));
    setEditorLoadError(null);
    setLogoFile(null);
    setLogoUploadError(null);
    setRefreshLoading(false);
    setRefreshError(null);
    setRefreshProposed(null);
    setRefreshTaglineMeta(null);
    setProposedDraft(null);
    setProposedDraftText({});
    setRefreshSelection({});
    setRefreshApplied(false);
    setEditorOpen(true);
  }, []);

  const createNewCompany = useCallback(() => {
    const draft = {
      company_id: "",
      company_name: "",
      name: "",
      website_url: "",
      tagline: "",
      logo_url: "",
      amazon_url: "",
      amazon_store_url: "",
      affiliate_link_urls: [],
      show_location_sources_to_users: false,
      visibility: { hq_public: true, manufacturing_public: true, admin_rating_public: true },
      location_sources: [],
      headquarters_location: "",
      headquarters_locations: [],
      manufacturing_locations: [],
      industries: [],
      keywords: [],
      rating: calculateInitialRating({ hasManufacturingLocations: false, hasHeadquarters: false, hasReviews: false }),
      notes_entries: [],
      notes: "",
    };

    setEditorOriginalId(null);
    setEditorDraft(draft);
    setEditorShowAdvanced(false);
    setEditorDisplayNameOverride("");
    setLogoFile(null);
    setLogoUploadError(null);
    setRefreshLoading(false);
    setRefreshError(null);
    setRefreshProposed(null);
    setRefreshTaglineMeta(null);
    setProposedDraft(null);
    setProposedDraftText({});
    setRefreshSelection({});
    setRefreshApplied(false);
    setEditorOpen(true);
  }, []);

  const refreshDiffFields = useMemo(
    () => [
      { key: "company_name", label: "Company name" },
      { key: "website_url", label: "Website URL" },
      { key: "tagline", label: "Tagline" },
      { key: "logo_url", label: "Logo URL" },
      { key: "headquarters_locations", label: "HQ locations" },
      { key: "manufacturing_locations", label: "Manufacturing locations" },
      { key: "industries", label: "Industries" },
      { key: "keywords", label: "Keywords" },
      { key: "curated_reviews", label: "Reviews" },
      { key: "red_flag", label: "Red flag" },
      { key: "red_flag_reason", label: "Red flag reason" },
      { key: "location_confidence", label: "Location confidence" },
      { key: "location_sources", label: "Location sources" },
    ],
    []
  );

  const normalizeForDiff = useCallback((key, value) => {
    switch (key) {
      case "industries":
      case "keywords": {
        return normalizeStringList(value)
          .map((v) => v.trim())
          .filter(Boolean)
          .map((v) => v.toLowerCase())
          .sort();
      }
      case "headquarters_locations":
      case "manufacturing_locations": {
        return normalizeStructuredLocationList(value)
          .map((v) => formatStructuredLocation(v))
          .map((v) => v.trim())
          .filter(Boolean)
          .map((v) => v.toLowerCase())
          .sort();
      }
      case "location_sources": {
        const list = Array.isArray(value) ? value : [];
        return list
          .filter((v) => v && typeof v === "object")
          .map((v) => {
            const location = asString(v.location).trim();
            const source_url = asString(v.source_url).trim();
            const source_type = asString(v.source_type).trim();
            const location_type = asString(v.location_type).trim();
            return [location, source_type, location_type, source_url]
              .filter(Boolean)
              .join(" | ")
              .toLowerCase();
          })
          .filter(Boolean)
          .sort();
      }
      case "curated_reviews": {
        const list = Array.isArray(value) ? value : [];
        return list
          .filter((v) => v && typeof v === "object")
          .map((v) => {
            const url = asString(v.source_url || v.url || "").trim().toLowerCase();
            const title = asString(v.title || "").trim().toLowerCase();
            return `${url}|${title}`;
          })
          .filter(Boolean)
          .sort();
      }
      case "red_flag": {
        return Boolean(value);
      }
      default:
        return asString(value).trim();
    }
  }, []);

  const diffToDisplay = useCallback((key, value) => {
    switch (key) {
      case "industries":
      case "keywords": {
        const list = normalizeStringList(value);
        return list.length ? list.join("\n") : "(empty)";
      }
      case "headquarters_locations":
      case "manufacturing_locations": {
        const list = normalizeStructuredLocationList(value).map((v) => formatStructuredLocation(v)).filter(Boolean);
        return list.length ? list.join("\n") : "(empty)";
      }
      case "location_sources": {
        const list = Array.isArray(value) ? value : [];
        const lines = list
          .filter((v) => v && typeof v === "object")
          .map((v) => {
            const location = asString(v.location).trim();
            const source_url = asString(v.source_url).trim();
            const source_type = asString(v.source_type).trim();
            const location_type = asString(v.location_type).trim();
            return [location, source_type, location_type, source_url].filter(Boolean).join(" — ");
          })
          .filter(Boolean);
        return lines.length ? lines.join("\n") : "(empty)";
      }
      case "curated_reviews": {
        const list = Array.isArray(value) ? value : [];
        const lines = list
          .filter((v) => v && typeof v === "object")
          .map((v) => {
            const source = asString(v.source_name || "").trim();
            const title = asString(v.title || "").trim();
            const url = asString(v.source_url || v.url || "").trim();
            const author = asString(v.author || "").trim();
            const parts = [title || source, author ? `by ${author}` : "", url].filter(Boolean);
            return parts.join(" — ");
          })
          .filter(Boolean);
        return lines.length ? lines.join("\n") : "(no reviews)";
      }
      case "red_flag": {
        return Boolean(value) ? "true" : "false";
      }
      default: {
        const s = asString(value).trim();
        return s || "(empty)";
      }
    }
  }, []);

  const proposedValueToInputText = useCallback(
    (key, value) => {
      switch (key) {
        case "industries":
        case "keywords": {
          const list = normalizeStringList(value);
          return list.length ? list.join("\n") : "";
        }
        case "headquarters_locations":
        case "manufacturing_locations": {
          const list = normalizeStructuredLocationList(value).map((v) => formatStructuredLocation(v)).filter(Boolean);
          return list.length ? list.join("\n") : "";
        }
        case "location_sources": {
          const list = Array.isArray(value) ? value : [];
          const lines = list
            .filter((v) => v && typeof v === "object")
            .map((v) => {
              const location = asString(v.location).trim();
              const source_url = asString(v.source_url).trim();
              const source_type = asString(v.source_type).trim();
              const location_type = asString(v.location_type).trim();
              return [location, source_type, location_type, source_url].filter(Boolean).join(" — ");
            })
            .filter(Boolean);
          return lines.length ? lines.join("\n") : "";
        }
        case "curated_reviews": {
          const list = Array.isArray(value) ? value : [];
          const lines = list
            .filter((v) => v && typeof v === "object")
            .map((v) => {
              const source = asString(v.source_name || "").trim();
              const title = asString(v.title || "").trim();
              const url = asString(v.source_url || v.url || "").trim();
              const author = asString(v.author || "").trim();
              const parts = [title || source, author ? `by ${author}` : "", url].filter(Boolean);
              return parts.join(" — ");
            })
            .filter(Boolean);
          return lines.length ? lines.join("\n") : "";
        }
        case "red_flag": {
          return Boolean(value) ? "true" : "false";
        }
        default:
          return asString(value).trim();
      }
    },
    []
  );

  const parseProposedInputText = useCallback(
    (key, text, prevValue) => {
      const raw = asString(text);
      switch (key) {
        case "industries":
        case "keywords": {
          const parts = raw
            .split(/\r?\n/)
            .flatMap((line) => line.split(/,/))
            .map((v) => v.trim())
            .filter(Boolean);
          return parts;
        }
        case "headquarters_locations":
        case "manufacturing_locations": {
          const existing = normalizeStructuredLocationList(prevValue);
          const used = new Set();
          const lines = raw
            .split(/\r?\n/)
            .map((v) => v.trim())
            .filter(Boolean);

          const next = [];
          for (const line of lines) {
            let found = null;
            for (let i = 0; i < existing.length; i += 1) {
              if (used.has(i)) continue;
              const display = formatStructuredLocation(existing[i]).trim();
              if (display && display === line) {
                found = existing[i];
                used.add(i);
                break;
              }
            }
            next.push(found || normalizeStructuredLocationEntry(line));
          }

          return next.filter(Boolean);
        }
        case "location_sources": {
          const existing = Array.isArray(prevValue) ? prevValue.filter((v) => v && typeof v === "object") : [];
          const existingLines = existing.map((v) => {
            const location = asString(v.location).trim();
            const source_url = asString(v.source_url).trim();
            const source_type = asString(v.source_type).trim();
            const location_type = asString(v.location_type).trim();
            return [location, source_type, location_type, source_url].filter(Boolean).join(" — ");
          });

          const used = new Set();
          const lines = raw
            .split(/\r?\n/)
            .map((v) => v.trim())
            .filter(Boolean);

          const next = [];
          for (const line of lines) {
            const idx = existingLines.findIndex((l, i) => !used.has(i) && l === line);
            if (idx !== -1) {
              used.add(idx);
              next.push(existing[idx]);
              continue;
            }

            const parts = line
              .split(/\s*(?:—|\|)\s*/)
              .map((p) => p.trim())
              .filter(Boolean);

            const [p1, p2, p3, p4] = parts;
            const looksLikeUrl = (v) => /^https?:\/\//i.test(asString(v).trim());

            const obj = {
              location: asString(p1).trim(),
              source_type: "",
              location_type: "",
              source_url: "",
            };

            if (parts.length === 2) {
              if (looksLikeUrl(p2)) obj.source_url = asString(p2).trim();
              else obj.source_type = asString(p2).trim();
            } else if (parts.length === 3) {
              if (looksLikeUrl(p3)) {
                obj.source_type = asString(p2).trim();
                obj.source_url = asString(p3).trim();
              } else {
                obj.source_type = asString(p2).trim();
                obj.location_type = asString(p3).trim();
              }
            } else if (parts.length >= 4) {
              obj.source_type = asString(p2).trim();
              obj.location_type = asString(p3).trim();
              obj.source_url = asString(p4).trim();
            }

            if (obj.location || obj.source_type || obj.location_type || obj.source_url) next.push(obj);
          }

          return next;
        }
        case "curated_reviews": {
          const existing = Array.isArray(prevValue) ? prevValue.filter((v) => v && typeof v === "object") : [];
          const lines = raw.split(/\r?\n/).map((v) => v.trim()).filter(Boolean);

          // Try to match each edited line back to an existing review object
          const used = new Set();
          const next = [];
          for (const line of lines) {
            // Check if this line matches an existing review
            let found = null;
            for (let i = 0; i < existing.length; i++) {
              if (used.has(i)) continue;
              const r = existing[i];
              const source = asString(r.source_name || "").trim();
              const title = asString(r.title || "").trim();
              const url = asString(r.source_url || r.url || "").trim();
              const author = asString(r.author || "").trim();
              const parts = [title || source, author ? `by ${author}` : "", url].filter(Boolean);
              if (parts.join(" — ") === line) {
                found = r;
                used.add(i);
                break;
              }
            }
            if (found) {
              next.push(found);
            } else {
              // Parse new review from text: "title — by author — url"
              const parts = line.split(/\s*—\s*/).map((p) => p.trim()).filter(Boolean);
              const obj = { source_name: "", author: "", source_url: "", title: "", date: "", excerpt: "" };
              for (const part of parts) {
                if (/^https?:\/\//i.test(part)) obj.source_url = part;
                else if (/^by\s+/i.test(part)) obj.author = part.replace(/^by\s+/i, "").trim();
                else if (!obj.title) obj.title = part;
                else obj.source_name = part;
              }
              if (obj.title || obj.source_url) next.push(obj);
            }
          }
          return next;
        }
        case "red_flag": {
          const v = raw.trim().toLowerCase();
          if (!v) return false;
          if (["true", "1", "yes", "y"].includes(v)) return true;
          if (["false", "0", "no", "n"].includes(v)) return false;
          return Boolean(prevValue);
        }
        case "location_confidence": {
          const trimmed = raw.trim();
          if (!trimmed) return "";
          const num = Number(trimmed);
          return Number.isFinite(num) ? num : trimmed;
        }
        default:
          return raw;
      }
    },
    []
  );

  const diffRows = useMemo(() => {
    const baseProposed = refreshProposed && typeof refreshProposed === "object" ? refreshProposed : null;
    if (!editorDraft || !baseProposed) return [];

    const rows = [];
    for (const f of refreshDiffFields) {
      if (!Object.prototype.hasOwnProperty.call(baseProposed, f.key)) continue;

      const currentVal = editorDraft?.[f.key];
      const proposedVal = baseProposed?.[f.key];

      const a = normalizeForDiff(f.key, currentVal);
      const b = normalizeForDiff(f.key, proposedVal);
      const changed = JSON.stringify(a) !== JSON.stringify(b);
      if (!changed) continue;

      rows.push({
        key: f.key,
        label: f.label,
        currentText: diffToDisplay(f.key, currentVal),
        proposedText: diffToDisplay(f.key, proposedVal),
      });
    }

    return rows;
  }, [diffToDisplay, editorDraft, normalizeForDiff, refreshDiffFields, refreshProposed]);

  const selectedDiffCount = useMemo(() => {
    return diffRows.reduce((sum, row) => sum + (refreshSelection[row.key] ? 1 : 0), 0);
  }, [diffRows, refreshSelection]);

  const selectAllDiffs = useCallback(() => {
    const next = {};
    for (const row of diffRows) next[row.key] = true;
    setRefreshSelection(next);
  }, [diffRows]);

  const clearAllDiffs = useCallback(() => {
    setRefreshSelection({});
  }, []);

  const formatConfidencePct = useCallback((value) => {
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    if (!Number.isFinite(n)) return "—";
    return `${Math.round(n * 100)}%`;
  }, []);

  const applySelectedDiffs = useCallback(() => {
    const baseProposed = proposedDraft && typeof proposedDraft === "object" ? proposedDraft : null;
    if (!baseProposed) return;

    setEditorDraft((prev) => {
      const base = prev && typeof prev === "object" ? prev : {};
      let next = base;

      for (const row of diffRows) {
        if (!refreshSelection[row.key]) continue;
        if (!Object.prototype.hasOwnProperty.call(baseProposed, row.key)) continue;
        if (next === base) next = { ...base };
        next[row.key] = baseProposed[row.key];
      }

      return next;
    });

    setRefreshApplied(true);
    toast.success(`Applied ${selectedDiffCount} change${selectedDiffCount === 1 ? "" : "s"}`);
  }, [diffRows, proposedDraft, refreshSelection, selectedDiffCount]);

  const applyAllProposedToDraft = useCallback(() => {
    const baseProposed = proposedDraft && typeof proposedDraft === "object" ? proposedDraft : null;
    if (!baseProposed) return;

    const protectedKeys = new Set(["logo_url", "notes", "notes_entries", "rating"]);

    setEditorDraft((prev) => {
      const base = prev && typeof prev === "object" ? prev : {};
      let next = base;

      for (const f of refreshDiffFields) {
        if (protectedKeys.has(f.key)) continue;
        if (!Object.prototype.hasOwnProperty.call(baseProposed, f.key)) continue;
        if (next === base) next = { ...base };
        next[f.key] = baseProposed[f.key];
      }

      return next;
    });

    setRefreshApplied(true);
    toast.success("Applied proposed values to draft");
  }, [proposedDraft, refreshDiffFields]);

  const copyAllProposedAsJson = useCallback(async () => {
    const baseProposed = proposedDraft && typeof proposedDraft === "object" ? proposedDraft : null;
    if (!baseProposed) return;
    const ok = await copyToClipboard(prettyJson(baseProposed));
    if (ok) toast.success("Copied proposed JSON");
    else toast.error("Copy failed");
  }, [proposedDraft]);

  const refreshCompany = useCallback(async () => {
    const companyId = asString(editorOriginalId || editorDraft?.company_id).trim();
    if (!companyId) {
      toast.error("Save the company first.");
      return;
    }

    // Extra safety: prevent duplicate requests even if the button is double-clicked
    // before the disabled state re-renders.
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;

    const startedAt = new Date().toISOString();

    setRefreshMetaByCompany((prev) => ({
      ...(prev || {}),
      [companyId]: {
        lastRefreshAt: startedAt,
        lastRefreshStatus: { kind: "running", code: null },
        lastRefreshDebug: null,
      },
    }));

    setRefreshLoading(true);
    // Keep the last failure visible while the next attempt is running.
    setRefreshProposed(null);
    setRefreshTaglineMeta(null);
    setProposedDraft(null);
    setProposedDraftText({});
    setRefreshSelection({});
    setRefreshApplied(false);

    const requestPayload = {
      company_id: companyId,
      timeout_ms: 200000,
      deadline_ms: 200000,
    };

    // Pre-warm: fire a lightweight request to wake up the Function App before the heavy refresh.
    // SWA cold-starts frequently cause 500 "Backend call failure". This non-blocking ping gives
    // the Function App a head-start on initialization.
    try {
      fetch(`${API_BASE}/ping?_t=${Date.now()}`, {
        method: "GET",
        signal: AbortSignal.timeout(8000),
      }).catch(() => {});
    } catch {
      // ignore — best effort
    }

    try {
      const refreshPaths = ["/xadmin-api-refresh-company"];
      const attempts = [];

      let usedPath = refreshPaths[0];
      let result = null;

      for (const path of refreshPaths) {
        usedPath = path;

        try {
          const r = await apiFetchParsed(path, {
            method: "POST",
            body: requestPayload,
          });

          const requestExplain = getLastApiRequestExplain();

          attempts.push({
            path,
            status: r.status,
            request: requestExplain,
            request_payload: requestPayload,
            response_headers: getResponseHeadersForDebug(r.response),
            api_fetch_error: r.response && typeof r.response === "object" ? r.response.__api_fetch_error : null,
            api_fetch_fallback: r.response && typeof r.response === "object" ? r.response.__api_fetch_fallback : null,
          });
          result = r;
          break;
        } catch (err) {
          const status = normalizeHttpStatusNumber(err?.status) ?? 0;
          const requestExplain = getLastApiRequestExplain();
          attempts.push({
            path,
            status,
            request: requestExplain,
            request_payload: requestPayload,
          });
          if (status === 404) continue;

          // ── SWA 500 auto-retry ──
          // The SWA gateway may return 500 "Backend call failure" during cold starts or
          // when the Function App is under heavy load. Retry up to 3 times with backoff.
          const errText = asString(err?.text).trim();
          const isSwa500 = status >= 500 &&
            (errText === "Backend call failure" || errText === "" || !errText);
          if (isSwa500) {
            const retryDelays = [5000, 10000, 15000];
            let retrySucceeded = false;
            for (let retryIdx = 0; retryIdx < retryDelays.length; retryIdx++) {
              try {
                await new Promise((resolve) => setTimeout(resolve, retryDelays[retryIdx]));

                toast.info(`Retrying refresh (attempt ${retryIdx + 2})…`);

                const retryResult = await apiFetchParsed(path, {
                  method: "POST",
                  body: requestPayload,
                });

                // Success — use this result
                const retryExplain = getLastApiRequestExplain();
                attempts.push({
                  path,
                  status: retryResult.status,
                  request: retryExplain,
                  request_payload: requestPayload,
                  response_headers: getResponseHeadersForDebug(retryResult.response),
                  swa_retry_attempt: retryIdx + 1,
                });
                result = retryResult;
                retrySucceeded = true;
                break;
              } catch (retryErr) {
                const retryStatus = normalizeHttpStatusNumber(retryErr?.status) ?? 0;
                const retryText = asString(retryErr?.text).trim();
                const retryIsSwa500 = retryStatus >= 500 &&
                  (retryText === "Backend call failure" || retryText === "" || !retryText);
                try {
                  console.warn(`[refresh-company] SWA 500 auto-retry attempt ${retryIdx + 1}/${retryDelays.length} ${retryIsSwa500 ? "still got 500" : "real error"}`);
                } catch {}
                if (!retryIsSwa500) break; // Real error, stop retrying
              }
            }
            if (retrySucceeded) break;
          }

          if (!result) {
            throw { ...(err || {}), status, attempts, usedPath: path };
          }
        }
      }

      if (!result) {
        const staticBuildId = await fetchStaticBuildId();
        const msg = `Refresh API missing in prod build${staticBuildId ? ` (build ${staticBuildId})` : ""}`;

        const errObj = {
          status: 404,
          message: msg,
          url: `/api${usedPath}`,
          attempts,
          build_id: staticBuildId,
          debug: { error: "both refresh endpoints returned 404" },
          debug_bundle: {
            kind: "refresh_company",
            endpoint_url: `/api${usedPath}`,
            request_payload: requestPayload,
            request_explain: attempts.length ? attempts[attempts.length - 1]?.request : null,
            attempts,
            response: null,
            build: {
              api_build_id: staticBuildId || null,
              cached_build_id: getCachedBuildId() || null,
            },
          },
        };

        setRefreshError(errObj);
        setRefreshMetaByCompany((prev) => ({
          ...(prev || {}),
          [companyId]: {
            lastRefreshAt: startedAt,
            lastRefreshStatus: { kind: "error", code: 404 },
            lastRefreshDebug: errObj.debug,
          },
        }));

        toast.error(errObj.message);
        return;
      }

      const res = result.response;
      const apiBuildId = normalizeBuildIdString(res.headers.get("x-api-build-id"));

      const jsonBody = result.data && typeof result.data === "object" ? result.data : null;
      const textBody = typeof result.text === "string" ? result.text : "";

      if (!jsonBody || Array.isArray(jsonBody)) {
        const preview = textBody.trim() ? textBody.trim().slice(0, 500) : "";
        const msg = `Bad response: not JSON (HTTP ${res.status})${preview ? ` — ${preview}` : ""}`;

        const errObj = {
          status: res.status,
          message: msg,
          url: `/api${usedPath}`,
          attempts,
          build_id: apiBuildId,
          debug: preview || textBody || null,
          debug_bundle: {
            kind: "refresh_company",
            endpoint_url: `/api${usedPath}`,
            request_payload: requestPayload,
            request_explain: attempts.length ? attempts[attempts.length - 1]?.request : null,
            attempts,
            response: {
              status: res.status,
              ok: res.ok,
              headers: getResponseHeadersForDebug(res),
              body_json: null,
              body_text: typeof textBody === "string" ? textBody : "",
            },
            build: {
              api_build_id: apiBuildId || null,
              cached_build_id: getCachedBuildId() || null,
            },
          },
        };

        setRefreshError(errObj);
        setRefreshMetaByCompany((prev) => ({
          ...(prev || {}),
          [companyId]: {
            lastRefreshAt: startedAt,
            lastRefreshStatus: { kind: "error", code: res.status },
            lastRefreshDebug: errObj.debug,
          },
        }));

        toast.error(errObj.message);
        return;
      }

      // Some refresh responses return { ok:false, ... } with useful diagnostics.
      if (jsonBody?.ok !== true) {
        // ── Auto-retry for "locked" responses ──
        // When the SWA gateway returns a 500 on the first attempt, the fallback
        // retry may find the lock held by the still-running original request
        // (ghost lock from SWA connection drop).
        // For short locks (≤60s), wait and auto-retry.
        // For longer locks, tell the user to try again shortly rather than making
        // them wait 2-3 minutes staring at a spinner.
        const isLocked = jsonBody?.root_cause === "locked" && jsonBody?.retryable === true;
        const retryAfterMs = isLocked ? Number(jsonBody?.retry_after_ms || 0) : 0;
        const MAX_AUTO_RETRY_WAIT_MS = 60_000; // 60s max auto-wait (reduced from 180s)

        if (isLocked && retryAfterMs > MAX_AUTO_RETRY_WAIT_MS) {
          // Lock is too far out — don't make the user wait, show a friendly message instead
          const waitSec = Math.ceil(retryAfterMs / 1000);
          toast.warning(`A previous refresh is still in progress (${waitSec}s remaining). Please try again in about a minute.`);
          setRefreshMetaByCompany((prev) => ({
            ...(prev || {}),
            [companyId]: {
              lastRefreshAt: startedAt,
              lastRefreshStatus: { kind: "locked", code: null },
              lastRefreshDebug: { locked: true, retry_after_ms: retryAfterMs },
            },
          }));
          setRefreshError({
            status: 423,
            message: `Refresh locked — try again in ~${Math.ceil(retryAfterMs / 60000)} minute(s)`,
            debug: jsonBody,
          });
          return;
        }

        if (isLocked && retryAfterMs > 0 && retryAfterMs <= MAX_AUTO_RETRY_WAIT_MS) {
          toast.info(`Refresh in progress — waiting ${Math.ceil(retryAfterMs / 1000)}s for lock to release…`);
          setRefreshMetaByCompany((prev) => ({
            ...(prev || {}),
            [companyId]: {
              lastRefreshAt: startedAt,
              lastRefreshStatus: { kind: "running", code: null },
              lastRefreshDebug: { auto_retry_waiting: true, retry_after_ms: retryAfterMs },
            },
          }));

          await new Promise((resolve) => setTimeout(resolve, retryAfterMs + 2000));

          // Retry the request once after the lock should have expired
          try {
            const retryResult = await apiFetchParsed(usedPath, {
              method: "POST",
              body: requestPayload,
            });
            const retryJson = retryResult.data && typeof retryResult.data === "object" ? retryResult.data : null;

            if (retryJson?.ok === true && retryJson?.proposed) {
              // Success on retry — fall through to the success handling below
              // by reassigning result and continuing
              result = retryResult;
              // Re-read response variables for success path
              const retryRes = retryResult.response;
              const retryApiBuildId = normalizeBuildIdString(retryRes.headers.get("x-api-build-id"));
              const retryProposed = retryJson.proposed;
              const draft = deepClone(retryProposed);
              setRefreshProposed(retryProposed);
              setProposedDraft(draft);

              const nextTaglineMeta = retryJson?.tagline_meta && typeof retryJson.tagline_meta === "object" ? retryJson.tagline_meta : null;
              setRefreshTaglineMeta(nextTaglineMeta);

              if (nextTaglineMeta?.error) {
                toast.warning(`Tagline verification issue: ${asString(nextTaglineMeta.error).trim().slice(0, 160)}`);
              }

              const nextText = {};
              for (const f of refreshDiffFields) {
                if (!Object.prototype.hasOwnProperty.call(draft, f.key)) continue;
                nextText[f.key] = proposedValueToInputText(f.key, draft[f.key]);
              }
              setProposedDraftText(nextText);

              const defaults = {};
              for (const f of refreshDiffFields) {
                if (!Object.prototype.hasOwnProperty.call(retryProposed, f.key)) continue;
                const a = normalizeForDiff(f.key, editorDraft?.[f.key]);
                const b = normalizeForDiff(f.key, retryProposed?.[f.key]);
                if (JSON.stringify(a) !== JSON.stringify(b)) defaults[f.key] = true;
              }
              setRefreshSelection(defaults);

              setRefreshMetaByCompany((prev) => ({
                ...(prev || {}),
                [companyId]: {
                  lastRefreshAt: startedAt,
                  lastRefreshStatus: { kind: "success", code: retryRes.status },
                  lastRefreshDebug: null,
                },
              }));

              setRefreshError(null);
              if (retryJson?.recovered_from_pending) {
                toast.info("Refresh results recovered from a previous attempt.");
              } else {
                toast.success("Proposed updates loaded (after retry)");
              }
              playNotification();
              return;
            }
            // Retry also failed — fall through to normal error handling below
          } catch {
            // Retry network error — fall through to show original locked error
          }
        }

        const debug =
          jsonBody?.response && typeof jsonBody.response === "object"
            ? jsonBody.response
            : jsonBody;

        const debugMessage =
          asString(debug?.message).trim() ||
          asString(debug?.error).trim() ||
          asString(jsonBody?.message).trim() ||
          asString(jsonBody?.error).trim();

        const msg =
          debugMessage ||
          (textBody.trim() ? textBody.trim().slice(0, 500) : "") ||
          (await getUserFacingConfigMessage(res)) ||
          res.statusText ||
          `Refresh failed (${res.status})`;

        const errObj = {
          status: res.status,
          message: asString(msg).trim() || `Refresh failed (${res.status})`,
          url: asString(debug?.url).trim() || `/api${usedPath}`,
          attempts,
          build_id: apiBuildId,
          debug,
          debug_bundle: {
            kind: "refresh_company",
            endpoint_url: `/api${usedPath}`,
            request_payload: requestPayload,
            request_explain: attempts.length ? attempts[attempts.length - 1]?.request : null,
            attempts,
            response: {
              status: res.status,
              ok: res.ok,
              headers: getResponseHeadersForDebug(res),
              body_json: jsonBody,
              body_text: typeof textBody === "string" ? textBody : "",
            },
            build: {
              api_build_id: apiBuildId || null,
              cached_build_id: getCachedBuildId() || null,
            },
          },
        };

        setRefreshError(errObj);
        setRefreshMetaByCompany((prev) => ({
          ...(prev || {}),
          [companyId]: {
            lastRefreshAt: startedAt,
            lastRefreshStatus: { kind: "error", code: res.status },
            lastRefreshDebug: debug,
          },
        }));

        toast.error(`${errObj.message} (${usedPath} → HTTP ${res.status})`);
        return;
      }

      const proposed = jsonBody?.proposed && typeof jsonBody.proposed === "object" ? jsonBody.proposed : null;
      if (!proposed) {
        const errObj = {
          status: res.status,
          message: "No proposed updates returned.",
          url: `/api${usedPath}`,
          attempts,
          build_id: apiBuildId,
          debug: jsonBody,
          debug_bundle: {
            kind: "refresh_company",
            endpoint_url: `/api${usedPath}`,
            request_payload: requestPayload,
            request_explain: attempts.length ? attempts[attempts.length - 1]?.request : null,
            attempts,
            response: {
              status: res.status,
              ok: res.ok,
              headers: getResponseHeadersForDebug(res),
              body_json: jsonBody,
              body_text: typeof textBody === "string" ? textBody : "",
            },
            build: {
              api_build_id: apiBuildId || null,
              cached_build_id: getCachedBuildId() || null,
            },
          },
        };
        setRefreshError(errObj);
        setRefreshMetaByCompany((prev) => ({
          ...(prev || {}),
          [companyId]: {
            lastRefreshAt: startedAt,
            lastRefreshStatus: { kind: "error", code: res.status },
            lastRefreshDebug: errObj.debug,
          },
        }));

        toast.error(`${errObj.message} (${usedPath} → HTTP ${res.status})`);
        return;
      }

      const draft = deepClone(proposed);
      setRefreshProposed(proposed);
      setProposedDraft(draft);

      const nextTaglineMeta = jsonBody?.tagline_meta && typeof jsonBody.tagline_meta === "object" ? jsonBody.tagline_meta : null;
      setRefreshTaglineMeta(nextTaglineMeta);

      if (nextTaglineMeta?.error) {
        toast.warning(`Tagline verification issue: ${asString(nextTaglineMeta.error).trim().slice(0, 160)}`);
      }

      const nextText = {};
      for (const f of refreshDiffFields) {
        if (!Object.prototype.hasOwnProperty.call(draft, f.key)) continue;
        nextText[f.key] = proposedValueToInputText(f.key, draft[f.key]);
      }
      setProposedDraftText(nextText);

      const defaults = {};
      for (const f of refreshDiffFields) {
        if (!Object.prototype.hasOwnProperty.call(proposed, f.key)) continue;
        const a = normalizeForDiff(f.key, editorDraft?.[f.key]);
        const b = normalizeForDiff(f.key, proposed?.[f.key]);
        if (JSON.stringify(a) !== JSON.stringify(b)) defaults[f.key] = true;
      }
      setRefreshSelection(defaults);

      setRefreshMetaByCompany((prev) => ({
        ...(prev || {}),
        [companyId]: {
          lastRefreshAt: startedAt,
          lastRefreshStatus: { kind: "success", code: res.status },
          lastRefreshDebug: null,
        },
      }));

      setRefreshError(null);
      if (jsonBody?.recovered_from_pending) {
        toast.info("Refresh results recovered from a previous attempt.");
      } else {
        toast.success("Proposed updates loaded");
      }
      playNotification();
    } catch (e) {
      // Normalize diagnostics from API wrapper errors (preferred) and plain exceptions.
      const errStatus =
        normalizeHttpStatusNumber(e?.status) ??
        normalizeHttpStatusNumber(e?.data?.status) ??
        normalizeHttpStatusNumber(e?.data?.response?.status) ??
        0;

      let debugData = e?.data;
      if (debugData && typeof debugData === "object" && debugData.response != null) {
        debugData = debugData.response;
      }

      const debugText =
        asString(e?.text).trim() ||
        (typeof e?.message === "string" ? e.message : "");

      const debugPayload =
        debugData != null
          ? debugData
          : debugText
            ? debugText
            : null;

      const debugMessage =
        debugData && typeof debugData === "object"
          ? asString(debugData.message || debugData.error).trim()
          : "";

      const msg =
        debugMessage ||
        debugText ||
        toErrorString(e) ||
        "Refresh failed";

      const attemptsList = Array.isArray(e?.attempts) ? e.attempts : [];
      const attemptsForDisplay = attemptsList.length ? attemptsList : [];

      const requestExplain = getLastApiRequestExplain();

      const errObj = {
        status: errStatus,
        message: asString(msg).trim() || "Refresh failed",
        url: asString(debugData?.url).trim() || asString(e?.url).trim() || asString(e?.usedPath).trim() || "(request failed)",
        attempts: attemptsForDisplay,
        build_id: normalizeBuildIdString(debugData?.build_id) || "",
        debug: debugPayload,
        debug_bundle: {
          kind: "refresh_company",
          endpoint_url: asString(e?.url).trim() || asString(e?.usedPath).trim() || "(request failed)",
          request_payload: requestPayload,
          request_explain: requestExplain,
          attempts: attemptsForDisplay,
          response: {
            status: errStatus,
            ok: false,
            headers: null,
            body_json: debugData && typeof debugData === "object" ? debugData : null,
            body_text: debugText || "",
          },
          build: {
            api_build_id: normalizeBuildIdString(debugData?.build_id) || null,
            cached_build_id: getCachedBuildId() || null,
          },
        },
      };

      setRefreshError(errObj);
      setRefreshMetaByCompany((prev) => ({
        ...(prev || {}),
        [companyId]: {
          lastRefreshAt: startedAt,
          lastRefreshStatus: { kind: "error", code: errObj.status || null },
          lastRefreshDebug: debugPayload,
        },
      }));

      toast.error(errObj.message);
    } finally {
      refreshInFlightRef.current = false;
      setRefreshLoading(false);
    }
  }, [editorDraft, editorOriginalId, normalizeForDiff, playNotification, proposedValueToInputText, refreshDiffFields]);

  const applySelectedProposedReviews = useCallback(
    (selectedReviews) => {
      const base = editorDraft && typeof editorDraft === "object" ? editorDraft : {};
      const existing = Array.isArray(base.curated_reviews) ? base.curated_reviews : [];
      const { merged, addedCount, skippedDuplicates } = mergeCuratedReviews(existing, selectedReviews);

      setEditorDraft((prev) => ({ ...(prev || {}), curated_reviews: merged }));
      return { addedCount, skippedDuplicates };
    },
    [editorDraft]
  );

  const deleteCuratedReviewFromDraft = useCallback((reviewId, index) => {
    const id = asString(reviewId).trim();

    setEditorDraft((prev) => {
      if (!prev || typeof prev !== "object") return prev;

      const list = Array.isArray(prev.curated_reviews) ? prev.curated_reviews : [];
      const next = id
        ? list.filter((r) => asString(r?.id).trim() !== id)
        : list.filter((_, i) => i !== index);

      return { ...prev, curated_reviews: next };
    });
  }, []);

  const updateCuratedReviewInDraft = useCallback((reviewId, patchOrNext) => {
    const id = asString(reviewId).trim();
    if (!id) return;

    setEditorDraft((prev) => {
      if (!prev || typeof prev !== "object") return prev;

      const list = Array.isArray(prev.curated_reviews) ? prev.curated_reviews : [];
      const next = list.map((r) => {
        if (asString(r?.id).trim() !== id) return r;

        const patch =
          typeof patchOrNext === "function" ? patchOrNext(r && typeof r === "object" ? r : {}) : patchOrNext || {};

        const nextShow =
          Object.prototype.hasOwnProperty.call(patch, "show_to_users") ||
          Object.prototype.hasOwnProperty.call(patch, "is_public") ||
          Object.prototype.hasOwnProperty.call(patch, "visible_to_users")
            ? Boolean(patch.show_to_users ?? patch.is_public ?? patch.visible_to_users)
            : undefined;

        const merged = {
          ...(r && typeof r === "object" ? r : {}),
          ...(patch && typeof patch === "object" ? patch : {}),
          last_updated_at: new Date().toISOString(),
          include_on_save: true,
        };

        if (typeof nextShow === "boolean") {
          merged.show_to_users = nextShow;
          merged.is_public = nextShow;
        }

        return merged;
      });

      return { ...prev, curated_reviews: next };
    });
  }, []);

  const saveEditor = useCallback(async () => {
    if (!editorDraft) return;

    const baseProposed = proposedDraft && typeof proposedDraft === "object" ? proposedDraft : null;
    const protectedKeys = new Set(["logo_url", "notes", "notes_entries", "rating"]);

    let draftForSave = (() => {
      if (!baseProposed) return editorDraft;

      const base = editorDraft;
      let next = base;

      for (const f of refreshDiffFields) {
        if (protectedKeys.has(f.key)) continue;
        if (!refreshSelection?.[f.key]) continue;
        if (!Object.prototype.hasOwnProperty.call(baseProposed, f.key)) continue;
        if (next === base) next = { ...base };
        next[f.key] = baseProposed[f.key];
      }

      return next;
    })();

    const selectedProposedReviews = reviewsImportRef.current?.getSelectedReviews?.() || [];
    const proposedReviewCount = Number(reviewsImportRef.current?.getProposedReviewCount?.() || 0) || 0;

    if (proposedReviewCount > 0 && selectedProposedReviews.length === 0) {
      toast.warning("No reviews were marked 'Include on save', nothing was persisted");
    }

    let autoAddedReviews = 0;
    let autoSkippedReviews = 0;

    if (selectedProposedReviews.length > 0) {
      const existingCurated = Array.isArray(draftForSave?.curated_reviews) ? draftForSave.curated_reviews : [];
      const { merged, addedCount, skippedDuplicates } = mergeCuratedReviews(existingCurated, selectedProposedReviews);

      autoAddedReviews = addedCount;
      autoSkippedReviews = skippedDuplicates;

      if (addedCount > 0) {
        draftForSave = { ...(draftForSave || {}), curated_reviews: merged };
        setEditorDraft((prev) => ({ ...(prev || {}), curated_reviews: merged }));
      }
    }

    const validationError = validateCompanyDraft(draftForSave);
    if (validationError) {
      toast.error(validationError);
      return;
    }

    const isNew = !editorOriginalId;

    setEditorSaving(true);
    try {
      const draftCompanyId = asString(draftForSave.company_id).trim();
      const draftCompanyName = asString(draftForSave.company_name).trim();
      const draftDisplayOverride = asString(editorDisplayNameOverride).trim();

      const resolvedCompanyName = draftCompanyName;
      const resolvedName = draftDisplayOverride ? draftDisplayOverride : draftCompanyName;

      const suggestedId = slugifyCompanyId(resolvedCompanyName);

      const resolvedCompanyId = isNew
        ? draftCompanyId || suggestedId
        : draftCompanyId || asString(editorOriginalId).trim();

      const hqLocations = normalizeStructuredLocationList(draftForSave.headquarters_locations);
      const manuLocations = normalizeStructuredLocationList(draftForSave.manufacturing_locations);

      const industries = normalizeStringList(draftForSave.industries);
      const keywords = normalizeStringList(draftForSave.keywords);
      const rating = normalizeRating(draftForSave.rating);
      const notes_entries = normalizeCompanyNotes(draftForSave.notes_entries);
      const location_sources = normalizeLocationSources(draftForSave.location_sources);
      const visibility = normalizeVisibility(draftForSave.visibility);
      const affiliate_link_urls = normalizeStringList(draftForSave.affiliate_link_urls);
      const rating_icon_type = normalizeRatingIconType(draftForSave.rating_icon_type, rating);

      const draftBase = draftForSave;

      const payload = {
        ...draftBase,
        rating_icon_type,
        company_id: resolvedCompanyId,
        id: asString(draftForSave.id).trim() || resolvedCompanyId,
        company_name: resolvedCompanyName,
        name: resolvedName,
        website_url: getCompanyUrl(draftForSave),
        url: asString(draftForSave.url || getCompanyUrl(draftForSave)).trim(),
        headquarters_location: hqLocations.length > 0 ? formatStructuredLocation(hqLocations[0]) : "",
        headquarters_locations: hqLocations,
        headquarters: hqLocations,
        manufacturing_locations: manuLocations,
        manufacturing_geocodes: manuLocations,
        industries,
        keywords,
        product_keywords: keywords,
        rating,
        notes_entries,
        notes: asString(draftForSave.notes).trim(),
        tagline: asString(draftForSave.tagline).trim(),
        logo_url: asString(draftForSave.logo_url).trim(),
        amazon_url: asString(draftForSave.amazon_url).trim(),
        amazon_store_url: asString(draftForSave.amazon_store_url).trim(),
        affiliate_link_urls,
        show_location_sources_to_users: Boolean(draftForSave.show_location_sources_to_users),
        visibility,
        location_sources,
      };

      if (
        refreshTaglineMeta &&
        baseProposed &&
        refreshSelection?.tagline &&
        Object.prototype.hasOwnProperty.call(baseProposed, "tagline")
      ) {
        payload.tagline_meta = { ...(refreshTaglineMeta || {}), captured_at: new Date().toISOString() };
      }

      if (!payload.company_id) {
        if (isNew) {
          payload.company_id = `company_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          payload.id = payload.company_id;
        } else {
          payload.company_id = asString(editorOriginalId).trim();
          payload.id = asString(draftForSave.id).trim() || payload.company_id;
        }
      }

      const method = isNew ? "POST" : "PUT";

      const user = getAdminUser();
      const actorEmail = asString(user?.email).trim();
      const requestId =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now()}_${Math.random().toString(36).slice(2)}`;

      const baseAuditAction = refreshApplied && editorOriginalId ? "refresh_apply" : "";
      const reviewsAuditAction = autoAddedReviews > 0 ? "reviews_import_apply" : "";
      const audit_action = baseAuditAction || reviewsAuditAction;
      const source = refreshApplied && editorOriginalId ? "refresh" : "admin-ui";

      const res = await apiFetch("/xadmin-api-companies", {
        method,
        body: {
          company: payload,
          actor_email: actorEmail || undefined,
          actor_user_id: actorEmail || undefined,
          audit_action: audit_action || undefined,
          source,
          request_id: requestId,
        },
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok !== true) {
        const msg = (await getUserFacingConfigMessage(res)) || body?.error || `Save failed (${res.status})`;
        toast.error(msg);
        return;
      }

      const savedCompany = body?.company || payload;
      const savedId = getCompanyId(savedCompany);

      setItems((prev) => {
        if (!savedId) return [savedCompany, ...prev];
        const next = prev.filter((c) => getCompanyId(c) !== savedId);
        return [savedCompany, ...next];
      });

      const label = isNew ? "Company created" : "Company saved";
      const reviewDetail = autoAddedReviews
        ? `${autoAddedReviews} review${autoAddedReviews === 1 ? "" : "s"} saved and visible on public profile${
            autoSkippedReviews ? ` (skipped ${autoSkippedReviews} duplicate${autoSkippedReviews === 1 ? "" : "s"})` : ""
          }`
        : "";

      toast.success(reviewDetail ? `${label} — ${reviewDetail}` : label);
      closeEditor();
    } catch (e) {
      toast.error(e?.message || "Save failed");
    } finally {
      setEditorSaving(false);
    }
  }, [closeEditor, editorDisplayNameOverride, editorDraft, editorOriginalId, proposedDraft, refreshDiffFields, refreshSelection, refreshTaglineMeta]);

  const updateCompanyInState = useCallback((companyId, patch) => {
    const id = asString(companyId).trim();
    if (!id) return;
    setItems((prev) =>
      prev.map((c) => {
        if (getCompanyId(c) !== id) return c;
        return { ...c, ...(patch || {}) };
      })
    );
  }, []);

  const applyReviewsFromNotes = useCallback(async () => {
    const companyId = asString(editorDraft?.company_id).trim() || asString(editorOriginalId).trim();
    if (!companyId) {
      toast.error("Save the company first to generate a company_id.");
      return;
    }

    const notes = asString(editorDraft?.notes).trim();
    if (!notes) {
      toast.error("Notes field is empty.");
      return;
    }

    const mode = notesToReviewsMode === "replace" ? "replace" : "append";
    const dryRun = Boolean(notesToReviewsDryRun);

    if (mode === "replace" && !dryRun) {
      const ok = window.confirm("Replace will overwrite curated reviews for this company. Continue?");
      if (!ok) return;
    }

    setNotesToReviewsLoading(true);
    try {
      const res = await apiFetch("/xadmin-api-apply-reviews-from-notes", {
        method: "POST",
        body: {
          company_id: companyId,
          mode,
          dry_run: dryRun,
          notes_text: notes,
        },
      });

      const body = await res.json().catch(() => ({}));
      if (body?.ok !== true) {
        const msg =
          asString(body?.message).trim() ||
          asString(body?.error).trim() ||
          (await getUserFacingConfigMessage(res)) ||
          "Apply reviews failed";
        toast.error(msg);
        return;
      }

      const parsedCount = Number(body?.parsed_count ?? 0) || 0;
      const savedCount = Number(body?.saved_count ?? 0) || 0;
      const total = Number(body?.review_count ?? 0) || 0;
      const warnings = Array.isArray(body?.warnings) ? body.warnings : [];
      const preview = Array.isArray(body?.preview) ? body.preview : [];

      if (dryRun) {
        setNotesToReviewsPreview(preview);
        setNotesToReviewsPreviewMeta({ parsedCount, savedCount, total, mode, warnings });
        toast.success(`Preview ready: ${parsedCount} parsed (would save ${savedCount})`);
        return;
      }

      // Refresh curated_reviews from the backend, but keep any other unsaved draft changes.
      try {
        const companyRes = await apiFetch(`/xadmin-api-companies/${encodeURIComponent(companyId)}`);
        const companyBody = await companyRes.json().catch(() => ({}));
        const company = companyBody?.company && typeof companyBody.company === "object" ? companyBody.company : null;
        if (company && typeof company === "object") {
          const curated = Array.isArray(company.curated_reviews) ? company.curated_reviews : [];
          setEditorDraft((prev) => ({
            ...(prev && typeof prev === "object" ? prev : {}),
            curated_reviews: curated,
            review_count: company.review_count ?? total,
            reviews_last_updated_at: company.reviews_last_updated_at ?? new Date().toISOString(),
          }));
          updateCompanyInState(companyId, {
            curated_reviews: curated,
            review_count: company.review_count,
            reviews_last_updated_at: company.reviews_last_updated_at,
          });
        } else {
          setEditorDraft((prev) => ({ ...(prev || {}), review_count: total }));
          updateCompanyInState(companyId, { review_count: total });
        }
      } catch {
        // If refresh fails, at least update the counts locally.
        setEditorDraft((prev) => ({ ...(prev || {}), review_count: total }));
        updateCompanyInState(companyId, { review_count: total });
      }

      if (mode === "replace") {
        toast.success(`Replaced reviews (total ${total})`);
      } else {
        toast.success(`Added ${savedCount} review${savedCount === 1 ? "" : "s"} (total ${total})`);
      }

      // Auto-clear notes and preview for next paste
      setEditorDraft((prev) => ({
        ...(prev && typeof prev === "object" ? prev : {}),
        notes: "",
      }));
      setNotesToReviewsPreview([]);
      setNotesToReviewsPreviewMeta(null);

      if (warnings.length) {
        console.log("[apply-reviews-from-notes] warnings", warnings);
      }
    } catch (e) {
      toast.error(asString(e?.message).trim() || "Apply reviews failed");
    } finally {
      setNotesToReviewsLoading(false);
    }
  }, [
    editorDraft,
    editorOriginalId,
    notesToReviewsDryRun,
    notesToReviewsMode,
    updateCompanyInState,
  ]);

  const isAllowedLogoType = useCallback((type) => {
    return type === "image/png" || type === "image/jpeg" || type === "image/webp";
  }, []);

  const handleLogoFileChange = useCallback(
    (e) => {
      const file = e?.target?.files?.[0] || null;
      setLogoUploadError(null);
      setLogoFile(null);

      if (!file) return;

      if (!isAllowedLogoType(file.type)) {
        setLogoUploadError("Invalid file type. Use PNG, JPG, or WebP.");
        return;
      }

      const maxBytes = 300 * 1024;
      if (typeof file.size === "number" && file.size > maxBytes) {
        setLogoUploadError("File too large. Max size is 300KB.");
        return;
      }

      setLogoFile(file);
    },
    [isAllowedLogoType]
  );

  const uploadLogo = useCallback(async () => {
    const companyId = asString(editorOriginalId).trim();
    if (!companyId) {
      toast.error("Save the company first to generate a company_id, then upload the logo.");
      return;
    }

    if (!logoFile) {
      toast.error("Choose a logo file first.");
      return;
    }

    setLogoUploading(true);
    setLogoUploadError(null);

    try {
      const url = await uploadLogoBlobFile(logoFile, companyId);

      setEditorDraft((d) => ({ ...(d || {}), logo_url: url }));
      updateCompanyInState(companyId, { logo_url: url });
      setLogoFile(null);
      toast.success("Logo uploaded");
    } catch (e) {
      const msg = e?.message || "Logo upload failed";
      setLogoUploadError(msg);
      toast.error(msg);
    } finally {
      setLogoUploading(false);
    }
  }, [editorOriginalId, logoFile, updateCompanyInState]);

  const clearLogoReference = useCallback(() => {
    const companyId = asString(editorOriginalId).trim();
    setEditorDraft((d) => ({ ...(d || {}), logo_url: "" }));
    if (companyId) updateCompanyInState(companyId, { logo_url: "" });
    toast.success("Logo cleared (save to persist)");
  }, [editorOriginalId, updateCompanyInState]);

  const deleteLogoFromStorage = useCallback(async () => {
    const companyId = asString(editorOriginalId).trim();
    const current = asString(editorDraft?.logo_url).trim();

    if (!companyId) {
      toast.error("Missing company_id");
      return;
    }

    if (!current) {
      toast.error("No logo to delete");
      return;
    }

    const isAzure = current.includes(".blob.core.windows.net") && current.includes("/company-logos/");
    if (!isAzure) {
      toast.error("This logo is not stored in Azure Blob Storage. Use Clear instead.");
      return;
    }

    setLogoDeleting(true);
    try {
      await deleteLogoBlob(current);

      setEditorDraft((d) => ({ ...(d || {}), logo_url: "" }));
      updateCompanyInState(companyId, { logo_url: "" });
      toast.success("Logo deleted");
    } catch (e) {
      const msg = e?.message || "Failed to delete logo";
      toast.error(msg);
    } finally {
      setLogoDeleting(false);
    }
  }, [editorDraft, editorOriginalId, updateCompanyInState]);

  const deleteCompany = useCallback(async (companyId) => {
    const safeId = asString(companyId).trim();
    if (!safeId) {
      toast.error("Missing company_id");
      return { ok: false, id: safeId, message: "Missing company_id" };
    }

    setRowErrors((prev) => {
      const next = { ...(prev || {}) };
      delete next[safeId];
      return next;
    });

    try {
      const user = getAdminUser();
      const actorEmail = asString(user?.email).trim();
      const requestId =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now()}_${Math.random().toString(36).slice(2)}`;

      const res = await apiFetch(`/xadmin-api-companies/${encodeURIComponent(safeId)}`, {
        method: "DELETE",
        body: {
          actor_email: actorEmail || undefined,
          actor_user_id: actorEmail || undefined,
          source: "admin-ui",
          request_id: requestId,
        },
      });

      const body = await res.json().catch(() => ({}));
      const ok = (res.ok && body?.ok === true) || (!res.ok && body?.ok === true);

      if (!ok) {
        const msg = (await getUserFacingConfigMessage(res)) || body?.error || `Delete failed (${res.status})`;
        const detail = body?.detail || body?.error || res.statusText || "Unknown error";

        setRowErrors((prev) => ({
          ...(prev || {}),
          [safeId]: { status: res.status, message: msg, detail, body },
        }));

        return { ok: false, id: safeId, message: msg, detail, body, status: res.status };
      }

      setItems((prev) => prev.filter((c) => getCompanyId(c) !== safeId));
      setRowErrors((prev) => {
        const next = { ...(prev || {}) };
        delete next[safeId];
        return next;
      });

      return { ok: true, id: safeId };
    } catch (e) {
      const msg = e?.message || "Delete failed";
      setRowErrors((prev) => ({
        ...(prev || {}),
        [safeId]: { status: 0, message: msg, detail: msg },
      }));
      return { ok: false, id: safeId, message: msg, detail: msg, status: 0 };
    }
  }, []);

  const openDeleteConfirm = useCallback((spec) => {
    setDeleteConfirmError(null);
    setDeleteConfirm(spec);
    setDeleteConfirmOpen(true);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteConfirm) return;
    setDeleteConfirmLoading(true);
    setDeleteConfirmError(null);

    try {
      if (deleteConfirm.kind === "bulk") {
        let deleted = 0;
        for (const id of deleteConfirm.ids) {
          const res = await deleteCompany(id);
          if (res.ok) deleted += 1;
        }
        if (deleted > 0) toast.success(`Deleted ${deleted} compan${deleted === 1 ? "y" : "ies"}`);
        setSelectedRows([]);
        setDeleteConfirmOpen(false);
        return;
      }

      const res = await deleteCompany(deleteConfirm.company_id);
      if (!res.ok) {
        setDeleteConfirmError({
          message: asString(res.message || "Delete failed"),
          detail: asString(res.detail || ""),
          body: res.body,
        });
        toast.error(asString(res.message || "Delete failed"));
        return;
      }

      toast.success("Company deleted");
      setDeleteConfirmOpen(false);
      closeEditor();
    } finally {
      setDeleteConfirmLoading(false);
    }
  }, [closeEditor, deleteCompany, deleteConfirm]);

  const deleteSelected = useCallback(() => {
    const ids = selectedRows.map((r) => getCompanyId(r)).filter(Boolean);
    if (ids.length === 0) return;

    openDeleteConfirm({ kind: "bulk", ids, label: `${ids.length} selected compan${ids.length === 1 ? "y" : "ies"}` });
  }, [openDeleteConfirm, selectedRows]);

  const columns = useMemo(() => {
    return [
      {
        name: "Edit",
        button: true,
        cell: (row) => (
          <Button size="sm" variant="outline" onClick={() => openEditorForCompany(row)}>
            <Pencil className="h-4 w-4" />
          </Button>
        ),
        width: "70px",
      },
      {
        name: "Name",
        selector: (row) => getCompanyName(row),
        sortable: true,
        wrap: true,
        grow: 2,
        cell: (row) => {
          const name = getCompanyName(row);
          return (
            <div className="flex flex-wrap items-center gap-2 min-w-0 group/name">
              <span className={isDeletedCompany(row) ? "opacity-50 line-through" : ""}>{name || "(missing)"}</span>
              {name && (
                <button
                  type="button"
                  className="opacity-0 group-hover/name:opacity-100 transition-opacity p-1 rounded hover:bg-slate-100 dark:bg-muted"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(name);
                    toast.success("Name copied to clipboard");
                  }}
                  title="Copy name"
                >
                  <Copy className="h-3 w-3 opacity-50" />
                </button>
              )}
              {isDeletedCompany(row) ? (
                <span className="rounded-full bg-slate-100 dark:bg-muted border border-slate-200 dark:border-border px-2 py-0.5 text-[11px] opacity-70">
                  deleted
                </span>
              ) : null}
            </div>
          );
        },
      },
      {
        name: "Domain",
        selector: (row) => asString(row?.normalized_domain).trim(),
        sortable: true,
        wrap: true,
        cell: (row) => {
          const domain = asString(row?.normalized_domain).trim();
          return (
            <div className="flex items-center gap-2 group/domain">
              <span>{domain}</span>
              {domain && (
                <button
                  type="button"
                  className="opacity-0 group-hover/domain:opacity-100 transition-opacity p-1 rounded hover:bg-slate-100 dark:bg-muted"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(domain);
                    toast.success("Domain copied to clipboard");
                  }}
                  title="Copy domain"
                >
                  <Copy className="h-3 w-3 text-slate-500 dark:text-muted-foreground" />
                </button>
              )}
            </div>
          );
        },
      },
      {
        name: "HQ",
        selector: (row) => {
          const hqList = normalizeStructuredLocationList(
            row?.headquarters_locations || row?.headquarters || row?.headquarters_location
          );
          return hqList.map((l) => formatStructuredLocation(l)).filter(Boolean).join("; ");
        },
        sortable: true,
        wrap: true,
      },
      {
        name: "MFG",
        selector: (row) => {
          const manuBase =
            Array.isArray(row?.manufacturing_geocodes) && row.manufacturing_geocodes.length > 0
              ? row.manufacturing_geocodes
              : row?.manufacturing_locations;
          const list = normalizeStructuredLocationList(manuBase);
          return list.map((l) => formatStructuredLocation(l)).filter(Boolean).join("; ");
        },
        sortable: true,
        wrap: true,
      },
      {
        name: "Stars",
        selector: (row) => getQQScore(row),
        sortable: true,
        right: true,
        width: "80px",
        cell: (row) => {
          const val = getQQScore(row);
          if (!val) return <span className="text-xs text-slate-400 dark:text-muted-foreground">—</span>;
          return <span className="text-xs text-slate-900 dark:text-foreground">{val.toFixed(1)}</span>;
        },
      },
      {
        name: "reviews",
        selector: (row) => getComputedReviewCount(row),
        sortable: true,
        right: true,
        width: "110px",
      },
      {
        name: "Profile",
        selector: (row) => getProfileCompleteness(row),
        sortable: true,
        right: true,
        width: "130px",
        cell: (row) => {
          const score = getProfileCompleteness(row);
          const label = getProfileCompletenessLabel(score);

          const tone =
            score >= 85
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : score >= 60
                ? "border-blue-200 bg-blue-50 text-blue-800"
                : score >= 35
                  ? "border-amber-200 bg-amber-50 text-amber-900"
                  : "border-red-200 bg-red-50 text-red-800";

          return (
            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${tone}`}>
              {label} · {score}%
            </span>
          );
        },
      },
      {
        name: "Updated",
        selector: (row) => asString(row?.updated_at || row?.created_at).trim(),
        sortable: true,
        cell: (row) => (
          <span className="text-xs text-slate-700 dark:text-muted-foreground">{toDisplayDate(row?.updated_at || row?.created_at)}</span>
        ),
        width: "160px",
      },
      {
        name: "Issues",
        selector: (row) => getContractMissingFields(row).length,
        sortable: true,
        cell: (row) => {
          const tags = getContractMissingFields(row);
          const dupCount = Number(row?._duplicates_count || 0);

          if (tags.length === 0 && dupCount === 0) return <span className="text-xs text-emerald-700">OK</span>;

          return (
            <div className="flex flex-wrap gap-[6px]">
              {dupCount > 0 && (
                <span
                  title={`${dupCount} duplicate record${dupCount === 1 ? "" : "s"} with same domain`}
                  className="rounded-full bg-red-50 border border-red-300 px-2 py-0.5 text-[11px] text-red-800 cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation();
                    const domain = asString(row?.normalized_domain).trim();
                    if (!domain || domain === "unknown") {
                      toast.error("No domain to merge");
                      return;
                    }
                    if (!window.confirm(`Merge ${dupCount} duplicate(s) for ${domain} into this record?`)) return;
                    apiFetch("/admin/cleanup-seed-fallback-dups", {
                      method: "POST",
                      body: { normalized_domain: domain, dry_run: false },
                    })
                      .then((r) => r.json().catch(() => ({})))
                      .then((data) => {
                        if (data?.ok) {
                          toast.success(`Merged ${dupCount} duplicate(s) for ${domain}`);
                          loadCompanies({ search: search.trim(), take });
                        } else {
                          toast.error(`Merge failed: ${data?.error || "unknown error"}`);
                        }
                      })
                      .catch((err) => toast.error(`Merge failed: ${err?.message || "unknown"}`));
                  }}
                >
                  {dupCount} dup{dupCount === 1 ? "" : "s"}
                </span>
              )}
              {tags.map((t, idx) => {
                const label = formatContractMissingField(t);
                const key = `${t}-${idx}`;

                const stageRaw =
                  asString(row?.enrichment_health?.reviews_stage_status || row?.reviews_stage_status).trim().toLowerCase();
                const reviewsTerminal = Boolean(row?.enrichment_health?.reviews_terminal) || stageRaw === "exhausted";
                const titleSuffix = t === "reviews" && reviewsTerminal ? " (exhausted)" : "";

                return (
                  <span
                    key={key}
                    title={`Missing: ${t}${titleSuffix}`}
                    className="rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-[11px] text-amber-900"
                  >
                    {label}
                  </span>
                );
              })}
            </div>
          );
        },
        width: "240px",
      },
      {
        name: "Delete",
        button: true,
        cell: (row) => {
          const id = getCompanyId(row);
          const rowError = id ? rowErrors?.[id] : null;

          return (
            <div className="space-y-2">
              <Button
                size="sm"
                variant="outline"
                className="border-red-600 text-red-600 hover:bg-red-600 hover:text-white"
                onClick={() =>
                  openDeleteConfirm({
                    kind: "single",
                    company_id: id,
                    company_name: getCompanyName(row),
                  })
                }
                disabled={!id}
              >
                <Trash2 className="h-4 w-4" />
              </Button>

              {rowError ? (
                <div className="max-w-[520px] rounded border border-red-200 bg-red-50 p-2 text-[11px] text-red-900">
                  <div className="font-medium">Delete failed</div>
                  <div>{asString(rowError.message || "Delete failed")}</div>
                  {rowError.detail && rowError.detail !== rowError.message ? (
                    <div className="mt-1 whitespace-pre-wrap break-words font-mono text-red-800">
                      {asString(rowError.detail)}
                    </div>
                  ) : null}
                  {rowError.body && typeof rowError.body === "object" ? (
                    <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-red-800">
                      {prettyJson(rowError.body)}
                    </pre>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        },
        width: "80px",
      },
    ];
  }, [openDeleteConfirm, openEditorForCompany, rowErrors, loadCompanies, search, take]);

  const tableTheme = useMemo(
    () => ({
      table: {
        style: {
          backgroundColor: isDark ? "hsl(187 15% 11%)" : undefined,
          color: isDark ? "hsl(187 10% 93%)" : undefined,
        },
      },
      header: {
        style: {
          minHeight: "48px",
          backgroundColor: isDark ? "hsl(187 15% 11%)" : undefined,
          color: isDark ? "hsl(187 10% 93%)" : undefined,
        },
      },
      headRow: {
        style: {
          backgroundColor: isDark ? "hsl(187 12% 15%)" : undefined,
          color: isDark ? "hsl(187 10% 93%)" : undefined,
          borderBottomColor: isDark ? "hsl(187 10% 18%)" : undefined,
        },
      },
      headCells: {
        style: {
          fontWeight: 600,
          fontSize: "12px",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: isDark ? "hsl(187 15% 55%)" : undefined,
        },
      },
      rows: {
        style: {
          backgroundColor: isDark ? "hsl(187 15% 11%)" : undefined,
          color: isDark ? "hsl(187 10% 93%)" : undefined,
          borderBottomColor: isDark ? "hsl(187 10% 18%)" : undefined,
          "&:hover": {
            backgroundColor: isDark ? "hsl(187 12% 15%)" : undefined,
          },
        },
      },
      pagination: {
        style: {
          backgroundColor: isDark ? "hsl(187 15% 11%)" : undefined,
          color: isDark ? "hsl(187 10% 93%)" : undefined,
          borderTopColor: isDark ? "hsl(187 10% 18%)" : undefined,
        },
      },
      noData: {
        style: {
          backgroundColor: isDark ? "hsl(187 15% 11%)" : undefined,
          color: isDark ? "hsl(187 15% 55%)" : undefined,
        },
      },
      progress: {
        style: {
          backgroundColor: isDark ? "hsl(187 15% 11%)" : undefined,
          color: isDark ? "hsl(187 15% 55%)" : undefined,
        },
      },
    }),
    [isDark]
  );

  const contextActions = useMemo(() => {
    if (!selectedRows || selectedRows.length === 0) return null;
    return (
      <Button
        variant="outline"
        className="border-red-600 text-red-600 hover:bg-red-600 hover:text-white"
        onClick={deleteSelected}
      >
        <Trash2 className="h-4 w-4 mr-2" />
        Delete selected ({selectedRows.length})
      </Button>
    );
  }, [deleteSelected, selectedRows]);

  const noDataComponent = useMemo(() => {
    if (lastError && (lastError.status === 503 || lastError.status === 404 || lastError.status >= 500)) {
      return <div className="p-6 text-sm text-slate-600 dark:text-muted-foreground">Unable to load companies (see error above).</div>;
    }
    return <div className="p-6 text-sm text-slate-600 dark:text-muted-foreground">No companies found.</div>;
  }, [lastError]);

  const progressComponent = useMemo(() => {
    return <div className="p-6 text-sm text-slate-600 dark:text-muted-foreground">Loading companies…</div>;
  }, []);

  const editorValidationError = useMemo(() => {
    return editorDraft ? validateCompanyDraft(editorDraft) : null;
  }, [editorDraft]);

  const editorCompanyId = useMemo(() => {
    if (!editorDraft) return "";
    const isNew = !editorOriginalId;
    const existing = asString(editorDraft.company_id).trim();
    if (existing) return existing;
    if (!isNew) return "";

    const suggested = slugifyCompanyId(getCompanyName(editorDraft));
    return suggested;
  }, [editorDraft, editorOriginalId]);

  return (
    <>
      <Helmet>
        <title>Tabarnam Admin — Companies</title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>

      <div className="min-h-screen bg-slate-50 dark:bg-background">
        <AdminHeader />

        <main className="container mx-auto py-6 px-4 space-y-4">
          <header className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h1 className="text-3xl font-bold text-slate-900 dark:text-foreground">Companies</h1>

              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" onClick={() => loadCompanies({ search: search.trim(), take })} disabled={loading}>
                  <RefreshCcw className="h-4 w-4 mr-2" />
                  {loading ? "Loading…" : "Refresh"}
                </Button>
                <Button onClick={createNewCompany}>
                  <Plus className="h-4 w-4 mr-2" />
                  New company
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search companies (server-side)…"
                  className="w-[320px]"
                />
              </div>

              <div className="flex items-center gap-2">
                <label className="text-sm text-slate-700 dark:text-muted-foreground">Take</label>
                <Input
                  value={String(take)}
                  onChange={(e) => setTake(Number(e.target.value || DEFAULT_TAKE))}
                  className="w-[100px]"
                  inputMode="numeric"
                />
              </div>

              <Button
                variant={onlyIncomplete ? "default" : "outline"}
                onClick={() => setOnlyIncomplete((v) => !v)}
                title="Show only companies missing key fields"
              >
                <AlertTriangle className="h-4 w-4 mr-2" />
                Incomplete ({incompleteCount})
              </Button>

              <div className="text-sm text-slate-600 dark:text-muted-foreground">
                Showing {filteredItems.length} companies{loading ? " · Loading…" : ""}
              </div>
            </div>
          </header>

          {lastError && (lastError.status === 503 || lastError.status === 404 || lastError.status >= 500) && (
            <div className="rounded-lg border-2 border-red-500 bg-red-50 p-4">
              <div className="flex items-start gap-3">
                <AlertCircle className="h-6 w-6 text-red-600 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <h3 className="text-lg font-semibold text-red-900">Admin API Unavailable ({lastError.status})</h3>
                  <p className="mt-1 text-sm text-red-800">{lastError.message}</p>
                  {lastError.detail && lastError.detail !== lastError.message && (
                    <p className="mt-1 text-xs text-red-700 font-mono">{lastError.detail}</p>
                  )}
                  <div className="mt-3 flex gap-2">
                    <Button asChild variant="destructive" size="sm">
                      <Link to="/admin/diagnostics">Go to Diagnostics</Link>
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => loadCompanies({ search: search.trim(), take })}
                      disabled={loading}
                    >
                      <RefreshCcw className="h-4 w-4 mr-2" />
                      Retry
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}

          <section className="rounded-lg border border-slate-200 dark:border-border bg-white dark:bg-card overflow-hidden">
            <DataTable
              columns={columns}
              data={filteredItems}
              conditionalRowStyles={[
                {
                  when: (row) => isDeletedCompany(row),
                  style: {
                    backgroundColor: isDark ? "hsl(187 12% 15%)" : "#f8fafc",
                    color: isDark ? "hsl(187 15% 55%)" : "#64748b",
                  },
                },
              ]}
              progressPending={loading && items.length === 0}
              progressComponent={progressComponent}
              pagination
              paginationPerPage={25}
              paginationRowsPerPageOptions={[10, 25, 50, 100]}
              highlightOnHover
              dense
              customStyles={tableTheme}
              selectableRows
              onSelectedRowsChange={(state) => setSelectedRows(state?.selectedRows || [])}
              clearSelectedRows={selectedRows.length === 0}
              contextActions={contextActions}
              noDataComponent={noDataComponent}
            />
          </section>

          <Dialog open={editorOpen} onOpenChange={handleEditorOpenChange}>
            <DialogContent className="w-[95vw] max-w-[1500px] h-[90vh] max-h-[90vh] p-0 bg-white dark:bg-card overflow-hidden flex flex-col gap-0">
              <ErrorBoundary
                resetKeys={[editorOriginalId, editorOpen]}
                fallback={({ error }) => (
                  <div className="bg-white dark:bg-card opacity-100 w-full h-full max-h-[90vh] overflow-auto">
                    <div className="p-6 space-y-4">
                      <div className="text-lg font-semibold text-slate-900 dark:text-foreground">Edit dialog crashed</div>
                      <div className="text-sm text-slate-700 dark:text-muted-foreground font-mono whitespace-pre-wrap break-words">
                        {asString(error?.message || error)}
                      </div>
                      <pre className="rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-3 text-xs text-slate-800 dark:text-foreground whitespace-pre-wrap break-words">
                        {prettyJson(error)}
                      </pre>
                      <Button type="button" onClick={closeEditor}>
                        Close
                      </Button>
                    </div>
                  </div>
                )}
              >
                <div className="flex h-full min-h-0 flex-col">
                  <DialogHeader className="flex-none px-6 py-4 border-b bg-white dark:bg-card">
                    <DialogTitle>{editorOriginalId ? "Edit Company" : "New company"}</DialogTitle>
                    <DialogDescription className="sr-only">
                      Edit company details. Use Refresh search to fetch proposed updates.
                    </DialogDescription>
                  </DialogHeader>

                  <div className="relative flex flex-1 min-h-0">
                    <div
                      data-testid="edit-scroll-area"
                      ref={setEditorScrollNode}
                      className="flex-1 min-h-0 overflow-auto no-scrollbar px-6 py-4 pr-16"
                    >
                  {editorLoadError ? (
                    <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">
                      {asString(editorLoadError)}
                    </div>
                  ) : null}

                  {editorLoading && !editorLoadError ? (
                    <div className="rounded-lg border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-4 text-sm text-slate-700 dark:text-muted-foreground">
                      Loading company…
                    </div>
                  ) : null}

                  {!editorDraft && !editorLoading && !editorLoadError ? (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                      Could not load company. Close and re-open.
                    </div>
                  ) : null}

                  {editorDraft ? (
                    <div className="space-y-5">
                      <div className="rounded-lg border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-4">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                          <div className="min-w-0">
                            <div className="text-xs font-medium text-slate-700 dark:text-muted-foreground">company_id</div>
                            <div className="mt-1 flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
                              <div className="flex flex-wrap items-center gap-2">
                                <code className="rounded bg-white dark:bg-card border border-slate-200 dark:border-border px-2 py-1 text-xs text-slate-900 dark:text-foreground">
                                  {editorOriginalId ? asString(editorDraft.company_id).trim() || "(missing)" : editorCompanyId || "(auto)"}
                                </code>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={async () => {
                                    const value = editorOriginalId
                                      ? asString(editorDraft.company_id).trim()
                                      : asString(editorCompanyId).trim();
                                    const ok = await copyToClipboard(value);
                                    if (ok) toast.success("Copied");
                                    else toast.error("Copy failed");
                                  }}
                                  disabled={
                                    !(editorOriginalId
                                      ? asString(editorDraft.company_id).trim()
                                      : asString(editorCompanyId).trim())
                                  }
                                  title="Copy company_id"
                                >
                                  <Copy className="h-4 w-4" />
                                </Button>
                              </div>

                              {editorOriginalId ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="flex-none"
                                  onClick={refreshCompany}
                                  disabled={refreshLoading || editorSaving}
                                  title="Refresh search"
                                >
                                  <RefreshCcw className="h-4 w-4 mr-2" />
                                  {refreshLoading ? "Refreshing…" : "Refresh search"}
                                </Button>
                              ) : null}

                              {editorOriginalId ? (
                                <div className="min-w-0 flex-1 max-w-[520px] leading-snug">
                                  <div className="text-xs text-muted-foreground">
                                    Click "Refresh search" to fetch proposed updates. Protected fields (logo, notes, manual stars) are never overwritten.
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          </div>

                          {!editorOriginalId ? (
                            <div className="min-w-[260px]">
                              <label className="text-xs font-medium text-slate-700 dark:text-muted-foreground">Override company_id (optional)</label>
                              <Input
                                value={asString(editorDraft.company_id)}
                                onChange={(e) => setEditorDraft((d) => ({ ...d, company_id: e.target.value }))}
                                placeholder={slugifyCompanyId(getCompanyName(editorDraft)) || "auto-generated"}
                                className="mt-1"
                              />
                            </div>
                          ) : null}
                        </div>
                      </div>

                      {/* ─── Refresh search status banner ─── */}
                      {editorOriginalId && refreshLoading && !proposedDraft && !refreshError ? (
                        <div className="rounded-lg border border-blue-300 bg-blue-50 p-4 flex items-center gap-4">
                          <div className="relative flex h-3 w-3">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-3 w-3 bg-blue-500"></span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-blue-900">Refreshing company data…</div>
                            <div className="text-xs text-blue-700 mt-0.5">Fetching proposed updates from xAI</div>
                          </div>
                        </div>
                      ) : null}

                      {editorOriginalId && !refreshLoading && lastRefreshMeta?.lastRefreshStatus ? (() => {
                        const isSuccess = lastRefreshMeta.lastRefreshStatus.kind === "success";
                        const isError = lastRefreshMeta.lastRefreshStatus.kind === "error";
                        const code = lastRefreshMeta.lastRefreshStatus.code;
                        const at = lastRefreshMeta.lastRefreshAt;
                        const hasDiffs = proposedDraft && Array.isArray(diffRows) && diffRows.length > 0;

                        if (isSuccess) {
                          return (
                            <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 flex items-center gap-4">
                              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500 text-white">
                                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                </svg>
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="text-sm font-medium text-emerald-900">
                                  Refresh complete{hasDiffs ? ` — ${diffRows.length} proposed change${diffRows.length !== 1 ? "s" : ""}` : " — no changes found"}
                                </div>
                                {at ? <div className="text-xs text-emerald-700 mt-0.5">{toDisplayDate(at)}</div> : null}
                              </div>
                            </div>
                          );
                        }

                        if (isError) {
                          return (
                            <div className="rounded-lg border border-red-300 bg-red-50 p-4 flex items-center gap-4">
                              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-red-500 text-white">
                                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="text-sm font-medium text-red-900">
                                  Refresh failed{code ? ` (${code})` : ""}
                                </div>
                                {at ? <div className="text-xs text-red-700 mt-0.5">{toDisplayDate(at)}</div> : null}
                              </div>
                            </div>
                          );
                        }

                        return null;
                      })() : null}

                      {editorOriginalId && (refreshLoading || refreshError || proposedDraft) ? (
                        <div className="rounded-lg border border-slate-200 dark:border-border bg-white dark:bg-card p-4 space-y-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="text-sm font-semibold text-slate-900 dark:text-foreground">Proposed refresh</div>
                            {proposedDraft ? (
                              <div className="flex flex-wrap items-center gap-2">
                                {diffRows.length > 0 ? (
                                  <>
                                    <Button type="button" size="sm" variant="outline" onClick={selectAllDiffs}>
                                      Select all
                                    </Button>
                                    <Button type="button" size="sm" variant="outline" onClick={clearAllDiffs}>
                                      Clear
                                    </Button>
                                    <Button
                                      type="button"
                                      size="sm"
                                      onClick={applySelectedDiffs}
                                      disabled={selectedDiffCount === 0}
                                    >
                                      Apply selected ({selectedDiffCount})
                                    </Button>
                                  </>
                                ) : null}

                                <Button type="button" size="sm" variant="outline" onClick={applyAllProposedToDraft}>
                                  Apply proposed → editable draft
                                </Button>

                                <Button type="button" size="sm" variant="outline" onClick={copyAllProposedAsJson} title="Copy all proposed as JSON">
                                  <Copy className="h-4 w-4 mr-2" />
                                  Copy all JSON
                                </Button>
                              </div>
                            ) : null}
                          </div>

                          {refreshTaglineMeta ? (
                            <div className="rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-3 text-xs text-slate-700 dark:text-muted-foreground space-y-2">
                              <div className="font-semibold text-slate-900 dark:text-foreground">Tagline verification (xAI)</div>
                              {asString(refreshTaglineMeta?.error).trim() ? (
                                <div className="text-red-800">Error: {asString(refreshTaglineMeta.error).trim()}</div>
                              ) : (
                                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                                  <div>
                                    <div className="font-medium text-slate-800 dark:text-foreground">Confirmed company name</div>
                                    <div className="mt-0.5 break-words text-slate-900 dark:text-foreground">
                                      {asString(refreshTaglineMeta?.confirmed_company_name).trim() || "—"}
                                    </div>
                                    {asString(refreshTaglineMeta?.confirm_reason).trim() ? (
                                      <div className="mt-1 text-slate-600 dark:text-muted-foreground">{asString(refreshTaglineMeta.confirm_reason).trim()}</div>
                                    ) : null}
                                  </div>
                                  <div>
                                    <div className="font-medium text-slate-800 dark:text-foreground">Confidence</div>
                                    <div className="mt-0.5 text-slate-900 dark:text-foreground">
                                      Name: {formatConfidencePct(refreshTaglineMeta?.confirm_confidence)}
                                      <span className="mx-2 text-slate-400 dark:text-muted-foreground">•</span>
                                      Tagline: {formatConfidencePct(refreshTaglineMeta?.tagline_confidence)}
                                    </div>
                                    {asString(refreshTaglineMeta?.tagline_reason).trim() ? (
                                      <div className="mt-1 text-slate-600 dark:text-muted-foreground">{asString(refreshTaglineMeta.tagline_reason).trim()}</div>
                                    ) : null}
                                  </div>
                                </div>
                              )}
                            </div>
                          ) : null}

                          {refreshError ? (
                            <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-900 space-y-3">
                              {(() => {
                                const debug = refreshError?.debug ?? refreshError?.response ?? null;

                                const debugObj = debug && typeof debug === "object" ? debug : null;
                                const debugText = typeof debug === "string" ? debug : "";

                                const status = normalizeHttpStatusNumber(refreshError?.status) ?? normalizeHttpStatusNumber(debugObj?.status) ?? null;

                                const message =
                                  asString(debugObj?.message).trim() ||
                                  asString(debugObj?.error).trim() ||
                                  asString(refreshError?.message).trim() ||
                                  (debugText.trim() ? debugText.trim() : "Refresh failed");

                                const url = asString(debugObj?.url).trim() || asString(refreshError?.url).trim();

                                const attemptsList = Array.isArray(debugObj?.attempts)
                                  ? debugObj.attempts
                                  : Array.isArray(refreshError?.attempts)
                                    ? refreshError.attempts
                                    : [];

                                const attemptsCount = attemptsList.length;

                                const rawDebugText = debugObj ? prettyJson(debugObj) : asString(debugText);

                                return (
                                  <div className="space-y-3">
                                    <div className="flex flex-wrap items-start justify-between gap-2">
                                      <div className="min-w-0 flex-1">
                                        <div className="font-semibold">Refresh failed</div>

                                        <div className="mt-1 text-xs text-red-900/90 space-y-0.5">
                                          <div>HTTP status: {status != null ? status : "—"}</div>
                                          {url ? <div className="break-words">URL: {url}</div> : null}
                                          {attemptsCount ? <div>Attempts: {attemptsCount}</div> : null}
                                        </div>

                                        <div className="mt-2 whitespace-pre-wrap break-words">{message}</div>

                                        {attemptsCount ? (
                                          <div className="mt-2 text-xs text-red-900/80 whitespace-pre-wrap break-words">
                                            Tried: {attemptsList.map((a) => `${a.path} → ${a.status}`).join(", ")}
                                            {refreshError?.build_id ? ` • build ${asString(refreshError.build_id)}` : ""}
                                          </div>
                                        ) : refreshError?.build_id ? (
                                          <div className="mt-2 text-xs text-red-900/80">Build: {asString(refreshError.build_id)}</div>
                                        ) : null}
                                      </div>

                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        className="bg-white dark:bg-card"
                                        onClick={async () => {
                                          const bundle =
                                            refreshError?.debug_bundle && typeof refreshError.debug_bundle === "object"
                                              ? refreshError.debug_bundle
                                              : debugObj
                                                ? debugObj
                                                : {
                                                    kind: "refresh_company",
                                                    message: asString(debugText).trim() || "Refresh failed",
                                                  };

                                          const payload = prettyJson(bundle);
                                          const ok = await copyToClipboard(payload);
                                          if (ok) toast.success("Copied debug");
                                          else toast.error("Copy failed");
                                        }}
                                        title="Copy debug"
                                      >
                                        <Copy className="h-4 w-4 mr-2" />
                                        Copy debug
                                      </Button>
                                    </div>

                                    <details>
                                      <summary className="cursor-pointer select-none text-xs font-semibold text-red-900/90">Raw debug</summary>
                                      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-red-200 bg-white dark:bg-card p-2 text-[11px] text-red-900">
                                        {rawDebugText}
                                      </pre>
                                    </details>
                                  </div>
                                );
                              })()}
                            </div>
                          ) : null}

                          {refreshLoading && !proposedDraft && !refreshError ? (
                            <div className="rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-3 text-sm text-slate-700 dark:text-muted-foreground">
                              Fetching proposed updates…
                            </div>
                          ) : proposedDraft ? (
                            diffRows.length > 0 ? (
                              <div className="space-y-3">
                                {diffRows.map((row) => {
                                  const textValue = Object.prototype.hasOwnProperty.call(proposedDraftText || {}, row.key)
                                    ? proposedDraftText[row.key]
                                    : proposedValueToInputText(row.key, proposedDraft?.[row.key]);

                                  const isMultiLine = [
                                    "industries",
                                    "keywords",
                                    "headquarters_locations",
                                    "manufacturing_locations",
                                    "location_sources",
                                    "red_flag_reason",
                                    "curated_reviews",
                                  ].includes(row.key);

                                  return (
                                    <div key={row.key} className="rounded-lg border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-3">
                                      <div className="flex items-start gap-3">
                                        <Checkbox
                                          checked={Boolean(refreshSelection[row.key])}
                                          onCheckedChange={(checked) =>
                                            setRefreshSelection((prev) => ({
                                              ...(prev || {}),
                                              [row.key]: Boolean(checked),
                                            }))
                                          }
                                          aria-label={`Overwrite ${row.label}`}
                                        />
                                        <div className="flex-1 min-w-0">
                                          <div className="text-sm font-medium text-slate-900 dark:text-foreground">{row.label}</div>
                                          <div className="mt-2 grid grid-cols-1 lg:grid-cols-2 gap-3">
                                            <div className="rounded border border-slate-200 dark:border-border bg-white dark:bg-card p-2">
                                              <div className="text-xs font-semibold text-slate-700 dark:text-muted-foreground">Current</div>
                                              <pre className="mt-1 whitespace-pre-wrap break-words text-xs text-slate-800 dark:text-foreground">{row.currentText}</pre>
                                            </div>
                                            <div className="rounded border border-slate-200 dark:border-border bg-white dark:bg-card p-2">
                                              <div className="text-xs font-semibold text-slate-700 dark:text-muted-foreground">Proposed (editable)</div>
                                              <div className="mt-1 flex items-start gap-2">
                                                {isMultiLine ? (
                                                  <Textarea
                                                    value={textValue}
                                                    onChange={(e) => {
                                                      const nextText = e.target.value;
                                                      setProposedDraftText((prev) => ({ ...(prev || {}), [row.key]: nextText }));
                                                      setProposedDraft((prev) => {
                                                        const base = prev && typeof prev === "object" ? prev : {};
                                                        return {
                                                          ...base,
                                                          [row.key]: parseProposedInputText(row.key, nextText, base[row.key]),
                                                        };
                                                      });
                                                    }}
                                                    className="text-xs min-h-[84px] leading-snug"
                                                    rows={4}
                                                  />
                                                ) : (
                                                  <Input
                                                    type="text"
                                                    value={textValue}
                                                    onChange={(e) => {
                                                      const nextText = e.target.value;
                                                      setProposedDraftText((prev) => ({ ...(prev || {}), [row.key]: nextText }));
                                                      setProposedDraft((prev) => {
                                                        const base = prev && typeof prev === "object" ? prev : {};
                                                        return {
                                                          ...base,
                                                          [row.key]: parseProposedInputText(row.key, nextText, base[row.key]),
                                                        };
                                                      });
                                                    }}
                                                    className="h-9 text-xs"
                                                  />
                                                )}

                                                <Button
                                                  type="button"
                                                  size="sm"
                                                  variant="outline"
                                                  className="h-9 w-9 p-0 flex-none"
                                                  onClick={async () => {
                                                    const ok = await copyToClipboard(textValue);
                                                    if (ok) toast.success("Copied");
                                                    else toast.error("Copy failed");
                                                  }}
                                                  disabled={!asString(textValue).trim()}
                                                  title="Copy proposed"
                                                >
                                                  <Copy className="h-4 w-4" />
                                                </Button>
                                              </div>
                                            </div>
                                          </div>
                                        </div>
                                      </div>
                                    </div>
                                  );
                                })}

                                <div className="text-xs text-slate-600 dark:text-muted-foreground">
                                  Selected rows will be written on Save. Protected fields are never overwritten: logo, structured notes, and manual stars.
                                </div>

                                {/* Raw Grok response viewer */}
                                {refreshProposed?.last_enrichment_raw_response ? (
                                  <details className="rounded-lg border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted">
                                    <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-slate-700 dark:text-muted-foreground hover:bg-slate-100 dark:bg-muted">
                                      Raw Grok response
                                      {refreshProposed?.enrichment_method ? (
                                        <span className="ml-2 rounded-full bg-slate-200 dark:bg-muted px-2 py-0.5 text-[10px] text-slate-600 dark:text-muted-foreground">
                                          {refreshProposed.enrichment_method}
                                        </span>
                                      ) : null}
                                      {refreshProposed?.last_enrichment_at ? (
                                        <span className="ml-2 text-[10px] text-slate-500 dark:text-muted-foreground">
                                          {new Date(refreshProposed.last_enrichment_at).toLocaleTimeString()}
                                        </span>
                                      ) : null}
                                    </summary>
                                    <div className="border-t border-slate-200 dark:border-border p-3">
                                      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border border-slate-200 dark:border-border bg-white dark:bg-card p-3 text-[11px] text-slate-800 dark:text-foreground leading-relaxed">
                                        {typeof refreshProposed.last_enrichment_raw_response === "string"
                                          ? refreshProposed.last_enrichment_raw_response
                                          : JSON.stringify(refreshProposed.last_enrichment_raw_response, null, 2)}
                                      </pre>
                                      <div className="mt-2 flex gap-2">
                                        <Button
                                          type="button"
                                          size="sm"
                                          variant="outline"
                                          onClick={async () => {
                                            const text = typeof refreshProposed.last_enrichment_raw_response === "string"
                                              ? refreshProposed.last_enrichment_raw_response
                                              : JSON.stringify(refreshProposed.last_enrichment_raw_response, null, 2);
                                            const ok = await copyToClipboard(text);
                                            if (ok) toast.success("Raw response copied");
                                            else toast.error("Copy failed");
                                          }}
                                        >
                                          <Copy className="h-3 w-3 mr-1" />
                                          Copy raw response
                                        </Button>
                                      </div>
                                    </div>
                                  </details>
                                ) : null}
                              </div>
                            ) : (
                              <div className="rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-3 text-sm text-slate-700 dark:text-muted-foreground">
                                No differences found.
                              </div>
                            )
                          ) : null}
                        </div>
                      ) : null}

                      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,460px)]">
                        <div className="space-y-5">
                          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                            <div className="space-y-1 md:col-span-2">
                              <div className="flex items-center justify-between gap-2">
                                <label className="text-sm text-slate-700 dark:text-muted-foreground">
                                  Company name <span className="text-red-600">*</span>
                                </label>
                                {asString(editorDisplayNameOverride).trim() ? (
                                  <span className="rounded-full bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-[11px] text-emerald-900">
                                    Using display name
                                  </span>
                                ) : null}
                              </div>
                              <Input
                                required
                                value={asString(editorDraft.company_name)}
                                onChange={(e) => {
                                  const next = e.target.value;
                                  setEditorDraft((d) => {
                                    const base = d && typeof d === "object" ? d : {};
                                    const override = asString(editorDisplayNameOverride).trim();
                                    const out = { ...base, company_name: next };
                                    if (!override) out.name = next;
                                    return out;
                                  });
                                }}
                                placeholder="Acme Corp"
                              />
                            </div>

                            <div className="space-y-2 md:col-span-2">
                              <button
                                type="button"
                                className="flex w-full items-center justify-between rounded-md border border-slate-200 dark:border-border bg-white dark:bg-card px-3 py-2 text-sm text-slate-800 dark:text-foreground hover:bg-slate-50 dark:bg-muted dark:hover:bg-accent"
                                onClick={() => setEditorShowAdvanced((v) => !v)}
                                aria-expanded={editorShowAdvanced}
                              >
                                <span className="font-medium">Display options</span>
                                <ChevronDown className={editorShowAdvanced ? "h-4 w-4 rotate-180 transition-transform" : "h-4 w-4 transition-transform"} />
                              </button>

                              {editorShowAdvanced ? (
                                <div className="rounded-lg border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-3 space-y-2">
                                  <div className="space-y-1">
                                    <label className="text-sm text-slate-700 dark:text-muted-foreground">Display name (optional)</label>
                                    <Input
                                      value={editorDisplayNameOverride}
                                      onChange={(e) => {
                                        const next = e.target.value;
                                        setEditorDisplayNameOverride(next);
                                        setEditorDraft((d) => {
                                          const base = d && typeof d === "object" ? d : {};
                                          const companyName = asString(base.company_name).trim();
                                          return { ...base, name: asString(next).trim() ? next : companyName };
                                        });
                                      }}
                                      placeholder={asString(editorDraft.company_name) || ""}
                                    />
                                  </div>
                                  <div className="text-xs text-slate-600 dark:text-muted-foreground">
                                    If set, this is what users see. If empty, we show Company name.
                                  </div>
                                </div>
                              ) : null}
                            </div>

                            <div className="space-y-1 md:col-span-2">
                              <label className="text-sm text-slate-700 dark:text-muted-foreground">Website URL</label>
                              <Input
                                value={asString(editorDraft.website_url)}
                                onChange={(e) => setEditorDraft((d) => ({ ...d, website_url: e.target.value }))}
                                placeholder="https://example.com"
                              />
                            </div>

                            <div className="space-y-1 md:col-span-2">
                              <label className="text-sm text-slate-700 dark:text-muted-foreground">Tagline</label>
                              <Input
                                value={asString(editorDraft.tagline)}
                                onChange={(e) => setEditorDraft((d) => ({ ...d, tagline: e.target.value }))}
                                placeholder="Mission statement…"
                              />
                            </div>

                            <div className="space-y-1">
                              <label className="text-sm text-slate-700 dark:text-muted-foreground">Amazon URL</label>
                              <Input
                                value={asString(editorDraft.amazon_url)}
                                onChange={(e) => setEditorDraft((d) => ({ ...d, amazon_url: e.target.value }))}
                              />
                              <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-muted-foreground mt-2">
                                <Checkbox
                                  checked={Boolean(editorDraft.no_amazon_store)}
                                  onCheckedChange={(v) =>
                                    setEditorDraft((d) => ({
                                      ...(d || {}),
                                      no_amazon_store: Boolean(v),
                                    }))
                                  }
                                />
                                <span>No Amazon Store</span>
                              </label>
                            </div>

                          </div>

                          <div className="space-y-2">
                            <label className="text-sm text-slate-700 dark:text-muted-foreground">Logo</label>

                            {(() => {
                              const rawLogoUrl = asString(editorDraft?.logo_url).trim();
                              const status = asString(editorDraft?.logo_status).trim().toLowerCase();

                              if (!rawLogoUrl) {
                                return (
                                  <div className="text-xs text-slate-500 dark:text-muted-foreground">
                                    {status === "not_found_on_site"
                                      ? "No logo found on company website."
                                      : status === "not_found"
                                        ? "No logo found."
                                        : "No logo uploaded."}
                                  </div>
                                );
                              }

                              return (
                                <div className="flex items-center gap-3 rounded-lg border border-slate-200 dark:border-border bg-white dark:bg-card p-2">
                                  {!logoPreviewFailed ? (
                                    <img
                                      src={getCompanyLogoUrl({ ...editorDraft, id: editorOriginalId, logo_url: rawLogoUrl })}
                                      alt="Company logo"
                                      className="h-12 w-12 rounded border border-slate-200 dark:border-border object-contain bg-white dark:bg-card"
                                      loading="lazy"
                                      onError={() => setLogoPreviewFailed(true)}
                                    />
                                  ) : (
                                    <div className="h-12 w-12 rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted flex items-center justify-center text-[11px] text-slate-600 dark:text-muted-foreground text-center px-1">
                                      {status === "not_found_on_site" ? "No logo on site" : "No logo found"}
                                    </div>
                                  )}

                                  <div className="flex-1 min-w-0">
                                    <div className="text-xs text-slate-500 dark:text-muted-foreground">Current logo_url</div>
                                    <div className="text-xs text-slate-800 dark:text-foreground break-all">{rawLogoUrl}</div>
                                  </div>
                                </div>
                              );
                            })()}

                            <div className="flex flex-wrap items-center gap-2">
                              <input
                                type="file"
                                accept="image/png,image/jpeg,image/svg+xml"
                                onChange={handleLogoFileChange}
                                className="block w-full max-w-[360px] text-sm text-slate-700 dark:text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-slate-900/90"
                                disabled={logoUploading || logoDeleting}
                              />

                              <Button
                                variant="outline"
                                onClick={uploadLogo}
                                disabled={!editorOriginalId || !logoFile || logoUploading || Boolean(logoUploadError) || logoDeleting}
                              >
                                {logoUploading ? "Uploading…" : "Upload"}
                              </Button>

                              <Button
                                variant="outline"
                                onClick={clearLogoReference}
                                disabled={logoUploading || logoDeleting || !asString(editorDraft.logo_url).trim()}
                              >
                                Clear
                              </Button>

                              <Button
                                variant="outline"
                                className="border-red-600 text-red-600 hover:bg-red-600 hover:text-white"
                                onClick={deleteLogoFromStorage}
                                disabled={
                                  logoUploading ||
                                  logoDeleting ||
                                  !editorOriginalId ||
                                  !asString(editorDraft.logo_url).trim() ||
                                  !(asString(editorDraft.logo_url).includes(".blob.core.windows.net") &&
                                    asString(editorDraft.logo_url).includes("/company-logos/"))
                                }
                              >
                                {logoDeleting ? "Deleting…" : "Delete from storage"}
                              </Button>
                            </div>

                            {logoFile ? (
                              <div className="text-xs text-slate-600 dark:text-muted-foreground">
                                Selected: {logoFile.name} ({Math.round((logoFile.size / 1024) * 10) / 10}KB)
                              </div>
                            ) : null}

                            {logoUploadError ? <div className="text-xs text-red-700">{logoUploadError}</div> : null}

                            {!editorOriginalId ? (
                              <div className="text-xs text-slate-600 dark:text-muted-foreground">Save the company first to enable uploads.</div>
                            ) : null}
                          </div>

                          <StringListEditor
                            label="Affiliate link URLs"
                            value={editorDraft.affiliate_link_urls}
                            onChange={(next) => setEditorDraft((d) => ({ ...(d || {}), affiliate_link_urls: next }))}
                          />

                          <LocationSourcesEditor
                            value={editorDraft.location_sources}
                            onChange={(next) => setEditorDraft((d) => ({ ...(d || {}), location_sources: next }))}
                          />

                          <StructuredLocationListEditor
                            label="HQ locations"
                            value={editorDraft.headquarters_locations}
                            onChange={(next) => setEditorDraft((d) => ({ ...(d || {}), headquarters_locations: next }))}
                            LocationStatusBadge={LocationStatusBadge}
                          />

                          <StructuredLocationListEditor
                            label="Manufacturing locations"
                            value={editorDraft.manufacturing_locations}
                            onChange={(next) => setEditorDraft((d) => ({ ...(d || {}), manufacturing_locations: next }))}
                            LocationStatusBadge={LocationStatusBadge}
                          />

                          <StringListEditor
                            label="Industries"
                            value={editorDraft.industries}
                            onChange={(next) => setEditorDraft((d) => ({ ...(d || {}), industries: next }))}
                            placeholder="Add an industry…"
                          />

                          <StringListEditor
                            label="Keywords"
                            value={editorDraft.keywords}
                            onChange={(next) => setEditorDraft((d) => ({ ...(d || {}), keywords: next }))}
                            placeholder="Add a keyword…"
                          />

                          <CuratedReviewsEditor
                            value={Array.isArray(editorDraft.curated_reviews) ? editorDraft.curated_reviews : []}
                            onChange={(next) => setEditorDraft((d) => ({ ...(d || {}), curated_reviews: next }))}
                            disabled={editorSaving}
                          />

                        </div>

                        <div className="space-y-5">
                          <div className="space-y-3 rounded-lg border border-slate-200 dark:border-border bg-white dark:bg-card p-4">
                            <div className="text-sm font-semibold text-slate-900 dark:text-foreground">Visibility</div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              <label className="flex items-start gap-2 text-sm text-slate-800 dark:text-foreground">
                                <Checkbox
                                  checked={Boolean(editorDraft.show_location_sources_to_users)}
                                  onCheckedChange={(v) =>
                                    setEditorDraft((d) => ({
                                      ...(d || {}),
                                      show_location_sources_to_users: Boolean(v),
                                    }))
                                  }
                                />
                                <span>Show location sources to users</span>
                              </label>

                              <label className="flex items-start gap-2 text-sm text-slate-800 dark:text-foreground">
                                <Checkbox
                                  checked={Boolean(editorDraft.visibility?.hq_public)}
                                  onCheckedChange={(v) =>
                                    setEditorDraft((d) => ({
                                      ...(d || {}),
                                      visibility: { ...normalizeVisibility(d?.visibility), hq_public: Boolean(v) },
                                    }))
                                  }
                                />
                                <span>Show HQ location</span>
                              </label>

                              <label className="flex items-start gap-2 text-sm text-slate-800 dark:text-foreground">
                                <Checkbox
                                  checked={Boolean(editorDraft.visibility?.manufacturing_public)}
                                  onCheckedChange={(v) =>
                                    setEditorDraft((d) => ({
                                      ...(d || {}),
                                      visibility: {
                                        ...normalizeVisibility(d?.visibility),
                                        manufacturing_public: Boolean(v),
                                      },
                                    }))
                                  }
                                />
                                <span>Show manufacturing locations</span>
                              </label>

                              <label className="flex items-start gap-2 text-sm text-slate-800 dark:text-foreground">
                                <Checkbox
                                  checked={Boolean(editorDraft.visibility?.admin_rating_public)}
                                  onCheckedChange={(v) =>
                                    setEditorDraft((d) => ({
                                      ...(d || {}),
                                      visibility: {
                                        ...normalizeVisibility(d?.visibility),
                                        admin_rating_public: Boolean(v),
                                      },
                                    }))
                                  }
                                />
                                <span>Show QQ rating</span>
                              </label>
                            </div>
                          </div>

                          <RatingEditor draft={editorDraft} onChange={(next) => setEditorDraft(next)} StarNotesEditor={StarNotesEditor} />

                          <ReviewsImportPanel
                            ref={reviewsImportRef}
                            companyId={
                              asString(editorDraft.company_id).trim() ||
                              asString(editorOriginalId).trim() ||
                              asString(editorCompanyId).trim()
                            }
                            existingCuratedReviews={Array.isArray(editorDraft.curated_reviews) ? editorDraft.curated_reviews : []}
                            disabled={editorSaving}
                            onApply={applySelectedProposedReviews}
                          />

                          <ImportedReviewsPanel
                            companyId={
                              asString(editorDraft.company_id).trim() ||
                              asString(editorOriginalId).trim() ||
                              asString(editorCompanyId).trim()
                            }
                            companyName={asString(editorDraft.company_name).trim()}
                            existingCuratedReviews={Array.isArray(editorDraft.curated_reviews) ? editorDraft.curated_reviews : []}
                            disabled={editorSaving}
                            onDeleteSavedReview={deleteCuratedReviewFromDraft}
                            onUpdateSavedReview={(reviewId, patch) => updateCuratedReviewInDraft(reviewId, patch)}
                          />

                          <CompanyNotesEditor
                            value={editorDraft.notes_entries}
                            onChange={(next) => setEditorDraft((d) => ({ ...(d || {}), notes_entries: next }))}
                            TextWithLinks={TextWithLinks}
                          />

                          <div className="space-y-2">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <label className="text-sm text-slate-700 dark:text-muted-foreground">Paste reviews (Grok / manual)</label>
                              <div className="flex flex-wrap items-center gap-2">
                                <div className="flex items-center gap-2 text-xs text-slate-700 dark:text-muted-foreground">
                                  <span className="font-medium">Notes → Reviews</span>
                                  <select
                                    value={notesToReviewsMode}
                                    onChange={(e) => setNotesToReviewsMode(e.target.value)}
                                    className="h-8 rounded-md border border-slate-200 dark:border-border bg-white dark:bg-card px-2 text-xs"
                                    disabled={notesToReviewsLoading}
                                    aria-label="Apply mode"
                                  >
                                    <option value="append">Append</option>
                                    <option value="replace">Replace</option>
                                  </select>
                                  <label className="flex items-center gap-2">
                                    <Checkbox
                                      checked={notesToReviewsDryRun}
                                      onCheckedChange={(v) => setNotesToReviewsDryRun(Boolean(v))}
                                      disabled={notesToReviewsLoading}
                                    />
                                    <span>Dry run</span>
                                  </label>
                                </div>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={applyReviewsFromNotes}
                                  disabled={
                                    notesToReviewsLoading ||
                                    !(asString(editorDraft?.company_id).trim() || asString(editorOriginalId).trim()) ||
                                    !asString(editorDraft?.notes).trim()
                                  }
                                  title="Parse reviews out of the Notes field and save into curated_reviews"
                                >
                                  {notesToReviewsLoading ? "Applying…" : "Apply reviews from Notes"}
                                </Button>
                              </div>
                            </div>

                            <textarea
                              value={asString(editorDraft.notes)}
                              onChange={(e) => setEditorDraft((d) => ({ ...d, notes: e.target.value }))}
                              className="min-h-[200px] w-full rounded-md border border-slate-200 dark:border-border bg-white dark:bg-card px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                              placeholder={"Paste Grok review output here\u2026\n\nSource: YouTube\nAuthor: Channel Name\nURL: https://example.com/video\nTitle: Review Title\nDate: Jan 1, 2025\nText: Excerpt or summary of the review\u2026"}
                            />

                            {notesToReviewsPreviewMeta ? (
                              <div className="rounded-lg border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted p-3 space-y-2">
                                <div className="flex flex-wrap items-start justify-between gap-2">
                                  <div className="text-xs text-slate-700 dark:text-muted-foreground">
                                    <div className="font-medium">Dry run preview</div>
                                    <div className="mt-1">
                                      Parsed: <span className="font-medium">{notesToReviewsPreviewMeta.parsedCount}</span>
                                      <span className="mx-1">•</span>
                                      Would save: <span className="font-medium">{notesToReviewsPreviewMeta.savedCount}</span>
                                      <span className="mx-1">•</span>
                                      Result total: <span className="font-medium">{notesToReviewsPreviewMeta.total}</span>
                                      <span className="mx-1">•</span>
                                      Mode: <span className="font-medium">{notesToReviewsPreviewMeta.mode}</span>
                                    </div>
                                    {Array.isArray(notesToReviewsPreviewMeta.warnings) && notesToReviewsPreviewMeta.warnings.length ? (
                                      <div className="mt-1 text-[11px] text-slate-500 dark:text-muted-foreground">
                                        Warnings: {notesToReviewsPreviewMeta.warnings.join(", ")}
                                      </div>
                                    ) : null}
                                  </div>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={() => {
                                      setNotesToReviewsPreview([]);
                                      setNotesToReviewsPreviewMeta(null);
                                    }}
                                  >
                                    Clear preview
                                  </Button>
                                </div>

                                {Array.isArray(notesToReviewsPreview) && notesToReviewsPreview.length ? (
                                  <div className="space-y-2">
                                    {notesToReviewsPreview.map((r, idx) => (
                                      <div key={asString(r?.id).trim() || `preview-${idx}`} className="rounded border border-slate-200 dark:border-border bg-white dark:bg-card p-2">
                                        <div className="text-xs text-slate-800 dark:text-foreground">
                                          <span className="font-medium">{asString(r?.title).trim() || "(no title)"}</span>
                                          {asString(r?.source_name).trim() ? <span className="text-slate-500 dark:text-muted-foreground"> · {asString(r?.source_name).trim()}</span> : null}
                                          {asString(r?.author).trim() ? <span className="text-slate-500 dark:text-muted-foreground"> · {asString(r?.author).trim()}</span> : null}
                                          {asString(r?.date).trim() ? <span className="text-slate-500 dark:text-muted-foreground"> · {asString(r?.date).trim()}</span> : null}
                                          {r?.rating != null ? <span className="text-slate-500 dark:text-muted-foreground"> · {String(r.rating)}/5</span> : null}
                                        </div>
                                        <div className="mt-1 whitespace-pre-wrap text-[11px] text-slate-700 dark:text-muted-foreground">{asString(r?.text).trim()}</div>
                                        {asString(r?.url).trim() ? (
                                          <div className="mt-1 text-[11px] text-slate-500 dark:text-muted-foreground">URL: {asString(r?.url).trim()}</div>
                                        ) : null}
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <div className="text-xs text-slate-600 dark:text-muted-foreground">No preview items returned.</div>
                                )}
                              </div>
                            ) : null}
                          </div>

                          {editorOriginalId ? <AdminEditHistory companyId={editorOriginalId} /> : null}
                        </div>
                      </div>

                      {editorValidationError ? (
                        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                          {editorValidationError}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  </div>

                  <div className="absolute right-2 top-2 bottom-2">
                    <ScrollScrubber position="relative" scrollEl={editorScrollEl} scrollRef={editorScrollRef} />
                  </div>
                </div>

                <DialogFooter className="flex-none px-6 py-4 border-t">
                  {editorOriginalId ? (
                    <Button
                      variant="outline"
                      className="border-red-600 text-red-600 hover:bg-red-600 hover:text-white mr-auto"
                      onClick={() =>
                        openDeleteConfirm({
                          kind: "single",
                          company_id: editorOriginalId,
                          company_name: getCompanyName(editorDraft),
                        })
                      }
                      disabled={editorSaving}
                    >
                      <Trash2 className="h-4 w-4 mr-2" />
                      Delete
                    </Button>
                  ) : (
                    <span className="mr-auto" />
                  )}
                  <Button variant="outline" onClick={closeEditor}>
                    Cancel
                  </Button>
                  <Button onClick={saveEditor} disabled={editorSaving || Boolean(editorValidationError)}>
                    <Save className="h-4 w-4 mr-2" />
                    {editorSaving ? "Saving…" : editorOriginalId ? "Save changes" : "Create"}
                  </Button>
                </DialogFooter>
                </div>
              </ErrorBoundary>
            </DialogContent>
          </Dialog>

          <AlertDialog open={deleteConfirmOpen} onOpenChange={(open) => !deleteConfirmLoading && setDeleteConfirmOpen(open)}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Confirm delete</AlertDialogTitle>
                <AlertDialogDescription>
                  This action is irreversible. The company will be removed from the admin list immediately.
                </AlertDialogDescription>
              </AlertDialogHeader>

              <div className="space-y-2">
                {deleteConfirm?.kind === "bulk" ? (
                  <div className="text-sm text-slate-700 dark:text-muted-foreground">Delete {asString(deleteConfirm.label)}?</div>
                ) : (
                  <div className="text-sm text-slate-700 dark:text-muted-foreground">
                    Delete <span className="font-semibold">{asString(deleteConfirm?.company_name) || "this company"}</span> (
                    <code className="text-xs">{asString(deleteConfirm?.company_id)}</code>)?
                  </div>
                )}

                {deleteConfirmError ? (
                  <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-900">
                    <div className="font-medium">Delete failed</div>
                    <div>{asString(deleteConfirmError.message)}</div>
                    {deleteConfirmError.detail ? (
                      <div className="mt-1 whitespace-pre-wrap break-words font-mono text-red-800">
                        {asString(deleteConfirmError.detail)}
                      </div>
                    ) : null}
                    {deleteConfirmError.body && typeof deleteConfirmError.body === "object" ? (
                      <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-red-800">
                        {prettyJson(deleteConfirmError.body)}
                      </pre>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <AlertDialogFooter>
                <AlertDialogCancel disabled={deleteConfirmLoading}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-red-600 hover:bg-red-600/90"
                  onClick={(e) => {
                    e.preventDefault();
                    confirmDelete();
                  }}
                  disabled={deleteConfirmLoading}
                >
                  {deleteConfirmLoading ? "Deleting…" : "Delete"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </main>
      </div>
    </>
  );
}
