import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Helmet } from "react-helmet-async";
import {
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  Check,
  Clock,
} from "lucide-react";

import AdminHeader from "@/components/AdminHeader";
import { Button } from "@/components/ui/button";
import { apiFetch, readJsonOrText } from "@/lib/api";
import { getCompanyLogoUrl } from "@/lib/logoUrl";

const PAGE_SIZE = 60;

function Pagination({ page, totalPages, setPage }) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-center gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={page === 0}
        onClick={() => {
          setPage((p) => p - 1);
          window.scrollTo(0, 0);
        }}
        className="border-slate-700 text-slate-300"
      >
        <ChevronLeft className="w-4 h-4 mr-1" />
        Previous
      </Button>
      <span className="text-sm text-slate-400">
        Page {page + 1} of {totalPages}
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={page >= totalPages - 1}
        onClick={() => {
          setPage((p) => p + 1);
          window.scrollTo(0, 0);
        }}
        className="border-slate-700 text-slate-300"
      >
        Next
        <ChevronRight className="w-4 h-4 ml-1" />
      </Button>
    </div>
  );
}

function LogoCard({ company, failed, onImgError, onToggleApproval, saving }) {
  const logoUrl = getCompanyLogoUrl(company);
  const approved = !!company.logo_approved;

  return (
    <div
      className={`bg-slate-900 border rounded-lg p-3 flex flex-col items-center gap-2 ${
        approved ? "border-emerald-700/50" : "border-slate-800"
      }`}
    >
      <div className="w-full aspect-square flex items-center justify-center bg-white rounded overflow-hidden relative">
        {failed ? (
          <div className="flex flex-col items-center gap-1 text-slate-400">
            <AlertTriangle className="w-8 h-8" />
            <span className="text-xs">Broken</span>
          </div>
        ) : (
          <img
            src={logoUrl}
            alt={company.company_name || company.id}
            className="max-w-full max-h-full object-contain p-2"
            loading="lazy"
            onError={() => onImgError(company.id)}
          />
        )}
      </div>

      <div className="w-full text-center min-h-[2.5rem]">
        <a
          href={`/admin?company_id=${encodeURIComponent(company.id)}`}
          className="text-sm text-teal-400 hover:text-teal-300 hover:underline font-medium line-clamp-2"
          title={company.company_name || company.id}
        >
          {company.company_name || company.id}
        </a>
      </div>

      {company.website_url && (
        <a
          href={
            company.website_url.startsWith("http")
              ? company.website_url
              : `https://${company.website_url}`
          }
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-slate-500 hover:text-slate-300 flex items-center gap-1 truncate max-w-full"
          title={company.website_url}
        >
          <ExternalLink className="w-3 h-3 flex-shrink-0" />
          <span className="truncate">
            {company.website_url.replace(/^https?:\/\//, "")}
          </span>
        </a>
      )}

      <Button
        variant="outline"
        size="sm"
        disabled={saving}
        onClick={() => onToggleApproval(company)}
        className={
          approved
            ? "w-full border-amber-600/50 text-amber-400 hover:bg-amber-900/30 hover:text-amber-300 text-xs"
            : "w-full border-emerald-600/50 text-emerald-400 hover:bg-emerald-900/30 hover:text-emerald-300 text-xs"
        }
      >
        {approved ? (
          <>
            <Clock className="w-3 h-3 mr-1" />
            Move to Pending
          </>
        ) : (
          <>
            <Check className="w-3 h-3 mr-1" />
            Approve
          </>
        )}
      </Button>
    </div>
  );
}

export default function AdminLogoReview() {
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [pendingPage, setPendingPage] = useState(0);
  const [approvedPage, setApprovedPage] = useState(0);
  const [failedIds, setFailedIds] = useState(new Set());
  const [savingIds, setSavingIds] = useState(new Set());

  const fetchCompanies = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/xadmin-api-companies?take=1000`);
      const data = await readJsonOrText(res);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      const items = (data?.items || []).filter(
        (c) => c && typeof c === "object" && c.logo_url
      );
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

  const { pending, approved } = useMemo(() => {
    const p = [];
    const a = [];
    for (const c of companies) {
      if (c.logo_approved) a.push(c);
      else p.push(c);
    }
    return { pending: p, approved: a };
  }, [companies]);

  const pendingTotalPages = Math.ceil(pending.length / PAGE_SIZE);
  const approvedTotalPages = Math.ceil(approved.length / PAGE_SIZE);
  const pendingSlice = pending.slice(pendingPage * PAGE_SIZE, (pendingPage + 1) * PAGE_SIZE);
  const approvedSlice = approved.slice(approvedPage * PAGE_SIZE, (approvedPage + 1) * PAGE_SIZE);

  const handleImgError = useCallback((id) => {
    setFailedIds((prev) => new Set(prev).add(id));
  }, []);

  const handleToggleApproval = useCallback(async (company) => {
    const newVal = !company.logo_approved;
    setSavingIds((prev) => new Set(prev).add(company.id));
    try {
      const res = await apiFetch(`/xadmin-api-companies/${encodeURIComponent(company.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logo_approved: newVal }),
      });
      if (!res.ok) {
        const data = await readJsonOrText(res);
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      setCompanies((prev) =>
        prev.map((c) => (c.id === company.id ? { ...c, logo_approved: newVal } : c))
      );
    } catch (e) {
      setError(`Failed to update ${company.company_name || company.id}: ${e?.message}`);
    } finally {
      setSavingIds((prev) => {
        const next = new Set(prev);
        next.delete(company.id);
        return next;
      });
    }
  }, []);

  // Reset pages when items move between sections
  useEffect(() => {
    if (pendingPage > 0 && pendingPage >= pendingTotalPages) setPendingPage(Math.max(0, pendingTotalPages - 1));
  }, [pendingPage, pendingTotalPages]);
  useEffect(() => {
    if (approvedPage > 0 && approvedPage >= approvedTotalPages) setApprovedPage(Math.max(0, approvedTotalPages - 1));
  }, [approvedPage, approvedTotalPages]);

  const renderGrid = (items, page, setPage, totalPages) => (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
        {items.map((c) => (
          <LogoCard
            key={c.id}
            company={c}
            failed={failedIds.has(c.id)}
            onImgError={handleImgError}
            onToggleApproval={handleToggleApproval}
            saving={savingIds.has(c.id)}
          />
        ))}
      </div>
      {totalPages > 1 && (
        <div className="mt-4">
          <Pagination page={page} totalPages={totalPages} setPage={setPage} />
        </div>
      )}
    </>
  );

  return (
    <>
      <Helmet>
        <title>Admin - Logo Review</title>
      </Helmet>
      <AdminHeader />

      <div className="bg-slate-950 min-h-screen p-6">
        <div className="max-w-[1600px] mx-auto">
          <h1 className="text-2xl font-bold text-white mb-1">Logo Review</h1>
          <p className="text-slate-400 text-sm mb-8">
            {companies.length} companies with logos &middot;{" "}
            <span className="text-amber-400">{pending.length} pending</span> &middot;{" "}
            <span className="text-emerald-400">{approved.length} approved</span>
          </p>

          {error && (
            <div className="bg-red-900/30 border border-red-700 text-red-300 rounded p-4 mb-6">
              {error}
            </div>
          )}

          {loading ? (
            <div className="text-slate-400 text-center py-20">Loading…</div>
          ) : (
            <>
              {/* Pending Approval */}
              <section className="mb-12">
                <div className="flex items-center gap-3 mb-4">
                  <Clock className="w-5 h-5 text-amber-400" />
                  <h2 className="text-lg font-semibold text-white">
                    Pending Approval
                    <span className="text-slate-400 font-normal text-sm ml-2">({pending.length})</span>
                  </h2>
                </div>
                {pending.length === 0 ? (
                  <p className="text-slate-500 text-sm">All logos have been reviewed.</p>
                ) : (
                  renderGrid(pendingSlice, pendingPage, setPendingPage, pendingTotalPages)
                )}
              </section>

              {/* Approved */}
              <section>
                <div className="flex items-center gap-3 mb-4">
                  <Check className="w-5 h-5 text-emerald-400" />
                  <h2 className="text-lg font-semibold text-white">
                    Approved
                    <span className="text-slate-400 font-normal text-sm ml-2">({approved.length})</span>
                  </h2>
                </div>
                {approved.length === 0 ? (
                  <p className="text-slate-500 text-sm">No logos approved yet.</p>
                ) : (
                  renderGrid(approvedSlice, approvedPage, setApprovedPage, approvedTotalPages)
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </>
  );
}
