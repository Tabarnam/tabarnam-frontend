import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Helmet } from "react-helmet-async";
import { useTheme } from "next-themes";
import DataTable from "react-data-table-component";
import { Check, Copy, ImageOff, Pencil, Search, Upload, X } from "lucide-react";

import AdminHeader from "@/components/AdminHeader";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { apiFetch, readJsonOrText } from "@/lib/api";
import { getCompanyLogoUrl } from "@/lib/logoUrl";
import { getCompanyHomepageUrl } from "@/lib/homepageUrl";
import {
  uploadLogoBlobFile,
  uploadHomepageBlobFile,
} from "@/lib/blobStorage";
import {
  getCompanyId,
  getCompanyName,
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
  saving,
  emptyLabel,
  aspectClass,
  thumbClass,
}) {
  const fileRef = useRef(null);
  const buttonRef = useRef(null);
  const [hoverRect, setHoverRect] = useState(null);
  const [recentlyUploaded, setRecentlyUploaded] = useState(false);

  const handlePick = (e) => {
    e.stopPropagation();
    if (uploading || saving) return;
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
        disabled={uploading}
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  // "all" | "approved" | "pending"
  // "approved" = both logo_approved AND homepage_approved
  // "pending"  = at least one is unapproved
  const [statusFilter, setStatusFilter] = useState("all");
  const [savingIds, setSavingIds] = useState(() => new Set());
  const [uploadingLogoIds, setUploadingLogoIds] = useState(() => new Set());
  const [uploadingHomepageIds, setUploadingHomepageIds] = useState(() => new Set());

  const fetchCompanies = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/xadmin-api-companies?take=5000`);
      const data = await readJsonOrText(res);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      const items = (data?.items || []).filter((c) => c && typeof c === "object");
      setCompanies(items);
    } catch (e) {
      setError(e?.message || "Failed to load companies");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCompanies();
  }, [fetchCompanies]);

  const updateLocal = useCallback((id, patch) => {
    setCompanies((prev) =>
      prev.map((c) => (getCompanyId(c) === id ? { ...c, ...patch } : c))
    );
  }, []);

  const persistApproval = useCallback(async (company, field, value) => {
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
        body: JSON.stringify({ [field]: value }),
      });
      if (!res.ok) {
        const data = await readJsonOrText(res);
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      updateLocal(id, { [field]: value });
    } catch (e) {
      toast.error(`Failed to save ${field}: ${e?.message || e}`);
    } finally {
      setSavingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [updateLocal]);

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

  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return companies.filter((c) => {
      // Status filter
      const bothApproved = !!c?.logo_approved && !!c?.homepage_approved;
      if (statusFilter === "approved" && !bothApproved) return false;
      if (statusFilter === "pending" && bothApproved) return false;

      // Text search
      if (!q) return true;
      const name = (getCompanyName(c) || "").toLowerCase();
      const url = (c.website_url || c.normalized_domain || "").toLowerCase();
      const id = (getCompanyId(c) || "").toLowerCase();
      return name.includes(q) || url.includes(q) || id.includes(q);
    });
  }, [companies, searchQuery, statusFilter]);

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
        grow: 1.5,
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
        id: "domain",
        name: "Domain",
        selector: (row) => asString(row?.normalized_domain).trim(),
        sortable: true,
        wrap: true,
        cell: (row) => {
          const domain = asString(row?.normalized_domain).trim();
          return (
            <div className="flex items-center gap-2">
              <span>{domain}</span>
              {domain && (
                <button
                  type="button"
                  className="opacity-40 hover:opacity-100 transition-opacity p-1 rounded hover:bg-slate-100 dark:hover:bg-muted"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(domain);
                    toast.success("Domain copied to clipboard");
                  }}
                  title="Copy domain"
                >
                  <Copy className="h-3 w-3" />
                </button>
              )}
            </div>
          );
        },
      },
      {
        id: "approved",
        name: "Approved",
        // Sortable by approval count: 2 = both, 1 = partial, 0 = neither.
        selector: (row) => (row?.logo_approved ? 1 : 0) + (row?.homepage_approved ? 1 : 0),
        sortable: true,
        width: "115px",
        cell: (row) => {
          const logoOk = !!row?.logo_approved;
          const pageOk = !!row?.homepage_approved;
          const pill = (label, ok) => (
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${
                ok
                  ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                  : "border-slate-300 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400"
              }`}
            >
              {ok ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
              {label}
            </span>
          );
          return (
            <div className="flex flex-col gap-1 py-1">
              {pill("Logo", logoOk)}
              {pill("Page", pageOk)}
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
        width: "120px",
        cell: (row) => {
          const issues = [];
          if (!row?.logo_approved) issues.push("logo");
          if (!row?.homepage_approved) issues.push("page");
          if (issues.length === 0) {
            return <span className="text-xs text-emerald-500">OK</span>;
          }
          return (
            <div className="flex flex-wrap gap-1">
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
    ];
  }, [
    persistApproval,
    handleLogoUpload,
    handleHomepageUpload,
    uploadingLogoIds,
    uploadingHomepageIds,
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
        <div className="max-w-[1600px] mx-auto">
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white mb-1">Images</h1>
          <p className="text-slate-500 dark:text-slate-400 text-sm mb-4">
            {companies.length} companies
            {searchQuery && filteredItems.length !== companies.length && (
              <span className="ml-2 text-slate-500">
                (showing {filteredItems.length} matching &ldquo;{searchQuery}&rdquo;)
              </span>
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
              className="inline-flex rounded-md border border-slate-300 dark:border-slate-700 overflow-hidden text-sm"
            >
              {[
                { value: "all", label: "Show All" },
                { value: "approved", label: "Approved" },
                { value: "pending", label: "Pending" },
              ].map((opt) => {
                const active = statusFilter === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setStatusFilter(opt.value)}
                    className={`px-3 py-2 transition border-r last:border-r-0 border-slate-300 dark:border-slate-700 ${
                      active
                        ? "bg-teal-600 text-white"
                        : "bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                    }`}
                  >
                    {opt.label}
                  </button>
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
              data={filteredItems}
              progressPending={loading && companies.length === 0}
              progressComponent={
                <div className="text-slate-400 py-10 text-sm">Loading…</div>
              }
              pagination
              paginationPerPage={50}
              paginationRowsPerPageOptions={[25, 50, 100, 250, 500]}
              fixedHeader
              fixedHeaderScrollHeight="calc(100vh - 220px)"
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
    </>
  );
}
