import React, { useCallback, useEffect, useState } from "react";
import { apiFetch, readJsonOrText } from "@/lib/api";
import { Button } from "@/components/ui/button";
import AdminHeader from "@/components/AdminHeader";

const SEARCHABLE_FIELDS = [
  { key: "industries", label: "Industries", isArray: true },
  { key: "keywords", label: "Products (array)", isArray: true },
  { key: "product_keywords", label: "Products", isArray: false },
  { key: "tagline", label: "Tagline", isArray: false },
  { key: "headquarters_location", label: "HQ", isArray: false },
  { key: "manufacturing_locations", label: "Manufacturing", isArray: true },
  { key: "company_name", label: "Company Name", isArray: false },
];

export default function AdminSearchEdit() {
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedFields, setSelectedFields] = useState(["industries"]);
  const [companies, setCompanies] = useState([]);
  const [results, setResults] = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [sortBy, setSortBy] = useState("updated_at"); // "name" | "updated_at"
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [actionInProgress, setActionInProgress] = useState(false);
  const [lastAction, setLastAction] = useState(null);

  // Load all companies on mount
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        // Load companies — try largest batch first, fall back to smaller if API times out
        let items = [];
        for (const take of [5000, 2000, 1000]) {
          try {
            const res = await apiFetch(`/xadmin-api-companies?take=${take}`);
            if (!res.ok) continue;
            const data = await readJsonOrText(res);
            items = Array.isArray(data) ? data : data?.items || data?.companies || [];
            if (items.length > 0) break;
          } catch {
            continue;
          }
        }
        setCompanies(items);
      } catch (e) {
        console.error("Failed to load companies:", e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const toggleField = (key) => {
    setSelectedFields((prev) =>
      prev.includes(key) ? prev.filter((f) => f !== key) : [...prev, key]
    );
  };

  const handleSearch = useCallback(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term || selectedFields.length === 0) {
      setResults([]);
      setSelectedIds(new Set());
      return;
    }

    setSearching(true);
    const matched = [];

    for (const company of companies) {
      const matchedFields = [];

      for (const fieldDef of SEARCHABLE_FIELDS) {
        if (!selectedFields.includes(fieldDef.key)) continue;

        const val = company[fieldDef.key];
        if (fieldDef.isArray && Array.isArray(val)) {
          if (val.some((item) => String(item).toLowerCase().includes(term))) {
            matchedFields.push(fieldDef.label);
          }
        } else if (typeof val === "string" && val.toLowerCase().includes(term)) {
          matchedFields.push(fieldDef.label);
        }
      }

      if (matchedFields.length > 0) {
        matched.push({
          id: company.id,
          company_name: company.company_name || company.name || "(unnamed)",
          domain: company.normalized_domain || company.domain || "",
          updated_at: company.updated_at || "",
          matchedFields,
          company,
        });
      }
    }

    if (sortBy === "updated_at") {
      matched.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
    } else {
      matched.sort((a, b) => a.company_name.localeCompare(b.company_name));
    }
    setResults(matched);
    setSelectedIds(new Set(matched.map((r) => r.id)));
    setSearching(false);
  }, [searchTerm, selectedFields, companies]);

  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelectedIds(new Set(results.map((r) => r.id)));
  const deselectAll = () => setSelectedIds(new Set());

  const handleRemove = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;

    const term = searchTerm.trim();
    if (!term) return;

    if (!window.confirm(`Remove "${term}" from ${ids.length} companies across fields: ${selectedFields.join(", ")}?`)) {
      return;
    }

    setActionInProgress(true);
    let totalUpdated = 0;

    try {
      for (const fieldKey of selectedFields) {
        const fieldDef = SEARCHABLE_FIELDS.find((f) => f.key === fieldKey);
        if (!fieldDef) continue;

        // Filter to only companies that actually have this term in this field
        const relevantIds = ids.filter((id) => {
          const r = results.find((r) => r.id === id);
          return r?.matchedFields.includes(fieldDef.label);
        });

        if (relevantIds.length === 0) continue;

        const operation = fieldDef.isArray ? "remove_from_array" : "set";
        const value = fieldDef.isArray ? term : "";

        const res = await apiFetch("/xadmin-api-batch-update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            field: fieldKey,
            value,
            operation,
            companyIds: relevantIds,
            actor: "admin",
          }),
        });

        const data = await readJsonOrText(res);
        if (data?.ok) {
          totalUpdated += data.updated || 0;
        }
      }

      setLastAction({ type: "remove", term, count: totalUpdated });
      // Clear results after successful removal
      setResults([]);
      setSelectedIds(new Set());
      setSearchTerm("");
    } catch (e) {
      console.error("Batch remove failed:", e);
      setLastAction({ type: "error", message: e?.message || "Failed" });
    } finally {
      setActionInProgress(false);
    }
  };

  return (
    <div className="min-h-screen bg-white dark:bg-background">
      <AdminHeader />

      <div className="max-w-5xl mx-auto p-6 space-y-6">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-foreground">Search & Edit</h1>

        {/* Search input */}
        <div className="space-y-3">
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Search term (e.g., Puzzle Manufacturing)"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              className="flex-1 rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted px-3 py-2 text-sm text-slate-800 dark:text-foreground placeholder:text-slate-400"
            />
            <Button onClick={handleSearch} disabled={!searchTerm.trim() || loading}>
              Search
            </Button>
          </div>

          {/* Field checkboxes */}
          <div className="flex flex-wrap gap-2">
            {SEARCHABLE_FIELDS.map((f) => (
              <label
                key={f.key}
                className="flex items-center gap-1.5 rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted px-2.5 py-1.5 text-xs text-slate-700 dark:text-foreground cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selectedFields.includes(f.key)}
                  onChange={() => toggleField(f.key)}
                  className="rounded"
                />
                {f.label}
              </label>
            ))}
          </div>
        </div>

        {/* Loading state */}
        {loading && <div className="text-sm text-slate-500">Loading companies...</div>}
        {!loading && companies.length > 0 && results.length === 0 && !searchTerm && (
          <div className="text-sm text-slate-500 dark:text-muted-foreground">{companies.length} companies loaded. Enter a search term above.</div>
        )}

        {/* Last action feedback */}
        {lastAction && (
          <div className={`rounded px-4 py-2 text-sm ${lastAction.type === "error" ? "bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300" : "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-800 dark:text-emerald-300"}`}>
            {lastAction.type === "remove"
              ? `Removed "${lastAction.term}" from ${lastAction.count} companies.`
              : `Error: ${lastAction.message}`}
          </div>
        )}

        {/* Results */}
        {results.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-600 dark:text-muted-foreground">
                {results.length} companies found — {selectedIds.size} selected
              </span>
              <div className="flex items-center gap-2">
                <select
                  value={sortBy}
                  onChange={(e) => {
                    setSortBy(e.target.value);
                    setResults((prev) => {
                      const sorted = [...prev];
                      if (e.target.value === "updated_at") {
                        sorted.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
                      } else {
                        sorted.sort((a, b) => a.company_name.localeCompare(b.company_name));
                      }
                      return sorted;
                    });
                  }}
                  className="rounded border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted px-2 py-1 text-xs text-slate-700 dark:text-foreground"
                >
                  <option value="updated_at">Sort: Last updated</option>
                  <option value="name">Sort: Name A-Z</option>
                </select>
                <Button variant="ghost" size="sm" onClick={selectAll}>Select all</Button>
                <Button variant="ghost" size="sm" onClick={deselectAll}>Deselect all</Button>
              </div>
            </div>

            <div className="rounded border border-slate-200 dark:border-border divide-y divide-slate-100 dark:divide-border max-h-[60vh] overflow-y-auto">
              {results.map((r) => (
                <label
                  key={r.id}
                  className={`flex items-center gap-3 px-3 py-2 text-sm cursor-pointer hover:bg-slate-50 dark:hover:bg-muted ${
                    selectedIds.has(r.id) ? "bg-white dark:bg-background" : "bg-slate-50/50 dark:bg-muted/50 opacity-60"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(r.id)}
                    onChange={() => toggleSelect(r.id)}
                    className="rounded"
                  />
                  <div className="flex-1 min-w-0">
                    <span className="font-medium text-slate-800 dark:text-foreground">{r.company_name}</span>
                    <span className="ml-2 text-xs text-slate-500 dark:text-muted-foreground">{r.domain}</span>
                    {r.updated_at && (
                      <span className="ml-2 text-[10px] text-slate-400 dark:text-muted-foreground">
                        {new Date(r.updated_at).toLocaleDateString()} {new Date(r.updated_at).toLocaleTimeString()}
                      </span>
                    )}
                  </div>
                  <div className="flex gap-1">
                    {r.matchedFields.map((f) => (
                      <span key={f} className="rounded bg-blue-100 dark:bg-blue-900/30 px-1.5 py-0.5 text-[10px] text-blue-800 dark:text-blue-300">
                        {f}
                      </span>
                    ))}
                  </div>
                </label>
              ))}
            </div>

            <div className="flex gap-2">
              <Button
                variant="destructive"
                onClick={handleRemove}
                disabled={selectedIds.size === 0 || actionInProgress}
              >
                {actionInProgress ? "Removing..." : `Remove "${searchTerm}" from ${selectedIds.size} companies`}
              </Button>
            </div>
          </div>
        )}

        {results.length === 0 && searchTerm && !searching && !loading && (
          <div className="text-sm text-slate-500 dark:text-muted-foreground">No companies found matching "{searchTerm}" in the selected fields.</div>
        )}
      </div>
    </div>
  );
}
