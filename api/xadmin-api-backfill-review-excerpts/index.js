// Phase 4.33 — admin endpoint to backfill missing `text` excerpts on
// previously-imported reviews.
//
// Why: production runs the canonical xAI call in `json_object` mode (Phase
// 2.19.9) which does NOT strictly enforce the JSON schema's required:[text]
// field. Combined with the (pre-Phase-4.33) descriptive "1-3 sentence
// excerpt or summary" prompt language, the model sometimes emitted review
// objects with all fields populated EXCEPT `text`. The display widget
// (getReviewText in src/pages/company-dashboard/dashboardUtils.js) falls
// through every fallback and renders an empty string.
//
// Phase 4.33 strengthens the prompt going forward. This endpoint patches
// the back-catalog: for one company per request, it walks `curated_reviews`,
// finds entries with missing/empty `text`, calls a small targeted xAI
// summarization (2 tool calls max) per URL, and writes the company doc
// back to Cosmos with the patched reviews.
//
// Usage:
//   POST /api/xadmin-api-backfill-review-excerpts
//   Body: { company_id: "company_..." }       — process one specific company
//   Body: { auto_pick_next: true }            — find the next company with
//                                               excerpt-less reviews, process it
//   Body: { dry_run: true, company_id: "..." } — count what would be patched
//                                                without calling xAI
//
// Response: { ok, company_id, reviews_total, reviews_patched, reviews_skipped, errors }
//
// Cost: ~$0.01-0.015 per review on grok-4.3 (1 web_search + small summary).
// Per-company wall-clock: ~10-30s sequential.

const { app } = require("../_app");
const { xaiLiveSearchStreaming } = require("../_xaiLiveSearch");
const { DEFAULT_XAI_MODEL } = require("../_shared");

const E = (key, def = "") => (process.env[key] ?? def).toString().trim();

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };
}

const json = (obj, status = 200) => ({
  status,
  headers: getCorsHeaders(),
  body: JSON.stringify(obj),
});

let cosmosClient = null;
function getCosmosClient() {
  const endpoint = E("COSMOS_DB_ENDPOINT");
  const key = E("COSMOS_DB_KEY");
  if (!endpoint || !key) return null;
  cosmosClient ||= require("../_cosmosConfig").getCosmosClient();
  return cosmosClient;
}

function getCompaniesContainer() {
  const c = getCosmosClient();
  if (!c) return null;
  return c
    .database(E("COSMOS_DB_DATABASE", "tabarnam-db"))
    .container(E("COSMOS_DB_COMPANIES_CONTAINER", "companies"));
}

/**
 * Decide whether a review entry's existing `text` field is good enough to
 * skip. Anything shorter than 10 chars (after trim) is considered missing.
 * Also catches placeholder strings like "no excerpt" / "n/a".
 */
function isExcerptMissing(review) {
  if (!review || typeof review !== "object") return false; // not a real review entry
  const text = review.text;
  if (typeof text !== "string") return true;
  const trimmed = text.trim();
  if (trimmed.length < 10) return true;
  // Catch common placeholder shapes the model occasionally emits. We
  // intentionally accept short trailing modifiers like "available" /
  // "provided" so "No excerpt available" and "no text provided" both
  // get caught alongside the bare forms.
  const lc = trimmed.toLowerCase();
  if (/^(n\/?a|none|no\s+(excerpt|text|summary|description|review|content)(\s+(available|provided|found|given))?|tbd|todo|placeholder|null|undefined)\s*\.?$/.test(lc)) {
    return true;
  }
  return false;
}

/**
 * Find a company by id via cross-partition query (we don't know the
 * partition key without it).
 */
async function findCompanyById(container, companyId) {
  try {
    const { resources } = await container.items
      .query(
        { query: "SELECT * FROM c WHERE c.id = @id", parameters: [{ name: "@id", value: companyId }] },
        { enableCrossPartitionQuery: true }
      )
      .fetchAll();
    return (resources && resources[0]) || null;
  } catch {
    return null;
  }
}

/**
 * Find the next company in the catalog that has at least one review with
 * missing/empty `text`. Used for the auto_pick_next mode so a caller can
 * loop the endpoint without maintaining its own cursor.
 *
 * Cross-partition. RU-expensive on large catalogs but only runs when
 * auto_pick_next: true is set.
 */
