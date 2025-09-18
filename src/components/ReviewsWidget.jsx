import React, { useEffect, useState } from "react";

export default function ReviewsWidget({ companyName }) {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(false);

  // form fields
  const [rating, setRating] = useState(5);
  const [text, setText] = useState("");
  const [userName, setUserName] = useState("");
  const [userLocation, setUserLocation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/get-reviews?company=${encodeURIComponent(companyName)}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || r.statusText);
      setList(data.reviews || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (companyName) load(); }, [companyName]);

  const submit = async () => {
    setError("");
    if (!text.trim() || text.trim().length < 10) {
      setError("Please write a longer review (at least 10 characters).");
      return;
    }
    setSubmitting(true);
    try {
      const r = await fetch("/api/submit-review", {
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
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || r.statusText);
      // Prepend newest
      setList(prev => [data.review, ...prev]);
      // reset
      setText("");
      setUserName("");
      setUserLocation("");
      setRating(5);
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mt-3 border rounded p-3 bg-gray-50">
      <div className="font-semibold mb-2">User Reviews</div>

      {/* Form */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-2 mb-2">
        <div>
          <label className="block text-xs text-gray-600">Rating</label>
          <select className="w-full border rounded px-2 py-1" value={rating} onChange={e=>setRating(e.target.value)}>
            {[5,4,3,2,1].map(n => <option key={n} value={n}>{n} ★</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-600">Your first name (optional)</label>
          <input className="w-full border rounded px-2 py-1" value={userName} onChange={e=>setUserName(e.target.value)} placeholder="Add your first name" />
        </div>
        <div className="md:col-span-2">
          <label className="block text-xs text-gray-600">Your location (optional)</label>
          <input className="w-full border rounded px-2 py-1" value={userLocation} onChange={e=>setUserLocation(e.target.value)} placeholder="City, State/Region, Country" />
        </div>
      </div>
      <div className="mb-2">
        <label className="block text-xs text-gray-600">Your review</label>
        <textarea
          className="w-full border rounded px-2 py-2 min-h-[120px]"
          value={text}
          onChange={e=>setText(e.target.value)}
          placeholder="Share your experience. No images."
        />
      </div>
      {error && <div className="text-sm text-red-600 mb-2">❌ {error}</div>}
      <button onClick={submit} disabled={submitting} className={`rounded px-4 py-2 text-white ${submitting ? "bg-gray-400" : "bg-emerald-600 hover:bg-emerald-700"}`}>
        {submitting ? "Submitting…" : "Submit review"}
      </button>

      {/* List */}
      <div className="mt-4">
        {loading ? <div className="text-sm text-gray-500">Loading reviews…</div> :
          !list.length ? <div className="text-sm text-gray-500">No reviews yet.</div> :
          <ul className="space-y-3">
            {list.map(r => (
              <li key={r.id} className="bg-white border rounded p-3">
                <div className="flex items-center justify-between">
                  <div className="font-medium">{r.rating} ★</div>
                  <div className="text-xs text-gray-500">{new Date(r.created_at).toLocaleString()}</div>
                </div>
                <div className="mt-2 whitespace-pre-wrap">{r.text}{" "}
                  {(r.user_name || r.user_location) && (
                    <strong>— {r.user_name || "Anonymous"}{r.user_location ? `, ${r.user_location}` : ""}</strong>
                  )}
                </div>
                {r.flagged_bot && (
                  <div className="mt-2 text-xs text-amber-700 bg-amber-50 inline-block px-2 py-1 rounded">
                    Flagged for review: {r.bot_reason || "possible automated content"}
                  </div>
                )}
              </li>
            ))}
          </ul>
        }
      </div>
    </div>
  );
}
