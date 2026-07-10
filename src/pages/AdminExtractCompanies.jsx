import React, { useCallback, useMemo, useRef, useState } from "react";
import { Helmet } from "react-helmet-async";
import {
  Loader2, Search, Copy, Check, Download, AlertTriangle, Store, ExternalLink, X, Undo2, Globe,
} from "lucide-react";

import AdminHeader from "@/components/AdminHeader";
import { Button } from "@/components/ui/button";
import { apiFetch, readJsonOrText } from "@/lib/api";

// Reconcile against the corpus using the SAME endpoint /admin/import uses, so
// duplicate detection can't drift between the two tools. Preflight fires a few
// Cosmos queries per entry, so we send names in bounded batches (not hundreds
// at once) to avoid an RU storm on the single warm worker.
const PREFLIGHT_BATCH = 20;
// xAI URL lookup is slow (web search per name) — smaller batches keep each
// request within the invocation budget; the endpoint fans out internally.
const URL_LOOKUP_BATCH = 10;

const FILTERS = [
  { key: "all", label: "All" },
  { key: "no_match", label: "New" },
  { key: "fuzzy_match", label: "Possible" },
  { key: "exact_match", label: "Exact" },
];

// How preflight's match_type codes read to a human.
const MATCH_TYPE_LABEL = {
  normalized_domain: "domain",
  canonical_url: "URL",
  company_name: "name",
  fuzzy_name: "name similarity",
  domain_substring: "domain",
};

