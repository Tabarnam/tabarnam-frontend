import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ClipLoader } from "react-spinners";
import {
  ChevronDown,
  ChevronUp,
  Columns,
  Download,
  Edit2,
  Plus,
  RefreshCcw,
  Search,
  Trash2,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
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
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import CompanyForm from "@/components/admin/CompanyForm";
import { getAdminUser } from "@/lib/azureAuth";
import { CompanyStarsBlock } from "@/components/results/CompanyStarsBlock";

const ITEMS_PER_PAGE = 50;

const DEFAULT_VISIBLE_COLUMNS = [
  "name",
  "industries",
  "reviews",
  "stars",
  "created",
  "updated",
  "actions",
];

function safeParseJSON(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function useDebouncedValue(value, delayMs) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);

  return debounced;
}

function formatDateShort(value) {
  const d = value ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  }).format(d);
}

function formatDateLong(value) {
  const d = value ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  return d.toLocaleString();
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function getCompanyName(c) {
  return c?.company_name || c?.name || "";
}

function getReviewCount(c) {
  return typeof c?.review_count === "number" ? c.review_count : 0;
}

function getKeywordsList(c) {
  return normalizeArray(c?.keywords);
}

function getManufacturingLocationsCount(c) {
  return normalizeArray(c?.manufacturing_locations).length;
}

function getHqLocationsCount(c) {
  if (Array.isArray(c?.headquarters) && c.headquarters.length) return c.headquarters.length;
  if (Array.isArray(c?.headquarters_locations) && c.headquarters_locations.length) return c.headquarters_locations.length;
  if (typeof c?.headquarters_location === "string" && c.headquarters_location.trim()) return 1;
  return 0;
}

function makeStorageKey(userEmail) {
  const safeEmail = String(userEmail || "anon").toLowerCase().trim() || "anon";
  return `admin.companiesTable.v1.${safeEmail}`;
}

function loadTableState(storageKey) {
  const fallback = {
    searchQuery: "",
    sortField: "updated",
    sortDir: "desc",
    visibleColumns: DEFAULT_VISIBLE_COLUMNS,
    pageIndex: 0,
  };

  if (typeof window === "undefined") return fallback;

  const raw = window.localStorage.getItem(storageKey);
  if (!raw) return fallback;

  const parsed = safeParseJSON(raw);
  if (!parsed || typeof parsed !== "object") return fallback;

  const visibleColumns = Array.isArray(parsed.visibleColumns) ? parsed.visibleColumns : DEFAULT_VISIBLE_COLUMNS;
  const normalizedVisible = ["name", ...visibleColumns.filter((c) => c !== "name" && c !== "actions"), "actions"];

  return {
    searchQuery: typeof parsed.searchQuery === "string" ? parsed.searchQuery : fallback.searchQuery,
    sortField: typeof parsed.sortField === "string" ? parsed.sortField : fallback.sortField,
    sortDir: parsed.sortDir === "asc" ? "asc" : "desc",
    visibleColumns: normalizedVisible.length ? normalizedVisible : fallback.visibleColumns,
    pageIndex: Number.isFinite(parsed.pageIndex) ? Math.max(0, parsed.pageIndex) : fallback.pageIndex,
  };
}

function saveTableState(storageKey, state) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // ignore
  }
}