async function findNextCompanyNeedingBackfill(container, skipIds = []) {
  // We need to find a company where curated_reviews has at least one entry
  // missing a usable text field. Cosmos can't easily express "text missing
  // OR short" via SQL, so we filter in code on a small candidate set.
  // Strategy: query companies that have ANY curated_reviews, page-walk,
  // check each.
  const skipSet = new Set(skipIds || []);
  const querySpec = {
    query: `SELECT c.id, c.normalized_domain, c.curated_reviews
            FROM c
            WHERE IS_ARRAY(c.curated_reviews) AND ARRAY_LENGTH(c.curated_reviews) > 0`,
  };
  const iter = container.items.query(querySpec, {
    enableCrossPartitionQuery: true,
    maxItemCount: 50,
  });
  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    for (const row of resources || []) {
      if (!row?.id || skipSet.has(row.id)) continue;
      const reviews = Array.isArray(row.curated_reviews) ? row.curated_reviews : [];
      const needsAny = reviews.some(isExcerptMissing);
      if (needsAny) return row.id;
    }
  }
  return null;
}

/**
 * Build the per-review excerpt-fetch prompt. Tight, single-purpose.
 */
function buildExcerptPrompt(review, companyName) {
  const url = String(review?.url || "").trim() || "(no URL provided)";
  const title = String(review?.title || "").trim() || "(no title)";
  const source = String(review?.source || "").trim() || "(unknown source)";
  const author = String(review?.author || "").trim() || "";

  return `You are helping fill in a missing review excerpt for a company-research database.

Company: ${companyName || "(unknown)"}
Review source: ${source}
Author: ${author || "(unknown)"}
Title: ${title}
URL: ${url}

Your task: visit the URL (web_search or browse_page) and return a substantive 1-3 sentence summary of what THIS specific review says about the company or its product. Focus on the reviewer's opinion, key points, and overall sentiment.

Do NOT fabricate. If the URL is inaccessible or the page does not contain a real review about ${companyName || "the company"}, return text = "".

Return ONLY a single JSON object with exactly one property:
{ "text": "1-3 sentence summary here" }

No prose, no markdown, no extra keys.`;
}

/**
 * Call xAI to generate the excerpt for one review. Returns either the
 * extracted text string or null on failure / empty result.
 */
async function fetchExcerptForReview(review, companyName, context, signal) {
  const prompt = buildExcerptPrompt(review, companyName);

  let res;
  try {
    res = await xaiLiveSearchStreaming({
      prompt,
      timeoutMs: 30_000,
      model: E("XAI_MODEL") || DEFAULT_XAI_MODEL,
      enableImageUnderstanding: false,
      maxToolCalls: 2, // allow one web_search + one browse_page if needed
      signal,
      response_format: { type: "json_object" },
    });
  } catch (err) {
    context.log(`[backfill-review-excerpts] xai call threw: ${err?.message || err}`);
    return null;
  }

  if (!res || !res.ok) {
    context.log(`[backfill-review-excerpts] xai call not ok: ${res?.error || "(no error code)"}`);
    return null;
  }

  // Extract text from the response. Reuse the xAI text extractor.
  let rawText = "";
  try {
    const { extractTextFromXaiResponse } = require("../_xaiLiveSearch");
    rawText = extractTextFromXaiResponse(res.resp) || "";
  } catch {
    rawText = "";
  }

  if (!rawText || typeof rawText !== "string") return null;

  // Parse JSON object. Tolerate code-fence wrappers.
  let parsed;
  try {
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    // Take the first {...} block to be robust to a stray prose preamble.
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    const jsonSlice = firstBrace >= 0 && lastBrace > firstBrace
      ? cleaned.slice(firstBrace, lastBrace + 1)
      : cleaned;
    parsed = JSON.parse(jsonSlice);
  } catch {
    context.log(`[backfill-review-excerpts] unparseable xai text (${rawText.length} chars)`);
    return null;
  }

  const text = parsed && typeof parsed.text === "string" ? parsed.text.trim() : "";
  if (text.length < 10) return null; // too short to be a real excerpt
  return text;
}

