import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import DataTable from "react-data-table-component";
import { Save, Trash2, Pencil, RefreshCcw, AlertTriangle, Plus, AlertCircle } from "lucide-react";

import AdminHeader from "@/components/AdminHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/toast";
import { apiFetch, getUserFacingConfigMessage } from "@/lib/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const DEFAULT_TAKE = 200;

function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
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
  return list.map((v) => asString(v).trim()).filter(Boolean).join(", ");
}

function getCompanyName(company) {
  return asString(company?.company_name || company?.name).trim();
}

function getCompanyUrl(company) {
  return asString(company?.website_url || company?.url || company?.canonical_url).trim();
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

export default function CompanyDashboard() {
  const [search, setSearch] = useState("");
  const [take, setTake] = useState(DEFAULT_TAKE);
  const [onlyIncomplete, setOnlyIncomplete] = useState(false);

  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState([]);

  const [selectedRows, setSelectedRows] = useState([]);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorDraft, setEditorDraft] = useState(null);
  const [editorOriginalId, setEditorOriginalId] = useState(null);

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

      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (q.trim()) params.set("search", q.trim());
        params.set("take", String(Math.max(1, Math.min(500, Math.trunc(t || DEFAULT_TAKE)))));

        const res = await apiFetch(`/xadmin-api-companies?${params.toString()}`);
        const body = await res.json().catch(() => ({}));

        if (!res.ok) {
          const msg = (await getUserFacingConfigMessage(res)) || body?.error || `Failed to load companies (${res.status})`;
          toast.error(msg);
          setItems([]);
          return;
        }

        setItems(Array.isArray(body?.items) ? body.items : []);
      } catch (e) {
        toast.error(e?.message || "Failed to load companies");
        setItems([]);
      } finally {
        setLoading(false);
      }
    },
    [search, take]
  );

  useEffect(() => {
    loadCompanies();
  }, [loadCompanies]);

  const openEditorForCompany = useCallback((company) => {
    const id = asString(company?.id || company?.company_id).trim();

    const draft = {
      ...company,
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
    setEditorOpen(true);
  }, []);

  const saveEditor = useCallback(async () => {
    if (!editorDraft) return;

    const err = validateCompanyDraft(editorDraft);
    if (err) {
      toast.error(err);
      return;
    }

    setEditorSaving(true);
    try {
      const payload = {
        ...editorDraft,
        id: asString(editorDraft.id || editorDraft.company_id || editorDraft.company_name).trim(),
        company_id: asString(editorDraft.company_id || editorDraft.id || editorDraft.company_name).trim(),
        company_name: getCompanyName(editorDraft),
        name: asString(editorDraft.name || getCompanyName(editorDraft)).trim(),
        website_url: getCompanyUrl(editorDraft),
        url: asString(editorDraft.url || getCompanyUrl(editorDraft)).trim(),
        headquarters_location: asString(editorDraft.headquarters_location).trim(),
        manufacturing_locations: normalizeLocationList(editorDraft.manufacturing_locations),
        product_keywords: keywordListToString(keywordStringToList(editorDraft.product_keywords)),
        notes: asString(editorDraft.notes).trim(),
        tagline: asString(editorDraft.tagline).trim(),
        logo_url: asString(editorDraft.logo_url).trim(),
      };

      const res = await apiFetch("/xadmin-api-companies", {
        method: "PUT",
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

      setItems((prev) => {
        const savedId = asString(savedCompany?.id || savedCompany?.company_id).trim();
        const matchId = editorOriginalId || savedId;
        if (!matchId) return [savedCompany, ...prev];

        let replaced = false;
        const next = prev.map((c) => {
          const cid = asString(c?.id || c?.company_id).trim();
          if (cid && cid === matchId) {
            replaced = true;
            return savedCompany;
          }
          return c;
        });

        return replaced ? next : [savedCompany, ...next];
      });

      toast.success("Company saved");
      setEditorOpen(false);
    } catch (e) {
      toast.error(e?.message || "Save failed");
    } finally {
      setEditorSaving(false);
    }
  }, [editorDraft, editorOriginalId]);

  const deleteCompany = useCallback(
    async (id) => {
      const safeId = asString(id).trim();
      if (!safeId) {
        toast.error("Missing company id");
        return false;
      }

      try {
        const res = await apiFetch("/xadmin-api-companies", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: safeId, actor: "admin_ui" }),
        });

        const body = await res.json().catch(() => ({}));
        if (!res.ok || body?.ok !== true) {
          const msg = (await getUserFacingConfigMessage(res)) || body?.error || `Delete failed (${res.status})`;
          toast.error(msg);
          return false;
        }

        setItems((prev) => prev.filter((c) => asString(c?.id || c?.company_id).trim() !== safeId));
        return true;
      } catch (e) {
        toast.error(e?.message || "Delete failed");
        return false;
      }
    },
    []
  );

  const deleteSelected = useCallback(async () => {
    const ids = selectedRows
      .map((r) => asString(r?.id || r?.company_id).trim())
      .filter(Boolean);

    if (ids.length === 0) return;

    const ok = window.confirm(`Delete ${ids.length} selected compan${ids.length === 1 ? "y" : "ies"}?`);
    if (!ok) return;

    let deleted = 0;
    for (const id of ids) {
      const success = await deleteCompany(id);
      if (success) deleted += 1;
    }

    if (deleted > 0) toast.success(`Deleted ${deleted} compan${deleted === 1 ? "y" : "ies"}`);
    setSelectedRows([]);
  }, [deleteCompany, selectedRows]);

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
        cell: (row) => <span className="text-xs text-slate-700">{toDisplayDate(row?.updated_at || row?.created_at)}</span>,
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
                <span key={t} className="rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-[11px] text-amber-900">
                  {t}
                </span>
              ))}
              {more > 0 ? (
                <span className="rounded-full bg-slate-50 border border-slate-200 px-2 py-0.5 text-[11px] text-slate-700">+{more}</span>
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
          const id = asString(row?.id || row?.company_id).trim();
          return (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => openEditorForCompany(row)}>
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="border-red-600 text-red-600 hover:bg-red-600 hover:text-white"
                onClick={async () => {
                  const ok = window.confirm(`Delete ${getCompanyName(row) || id || "this company"}?`);
                  if (!ok) return;
                  const did = await deleteCompany(id);
                  if (did) toast.success("Company deleted");
                }}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          );
        },
        width: "140px",
      },
    ];
  }, [deleteCompany, openEditorForCompany]);

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
                <Button variant="outline" onClick={() => loadCompanies()} disabled={loading}>
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
                  placeholder="Search name, keyword, domain…"
                  className="w-[320px]"
                />
                <Button
                  variant="outline"
                  onClick={() => loadCompanies({ search, take })}
                  disabled={loading}
                >
                  Search
                </Button>
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

              <div className="text-sm text-slate-600">Showing {filteredItems.length} companies</div>
            </div>
          </header>

          <section className="rounded-lg border border-slate-200 bg-white overflow-hidden">
            <DataTable
              columns={columns}
              data={filteredItems}
              progressPending={loading}
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
              noDataComponent={<div className="p-6 text-sm text-slate-600">No companies found.</div>}
            />
          </section>

          <Dialog open={editorOpen} onOpenChange={(open) => !editorSaving && setEditorOpen(open)}>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>{editorOriginalId ? "Edit company" : "New company"}</DialogTitle>
                <DialogDescription>
                  Update company fields and save to Cosmos. Missing fields are highlighted in the table.
                </DialogDescription>
              </DialogHeader>

              {editorDraft ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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

                  <div className="space-y-1">
                    <label className="text-sm text-slate-700">Logo URL</label>
                    <Input
                      value={asString(editorDraft.logo_url)}
                      onChange={(e) => setEditorDraft((d) => ({ ...d, logo_url: e.target.value }))}
                      placeholder="https://…"
                    />
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
                      onChange={(e) => setEditorDraft((d) => ({ ...d, manufacturing_locations: normalizeLocationList(e.target.value) }))}
                      placeholder="City, Region, Country; …"
                    />
                  </div>

                  <div className="md:col-span-2 space-y-1">
                    <label className="text-sm text-slate-700">Product keywords</label>
                    <Input
                      value={asString(editorDraft.product_keywords)}
                      onChange={(e) => setEditorDraft((d) => ({ ...d, product_keywords: e.target.value }))}
                      placeholder="running shoes, socks, …"
                    />
                  </div>

                  <div className="md:col-span-2 space-y-1">
                    <label className="text-sm text-slate-700">Notes</label>
                    <textarea
                      value={asString(editorDraft.notes)}
                      onChange={(e) => setEditorDraft((d) => ({ ...d, notes: e.target.value }))}
                      className="min-h-[120px] w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                      placeholder="Internal notes…"
                    />
                  </div>
                </div>
              ) : null}

              <DialogFooter>
                <Button variant="outline" onClick={() => setEditorOpen(false)} disabled={editorSaving}>
                  Cancel
                </Button>
                <Button onClick={saveEditor} disabled={editorSaving}>
                  <Save className="h-4 w-4 mr-2" />
                  {editorSaving ? "Saving…" : "Save"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </main>
      </div>
    </>
  );
}
