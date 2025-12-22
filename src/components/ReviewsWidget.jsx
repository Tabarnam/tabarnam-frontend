// src/components/ReviewsWidget.jsx
import React, { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { withAmazonAffiliate } from "@/lib/amazonAffiliate";
import { RatingDots } from "@/components/Stars";

export default function ReviewsWidget({ companyId, companyName, displayName }) {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [rating, setRating] = useState(5);
  const [text, setText] = useState("");
  const [userName, setUserName] = useState("");
  const [userLocation, setUserLocation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    const id = String(companyId || "").trim();
    if (!id) {
      setList([]);
      return;
    }

    setLoading(true);
    setError("");
    try {
      const qs = `company_id=${encodeURIComponent(id)}`;
      const r = await fetch(`${API_BASE}/get-reviews?${qs}`);
      const data = await r.json().catch(() => ({ items: [], reviews: [] }));
      if (!r.ok) throw new Error(data?.error || r.statusText || "Failed to load");
      const reviews = Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data?.reviews)
          ? data.reviews
          : [];
      setList(reviews);
    } catch (e) {
      setError(e?.message || "Failed to load reviews");
    } finally { setLoading(false); }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  async function submit() {
    setError("");
    if (!companyName) { setError("No company selected."); return; }
    if (!text.trim() || text.trim().length < 10) {
      setError("Please write a longer review (at least 10 characters)."); return;
    }
    setSubmitting(true);
    try {
      const r = await fetch(`${API_BASE}/submit-review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company_name: companyName,
          rating: Number(rating),
          text: text.trim(),
          user_name: userName.trim() || null,
          user_location: userLocation.trim() || null
        })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data?.ok) throw new Error(data?.error || r.statusText || "Submit failed");
      setList(prev => [data.review, ...prev]);
      setText(""); setUserName(""); setUserLocation(""); setRating(5);
    } catch (e) { setError(e?.message || "Submit failed"); }
    finally { setSubmitting(false); }
  }

  const titleName = String(displayName || companyName || "").trim();

  return (
    <div className="mt-3 border rounded p-3 bg-gray-50">
      <div className="font-semibold mb-2">{titleName ? `Reviews for ${titleName}` : "Reviews"}</div>

      <div className="mt-4">
        {loading ? (
          <div className="text-sm text-gray-500">Loading reviews…</div>
        ) : error ? (
          <div className="text-sm text-red-600">{error}</div>
        ) : !list.length ? (
          <div className="text-sm text-gray-500">No reviews yet.</div>
        ) : (
          <ul className="space-y-3">
            {list.map((r, idx) => {
              const sourceName = r.source_name || r.source || "";
              const sourceUrl = r.source_url || r.url || null;
              const text = r.text || r.abstract || "";
              const truncateUrl = (url, maxLen = 40) => {
                if (!url) return null;
                return url.length > maxLen ? url.substring(0, maxLen) + "…" : url;
              };

              return (
                <li key={r.id || `${companyName || companyId || "company"}-${idx}`} className="bg-white border rounded p-3">
                  <div className="flex items-center justify-between">
                    <div className="font-medium text-amber-600">{sourceName || "Unknown Source"}</div>
                    <div className="text-xs text-gray-500">
                      {r.created_at ? new Date(r.created_at).toLocaleString() : ""}
                    </div>
                  </div>

                  <div className="mt-2">
                    <p className="text-sm text-gray-700 mb-2">{text}</p>

                    {r.rating != null && (
                      <div className="flex items-center gap-2 mb-2">
                        <RatingDots value={Number(r.rating)} size={14} />
                        <div className="text-sm font-medium text-[#649BA0]">{Number(r.rating)}/5</div>
                      </div>
                    )}

                    {sourceUrl && (
                      <div className="text-xs">
                        <a
                          href={withAmazonAffiliate(sourceUrl)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-600 hover:underline inline-flex items-center gap-1"
                          title={withAmazonAffiliate(sourceUrl)}
                        >
                          {truncateUrl(withAmazonAffiliate(sourceUrl))}
                          <span className="text-gray-400">↗</span>
                        </a>
                      </div>
                    )}
                  </div>

                  {r.type === "user" && r.source.includes("(") && (
                    <div className="mt-2 text-xs text-gray-500">User submitted</div>
                  )}

                  {r.flagged_bot && (
                    <div className="mt-2 text-xs text-amber-700 bg-amber-50 inline-block px-2 py-1 rounded">
                      Flagged: {r.bot_reason || "possible automated content"}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