async function handler(req, context) {
  const method = String(req?.method || "").toUpperCase();
  if (method === "OPTIONS") return { status: 200, headers: getCorsHeaders() };

  if (!E("XAI_API_KEY") && !E("XAI_KEY")) {
    return json({ error: "XAI_API_KEY not configured on Function App" }, 500);
  }

  let body = {};
  try { body = (await req.json()) || {}; } catch { body = {}; }

  const requestedCompanyId = String(body?.company_id || "").trim();
  const autoPickNext = body?.auto_pick_next === true;
  const dryRun = body?.dry_run === true;
  const skipIds = Array.isArray(body?.skip_ids) ? body.skip_ids.map(String).filter(Boolean) : [];

  if (!requestedCompanyId && !autoPickNext) {
    return json({ error: "Provide either company_id or auto_pick_next: true" }, 400);
  }

  const container = getCompaniesContainer();
  if (!container) return json({ error: "Cosmos DB not configured" }, 500);

  // Resolve the company to operate on.
  let companyId = requestedCompanyId;
  if (!companyId && autoPickNext) {
    companyId = await findNextCompanyNeedingBackfill(container, skipIds);
    if (!companyId) {
      return json({ ok: true, done: true, message: "No companies remain with excerpt-less reviews" });
    }
  }

  const company = await findCompanyById(container, companyId);
  if (!company) return json({ error: "company not found", company_id: companyId }, 404);

  const reviews = Array.isArray(company.curated_reviews) ? company.curated_reviews : [];
  const missing = reviews.map((r, i) => (isExcerptMissing(r) ? i : -1)).filter((i) => i >= 0);

  context.log(
    `[backfill-review-excerpts] company=${companyId} total_reviews=${reviews.length} missing=${missing.length} dry_run=${dryRun}`
  );

  if (dryRun) {
    return json({
      ok: true,
      company_id: companyId,
      company_name: company.company_name || company.display_name || null,
      reviews_total: reviews.length,
      reviews_missing_text: missing.length,
      dry_run: true,
    });
  }

  if (missing.length === 0) {
    return json({
      ok: true,
      company_id: companyId,
      reviews_total: reviews.length,
      reviews_patched: 0,
      reviews_skipped: 0,
      message: "No excerpt-less reviews on this company",
    });
  }

  const companyName = company.company_name || company.display_name || "(unknown)";

  // Mutate a copy so we can compare. JSON-clone keeps us defensive.
  const patched = JSON.parse(JSON.stringify(reviews));
  const errors = [];
  let patchedCount = 0;
  let skippedCount = 0;

  for (const i of missing) {
    const review = patched[i] || {};
    try {
      const text = await fetchExcerptForReview(review, companyName, context, null);
      if (text && text.length >= 10) {
        review.text = text;
        patched[i] = review;
        patchedCount++;
      } else {
        skippedCount++;
        errors.push({ index: i, url: review.url || null, reason: "xai_returned_empty_or_short_text" });
      }
    } catch (err) {
      skippedCount++;
      errors.push({ index: i, url: review.url || null, reason: err?.message || String(err) });
    }
  }

  // Only write back if we actually patched something.
  if (patchedCount > 0) {
    const updated = { ...company, curated_reviews: patched };
    updated.updated_at = new Date().toISOString();
    updated.review_excerpts_backfilled_at = updated.updated_at;
    try {
      const partitionKey = String(company.normalized_domain || "unknown").trim();
      await container.item(company.id, partitionKey).replace(updated);
    } catch (err) {
      context.log(`[backfill-review-excerpts] cosmos replace failed: ${err?.message || err}`);
      return json(
        {
          ok: false,
          company_id: companyId,
          reviews_total: reviews.length,
          reviews_patched: patchedCount,
          reviews_skipped: skippedCount,
          persist_error: err?.message || String(err),
          errors,
        },
        500
      );
    }
  }

  return json({
    ok: true,
    company_id: companyId,
    company_name: companyName,
    reviews_total: reviews.length,
    reviews_patched: patchedCount,
    reviews_skipped: skippedCount,
    errors,
  });
}

app.http("adminBackfillReviewExcerpts", {
  route: "xadmin-api-backfill-review-excerpts",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler,
});

module.exports = { handler, isExcerptMissing, buildExcerptPrompt, _test: { fetchExcerptForReview } };
