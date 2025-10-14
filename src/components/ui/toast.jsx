// src/components/ui/toast.jsx
// Lightweight helpers that call your Functions base (exported from @/lib/api)

import { API_BASE } from "@/lib/api";

// Single call to the proxy. `limit` = how many to ask for in this request.
export async function callXAI(
  query,
  { limit = 20, queryType = "product_keyword", center, timeout_ms } = {}
) {
  const res = await fetch(`${API_BASE}/proxy-xai`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      queryType,
      query,
      limit,
      ...(center ? { center } : {}),
      ...(timeout_ms ? { timeout_ms } : {}),
    }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Proxy error ${res.status}: ${text || "(no body)"}`);
  try { return JSON.parse(text); }
  catch { throw new Error(`Proxy returned invalid JSON: ${text?.slice(0, 300) ?? ""}`); }
}

// Progressive bulk import runner: multiple small requests; partial updates to the page.
export async function bulkImport({
  query,
  target = 25,         // total companies desired
  perRequest = 1,      // ask 1 per request for best dedupe/progress signal
  concurrency = 3,     // how many parallel calls
  timeout_ms = 10 * 60 * 1000, // 10 minutes per request
  stall_ms = 90 * 1000,        // abort if no new company within 90s
  queryType = "product_keyword",
  center = undefined,
  onProgress = () => {},       // (companiesAddedSoFar, newCompaniesBatch) => void
}) {
  const seen = new Set(); // company names
  const all = [];
  let lastProgressAt = Date.now();
  let stop = false;

  function noteNew(list) {
    const fresh = [];
    for (const c of (list || [])) {
      const name = (c?.company_name || "").trim();
      if (!name || seen.has(name)) continue;
      seen.add(name); all.push(c); fresh.push(c);
    }
    if (fresh.length) { lastProgressAt = Date.now(); onProgress(all.slice(), fresh); }
  }

  async function worker() {
    while (!stop && all.length < target) {
      if (Date.now() - lastProgressAt > stall_ms) {
        stop = true; throw new Error(`No new companies in ${Math.round(stall_ms/1000)}s.`);
      }
      try {
        const { companies = [] } = await callXAI(query, { limit: perRequest, queryType, center, timeout_ms });
        noteNew(companies);
        await new Promise(r => setTimeout(r, 250 + Math.random() * 250)); // tiny jitter
        if (!companies.length) await new Promise(r => setTimeout(r, 1500)); // backoff
      } catch (e) {
        console.warn("bulkImport worker error:", e?.message || e);
        if (String(e?.message || "").includes("Incorrect API key")) { stop = true; throw e; }
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, target)) }, () => worker());
  try {
    await Promise.race([
      Promise.allSettled(workers),
      new Promise((_, rej) => setTimeout(
        () => rej(new Error("Bulk import overall guard timeout exceeded.")),
        Math.max(timeout_ms, 15 * 60 * 1000)
      )),
    ]);
  } finally { stop = true; }

  return all;
}

// Tiny placeholder to keep React importer happy if you import as a component
export default function ToastPlaceholder(){ return null; }
