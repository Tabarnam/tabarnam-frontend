import React, { useCallback, useEffect, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { ExternalLink, ChevronLeft, ChevronRight, AlertTriangle } from "lucide-react";

import AdminHeader from "@/components/AdminHeader";
import { Button } from "@/components/ui/button";
import { apiFetch, readJsonOrText } from "@/lib/api";
import { getCompanyLogoUrl } from "@/lib/logoUrl";

const PAGE_SIZE = 60;

export default function AdminLogoReview() {
  const [companies, setCompanies] = useState([]);
  const [totalCount, setTotalCount] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(0);
  const [failedIds, setFailedIds] = useState(new Set());

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
      setTotalCount(items.length);
    } catch (e) {
      setError(e?.message || "Failed to load companies");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCompanies();
  }, [fetchCompanies]);

  const totalPages = Math.ceil(companies.length / PAGE_SIZE);
  const pageCompanies = companies.slice(
    page * PAGE_SIZE,
    (page + 1) * PAGE_SIZE
  );

  const handleImgError = useCallback((id) => {
    setFailedIds((prev) => new Set(prev).add(id));
  }, []);

  return (
    <>
      <Helmet>
        <title>Admin - Logo Review</title>
      </Helmet>
      <AdminHeader />

      <div className="bg-slate-950 min-h-screen p-6">
        <div className="max-w-[1600px] mx-auto">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-2xl font-bold text-white">Logo Review</h1>
              <p className="text-slate-400 text-sm mt-1">
                {totalCount != null
                  ? `${totalCount} companies with logos`
                  : "Loading…"}
              </p>
            </div>

            {totalPages > 1 && (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                  className="border-slate-700 text-slate-300"
                >
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <span className="text-sm text-slate-400">
                  Page {page + 1} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage((p) => p + 1)}
                  className="border-slate-700 text-slate-300"
                >
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            )}
          </div>

          {error && (
            <div className="bg-red-900/30 border border-red-700 text-red-300 rounded p-4 mb-6">
              {error}
            </div>
          )}

          {loading ? (
            <div className="text-slate-400 text-center py-20">Loading…</div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
              {pageCompanies.map((c) => {
                const logoUrl = getCompanyLogoUrl(c);
                const failed = failedIds.has(c.id);

                return (
                  <div
                    key={c.id}
                    className="bg-slate-900 border border-slate-800 rounded-lg p-3 flex flex-col items-center gap-2 group"
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
                          alt={c.company_name || c.id}
                          className="max-w-full max-h-full object-contain p-2"
                          loading="lazy"
                          onError={() => handleImgError(c.id)}
                        />
                      )}
                    </div>

                    <div className="w-full text-center min-h-[2.5rem]">
                      <Link
                        to={`/admin?id=${encodeURIComponent(c.id)}`}
                        className="text-sm text-teal-400 hover:text-teal-300 hover:underline font-medium line-clamp-2"
                        title={c.company_name || c.id}
                      >
                        {c.company_name || c.id}
                      </Link>
                    </div>

                    {c.website_url && (
                      <a
                        href={
                          c.website_url.startsWith("http")
                            ? c.website_url
                            : `https://${c.website_url}`
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-slate-500 hover:text-slate-300 flex items-center gap-1 truncate max-w-full"
                        title={c.website_url}
                      >
                        <ExternalLink className="w-3 h-3 flex-shrink-0" />
                        <span className="truncate">
                          {c.website_url.replace(/^https?:\/\//, "")}
                        </span>
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {totalPages > 1 && !loading && (
            <div className="flex items-center justify-center gap-2 mt-6">
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
          )}
        </div>
      </div>
    </>
  );
}