function csvField(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const STATUS_LABEL = {
  no_match: "New",
  exact_match: "Exact match",
  fuzzy_match: "Possible match",
  pending: "Checking",
  error: "Check failed",
};

export default function AdminExtractCompanies() {
  const [url, setUrl] = useState("https://mammothnation.com/");
  const [maxPages, setMaxPages] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [meta, setMeta] = useState(null);         // { source, url, pages_fetched, truncated, ... }
  const [rows, setRows] = useState([]);           // [{ name, product_count, status, match }]
  const [extracting, setExtracting] = useState(false);
  const [extractProgress, setExtractProgress] = useState({ pages: 0, companies: 0 });
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [urlLooking, setUrlLooking] = useState(false);
  const [urlProgress, setUrlProgress] = useState({ done: 0, total: 0 });
  const [urlModel, setUrlModel] = useState(null);
  const [filter, setFilter] = useState("all");
  const [copied, setCopied] = useState(false);

  const history = useRef([]);                      // undo stack of prior `rows` snapshots
  const [canUndo, setCanUndo] = useState(false);
  const runIdRef = useRef(0);                      // guards against stale preflight results
  const copyTimer = useRef(null);

  const counts = useMemo(() => {
    const c = { total: rows.length, no_match: 0, exact_match: 0, fuzzy_match: 0, pending: 0, error: 0 };
    for (const r of rows) c[r.status] = (c[r.status] || 0) + 1;
    return c;
  }, [rows]);

  const visibleRows = useMemo(() => {
    if (filter === "all") return rows;
    return rows.filter((r) => r.status === filter);
  }, [rows, filter]);

  // ── Reconcile: run import-preflight over the names in bounded batches ──
  const runPreflight = useCallback(async (names, runId) => {
    setChecking(true);
    setProgress({ done: 0, total: names.length });
    try {
      for (let i = 0; i < names.length; i += PREFLIGHT_BATCH) {
        if (runIdRef.current !== runId) return; // superseded by a newer extraction
        const batch = names.slice(i, i + PREFLIGHT_BATCH);
        let results = [];
        try {
          const res = await apiFetch("/import-preflight", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ entries: batch.map((name) => ({ company_name: name })) }),
          });
          const data = await readJsonOrText(res);
          if (res.ok && data?.ok && Array.isArray(data.results)) results = data.results;
          else throw new Error(data?.error || `HTTP ${res.status}`);
        } catch {
          // Mark this batch as check-failed but keep going.
          results = batch.map((_, idx) => ({ index: idx, status: "error", match: null }));
        }
        if (runIdRef.current !== runId) return;

        // Map results back to rows by name (stable even if rows were removed).
        const byName = new Map();
        for (const r of results) {
          const name = batch[r.index];
          if (name != null) byName.set(name, r);
        }
        setRows((prev) =>
          prev.map((row) => {
            const r = byName.get(row.name);
            return r ? { ...row, status: r.status, match: r.match || null } : row;
          })
        );
        setProgress({ done: Math.min(i + batch.length, names.length), total: names.length });
      }
    } finally {
      if (runIdRef.current === runId) setChecking(false);
    }
  }, []);

  const runExtract = useCallback(async () => {
    setLoading(true);
    setError(null);
    setMeta(null);
    setRows([]);
    setFilter("all");
    setUrlModel(null);
    history.current = [];
    setCanUndo(false);
    const runId = ++runIdRef.current;
    setExtracting(true);
    setExtractProgress({ pages: 0, companies: 0 });

    // Optional client-side page cap from the Max pages input.
    const userMax = (() => {
      const n = Number(String(maxPages).trim());
      return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
    })();
    const byKey = new Map(); // lowercased name -> accumulated row across chunks

    try {
      let page = 1;
      // Loop chunks until the server says done (or the user's page cap is hit),
      // rendering rows + a ticker as each chunk arrives.
      while (true) {
        if (runIdRef.current !== runId) return;
        const res = await apiFetch("/xadmin-api-extract-companies", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: url.trim(), page }),
        });
        const data = await readJsonOrText(res);
        if (!res.ok || (data && data.ok === false)) {
          throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
        }
        if (runIdRef.current !== runId) return;

        for (const c of data.companies || []) {
          const key = String(c.name || "").toLowerCase();
          if (!key) continue;
          const existing = byKey.get(key);
          if (existing) existing.product_count = (existing.product_count || 0) + (c.product_count || 0);
          else byKey.set(key, {
            name: c.name,
            product_count: c.product_count ?? null,
            status: "pending",
            match: null,
            website_url: "",
            url_status: "idle", // idle | looking | done | not_found | error
            url_confidence: null,
          });
        }
        const merged = [...byKey.values()].sort((a, b) =>
          a.name.localeCompare(b.name, "en", { sensitivity: "base" })
        );
        setRows(merged);
        setExtractProgress({ pages: data.to_page || page, companies: merged.length });

        const reachedUserMax = userMax != null && Number(data.to_page) >= userMax;
        const stop = data.done || data.next_page == null || reachedUserMax;
        setMeta({
          source: data.source,
          url: data.url,
          pages_fetched: data.to_page,
          truncated: data.truncated || (reachedUserMax && !data.done),
          truncated_reason: data.truncated ? data.truncated_reason : (reachedUserMax && !data.done ? "max_pages" : data.truncated_reason),
          count: merged.length,
        });
        if (stop) break;
        page = data.next_page;
      }

      if (runIdRef.current !== runId) return;
      setExtracting(false);
      // Reconcile the full accumulated set against the corpus.
      runPreflight([...byKey.values()].map((r) => r.name), runId);
    } catch (e) {
      if (runIdRef.current === runId) { setError(e?.message || "Extraction failed"); setExtracting(false); }
    } finally {
      if (runIdRef.current === runId) setLoading(false);
    }
  }, [url, maxPages, runPreflight]);

  // ── URL capture (pipeline step 3): resolve New companies' real websites ──
  const runUrlLookup = useCallback(async () => {
    // Snapshot the names to look up: New (no_match) rows without a URL yet.
    const targets = rows
      .filter((r) => r.status === "no_match" && !r.website_url && r.url_status !== "looking")
      .map((r) => r.name);
    if (targets.length === 0) return;

    const runId = runIdRef.current; // stays valid until a new extraction supersedes
    setUrlLooking(true);
    setUrlProgress({ done: 0, total: targets.length });
    setRows((prev) => prev.map((r) => (targets.includes(r.name) ? { ...r, url_status: "looking" } : r)));

    try {
      for (let i = 0; i < targets.length; i += URL_LOOKUP_BATCH) {
        if (runIdRef.current !== runId) return;
        const batch = targets.slice(i, i + URL_LOOKUP_BATCH);
        let results = [];
        try {
          const res = await apiFetch("/xadmin-api-extract-lookup-urls", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ companies: batch, source_url: meta?.url }),
          });
          const data = await readJsonOrText(res);
          if (res.ok && data?.ok && Array.isArray(data.results)) {
            results = data.results;
            if (data.model) setUrlModel(data.model);
          } else throw new Error(data?.error || `HTTP ${res.status}`);
        } catch {
          results = batch.map((name) => ({ name, found: false, website_url: "", error: "lookup_failed" }));
        }
        if (runIdRef.current !== runId) return;

        const byName = new Map(results.map((r) => [r.name, r]));
        setRows((prev) =>
          prev.map((row) => {
            const r = byName.get(row.name);
            if (!r) return row;
            return {
              ...row,
              website_url: r.found ? r.website_url : "",
              url_confidence: r.confidence ?? null,
              url_status: r.found ? "done" : (r.error === "not_found" ? "not_found" : "error"),
            };
          })
        );
        setUrlProgress({ done: Math.min(i + batch.length, targets.length), total: targets.length });
      }
    } finally {
      if (runIdRef.current === runId) setUrlLooking(false);
    }
  }, [rows, meta]);

  // ── Row actions (mirror /admin/import succession-table tools) ──
  const pushHistory = useCallback((snapshot) => {
    history.current.push(snapshot);
    setCanUndo(true);
  }, []);

  const removeRow = useCallback((name) => {
    setRows((prev) => {
      pushHistory(prev);
      return prev.filter((r) => r.name !== name);
    });
  }, [pushHistory]);

  const removeByStatus = useCallback((status) => {
    setRows((prev) => {
      if (!prev.some((r) => r.status === status)) return prev;
      pushHistory(prev);
      return prev.filter((r) => r.status !== status);
    });
  }, [pushHistory]);

  const undo = useCallback(() => {
    const snap = history.current.pop();
    if (snap) setRows(snap);
    setCanUndo(history.current.length > 0);
  }, []);

  // ── Excel-ready export of the current (curated) rows ──
  const exportColumns = ["Company", "Status", "Matched company", "Match type", "Products", "Website", "Confidence"];
  const rowToCells = useCallback((r) => ([
    r.name,
    STATUS_LABEL[r.status] || r.status,
    r.match?.company_name || "",
    r.match ? (MATCH_TYPE_LABEL[r.match.match_type] || r.match.match_type || "") : "",
    r.product_count ?? "",
    r.website_url || "", // real company website — filled by the xAI lookup step
    r.website_url && Number.isFinite(r.url_confidence) ? `${Math.round(r.url_confidence * 100)}%` : "",
  ]), []);

  const handleCopy = useCallback(async () => {
    const lines = [exportColumns.join("\t")];
    for (const r of visibleRows) lines.push(rowToCells(r).map((v) => String(v ?? "").replace(/\t/g, " ")).join("\t"));
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Clipboard blocked by browser — use Download CSV instead.");
    }
  }, [visibleRows, rowToCells, exportColumns]);

  const handleDownloadCsv = useCallback(() => {
    const lines = [exportColumns.map(csvField).join(",")];
    for (const r of visibleRows) lines.push(rowToCells(r).map(csvField).join(","));
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const host = (() => { try { return new URL(meta?.url || url).hostname; } catch { return "companies"; } })();
    const a = document.createElement("a");
    a.href = href; a.download = `${host}-companies.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(href);
  }, [visibleRows, rowToCells, exportColumns, meta, url]);

  const matchHref = (id) => `/admin?company_id=${encodeURIComponent(id)}`;

  return (
    <>
      <Helmet><title>Admin - Extract Companies</title></Helmet>
      <AdminHeader />

      <div className="bg-slate-950 min-h-screen p-6">
        <div className="max-w-[1200px] mx-auto">
          <h1 className="text-2xl font-bold text-white mb-1">Extract Companies</h1>
          <p className="text-slate-400 text-sm mb-6">
            Pull the companies selling on a marketplace, reconcile each against the Tabarnam corpus
            using the same duplicate detection as <a href="/admin/import" className="text-teal-400 hover:underline">Import</a>
            {" "}(exact match / possible duplicate), curate the list, then copy it into Excel. Shopify
            storefronts (like Mammoth Nation) are auto-detected via per-product vendor data. Finding
            each <span className="text-emerald-300">New</span> company&apos;s real website via xAI is a
            follow-up step.
          </p>

          {/* Input */}
          <section className="rounded-lg border border-slate-800 bg-slate-900 p-4 mb-6">
            <div className="grid grid-cols-1 md:grid-cols-[1fr_160px_auto] gap-3 items-end">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Website URL</label>
                <input
                  type="text" value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !loading) runExtract(); }}
                  placeholder="https://mammothnation.com/"
                  className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-100"
                />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Max pages (blank = auto)</label>
                <input
                  type="number" min={1} value={maxPages}
                  onChange={(e) => setMaxPages(e.target.value)} placeholder="auto"
                  className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-100"
                />
              </div>
              <Button onClick={runExtract} disabled={loading || !url.trim()} className="bg-teal-600 hover:bg-teal-500 text-white h-[38px]">
                {loading ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Search className="w-4 h-4 mr-1" />}
                Extract
              </Button>
            </div>
          </section>

          {error && (
            <div className="bg-red-900/30 border border-red-700 text-red-300 rounded p-3 mb-4 text-sm flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Extraction ticker — pages/companies stream in as chunks arrive */}
          {extracting && (
            <div className="mb-4">
              <div className="flex items-center gap-2 text-sm text-slate-300 mb-1">
                <Loader2 className="w-4 h-4 animate-spin text-teal-400" />
                Extracting… page {extractProgress.pages} · <span className="text-teal-300 font-medium">{extractProgress.companies.toLocaleString()}</span> companies found
              </div>
              <div className="w-full h-1.5 bg-slate-800 rounded overflow-hidden">
                <div className="h-full w-1/3 bg-teal-500 animate-pulse" />
              </div>
            </div>
          )}

          {meta && (
            <>
              {/* Summary */}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
                <div className="rounded-lg border border-slate-800 bg-slate-900 p-3">
                  <div className="text-xs uppercase text-slate-500 tracking-wider">Remaining</div>
                  <div className="text-2xl font-semibold text-white">{counts.total.toLocaleString()}</div>
                  <div className="text-xs text-slate-500">of {meta.count?.toLocaleString?.() ?? meta.count} found</div>
                </div>
                <div className="rounded-lg border border-emerald-900/50 bg-emerald-950/30 p-3">
                  <div className="text-xs uppercase text-emerald-300/80 tracking-wider">New</div>
                  <div className="text-2xl font-semibold text-emerald-300">{counts.no_match.toLocaleString()}</div>
                </div>
                <div className="rounded-lg border border-amber-900/50 bg-amber-950/30 p-3">
                  <div className="text-xs uppercase text-amber-300/80 tracking-wider">Possible dup</div>
                  <div className="text-2xl font-semibold text-amber-300">{counts.fuzzy_match.toLocaleString()}</div>
                </div>
                <div className="rounded-lg border border-rose-900/50 bg-rose-950/30 p-3">
                  <div className="text-xs uppercase text-rose-300/80 tracking-wider">Exact match</div>
                  <div className="text-2xl font-semibold text-rose-300">{counts.exact_match.toLocaleString()}</div>
                </div>
                <div className="rounded-lg border border-slate-800 bg-slate-900 p-3">
                  <div className="text-xs uppercase text-slate-500 tracking-wider flex items-center gap-1"><Store className="w-3 h-3" /> Source</div>
                  <div className="text-lg font-semibold text-slate-200 capitalize">{meta.source}</div>
                  <div className="text-xs text-slate-500">{meta.pages_fetched} pages</div>
                </div>
              </div>

              {/* Notices */}
              {meta.truncated && (
                <div className="bg-amber-900/25 border border-amber-700/60 text-amber-300 rounded p-3 mb-4 text-sm flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span>
                    List may be incomplete (stopped: <code className="text-amber-200">{meta.truncated_reason}</code>).
                    {meta.truncated_reason === "rate_limited" && " The site rate-limited us — try again in a minute."}
                    {meta.truncated_reason === "max_pages" && " Raise Max pages to fetch more."}
                  </span>
                </div>
              )}

              {/* Reconcile progress */}
              {checking && (
                <div className="mb-4">
                  <div className="flex items-center gap-2 text-sm text-slate-400 mb-1">
                    <Loader2 className="w-4 h-4 animate-spin text-teal-400" />
                    Reconciling against corpus… {progress.done}/{progress.total}
                  </div>
                  <div className="w-full h-1.5 bg-slate-800 rounded overflow-hidden">
                    <div className="h-full bg-teal-500 transition-all" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
                  </div>
                </div>
              )}

              {/* URL lookup progress */}
              {urlLooking && (
                <div className="mb-4">
                  <div className="flex items-center gap-2 text-sm text-slate-400 mb-1">
                    <Loader2 className="w-4 h-4 animate-spin text-sky-400" />
                    Finding websites via xAI{urlModel ? ` (${urlModel})` : ""}… {urlProgress.done}/{urlProgress.total}
                  </div>
                  <div className="w-full h-1.5 bg-slate-800 rounded overflow-hidden">
                    <div className="h-full bg-sky-500 transition-all" style={{ width: `${urlProgress.total ? (urlProgress.done / urlProgress.total) * 100 : 0}%` }} />
                  </div>
                </div>
              )}

              {/* Toolbar */}
              <div className="flex flex-wrap items-center gap-2 mb-3">
                <div className="flex rounded-md border border-slate-700 overflow-hidden">
                  {FILTERS.map((f) => (
                    <button key={f.key} onClick={() => setFilter(f.key)}
                      className={`px-3 py-1.5 text-sm ${filter === f.key ? "bg-teal-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}>
                      {f.label}
                    </button>
                  ))}
                </div>

                {counts.exact_match > 0 && (
                  <Button onClick={() => removeByStatus("exact_match")} variant="outline"
                    className="border-rose-600/50 text-rose-300 hover:bg-rose-900/30 h-8 px-2 text-xs">
                    <X className="w-3.5 h-3.5 mr-1" /> Remove exact ({counts.exact_match})
                  </Button>
                )}
                {counts.fuzzy_match > 0 && (
                  <Button onClick={() => removeByStatus("fuzzy_match")} variant="outline"
                    className="border-amber-600/50 text-amber-300 hover:bg-amber-900/30 h-8 px-2 text-xs">
                    <X className="w-3.5 h-3.5 mr-1" /> Remove possible ({counts.fuzzy_match})
                  </Button>
                )}
                {canUndo && (
                  <Button onClick={undo} variant="ghost" className="text-slate-300 hover:bg-slate-800 h-8 px-2 text-xs">
                    <Undo2 className="w-3.5 h-3.5 mr-1" /> Undo
                  </Button>
                )}

                {counts.no_match > 0 && (
                  <Button onClick={runUrlLookup} disabled={urlLooking || checking}
                    className="bg-sky-700 hover:bg-sky-600 text-white h-8 px-2 text-xs">
                    {urlLooking ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Globe className="w-3.5 h-3.5 mr-1" />}
                    Find URLs for New
                  </Button>
                )}

                <span className="text-xs text-slate-500 ml-1">{visibleRows.length.toLocaleString()} shown</span>
                <div className="ml-auto flex gap-2">
                  <Button onClick={handleCopy} variant="outline" className="border-slate-600 text-slate-200 hover:bg-slate-800">
                    {copied ? <Check className="w-4 h-4 mr-1 text-emerald-400" /> : <Copy className="w-4 h-4 mr-1" />}
                    {copied ? "Copied" : "Copy for Excel"}
                  </Button>
                  <Button onClick={handleDownloadCsv} variant="outline" className="border-slate-600 text-slate-200 hover:bg-slate-800">
                    <Download className="w-4 h-4 mr-1" /> CSV
                  </Button>
                </div>
              </div>

              {/* Table */}
              <div className="rounded-lg border border-slate-800 overflow-hidden">
                <div className="max-h-[60vh] overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-slate-900 text-slate-400 text-xs uppercase tracking-wider">
                      <tr>
                        <th className="text-left font-medium px-3 py-2">Company</th>
                        <th className="text-left font-medium px-3 py-2 w-56">Status</th>
                        <th className="text-left font-medium px-3 py-2 w-56">Website</th>
                        <th className="text-right font-medium px-3 py-2 w-20">Products</th>
                        <th className="w-10 px-2 py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {visibleRows.map((r) => (
                        <tr key={r.name} className={`border-t border-slate-800 ${
                          r.status === "exact_match" ? "bg-rose-950/10" :
                          r.status === "fuzzy_match" ? "bg-amber-950/10" :
                          r.status === "no_match" ? "bg-emerald-950/10" : ""
                        }`}>
                          <td className="px-3 py-1.5 text-slate-100">{r.name}</td>
                          <td className="px-3 py-1.5">
                            <StatusCell row={r} matchHref={matchHref} />
                          </td>
                          <td className="px-3 py-1.5">
                            <WebsiteCell row={r} />
                          </td>
                          <td className="px-3 py-1.5 text-right text-slate-500">{r.product_count ?? "—"}</td>
                          <td className="px-2 py-1.5 text-right">
                            <button onClick={() => removeRow(r.name)} title="Remove row"
                              className="text-slate-500 hover:text-rose-400 p-1 rounded hover:bg-slate-800">
                              <X className="w-4 h-4" />
                            </button>
                          </td>
                        </tr>
                      ))}
                      {visibleRows.length === 0 && (
                        <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-500">No companies to show.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

// Confidence → visual tier. null when we have no score.
function confidenceTier(c) {
  if (c == null || !Number.isFinite(c)) return null;
  if (c >= 0.8) return { dot: "bg-emerald-400", label: "high", dim: false };
  if (c >= 0.5) return { dot: "bg-amber-400", label: "medium", dim: false };
  return { dot: "bg-rose-400", label: "low", dim: true };
}

function WebsiteCell({ row }) {
  const { website_url, url_status, url_confidence } = row;
  if (url_status === "looking") {
    return <span className="inline-flex items-center gap-1.5 text-xs text-slate-400"><Loader2 className="w-3 h-3 animate-spin" /> Finding…</span>;
  }
  if (website_url) {
    const tier = confidenceTier(url_confidence);
    const pct = tier ? Math.round(url_confidence * 100) : null;
    return (
      <span className={`inline-flex items-center gap-1.5 ${tier?.dim ? "opacity-60" : ""}`}>
        {tier && (
          <span
            title={`${pct}% confidence (${tier.label})`}
            className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${tier.dot}`}
          />
        )}
        <a href={website_url} target="_blank" rel="noreferrer" className="text-teal-400 hover:underline inline-flex items-center gap-1 text-xs">
          {website_url.replace(/^https?:\/\//, "")}
          <ExternalLink className="w-3 h-3 flex-shrink-0" />
        </a>
        {pct != null && <span className="text-[10px] text-slate-500 tabular-nums">{pct}%</span>}
      </span>
    );
  }
  if (url_status === "not_found") return <span className="text-xs text-slate-500">not found</span>;
  if (url_status === "error") return <span className="text-xs text-amber-400/70">lookup failed</span>;
  return <span className="text-slate-600">—</span>;
}

function StatusCell({ row, matchHref }) {
  const { status, match } = row;
  const matchTypeLabel = match ? (MATCH_TYPE_LABEL[match.match_type] || match.match_type) : null;

  if (status === "pending") {
    return <span className="inline-flex items-center gap-1.5 text-xs text-slate-400"><Loader2 className="w-3 h-3 animate-spin" /> Checking…</span>;
  }
  if (status === "error") {
    return <span className="text-xs text-amber-400/80">Check failed</span>;
  }
  if (status === "no_match") {
    return <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-950/50 border border-emerald-900/50 text-emerald-300">New</span>;
  }
  if (status === "exact_match") {
    return (
      <span className="inline-flex items-center gap-1.5 flex-wrap">
        <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-rose-950/50 border border-rose-900/50 text-rose-300">
          <span className="w-1.5 h-1.5 rounded-full bg-rose-400" /> Exact match
        </span>
        {match?.id && (
          <a href={matchHref(match.id)} target="_blank" rel="noreferrer" className="text-teal-400 hover:underline inline-flex items-center gap-0.5 text-xs">
            {match.company_name || "matched"} <ExternalLink className="w-3 h-3" />
          </a>
        )}
        {matchTypeLabel && <span className="text-slate-500 text-xs">by {matchTypeLabel}</span>}
      </span>
    );
  }
  if (status === "fuzzy_match") {
    return (
      <span className="inline-flex items-center gap-1.5 flex-wrap">
        <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-amber-950/50 border border-amber-900/50 text-amber-300">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400" /> Possible match
        </span>
        {match?.id && (
          <a href={matchHref(match.id)} target="_blank" rel="noreferrer" className="text-teal-400 hover:underline inline-flex items-center gap-0.5 text-xs">
            {match.company_name || "matched"} <ExternalLink className="w-3 h-3" />
          </a>
        )}
        {matchTypeLabel && <span className="text-slate-500 text-xs">via {matchTypeLabel}</span>}
      </span>
    );
  }
  return null;
}
