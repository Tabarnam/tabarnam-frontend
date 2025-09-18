// src/components/ui/toast.jsx
// Lightweight client helpers to talk to /api/proxy-xai and do progressive bulk imports.

const API_BASE =
  (typeof window !== "undefined" && window.location.port === "5173")
    ? "http://localhost:7071"   // dev: call Functions directly to avoid Vite proxy timeouts
    : "";                        // prod: same-origin

// Single call to the proxy. `limit` is "how many to ask for in this batch".
export async function callXAI(
  query,
  { limit = 20, queryType = "product_keyword", center, timeout_ms } = {}
) {
  const res = await fetch(`${API_BASE}/api/proxy-xai`, {
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
  if (!res.ok) {
    throw new Error(`Proxy error ${res.status}: ${text || "(no body)"}`);
  }
  try { return JSON.parse(text); } catch {
    throw new Error(`Proxy returned invalid JSON: ${text?.slice(0, 300) ?? ""}`);
  }
}

// Progressive bulk import runner: multiple smaller requests, partial updates to the page.
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
  const seen = new Set();       // seen company names
  const all = [];               // accumulated
  let lastProgressAt = Date.now();
  let stop = false;

  function noteNew(list) {
    const fresh = [];
    for (const c of (list || [])) {
      const name = (c?.company_name || "").trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      all.push(c);
      fresh.push(c);
    }
    if (fresh.length) {
      lastProgressAt = Date.now();
      onProgress(all.slice(), fresh);
    }
  }

  async function worker() {
    while (!stop && all.length < target) {
      // stall detection
      if (Date.now() - lastProgressAt > stall_ms) {
        stop = true;
        throw new Error(`No new companies in ${Math.round(stall_ms/1000)}s. Review your search or try a smaller batch.`);
      }

      try {
        const { companies = [] } = await callXAI(query, {
          limit: perRequest,
          queryType,
          center,
          timeout_ms
        });
        noteNew(companies);

        // small jitter to be kind to the upstream
        await new Promise(r => setTimeout(r, 250 + Math.random() * 250));
        if (!companies.length) {
          // No companies this round: brief backoff
          await new Promise(r => setTimeout(r, 1500));
        }
      } catch (e) {
        // Surface actionable info but allow other workers to proceed
        console.warn("bulkImport worker error:", e?.message || e);
        // Fast-fail on large upstream errors
        if (String(e?.message || "").includes("Incorrect API key")) {
          stop = true;
          throw e;
        }
        // brief backoff then continue
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, target)) }, () => worker());
  try {
    await Promise.race([
      Promise.allSettled(workers),
      // global guard: if target is big, still cap overall duration
      new Promise((_, rej) => setTimeout(() => rej(new Error("Bulk import overall guard timeout exceeded.")), Math.max(timeout_ms, 15 * 60 * 1000)))
    ]);
  } finally {
    stop = true;
  }

  return all;
}

// Tiny placeholder to keep React importer happy if you import as a component
export default function ToastPlaceholder(){ return null; }
