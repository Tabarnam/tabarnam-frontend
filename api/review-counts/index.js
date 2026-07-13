// api/review-counts/index.js
//
// Batch "how many reviews can a user see" endpoint for the results page. Returns
// the SAME number get-reviews returns for each company — because it literally
// runs get-reviews' handler per id and reads its `count`. This is the single
// source of truth (curated + admin notes + public user reviews from the reviews
// container, with all the same visibility/dedup rules), so a card's teaser count
// always equals what the user sees when they open the reviews. No maintained
// aggregate, so it can never drift and never needs an admin recount.
//
// Route: POST /review-counts   Body: { ids: string[] }
//   → { ok: true, counts: { "<company_id>": <visibleCount>, ... } }
//
// The per-id work is a few Cosmos reads, so it's bounded (MAX_IDS), run with
// limited concurrency, and briefly cached per worker. It's meant to be called
// lazily by the results page after the cards render — never on the hot search
// path.

const { app } = require("../_app");
const { computeVisibleReviewCount } = require("../_pinVisibleReviewCount");

const MAX_IDS = 60;
const CONCURRENCY = 6;
const CACHE_TTL_MS = 60 * 1000;

// Small per-worker TTL cache so repeated renders / pagination of the same page
// don't recompute. Short TTL keeps counts fresh after an admin approves/removes.
const cache = new Map(); // id -> { count, at }

const cors = (req) => ({
  "Access-Control-Allow-Origin": req?.headers?.get?.("origin") || "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
});
const json = (obj, status, req) => ({ status, headers: cors(req), body: JSON.stringify(obj) });

// Run get-reviews for one company id and return its visible-review count.
async function countForId(id, context) {
  const cached = cache.get(id);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.count;

  const count = await computeVisibleReviewCount(id);
  if (typeof count === "number") cache.set(id, { count, at: Date.now() });
  else context?.log?.(`[review-counts] count failed for ${id}`);
  return count;
}

// Resolve an array of ids with bounded concurrency.
async function countAll(ids, context) {
  const counts = {};
  let i = 0;
  async function worker() {
    while (i < ids.length) {
      const id = ids[i++];
      const c = await countForId(id, context);
      if (typeof c === "number") counts[id] = c;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
  return counts;
}

async function reviewCountsHandler(req, context) {
  const method = String(req.method || "").toUpperCase();
  if (method === "OPTIONS") return { status: 200, headers: cors(req) };
  if (method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405, req);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400, req);
  }

  const rawIds = Array.isArray(body?.ids) ? body.ids : [];
  // Dedupe, drop empties, cap.
  const ids = Array.from(
    new Set(rawIds.map((x) => String(x || "").trim()).filter(Boolean))
  ).slice(0, MAX_IDS);

  if (ids.length === 0) return json({ ok: true, counts: {} }, 200, req);

  const counts = await countAll(ids, context);
  return json({ ok: true, counts, truncated: rawIds.length > MAX_IDS }, 200, req);
}

app.http("reviewCounts", {
  route: "review-counts",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: reviewCountsHandler,
});

module.exports = { handler: reviewCountsHandler };