const CompaniesTableTab = ({ loading: initialLoading, onUpdate }) => {
  const user = getAdminUser();
  const storageKey = useMemo(() => makeStorageKey(user?.email), [user?.email]);

  const [tableState, setTableState] = useState(() => loadTableState(storageKey));
  const debouncedSearchQuery = useDebouncedValue(tableState.searchQuery, 250);

  const [rows, setRows] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loadingRows, setLoadingRows] = useState(false);
  const [recalcCompanyId, setRecalcCompanyId] = useState(null);

  const [editingCompany, setEditingCompany] = useState(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [deleteCompanyId, setDeleteCompanyId] = useState(null);
  const [loadingEdit, setLoadingEdit] = useState(false);

  const fetchAbortRef = useRef({ aborted: false });

  useEffect(() => {
    setTableState(loadTableState(storageKey));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  useEffect(() => {
    saveTableState(storageKey, tableState);
  }, [storageKey, tableState]);

  const setSearchQuery = useCallback((q) => {
    setTableState((s) => ({ ...s, searchQuery: q, pageIndex: 0 }));
  }, []);

  const toggleSort = useCallback((field) => {
    setTableState((s) => {
      if (s.sortField !== field) return { ...s, sortField: field, sortDir: "asc", pageIndex: 0 };
      return { ...s, sortDir: s.sortDir === "asc" ? "desc" : "asc", pageIndex: 0 };
    });
  }, []);

  const setPageIndex = useCallback((next) => {
    setTableState((s) => ({ ...s, pageIndex: Math.max(0, next) }));
  }, []);

  const setVisibleColumns = useCallback((updater) => {
    setTableState((s) => {
      const next = typeof updater === "function" ? updater(s.visibleColumns) : updater;
      const list = Array.isArray(next) ? next : s.visibleColumns;
      const normalized = ["name", ...list.filter((c) => c !== "name" && c !== "actions"), "actions"];
      return { ...s, visibleColumns: normalized.length ? normalized : DEFAULT_VISIBLE_COLUMNS };
    });
  }, []);

  const fetchRows = useCallback(
    async ({ searchQuery, sortField, sortDir, pageIndex }) => {
      const take = ITEMS_PER_PAGE;
      const skip = pageIndex * ITEMS_PER_PAGE;

      const params = new URLSearchParams({
        sort: "recent",
        take: String(take),
        skip: String(skip),
      });

      const q = String(searchQuery || "").trim();
      if (q) params.set("q", q);

      if (sortField) params.set("sortField", String(sortField));
      if (sortDir) params.set("sortDir", String(sortDir));

      setLoadingRows(true);
      fetchAbortRef.current.aborted = false;

      try {
        const res = await apiFetch(`/search-companies?${params.toString()}`);
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(text || `Failed to load companies (${res.status})`);
        }

        const data = await res.json();
        const items = Array.isArray(data?.items) ? data.items : [];
        const count = Number(data?.count) || items.length;

        if (fetchAbortRef.current.aborted) return;
        setRows(items);
        setTotalCount(count);
      } catch (e) {
        if (fetchAbortRef.current.aborted) return;
        toast.error(e?.message || "Failed to load companies");
        setRows([]);
        setTotalCount(0);
      } finally {
        if (!fetchAbortRef.current.aborted) setLoadingRows(false);
      }
    },
    []
  );

  useEffect(() => {
    fetchRows({
      searchQuery: debouncedSearchQuery,
      sortField: tableState.sortField,
      sortDir: tableState.sortDir,
      pageIndex: tableState.pageIndex,
    });

    return () => {
      fetchAbortRef.current.aborted = true;
    };
  }, [debouncedSearchQuery, tableState.sortField, tableState.sortDir, tableState.pageIndex, fetchRows]);

  const totalPages = useMemo(() => {
    if (!totalCount) return 1;
    return Math.max(1, Math.ceil(totalCount / ITEMS_PER_PAGE));
  }, [totalCount]);

  useEffect(() => {
    if (tableState.pageIndex > totalPages - 1) {
      setPageIndex(Math.max(0, totalPages - 1));
    }
  }, [tableState.pageIndex, totalPages, setPageIndex]);

  const handleRecalcReviews = useCallback(async (company) => {
    const companyId = company?.id;
    if (!companyId) return;

    setRecalcCompanyId(companyId);
    try {
      const res = await apiFetch("/admin-recalc-review-counts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company_id: companyId }),
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok !== true) {
        throw new Error(body?.error || `Recalc failed (${res.status})`);
      }

      const counts = body?.counts || {};
      setRows((prev) =>
        prev.map((r) => {
          if (r?.id !== companyId) return r;
          const nextReviewCount = typeof counts.review_count === "number" ? counts.review_count : r.review_count;
          return {
            ...r,
            review_count: nextReviewCount,
            public_review_count:
              typeof counts.public_review_count === "number" ? counts.public_review_count : r.public_review_count,
            private_review_count:
              typeof counts.private_review_count === "number" ? counts.private_review_count : r.private_review_count,
            reviews_count: nextReviewCount,
          };
        })
      );

      toast.success("Review counts recalculated");
    } catch (e) {
      toast.error(e?.message || "Failed to recalc review counts");
    } finally {
      setRecalcCompanyId(null);
    }
  }, []);

  const handleEdit = useCallback(async (company) => {
    const companyId = company?.id;
    if (!companyId) return;

    setLoadingEdit(true);
    try {
      const res = await apiFetch(`/companies-list?id=${encodeURIComponent(companyId)}`);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Failed to load company (${res.status})`);
      }
      const data = await res.json();
      const full = data?.item || company;
      setEditingCompany(full);
      setIsFormOpen(true);
    } catch (e) {
      toast.error(e?.message || "Failed to open company");
    } finally {
      setLoadingEdit(false);
    }
  }, []);

  const columns = useMemo(() => {
    return [
      {
        id: "name",
        label: "Name",
        sortable: true,
        className: "text-left",
        render: (company) => (
          <div className="min-w-[220px]">
            <div className="font-medium text-slate-900">{getCompanyName(company) || "—"}</div>
            {company?.normalized_domain ? (
              <div className="text-xs text-slate-500">{company.normalized_domain}</div>
            ) : null}
          </div>
        ),
      },
      {
        id: "industries",
        label: "Industries",
        sortable: true,
        className: "text-left",
        render: (company) => {
          const industries = normalizeArray(company?.industries);
          if (!industries.length) return <span className="text-slate-400">—</span>;

          return (
            <div className="flex flex-wrap gap-1 max-w-[260px]">
              {industries.slice(0, 2).map((ind, i) => (
                <span key={`${ind}_${i}`} className="bg-blue-100 text-blue-700 text-xs px-2 py-0.5 rounded">
                  {ind}
                </span>
              ))}
              {industries.length > 2 ? (
                <span className="text-xs text-slate-500">+{industries.length - 2}</span>
              ) : null}
            </div>
          );
        },
      },
      {
        id: "keywords",
        label: "Keywords",
        sortable: false,
        className: "text-left",
        render: (company) => {
          const keywords = getKeywordsList(company);
          if (!keywords.length) return <span className="text-slate-400">0</span>;

          const preview = keywords.slice(0, 2).join(", ");
          return (
            <span className="text-slate-700" title={keywords.join(", ")}>
              {keywords.length} {keywords.length === 1 ? "keyword" : "keywords"}
              {preview ? <span className="text-slate-500"> · {preview}</span> : null}
            </span>
          );
        },
      },
      {
        id: "reviews",
        label: "Reviews",
        sortable: true,
        className: "text-center",
        render: (company) => <span className="font-medium text-slate-900">{getReviewCount(company)}</span>,
      },
      {
        id: "stars",
        label: "Stars",
        sortable: true,
        className: "text-right",
        render: (company) => <CompanyStarsBlock company={company} />,
      },
      {
        id: "manufacturing",
        label: "Manufacturing Locations",
        sortable: false,
        className: "text-center",
        render: (company) => (
          <span className="font-medium text-slate-900">{getManufacturingLocationsCount(company)}</span>
        ),
      },
      {
        id: "hq",
        label: "HQ / Home Locations",
        sortable: false,
        className: "text-center",
        render: (company) => <span className="font-medium text-slate-900">{getHqLocationsCount(company)}</span>,
      },
      {
        id: "created",
        label: "Created",
        sortable: true,
        className: "text-left",
        render: (company) => {
          const short = formatDateShort(company?.created_at);
          const long = formatDateLong(company?.created_at);
          return (
            <span className="text-slate-700" title={long}>
              {short}
            </span>
          );
        },
      },
      {
        id: "updated",
        label: "Updated",
        sortable: true,
        className: "text-left",
        render: (company) => {
          const short = formatDateShort(company?.updated_at);
          const long = formatDateLong(company?.updated_at);
          return (
            <span className="text-slate-700" title={long}>
              {short}
            </span>
          );
        },
      },
      {
        id: "actions",
        label: "Actions",
        sortable: false,
        className: "text-center",
        render: (company) => (
          <div className="flex justify-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void handleRecalcReviews(company)}
              className="text-slate-600 hover:bg-slate-50"
              title="Recalculate review count"
              aria-label={`Recalculate reviews for ${getCompanyName(company)}`}
              disabled={recalcCompanyId === company.id}
            >
              {recalcCompanyId === company.id ? (
                <ClipLoader size={14} />
              ) : (
                <RefreshCcw className="h-4 w-4" />
              )}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void handleEdit(company)}
              className="text-blue-600 hover:bg-blue-50"
              title="Edit company"
              aria-label={`Edit ${getCompanyName(company)}`}
              disabled={loadingEdit}
            >
              <Edit2 className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDeleteCompanyId(company.id)}
              className="text-red-600 hover:bg-red-50"
              title="Delete company"
              aria-label={`Delete ${getCompanyName(company)}`}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ),
      },
    ];
  }, [loadingEdit, recalcCompanyId, handleRecalcReviews, handleEdit]);

  const visibleColumns = useMemo(() => {
    const active = new Set(tableState.visibleColumns);
    active.add("name");
    active.add("actions");
    return columns.filter((c) => active.has(c.id));
  }, [columns, tableState.visibleColumns]);

  const handleDelete = useCallback(
    async (companyId) => {
      try {
        const deletePayload = { id: companyId, actor: user?.email };

        const res = await apiFetch("/companies-list", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(deletePayload),
        });

        const body = await res.json().catch(() => ({}));
        if (!res.ok || body?.ok === false) {
          throw new Error(body?.error || body?.detail || `Delete failed with status ${res.status}`);
        }

        toast.success("Company deleted");
        setDeleteCompanyId(null);
        onUpdate?.();

        fetchRows({
          searchQuery: debouncedSearchQuery,
          sortField: tableState.sortField,
          sortDir: tableState.sortDir,
          pageIndex: tableState.pageIndex,
        });
      } catch (e) {
        toast.error(e?.message || "Failed to delete company");
      }
    },
    [user?.email, onUpdate, fetchRows, debouncedSearchQuery, tableState.sortField, tableState.sortDir, tableState.pageIndex]
  );

  const handleExportCSV = useCallback(async () => {
    try {
      const q = String(tableState.searchQuery || "").trim();

      const all = [];
      const pageSize = 200;
      for (let skip = 0; skip < 500; skip += pageSize) {
        const params = new URLSearchParams({
          sort: "recent",
          take: String(pageSize),
          skip: String(skip),
        });
        if (q) params.set("q", q);
        if (tableState.sortField) params.set("sortField", tableState.sortField);
        if (tableState.sortDir) params.set("sortDir", tableState.sortDir);

        const res = await apiFetch(`/search-companies?${params.toString()}`);
        if (!res.ok) break;
        const data = await res.json().catch(() => null);
        const items = Array.isArray(data?.items) ? data.items : [];
        if (!items.length) break;
        all.push(...items);
        if (items.length < pageSize) break;
      }

      if (!all.length) {
        toast.error("No companies to export");
        return;
      }

      const headers = [
        "ID",
        "Name",
        "Industries",
        "Keywords",
        "Reviews",
        "Stars",
        "Manufacturing Locations",
        "HQ / Home Locations",
        "Created",
        "Updated",
      ];

      const rowsOut = all.map((c) => {
        const industries = normalizeArray(c?.industries).join("; ");
        const keywords = getKeywordsList(c).join("; ");
        return [
          c?.id || "",
          getCompanyName(c) || "",
          industries,
          keywords,
          String(getReviewCount(c)),
          String(c?.stars ?? c?.star_rating ?? c?.star_score ?? ""),
          String(getManufacturingLocationsCount(c)),
          String(getHqLocationsCount(c)),
          c?.created_at || "",
          c?.updated_at || "",
        ];
      });

      const csv = [headers, ...rowsOut]
        .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
        .join("\n");

      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `companies_${new Date().toISOString().split("T")[0]}.csv`;
      a.click();
      URL.revokeObjectURL(url);

      toast.success("Exported to CSV");
    } catch (e) {
      toast.error(e?.message || "Export failed");
    }
  }, [tableState.searchQuery, tableState.sortField, tableState.sortDir]);

  const isLoading = initialLoading || loadingRows;

  return (
    <div className="space-y-4">
      <div className="flex flex-col lg:flex-row gap-3 lg:items-center">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" />
          <Input
            placeholder="Search by product, keyword, company…"
            value={tableState.searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        <div className="flex flex-wrap gap-2 justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="border-slate-200">
                <Columns className="mr-2 h-4 w-4" /> Columns
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {columns
                .filter((c) => c.id !== "actions")
                .map((c) => {
                  const alwaysVisible = c.id === "name";
                  const checked = tableState.visibleColumns.includes(c.id);
                  return (
                    <DropdownMenuCheckboxItem
                      key={c.id}
                      checked={checked}
                      disabled={alwaysVisible}
                      onCheckedChange={(next) => {
                        const shouldShow = next === true;
                        setVisibleColumns((prev) => {
                          const set = new Set(prev);
                          if (shouldShow) set.add(c.id);
                          else set.delete(c.id);
                          set.add("name");
                          set.add("actions");
                          return Array.from(set);
                        });
                      }}
                    >
                      {c.label}
                    </DropdownMenuCheckboxItem>
                  );
                })}
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem checked disabled>
                Actions
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            onClick={() => {
              setEditingCompany(null);
              setIsFormOpen(true);
            }}
            className="bg-[#B1DDE3] text-slate-900 hover:bg-[#A0C8D0]"
          >
            <Plus className="mr-2 h-4 w-4" /> Add Company
          </Button>

          <Button variant="outline" onClick={() => void handleExportCSV()} className="border-[#B1DDE3] text-slate-900">
            <Download className="mr-2 h-4 w-4" /> Export CSV
          </Button>
        </div>
      </div>

      <div className="flex items-center justify-between text-sm text-slate-600">
        <div>
          Showing {rows.length} companies
          {tableState.searchQuery.trim() ? " (filtered)" : ""}
        </div>
        <div className="flex items-center gap-2">
          {loadingEdit ? <ClipLoader size={16} color="#94A3B8" /> : null}
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center items-center py-12">
          <ClipLoader color="#B1DDE3" size={40} />
        </div>
      ) : (
        <div className="overflow-x-auto border border-slate-200 rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                {visibleColumns.map((col) => {
                  const isSorted = tableState.sortField === col.id;
                  const canSort = col.sortable;

                  return (
                    <th
                      key={col.id}
                      className={`p-3 font-semibold text-slate-700 ${col.className || "text-left"}`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          if (canSort) toggleSort(col.id);
                        }}
                        className={canSort ? "inline-flex items-center gap-1 hover:text-slate-900" : "inline-flex items-center"}
                        aria-label={canSort ? `Sort by ${col.label}` : col.label}
                      >
                        {col.label}
                        {canSort && isSorted ? (
                          tableState.sortDir === "asc" ? (
                            <ChevronUp className="h-4 w-4" />
                          ) : (
                            <ChevronDown className="h-4 w-4" />
                          )
                        ) : null}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((company) => (
                <tr key={company.id} className="border-b border-slate-200 hover:bg-slate-50 transition">
                  {visibleColumns.map((col) => (
                    <td
                      key={`${company.id}_${col.id}`}
                      className={`p-3 align-middle ${col.className || "text-left"}`}
                    >
                      {col.render(company)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>

          {rows.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-slate-500">No companies found. {tableState.searchQuery.trim() ? "Try a different search." : ""}</p>
            </div>
          ) : null}
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-2 items-center justify-between">
        <div className="text-sm text-slate-600">
          Page {Math.min(tableState.pageIndex + 1, totalPages)} of {totalPages}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setPageIndex(tableState.pageIndex - 1)}
            disabled={tableState.pageIndex <= 0}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            onClick={() => setPageIndex(tableState.pageIndex + 1)}
            disabled={tableState.pageIndex >= totalPages - 1}
          >
            Next
          </Button>
        </div>
      </div>

      <CompanyForm
        isOpen={isFormOpen}
        onClose={() => {
          setIsFormOpen(false);
          setEditingCompany(null);
        }}
        company={editingCompany}
        onSuccess={() => {
          onUpdate?.();
          fetchRows({
            searchQuery: debouncedSearchQuery,
            sortField: tableState.sortField,
            sortDir: tableState.sortDir,
            pageIndex: tableState.pageIndex,
          });
        }}
      />

      <AlertDialog open={!!deleteCompanyId} onOpenChange={(open) => !open && setDeleteCompanyId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Company</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this company? This action is tracked and can be undone from the History tab.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteCompanyId && void handleDelete(deleteCompanyId)}
              className="bg-red-600 hover:bg-red-700"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default CompaniesTableTab;
