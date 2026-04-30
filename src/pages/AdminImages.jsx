import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Helmet } from "react-helmet-async";
import { useTheme } from "next-themes";
import DataTable from "react-data-table-component";
import { Check, Copy, ImageOff, Pencil, Search, Sparkles, Trash2, Upload, X } from "lucide-react";

import AdminHeader from "@/components/AdminHeader";
import TallyCounter from "@/components/TallyCounter";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { apiFetch, getUserFacingConfigMessage, readJsonOrText } from "@/lib/api";
import { getAdminUser } from "@/lib/azureAuth";
import { getCompanyLogoUrl } from "@/lib/logoUrl";
import { getCompanyHomepageUrl } from "@/lib/homepageUrl";
import {
  uploadLogoBlobFile,
  uploadHomepageBlobFile,
} from "@/lib/blobStorage";
import {
  getCompanyId,
  getCompanyName,
  getCompanyUrl,
  toFullDate,
  toShortDate,
} from "@/pages/company-dashboard/dashboardUtils";
import {
  getProfileCompleteness,
  getProfileCompletenessLabel,
} from "@/lib/profileCompleteness";
import { toast } from "@/lib/toast";

function asString(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

// Renders a hover preview at fixed coordinates via a portal so it can escape
// the table's overflow clipping and the column borders.
function HoverPreviewPortal({ src, anchorRect, alt }) {
  if (!src || !anchorRect) return null;

  const PREVIEW_WIDTH = 480;
  const MARGIN = 12;
  const viewportW = typeof window !== "undefined" ? window.innerWidth : 1200;

  // Prefer right of anchor; fall back to left if off-screen.
  let left = anchorRect.right + MARGIN;
  if (left + PREVIEW_WIDTH > viewportW - 8) {
    left = Math.max(8, anchorRect.left - PREVIEW_WIDTH - MARGIN);
  }

  // Center vertically against anchor; clamp to viewport.
  const anchorCenterY = anchorRect.top + anchorRect.height / 2;
  const top = Math.max(8, anchorCenterY);

  return createPortal(
    <img
      src={src}
      alt={alt}
      aria-hidden="true"
      className="fixed pointer-events-none rounded-md border border-slate-300 dark:border-slate-700 shadow-2xl bg-white"
      style={{
        left,
        top,
        width: PREVIEW_WIDTH,
        maxWidth: "40vw",
        transform: "translateY(-50%)",
        zIndex: 9999,
      }}
      loading="lazy"
    />,
    document.body
  );
}

function ImageCell({
  src,
  alt,
  approved,
  onApproveChange,
  onUpload,
  uploading,
  fetching,
  saving,
  emptyLabel,
  aspectClass,
  thumbClass,
}) {
  const fileRef = useRef(null);
  const buttonRef = useRef(null);
  const [hoverRect, setHoverRect] = useState(null);
  const [recentlyUploaded, setRecentlyUploaded] = useState(false);
  // Elapsed seconds visible inside the "Fetching…" overlay so the admin
  // sees the call is still alive (Microlink screenshots can take 30-60s).
  const [fetchElapsed, setFetchElapsed] = useState(0);
  useEffect(() => {
    if (!fetching) { setFetchElapsed(0); return; }
    const startedAt = Date.now();
    const t = window.setInterval(() => {
      setFetchElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 250);
    return () => window.clearInterval(t);
  }, [fetching]);

  const handlePick = (e) => {
    e.stopPropagation();
    if (uploading || fetching || saving) return;
    fileRef.current?.click();
  };

  const handleFileChange = async (e) => {
    const file = e?.target?.files?.[0];
    if (file) {
      await onUpload(file);
      setRecentlyUploaded(true);
      // Visual affirmation: green check overlay fades out after 2.5s
      window.setTimeout(() => setRecentlyUploaded(false), 2500);
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  const handleMouseEnter = () => {
    if (!src) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setHoverRect(rect);
  };

  const handleMouseLeave = () => {
    setHoverRect(null);
  };

  return (
    <div className="flex flex-col items-center gap-1 py-1">
      <button
        ref={buttonRef}
        type="button"
        onClick={handlePick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        disabled={uploading || fetching}
        title={src ? "Click to replace" : "Click to upload"}
        className={`relative ${aspectClass} bg-white dark:bg-slate-100 rounded border border-slate-300 dark:border-slate-600 overflow-hidden flex items-center justify-center hover:ring-2 hover:ring-teal-500 transition`}
      >
        {src ? (
          <img
            key={src}
            src={src}
            alt={alt}
            className={`${thumbClass} object-contain`}
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className="flex flex-col items-center gap-0.5 text-slate-500 px-1 text-[10px] text-center">
            <Upload className="w-4 h-4" />
            <span>{emptyLabel}</span>
          </div>
        )}
        {uploading ? (
          <div className="absolute inset-0 bg-black/55 flex items-center justify-center text-white text-[10px]">
            Uploading…
          </div>
        ) : null}
        {fetching && !uploading ? (
          <div className="absolute inset-0 bg-black/55 flex flex-col items-center justify-center text-white text-[10px] gap-0.5">
            <span>Fetching…</span>
            <span className="tabular-nums opacity-80">{fetchElapsed}s</span>
          </div>
        ) : null}
        {recentlyUploaded && !uploading ? (
          <div className="absolute inset-0 bg-emerald-500/80 flex items-center justify-center text-white pointer-events-none">
            <Check className="w-6 h-6" />
          </div>
        ) : null}
      </button>

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={handleFileChange}
        className="hidden"
        disabled={uploading}
      />

      <label className="flex items-center gap-1.5 text-[11px] text-slate-700 dark:text-slate-200 select-none">
        <Checkbox
          checked={!!approved}
          onCheckedChange={(v) => onApproveChange(Boolean(v))}
          disabled={!src || saving}
        />
        Approve
      </label>

      <HoverPreviewPortal src={src} anchorRect={hoverRect} alt={alt} />
    </div>
  );
}

export default function AdminImages() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  const [companies, setCompanies] = useState([]);
  const [totalCount, setTotalCount] = useState(null);
  const [approvedCount, setApprovedCount] = useState(null);
  // filteredTotalCount reflects the active search + filter, used by the
  // paginator. totalCount and approvedCount stay unconditional for tally.
  const [filteredTotalCount, setFilteredTotalCount] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  // "all" | "approved" | "pending"
  // "approved" = both logo_approved AND homepage_approved (master flag)
  // "pending"  = at least one is unapproved
  // Filter is applied server-side; switching it triggers a refetch.
  const [statusFilter, setStatusFilter] = useState("all");
  // Server-side pagination state. Page is 1-indexed to match react-data-table.
  // Changing page, perPage, search, or status all trigger a refetch.
  const [currentPage, setCurrentPage] = useState(1);
  const [currentPerPage, setCurrentPerPage] = useState(25);
  const [savingIds, setSavingIds] = useState(() => new Set());
  const [uploadingLogoIds, setUploadingLogoIds] = useState(() => new Set());
  const [uploadingHomepageIds, setUploadingHomepageIds] = useState(() => new Set());
  const [fetchingLogoIds, setFetchingLogoIds] = useState(() => new Set());
  const [fetchingHomepageIds, setFetchingHomepageIds] = useState(() => new Set());

  // Delete confirmation state — same pattern as CompanyDashboard.jsx.
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [deleteConfirmLoading, setDeleteConfirmLoading] = useState(false);
  const [deleteConfirmError, setDeleteConfirmError] = useState(null);

  const fetchCompanies = useCallback(async (search, status, page, perPage, signal) => {
    setError(null);
    const params = new URLSearchParams();
    const trimmed = (search || "").trim();
    const skip = Math.max(0, (page - 1) * perPage);
    params.set("take", String(perPage));
    params.set("skip", String(skip));
    if (trimmed) params.set("search", trimmed);
    if (status === "approved") params.set("images_approved", "true");
    else if (status === "pending") params.set("images_approved", "false");
    try {
      const res = await apiFetch(`/xadmin-api-companies?${params.toString()}`, { signal });
      const data = await readJsonOrText(res);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      const items = (data?.items || []).filter((c) => c && typeof c === "object");
      setCompanies(items);
      if (typeof data?.totalCount === "number") setTotalCount(data.totalCount);
      if (typeof data?.approvedCount === "number") setApprovedCount(data.approvedCount);
      if (typeof data?.filteredTotalCount === "number") setFilteredTotalCount(data.filteredTotalCount);
    } catch (e) {
      if (e?.name === "AbortError") return;
      setError(e?.message || "Failed to load companies");
    } finally {
      setLoading(false);
    }
  }, []);

  // Refetch on any of: search, filter, page, perPage. Search is debounced;
  // the others fire immediately. AbortController kills any in-flight request
  // when the user types again or paginates faster than the network responds.
  useEffect(() => {
    const controller = new AbortController();
    const trimmed = searchQuery.trim();
    const delay = trimmed ? 250 : 0;
    setLoading(true);
    const t = window.setTimeout(() => {
      fetchCompanies(trimmed, statusFilter, currentPage, currentPerPage, controller.signal);
    }, delay);
    return () => {
      window.clearTimeout(t);
      controller.abort();
    };
  }, [searchQuery, statusFilter, currentPage, currentPerPage, fetchCompanies]);

  // Typing a search term or switching the status filter resets the paginator
  // back to page 1 — otherwise you'd land on, say, page 5 of a different
  // result set with no rows.
  useEffect(() => { setCurrentPage(1); }, [searchQuery, statusFilter]);

  const handlePageChange = useCallback((page) => {
    setCurrentPage(page);
  }, []);

  const handlePerPageChange = useCallback((newPerPage, page) => {
    setCurrentPerPage(newPerPage);
    setCurrentPage(page);
  }, []);

  const updateLocal = useCallback((id, patch) => {
    setCompanies((prev) =>
      prev.map((c) => (getCompanyId(c) === id ? { ...c, ...patch } : c))
    );
  }, []);

  const persistFields = useCallback(async (company, patch) => {
    const id = getCompanyId(company);
    if (!id) {
      toast.error("Missing company id");
      return;
    }
    setSavingIds((prev) => new Set(prev).add(id));
    try {
      const res = await apiFetch(`/xadmin-api-companies/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const data = await readJsonOrText(res);
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      updateLocal(id, patch);
    } catch (e) {
      toast.error(`Failed to save: ${e?.message || e}`);
    } finally {
      setSavingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [updateLocal]);

  // Toggling the master "Approved" box also toggles per-image approvals so the
  // logo and homepage are simultaneously approved/un-approved. Adjust the
  // server-side approved count optimistically so the tally counters react.
  const persistMasterApproval = useCallback((company, value) => {
    const wasApproved = !!company?.images_approved;
    if (wasApproved !== value) {
      setApprovedCount((prev) =>
        typeof prev === "number" ? Math.max(0, prev + (value ? 1 : -1)) : prev
      );
    }
    return persistFields(company, {
      images_approved: value,
      logo_approved: value,
      homepage_approved: value,
    });
  }, [persistFields]);

  const persistApproval = useCallback((company, field, value) => {
    return persistFields(company, { [field]: value });
  }, [persistFields]);

  const handleLogoUpload = useCallback(async (company, file) => {
    const id = getCompanyId(company);
    if (!id) {
      toast.error("Missing company id");
      return;
    }
    setUploadingLogoIds((prev) => new Set(prev).add(id));
    try {
      const url = await uploadLogoBlobFile(file, id);
      updateLocal(id, { logo_url: url, logo_approved: true });
      // Persist approval=true server-side to mirror dashboard upload behavior.
      await apiFetch(`/xadmin-api-companies/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logo_approved: true }),
      });
      toast.success("Logo uploaded");
    } catch (e) {
      toast.error(e?.message || "Logo upload failed");
    } finally {
      setUploadingLogoIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [updateLocal]);

  // Per-row Microlink fetch — calls the synchronous endpoint that wraps
  // the same persist logic used by the bulk backfill jobs. Backfilled
  // images land UNAPPROVED so the admin reviews them right here.
  const handleMicrolinkFetch = useCallback(async (company, asset) => {
    const id = getCompanyId(company);
    if (!id) {
      toast.error("Missing company id");
      return;
    }
    const setter = asset === "logo" ? setFetchingLogoIds : setFetchingHomepageIds;
    setter((prev) => new Set(prev).add(id));
    try {
      const res = await apiFetch(`/xadmin-api-microlink-fetch-one`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company_id: id, asset }),
      });
      const data = await readJsonOrText(res);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      if (!data?.ok) {
        toast.error(`Microlink: ${data?.reason || "fetch failed"}`);
        return;
      }
      if (asset === "logo") {
        updateLocal(id, {
          logo_url: data.logo_url,
          logo_source_url: data.logo_source_url || null,
          logo_source_type: "microlink_backfill",
          logo_status: "imported",
          logo_import_status: "imported",
          logo_stage_status: "imported",
          logo_approved: false,
        });
        toast.success("Logo fetched — review and approve");
      } else {
        updateLocal(id, {
          homepage_image_url: data.homepage_image_url,
          homepage_fetch_status: "ok",
          homepage_approved: false,
        });
        toast.success("Homepage fetched — review and approve");
      }
    } catch (e) {
      toast.error(e?.message || "Microlink fetch failed");
    } finally {
      setter((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [updateLocal]);

  // Row-level convenience: fetch whichever asset(s) on the row are unapproved
  // (logo and/or homepage) in parallel. The per-asset state keeps the
  // per-cell "Fetching…" overlay accurate so the admin sees which asset is
  // in flight even though they triggered both with one click.
  const handleRowMicrolinkFetch = useCallback(async (company) => {
    const id = getCompanyId(company);
    if (!id) {
      toast.error("Missing company id");
      return;
    }
    const targets = [];
    if (!company?.logo_approved) targets.push("logo");
    if (!company?.homepage_approved) targets.push("homepage");
    if (targets.length === 0) return;
    await Promise.all(targets.map((asset) => handleMicrolinkFetch(company, asset)));
  }, [handleMicrolinkFetch]);

  // Delete a single company — same flow as CompanyDashboard.jsx deleteCompany.
  const deleteCompany = useCallback(async (companyId) => {
    const safeId = asString(companyId).trim();
    if (!safeId) {
      toast.error("Missing company_id");
      return { ok: false, id: safeId, message: "Missing company_id" };
    }

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
        return { ok: false, id: safeId, message: msg, detail, body, status: res.status };
      }

      // Remove the row from local state.
      setCompanies((prev) => prev.filter((c) => getCompanyId(c) !== safeId));
      return { ok: true, id: safeId };
    } catch (e) {
      const msg = e?.message || "Delete failed";
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
    } finally {
      setDeleteConfirmLoading(false);
    }
  }, [deleteCompany, deleteConfirm]);

  const handleHomepageUpload = useCallback(async (company, file) => {
    const id = getCompanyId(company);
    if (!id) {
      toast.error("Missing company id");
      return;
    }
    setUploadingHomepageIds((prev) => new Set(prev).add(id));
    try {
      const url = await uploadHomepageBlobFile(file, id);
      updateLocal(id, { homepage_image_url: url, homepage_approved: true });
      await apiFetch(`/xadmin-api-companies/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ homepage_approved: true }),
      });
      toast.success("Homepage uploaded");
    } catch (e) {
      toast.error(e?.message || "Homepage upload failed");
    } finally {
      setUploadingHomepageIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [updateLocal]);

  // Search and status filter run server-side, but a thin client post-filter
  // on top makes optimistic approval toggles feel instant: if you check the
  // master Approve box while viewing the Pending bucket, the row should
  // disappear from view immediately instead of waiting for the next refetch.
  // The server-side count drives the paginator; minor "1-25 of N" drift after
  // toggles is corrected on the next page change.
  const visibleCompanies = useMemo(() => {
    if (statusFilter === "all") return companies;
    return companies.filter((c) => {
      const masterApproved = !!c?.images_approved;
      if (statusFilter === "approved") return masterApproved;
      return !masterApproved; // "pending"
    });
  }, [companies, statusFilter]);

  // Tally counters reflect the FULL dataset regardless of active filter, so
  // they show consistent totals as the user toggles between All/Approved/Pending.
  const counts = useMemo(() => {
    if (totalCount != null && approvedCount != null) {
      return {
        all: totalCount,
        approved: approvedCount,
        pending: Math.max(0, totalCount - approvedCount),
      };
    }
    return { all: companies.length, approved: 0, pending: companies.length };
  }, [companies.length, totalCount, approvedCount]);

  const columns = useMemo(() => {
    return [
      {
        id: "edit",
        name: "Edit",
        button: true,
        cell: (row) => {
          const id = getCompanyId(row);
          return (
            <a
              href={`/admin?company_id=${encodeURIComponent(id)}`}
              target="_blank"
              rel="noopener noreferrer"
              title="Open editor in new tab"
            >
              <Button size="sm" variant="ghost">
                <Pencil className="h-4 w-4" />
              </Button>
            </a>
          );
        },
        width: "70px",
      },
      {
        id: "name",
        name: "Name",
        selector: (row) => getCompanyName(row),
        sortable: true,
        wrap: true,
        width: "145px",
        cell: (row) => {
          const name = getCompanyName(row);
          return (
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <span>{name || "(missing)"}</span>
              {name && (
                <button
                  type="button"
                  className="opacity-40 hover:opacity-100 transition-opacity p-1 rounded hover:bg-slate-100 dark:hover:bg-muted"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(name);
                    toast.success("Name copied to clipboard");
                  }}
                  title="Copy name"
                >
                  <Copy className="h-3 w-3" />
                </button>
              )}
            </div>
          );
        },
      },
      {
        id: "url",
        name: "URL",
        selector: (row) => getCompanyUrl(row) || asString(row?.normalized_domain).trim(),
        sortable: true,
        wrap: true,
        width: "135px",
        cell: (row) => {
          const fullUrl = getCompanyUrl(row);
          const display = fullUrl || asString(row?.normalized_domain).trim();
          if (!display) return null;
          return (
            <div className="flex items-start gap-2 min-w-0 py-1">
              <span className="line-clamp-3 break-all" title={display}>{display}</span>
              <button
                type="button"
                className="flex-shrink-0 opacity-40 hover:opacity-100 transition-opacity p-1 rounded hover:bg-slate-100 dark:hover:bg-muted"
                onClick={(e) => {
                  e.stopPropagation();
                  navigator.clipboard.writeText(display);
                  toast.success("URL copied to clipboard");
                }}
                title="Copy URL"
              >
                <Copy className="h-3 w-3" />
              </button>
            </div>
          );
        },
      },
      {
        id: "approved",
        name: "Approved",
        selector: (row) => (row?.images_approved ? 1 : 0),
        sortable: true,
        width: "110px",
        cell: (row) => {
          const id = getCompanyId(row);
          const logoMissing = !row?.logo_approved;
          const homepageMissing = !row?.homepage_approved;
          const anyMissing = logoMissing || homepageMissing;
          const fetching = fetchingLogoIds.has(id) || fetchingHomepageIds.has(id);
          // Title spells out which asset(s) the click will fetch, so the
          // admin doesn't have to remember which checkbox is which.
          const fetchTitle = !anyMissing
            ? "All approved — nothing to fetch"
            : logoMissing && homepageMissing
              ? "Fetch logo + homepage from Microlink"
              : logoMissing
                ? "Fetch logo from Microlink"
                : "Fetch homepage from Microlink";
          return (
            <div className="flex items-center gap-2">
              <Checkbox
                checked={!!row?.images_approved}
                onCheckedChange={(v) => persistMasterApproval(row, Boolean(v))}
                disabled={savingIds.has(id)}
                aria-label="Master approve"
              />
              <button
                type="button"
                onClick={() => handleRowMicrolinkFetch(row)}
                disabled={!anyMissing || fetching || savingIds.has(id)}
                title={fetchTitle}
                className="opacity-60 hover:opacity-100 disabled:opacity-20 disabled:cursor-not-allowed transition-opacity text-teal-600 dark:text-teal-400"
                aria-label={fetchTitle}
              >
                <Sparkles className={`w-4 h-4 ${fetching ? "animate-pulse" : ""}`} />
              </button>
            </div>
          );
        },
      },
      {
        id: "logo",
        name: "Logo",
        width: "120px",
        cell: (row) => {
          const id = getCompanyId(row);
          const src = getCompanyLogoUrl(row);
          return (
            <ImageCell
              src={src || ""}
              alt={`${getCompanyName(row)} logo`}
              approved={!!row?.logo_approved}
              onApproveChange={(v) => persistApproval(row, "logo_approved", v)}
              onUpload={(file) => handleLogoUpload(row, file)}
              uploading={uploadingLogoIds.has(id)}
              fetching={fetchingLogoIds.has(id)}
              saving={savingIds.has(id)}
              emptyLabel="No logo"
              aspectClass="h-14 w-14"
              thumbClass="max-h-14 max-w-14"
            />
          );
        },
      },
      {
        id: "homepage",
        name: "Homepage",
        width: "150px",
        cell: (row) => {
          const id = getCompanyId(row);
          const src = row?.homepage_image_url ? getCompanyHomepageUrl(row) : "";
          return (
            <ImageCell
              src={src || ""}
              alt={`${getCompanyName(row)} homepage`}
              approved={!!row?.homepage_approved}
              onApproveChange={(v) => persistApproval(row, "homepage_approved", v)}
              onUpload={(file) => handleHomepageUpload(row, file)}
              uploading={uploadingHomepageIds.has(id)}
              fetching={fetchingHomepageIds.has(id)}
              saving={savingIds.has(id)}
              emptyLabel="No image"
              aspectClass="h-14 w-24"
              thumbClass="max-h-14 max-w-24"
            />
          );
        },
      },
      {
        id: "profile",
        name: "Profile",
        selector: (row) => getProfileCompleteness(row),
        sortable: true,
        width: "130px",
        cell: (row) => {
          const score = getProfileCompleteness(row);
          const label = getProfileCompletenessLabel(score);
          const tone =
            score >= 85
              ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
              : score >= 60
                ? "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
                : score >= 35
                  ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
                  : "border-red-200 bg-red-50 text-red-800 dark:border-red-700 dark:bg-red-950/40 dark:text-red-300";
          return (
            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${tone}`}>
              {label} · {score}%
            </span>
          );
        },
      },
      {
        id: "created",
        name: <span className="text-[10px]">Created</span>,
        selector: (row) => asString(row?.created_at).trim(),
        sortable: true,
        cell: (row) => (
          <span className="text-xs text-slate-700 dark:text-muted-foreground" title={toFullDate(row?.created_at)}>
            {toShortDate(row?.created_at)}
          </span>
        ),
        width: "95px",
      },
      {
        id: "updated",
        name: <span className="text-[10px]">Updated</span>,
        selector: (row) => asString(row?.updated_at || row?.created_at).trim(),
        sortable: true,
        cell: (row) => (
          <span className="text-xs text-slate-700 dark:text-muted-foreground" title={toFullDate(row?.updated_at || row?.created_at)}>
            {toShortDate(row?.updated_at || row?.created_at)}
          </span>
        ),
        width: "95px",
      },
      {
        id: "issues",
        name: "Issues",
        selector: (row) => {
          let n = 0;
          if (!row?.logo_approved) n += 1;
          if (!row?.homepage_approved) n += 1;
          return n;
        },
        sortable: true,
        width: "75px",
        cell: (row) => {
          const issues = [];
          if (!row?.logo_approved) issues.push("logo");
          if (!row?.homepage_approved) issues.push("page");
          if (issues.length === 0) {
            return <span className="text-xs text-emerald-500">OK</span>;
          }
          return (
            <div className="flex flex-col gap-1 items-start">
              {issues.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
                >
                  {tag}
                </span>
              ))}
            </div>
          );
        },
      },
      {
        id: "delete",
        name: "Delete",
        button: true,
        width: "70px",
        cell: (row) => {
          const id = getCompanyId(row);
          return (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 w-8 p-0 text-red-600 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/40"
              title="Delete company"
              onClick={() =>
                openDeleteConfirm({
                  kind: "single",
                  company_id: id,
                  company_name: getCompanyName(row),
                })
              }
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          );
        },
      },
    ];
  }, [
    persistApproval,
    persistMasterApproval,
    handleLogoUpload,
    handleHomepageUpload,
    handleRowMicrolinkFetch,
    openDeleteConfirm,
    uploadingLogoIds,
    uploadingHomepageIds,
    fetchingLogoIds,
    fetchingHomepageIds,
    savingIds,
  ]);

  const tableTheme = useMemo(
    () => ({
      table: {
        style: {
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
          fontSize: "11px",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: isDark ? "hsl(187 15% 65%)" : undefined,
        },
      },
      rows: {
        style: {
          backgroundColor: isDark ? "hsl(187 15% 11%)" : undefined,
          color: isDark ? "hsl(187 10% 93%)" : undefined,
          borderBottomColor: isDark ? "hsl(187 10% 18%)" : undefined,
          minHeight: "92px",
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
        pageButtonsStyle: isDark
          ? {
              color: "hsl(187 10% 93%)",
              fill: "hsl(187 10% 93%)",
              "&:disabled": { color: "hsl(187 10% 30%)", fill: "hsl(187 10% 30%)" },
              "&:hover:not(:disabled)": { backgroundColor: "hsl(187 12% 18%)" },
              "&:focus": { backgroundColor: "hsl(187 12% 18%)" },
            }
          : undefined,
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

  return (
    <>
      <Helmet>
        <title>Admin - Images</title>
      </Helmet>
      <AdminHeader />

      <div className="bg-slate-50 dark:bg-slate-950 min-h-screen p-6">
        <div className="max-w-[1200px] mx-auto">
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white mb-1">Images</h1>
          <p className="text-slate-500 dark:text-slate-400 text-sm mb-4">
            {searchQuery ? (
              <>
                {filteredTotalCount != null ? filteredTotalCount.toLocaleString() : companies.length} matching &ldquo;{searchQuery}&rdquo;
              </>
            ) : (
              <>
                {totalCount != null ? `${totalCount.toLocaleString()} companies total` : `${companies.length} companies loaded`}
                {statusFilter !== "all" && filteredTotalCount != null && (
                  <span className="ml-2 text-slate-400 dark:text-slate-500">
                    ({filteredTotalCount.toLocaleString()} {statusFilter})
                  </span>
                )}
              </>
            )}
          </p>

          <div className="flex flex-wrap items-center gap-3 mb-4">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by name, domain, or company id…"
                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md pl-9 pr-9 py-2 text-sm text-slate-800 dark:text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            <div
              role="radiogroup"
              aria-label="Filter by approval status"
              className="flex items-end gap-2"
            >
              {[
                { value: "all", label: "Show All", count: counts.all },
                { value: "approved", label: "Approved", count: counts.approved },
                { value: "pending", label: "Pending", count: counts.pending },
              ].map((opt) => {
                const active = statusFilter === opt.value;
                return (
                  <div key={opt.value} className="flex flex-col items-center gap-1">
                    <TallyCounter value={opt.count} label="" />
                    <button
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setStatusFilter(opt.value)}
                      className={`px-3 py-2 text-sm rounded border transition ${
                        active
                          ? "bg-teal-600 border-teal-600 text-white"
                          : "bg-white dark:bg-slate-900 border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                      }`}
                    >
                      {opt.label}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {error && (
            <div className="bg-red-100 dark:bg-red-900/30 border border-red-400 dark:border-red-700 text-red-700 dark:text-red-300 rounded p-4 mb-6">
              {error}
            </div>
          )}

          <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[hsl(187_15%_11%)]">
            <DataTable
              columns={columns}
              data={visibleCompanies}
              progressPending={loading && companies.length === 0}
              progressComponent={
                <div className="text-slate-400 py-10 text-sm">Loading…</div>
              }
              pagination
              paginationServer
              paginationTotalRows={filteredTotalCount ?? totalCount ?? 0}
              paginationPerPage={currentPerPage}
              paginationDefaultPage={currentPage}
              paginationRowsPerPageOptions={[25, 50, 100, 250, 500, 1000]}
              onChangePage={handlePageChange}
              onChangeRowsPerPage={handlePerPageChange}
              highlightOnHover
              defaultSortFieldId="updated"
              defaultSortAsc={false}
              customStyles={tableTheme}
              noDataComponent={
                <div className="py-8 text-slate-500 text-sm">
                  {companies.length === 0 ? "No companies yet." : "No matches."}
                  {companies.length > 0 ? null : (
                    <span className="ml-2">
                      <ImageOff className="inline-block w-4 h-4" />
                    </span>
                  )}
                </div>
              }
            />
          </section>
        </div>
      </div>

      <AlertDialog
        open={deleteConfirmOpen}
        onOpenChange={(open) => !deleteConfirmLoading && setDeleteConfirmOpen(open)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm delete</AlertDialogTitle>
            <AlertDialogDescription>
              This action is irreversible. The company will be removed from the admin list immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-2">
            <div className="text-sm text-slate-700 dark:text-muted-foreground">
              Delete <span className="font-semibold">{asString(deleteConfirm?.company_name) || "this company"}</span> (
              <code className="text-xs">{asString(deleteConfirm?.company_id)}</code>)?
            </div>

            {deleteConfirmError ? (
              <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-900">
                <div className="font-medium">Delete failed</div>
                <div>{asString(deleteConfirmError.message)}</div>
                {deleteConfirmError.detail ? (
                  <div className="mt-1 whitespace-pre-wrap break-words font-mono text-red-800">
                    {asString(deleteConfirmError.detail)}
                  </div>
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
    </>
  );
}
