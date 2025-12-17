import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import DataTable from "react-data-table-component";
import {
  Save,
  Trash2,
  Pencil,
  RefreshCcw,
  AlertTriangle,
  Plus,
  AlertCircle,
  Copy,
} from "lucide-react";

import AdminHeader from "@/components/AdminHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/toast";
import { apiFetch, getUserFacingConfigMessage } from "@/lib/api";
import { deleteLogoBlob, uploadLogoBlobFile } from "@/lib/blobStorage";
import {
  Dialog,
  DialogContent,
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

const DEFAULT_TAKE = 200;

function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function prettyJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return asString(value);
  }
}

function normalizeLocationList(value) {
  if (Array.isArray(value)) {
    return value.map((v) => asString(v).trim()).filter(Boolean);
  }
  const s = asString(value).trim();
  if (!s) return [];
  return s
    .split(/\s*[,;|]\s*/g)
    .map((v) => v.trim())
    .filter(Boolean);
}

function keywordStringToList(value) {
  return normalizeLocationList(value);
}

function keywordListToString(list) {
  if (!Array.isArray(list)) return "";
  return list
    .map((v) => asString(v).trim())
    .filter(Boolean)
    .join(", ");
}

function getCompanyName(company) {
  return asString(company?.company_name || company?.name).trim();
}

function getCompanyUrl(company) {
  return asString(company?.website_url || company?.url || company?.canonical_url || company?.website).trim();
}

function getCompanyId(company) {
  return asString(company?.company_id || company?.id).trim();
}

