import React, { useEffect, useMemo, useState } from "react";
import { API_BASE } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { RatingDots } from "@/components/Stars";
import { withAmazonAffiliate } from "@/lib/amazonAffiliate";

function formatDate(v) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString();
}

function truncate(text, maxLen) {
  const s = String(text || "").trim();
  if (!s) return "";
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

export default function CompanyReviewsPreview({ companyId, companyName }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);

  const queryUrl = useMemo(() => {
    const id = String(companyId || "").trim();
    const name = String(companyName || "").trim();
    if (id) return `${API_BASE}/get-reviews?company_id=${encodeURIComponent(id)}`;
    if (name) return `${API_BASE}/get-reviews?company=${encodeURIComponent(name)}`;
    return "";
  }, [companyId, companyName]);

  async function load() {
    if (!queryUrl) return;
    setLoading(true);
    setError("");
    try {
      const r = await fetch(queryUrl);
      const data = await r.json().catch(() => ({ items: [], reviews: [] }));
      if (!r.ok || data?.ok === false) {
        throw new Error(data?.error || r.statusText || `HTTP ${r.status}`);
      }

      const reviews = Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data?.reviews)
          ? data.reviews
          : [];

      setItems(reviews);
    } catch (e) {
      setItems([]);
      setError(e?.message || "Failed to load reviews");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setExpanded(false);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryUrl]);

  const previewCount = 5;
  const visible = expanded ? items : items.slice(0, previewCount);

  if (!companyId && !companyName) return null;

  return (
    <div className="border-t pt-4 mt-4">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          <h3 className="font-semibold text-sm">Reviews</h3>
          <p className="text-xs text-slate-600">
            Showing reviews from the same source as the public Results page.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={loading} onClick={load}>
          {loading ? "Loading…" : "Reload"}
        </Button>
      </div>

      {error ? <div className="text-sm text-red-600 mb-2">{error}</div> : null}

      {loading && items.length === 0 ? (
        <div className="text-sm text-slate-600">Loading reviews…</div>
      ) : items.length === 0 ? (
        <div className="text-sm text-slate-600">No reviews found.</div>
      ) : (
        <>
          <div className="text-xs text-slate-600 mb-2">Total: {items.length}</div>

          <ul className="space-y-2">
            {visible.map((r) => (
              <li key={r.id} className="bg-slate-50 border border-slate-200 rounded p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="text-sm font-medium text-slate-900">{r.source || "Unknown"}</div>
                  <div className="text-xs text-slate-500 whitespace-nowrap">{formatDate(r.created_at)}</div>
                </div>

                {r.rating != null ? (
                  <div className="mt-2 flex items-center gap-2">
                    <RatingDots value={Number(r.rating)} size={14} />
                    <div className="text-xs font-medium text-tabarnam-blue-dark">
                      {Number(r.rating)}/5
                    </div>
                  </div>
                ) : null}

                <div className="mt-2 text-sm text-slate-700 whitespace-pre-line">
                  {truncate(r.abstract || "", 400) || "—"}
                </div>

                {r.url ? (
                  <div className="mt-2 text-xs">
                    <a
                      href={withAmazonAffiliate(r.url)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-700 hover:underline"
                      title={withAmazonAffiliate(r.url)}
                    >
                      {truncate(withAmazonAffiliate(r.url), 70)}
                    </a>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>

          {items.length > previewCount ? (
            <div className="mt-3 flex items-center justify-between">
              <Button type="button" variant="secondary" size="sm" onClick={() => setExpanded((v) => !v)}>
                {expanded ? "Show latest 5" : `Show all (${items.length})`}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