function slugifyCompanyId(name) {
  const base = asString(name)
    .trim()
    .toLowerCase()
    .replace(/[']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return base;
}

function toIssueTags(company) {
  const issues = [];

  const name = getCompanyName(company);
  if (!name) issues.push("missing name");

  const url = getCompanyUrl(company);
  if (!url) issues.push("missing url");

  const logo = asString(company?.logo_url).trim();
  if (!logo) issues.push("missing logo");

  const hq = asString(company?.headquarters_location).trim();
  if (!hq) issues.push("missing HQ");

  const mfg = normalizeLocationList(company?.manufacturing_locations);
  if (mfg.length === 0) issues.push("missing MFG");

  const keywords = keywordStringToList(company?.product_keywords || company?.keywords);
  if (keywords.length === 0) issues.push("missing keywords");

  return issues;
}

function toDisplayDate(value) {
  const s = asString(value).trim();
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString();
}

function validateCompanyDraft(draft) {
  const name = getCompanyName(draft);
  const url = getCompanyUrl(draft);
  if (!name) return "Company name is required.";
  if (!url) return "Website URL is required.";
  return null;
}

async function copyToClipboard(value) {
  const s = asString(value).trim();
  if (!s) return false;

  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch {
    // fall through
  }

  try {
    const el = document.createElement("textarea");
    el.value = s;
    el.setAttribute("readonly", "");
    el.style.position = "absolute";
    el.style.left = "-9999px";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

export default function CompanyDashboard() {
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
  const [editorDraft, setEditorDraft] = useState(null);
  const [editorOriginalId, setEditorOriginalId] = useState(null);

  const [logoFile, setLogoFile] = useState(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoUpdating, setLogoUpdating] = useState(false);
  const [logoUploadError, setLogoUploadError] = useState(null);
  const [logoDeleting, setLogoDeleting] = useState(false);

  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [deleteConfirmLoading, setDeleteConfirmLoading] = useState(false);
  const [deleteConfirmError, setDeleteConfirmError] = useState(null);

  const requestSeqRef = useRef(0);
  const abortRef = useRef(null);

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
          const msg = configMsg || body?.error || `Failed to load companies (${res.status})`;
          const errorDetail = body?.detail || body?.error || res.statusText || "Unknown error";

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
        const errMsg = e?.message || "Failed to load companies";
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

  const openEditorForCompany = useCallback((company) => {
    const id = getCompanyId(company);

    const draft = {
      ...company,
      id: asString(company?.id).trim(),
      company_id: asString(company?.company_id || company?.id).trim(),
      company_name: getCompanyName(company),
      website_url: getCompanyUrl(company),
      headquarters_location: asString(company?.headquarters_location).trim(),
      manufacturing_locations: normalizeLocationList(company?.manufacturing_locations),
      product_keywords: keywordListToString(keywordStringToList(company?.product_keywords || company?.keywords)),
      notes: asString(company?.notes).trim(),
      tagline: asString(company?.tagline).trim(),
      logo_url: asString(company?.logo_url).trim(),
    };

    setEditorOriginalId(id || null);
    setEditorDraft(draft);
    setLogoFile(null);
    setLogoUploadError(null);
    setEditorOpen(true);
  }, []);

  const createNewCompany = useCallback(() => {
    const draft = {
      id: "",
      company_id: "",
      company_name: "",
      website_url: "",
      tagline: "",
      logo_url: "",
      headquarters_location: "",
      manufacturing_locations: [],
      product_keywords: "",
      notes: "",
    };

    setEditorOriginalId(null);
    setEditorDraft(draft);
    setLogoFile(null);
    setLogoUploadError(null);
    setEditorOpen(true);
  }, []);

  const saveEditor = useCallback(async () => {
    if (!editorDraft) return;

    const validationError = validateCompanyDraft(editorDraft);
    if (validationError) {
      toast.error(validationError);
      return;
    }

    const isNew = !editorOriginalId;

    setEditorSaving(true);
    try {
      const draftCompanyId = asString(editorDraft.company_id).trim();
      const draftName = getCompanyName(editorDraft);
      const suggestedId = slugifyCompanyId(draftName);

      const resolvedCompanyId = draftCompanyId || (isNew ? suggestedId : "") || "";

      const payload = {
        ...editorDraft,
        company_id: resolvedCompanyId,
        id: resolvedCompanyId,
        company_name: draftName,
        name: asString(editorDraft.name || draftName).trim(),
        website_url: getCompanyUrl(editorDraft),
        url: asString(editorDraft.url || getCompanyUrl(editorDraft)).trim(),
        headquarters_location: asString(editorDraft.headquarters_location).trim(),
        manufacturing_locations: normalizeLocationList(editorDraft.manufacturing_locations),
        product_keywords: keywordListToString(keywordStringToList(editorDraft.product_keywords)),
        notes: asString(editorDraft.notes).trim(),
        tagline: asString(editorDraft.tagline).trim(),
        logo_url: asString(editorDraft.logo_url).trim(),
      };

      if (!payload.company_id) {
        payload.company_id = `company_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        payload.id = payload.company_id;
      }

      const method = isNew ? "POST" : "PUT";

      const res = await apiFetch("/xadmin-api-companies", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company: payload }),
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

      toast.success(isNew ? "Company created" : "Company saved");
      setEditorOpen(false);
      setEditorDraft(null);
      setEditorOriginalId(null);
    } catch (e) {
      toast.error(e?.message || "Save failed");
    } finally {
      setEditorSaving(false);
    }
  }, [editorDraft, editorOriginalId]);

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
      const res = await apiFetch("/xadmin-api-companies", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company_id: safeId, actor: "admin_ui" }),
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok !== true) {
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
      setEditorOpen(false);
      setEditorDraft(null);
      setEditorOriginalId(null);
    } finally {
      setDeleteConfirmLoading(false);
    }
  }, [deleteCompany, deleteConfirm]);

  const deleteSelected = useCallback(() => {
    const ids = selectedRows.map((r) => getCompanyId(r)).filter(Boolean);
    if (ids.length === 0) return;

    openDeleteConfirm({ kind: "bulk", ids, label: `${ids.length} selected compan${ids.length === 1 ? "y" : "ies"}` });
  }, [openDeleteConfirm, selectedRows]);

  const columns = useMemo(() => {
    return [
      {
        name: "Name",
        selector: (row) => getCompanyName(row),
        sortable: true,
        wrap: true,
        grow: 2,
      },
      {
        name: "Domain",
        selector: (row) => asString(row?.normalized_domain).trim(),
        sortable: true,
        wrap: true,
      },
      {
        name: "HQ",
        selector: (row) => asString(row?.headquarters_location).trim(),
        sortable: true,
        wrap: true,
      },
      {
        name: "MFG",
        selector: (row) => normalizeLocationList(row?.manufacturing_locations).join("; "),
        sortable: false,
        wrap: true,
      },
      {
        name: "Reviews",
        selector: (row) => Number(row?.review_count ?? row?.reviews_count ?? 0) || 0,
        sortable: true,
        right: true,
        width: "110px",
      },
      {
        name: "Updated",
        selector: (row) => asString(row?.updated_at || row?.created_at).trim(),
        sortable: true,
        cell: (row) => (
          <span className="text-xs text-slate-700">{toDisplayDate(row?.updated_at || row?.created_at)}</span>
        ),
        width: "160px",
      },
      {
        name: "Issues",
        sortable: false,
        cell: (row) => {
          const tags = toIssueTags(row);
          if (tags.length === 0) return <span className="text-xs text-emerald-700">OK</span>;

          const shown = tags.slice(0, 3);
          const more = tags.length - shown.length;
          return (
            <div className="flex flex-wrap gap-1">
              {shown.map((t) => (
                <span
                  key={t}
                  className="rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-[11px] text-amber-900"
                >
                  {t}
                </span>
              ))}
              {more > 0 ? (
                <span className="rounded-full bg-slate-50 border border-slate-200 px-2 py-0.5 text-[11px] text-slate-700">
                  +{more}
                </span>
              ) : null}
            </div>
          );
        },
        width: "240px",
      },
      {
        name: "Actions",
        button: true,
        cell: (row) => {
          const id = getCompanyId(row);
          const rowError = id ? rowErrors?.[id] : null;

          return (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => openEditorForCompany(row)}>
                  <Pencil className="h-4 w-4" />
                </Button>
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
              </div>

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
        width: "140px",
      },
    ];
  }, [openDeleteConfirm, openEditorForCompany, rowErrors]);

  const tableTheme = useMemo(
    () => ({
      header: {
        style: {
          minHeight: "48px",
        },
      },
      headCells: {
        style: {
          fontWeight: 600,
          fontSize: "12px",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        },
      },
    }),
    []
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
      return <div className="p-6 text-sm text-slate-600">Unable to load companies (see error above).</div>;
    }
    return <div className="p-6 text-sm text-slate-600">No companies found.</div>;
  }, [lastError]);

  const progressComponent = useMemo(() => {
    return <div className="p-6 text-sm text-slate-600">Loading companies…</div>;
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

      <div className="min-h-screen bg-slate-50">
        <AdminHeader />

        <main className="container mx-auto py-6 px-4 space-y-4">
          <header className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h1 className="text-3xl font-bold text-slate-900">Companies</h1>

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
                <label className="text-sm text-slate-700">Take</label>
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

              <div className="text-sm text-slate-600">
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

          <section className="rounded-lg border border-slate-200 bg-white overflow-hidden">
            <DataTable
              columns={columns}
              data={filteredItems}
              progressPending={loading && items.length === 0}
              progressComponent={progressComponent}
              pagination
              paginationPerPage={25}
              paginationRowsPerPageOptions={[10, 25, 50, 100]}
              highlightOnHover
              pointerOnHover
              dense
              theme={tableTheme}
              selectableRows
              onSelectedRowsChange={(state) => setSelectedRows(state?.selectedRows || [])}
              clearSelectedRows={selectedRows.length === 0}
              contextActions={contextActions}
              onRowClicked={(row) => openEditorForCompany(row)}
              noDataComponent={noDataComponent}
            />
          </section>

          <Dialog open={editorOpen} onOpenChange={(open) => !editorSaving && setEditorOpen(open)}>
            <DialogContent className="max-w-none w-[90vw] h-[90vh] p-0">
              <div className="flex h-full flex-col">
                <DialogHeader className="px-6 py-4 border-b sticky top-0 bg-background z-10">
                  <DialogTitle>{editorOriginalId ? "Edit company" : "New company"}</DialogTitle>
                </DialogHeader>

                <div className="flex-1 overflow-auto px-6 py-4">
                  {editorDraft ? (
                    <div className="space-y-5">
                      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <div className="text-xs font-medium text-slate-700">company_id</div>
                            <div className="mt-1 flex items-center gap-2">
                              <code className="rounded bg-white border border-slate-200 px-2 py-1 text-xs text-slate-900">
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
                          </div>

                          {!editorOriginalId ? (
                            <div className="min-w-[260px]">
                              <label className="text-xs font-medium text-slate-700">Override company_id (optional)</label>
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

                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        <div className="space-y-1">
                          <label className="text-sm text-slate-700">Company name</label>
                          <Input
                            value={asString(editorDraft.company_name)}
                            onChange={(e) => setEditorDraft((d) => ({ ...d, company_name: e.target.value }))}
                            placeholder="Acme Corp"
                          />
                        </div>

                        <div className="space-y-1">
                          <label className="text-sm text-slate-700">Website URL</label>
                          <Input
                            value={asString(editorDraft.website_url)}
                            onChange={(e) => setEditorDraft((d) => ({ ...d, website_url: e.target.value }))}
                            placeholder="https://example.com"
                          />
                        </div>

                        <div className="space-y-2">
                          <label className="text-sm text-slate-700">Logo</label>

                          {asString(editorDraft.logo_url).trim() ? (
                            <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-2">
                              <img
                                src={asString(editorDraft.logo_url).trim()}
                                alt="Company logo"
                                className="h-12 w-12 rounded border border-slate-200 object-contain bg-white"
                                loading="lazy"
                                onError={(e) => {
                                  e.currentTarget.style.display = "none";
                                }}
                              />
                              <div className="flex-1 min-w-0">
                                <div className="text-xs text-slate-500">Current logo_url</div>
                                <div className="text-xs text-slate-800 break-all">
                                  {asString(editorDraft.logo_url).trim()}
                                </div>
                              </div>
                            </div>
                          ) : (
                            <div className="text-xs text-slate-500">No logo uploaded.</div>
                          )}

                          <div className="flex flex-wrap items-center gap-2">
                            <input
                              type="file"
                              accept="image/png,image/jpeg,image/webp"
                              onChange={handleLogoFileChange}
                              className="block w-full max-w-[360px] text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-slate-900/90"
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
                            <div className="text-xs text-slate-600">
                              Selected: {logoFile.name} ({Math.round((logoFile.size / 1024) * 10) / 10}KB)
                            </div>
                          ) : null}

                          {logoUploadError ? <div className="text-xs text-red-700">{logoUploadError}</div> : null}

                          {!editorOriginalId ? (
                            <div className="text-xs text-slate-600">Save the company first to enable uploads.</div>
                          ) : null}
                        </div>

                        <div className="space-y-1">
                          <label className="text-sm text-slate-700">Tagline</label>
                          <Input
                            value={asString(editorDraft.tagline)}
                            onChange={(e) => setEditorDraft((d) => ({ ...d, tagline: e.target.value }))}
                            placeholder="Mission statement…"
                          />
                        </div>

                        <div className="space-y-1">
                          <label className="text-sm text-slate-700">HQ location</label>
                          <Input
                            value={asString(editorDraft.headquarters_location)}
                            onChange={(e) => setEditorDraft((d) => ({ ...d, headquarters_location: e.target.value }))}
                            placeholder="City, State/Region, Country"
                          />
                        </div>

                        <div className="space-y-1">
                          <label className="text-sm text-slate-700">Manufacturing locations</label>
                          <Input
                            value={normalizeLocationList(editorDraft.manufacturing_locations).join(", ")}
                            onChange={(e) =>
                              setEditorDraft((d) => ({
                                ...d,
                                manufacturing_locations: normalizeLocationList(e.target.value),
                              }))
                            }
                            placeholder="City, Region, Country; …"
                          />
                        </div>

                        <div className="lg:col-span-2 space-y-1">
                          <label className="text-sm text-slate-700">Product keywords</label>
                          <Input
                            value={asString(editorDraft.product_keywords)}
                            onChange={(e) => setEditorDraft((d) => ({ ...d, product_keywords: e.target.value }))}
                            placeholder="running shoes, socks, …"
                          />
                        </div>

                        <div className="lg:col-span-2 space-y-1">
                          <label className="text-sm text-slate-700">Notes</label>
                          <textarea
                            value={asString(editorDraft.notes)}
                            onChange={(e) => setEditorDraft((d) => ({ ...d, notes: e.target.value }))}
                            className="min-h-[200px] w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                            placeholder="Internal notes…"
                          />
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

                <DialogFooter className="px-6 py-4 border-t">
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
                  <Button variant="outline" onClick={() => setEditorOpen(false)} disabled={editorSaving}>
                    Cancel
                  </Button>
                  <Button onClick={saveEditor} disabled={editorSaving || Boolean(editorValidationError)}>
                    <Save className="h-4 w-4 mr-2" />
                    {editorSaving ? "Saving…" : editorOriginalId ? "Save changes" : "Create"}
                  </Button>
                </DialogFooter>
              </div>
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
                  <div className="text-sm text-slate-700">Delete {asString(deleteConfirm.label)}?</div>
                ) : (
                  <div className="text-sm text-slate-700">
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
