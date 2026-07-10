// Company URL capture — step 3 of the Extract Companies pipeline.
//
// Given a company/brand NAME (surfaced by extraction + reconciled as "new"),
// find that company's OWN official website — not the marketplace we pulled it
// from, not Amazon/Wikipedia/social. Uses xAI web search with a tight,
// low-token, strict-JSON prompt because this is a simple lookup, not deep
// enrichment.
//
// Model is operator-selectable via XAI_URL_LOOKUP_MODEL so a cheap/fast model
// can be used without a code change; otherwise it falls back to the app's
// configured xAI model chain.

const { xaiLiveSearch, extractTextFromXaiResponse } = require("./_xaiLiveSearch");

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_TOKENS = 200; // just a URL + confidence — keep output tiny
const DEFAULT_CONCURRENCY = 5;
const MAX_BATCH = 50;

// Domains that are NOT a company's own site — marketplaces, aggregators,
// socials, encyclopedias. If the model returns one of these we treat the
// lookup as "not found" (the source marketplace host is added per-call).
const NON_OWN_HOST_FRAGMENTS = [
  "amazon.", "walmart.", "etsy.", "ebay.", "target.", "aliexpress.", "alibaba.",
  "faire.com", "shopify.com", "facebook.", "instagram.", "tiktok.", "twitter.",
  "x.com", "linkedin.", "pinterest.", "youtube.", "youtu.be", "wikipedia.",
  "yelp.", "google.", "bing.", "reddit.", "crunchbase.", "bbb.org",
];

function asString(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function hostOf(rawUrl) {
  try {
    let raw = asString(rawUrl).trim();
    if (!raw) return "";
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Normalize a model-returned URL to a clean https homepage origin, or "" if
 * it isn't a usable http(s) URL.
 */
function normalizeUrl(rawUrl) {
  let raw = asString(rawUrl).trim();
  if (!raw) return "";
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    if (!u.hostname || !u.hostname.includes(".")) return "";
    // Homepage origin — drop path/query/hash for a clean, paste-ready URL.
    return `${u.protocol}//${u.hostname}`;
  } catch {
    return "";
  }
}

function isRejectedHost(host, sourceHost) {
  if (!host) return true;
  if (sourceHost && (host === sourceHost || host.endsWith(`.${sourceHost}`))) return true;
  return NON_OWN_HOST_FRAGMENTS.some((frag) => host.includes(frag));
}

const URL_LOOKUP_SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean" },
    website_url: { type: "string" },
    confidence: { type: "number" },
  },
  required: ["found", "website_url", "confidence"],
  additionalProperties: false,
};

function buildPrompt(name, sourceContext) {
  const where = sourceContext ? ` The company sells on ${sourceContext}.` : "";
  return (
    `Find the official website (homepage) of the company/brand "${name}".${where}\n` +
    `Return the brand's OWN website — not a marketplace, retailer, Amazon, ` +
    `social media, Wikipedia, or directory listing. If you cannot confidently ` +
    `identify the official homepage, set found=false and website_url to "".\n` +
    `Respond ONLY as JSON: {"found": boolean, "website_url": string, "confidence": number between 0 and 1}.`
  );
}

/**
 * Resolve one company's website. Always resolves (never throws).
 * Returns { name, found, website_url, confidence, error?, model, elapsed_ms }.
 */
async function lookupCompanyUrl(name, opts = {}) {
  const startedAt = Date.now();
  const cleanName = asString(name).trim();
  const model = asString(opts.model).trim() || undefined; // undefined → xaiLiveSearch default chain
  const sourceHost = hostOf(opts.sourceUrl);
  const base = { name: cleanName, model: model || "(default)" };

  if (!cleanName) {
    return { ...base, found: false, website_url: "", confidence: 0, error: "empty_name", elapsed_ms: 0 };
  }

  let result;
  try {
    result = await xaiLiveSearch({
      prompt: buildPrompt(cleanName, opts.sourceContext),
      model,
      maxTokens: opts.maxTokens || DEFAULT_MAX_TOKENS,
      timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
      useTools: true,
      search_parameters: { mode: "on" },
      response_format: {
        type: "json_schema",
        json_schema: { name: "company_url", schema: URL_LOOKUP_SCHEMA, strict: true },
      },
      signal: opts.signal,
    });
  } catch (e) {
    return { ...base, found: false, website_url: "", confidence: 0, error: asString(e?.message || e), elapsed_ms: Date.now() - startedAt };
  }

  if (!result || !result.ok) {
    return { ...base, found: false, website_url: "", confidence: 0, error: result?.error || "xai_failed", elapsed_ms: Date.now() - startedAt };
  }

  const text = extractTextFromXaiResponse(result.resp);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ...base, found: false, website_url: "", confidence: 0, error: "unparseable_response", elapsed_ms: Date.now() - startedAt };
  }

  const url = normalizeUrl(parsed?.website_url);
  const host = hostOf(url);
  let found = Boolean(parsed?.found) && !!url && !isRejectedHost(host, sourceHost);
  let confidence = Number(parsed?.confidence);
  if (!Number.isFinite(confidence)) confidence = found ? 0.5 : 0;

  return {
    ...base,
    found,
    website_url: found ? url : "",
    confidence: Math.max(0, Math.min(1, confidence)),
    ...(found ? {} : { error: url && isRejectedHost(host, sourceHost) ? "rejected_marketplace_host" : (parsed?.found ? "unusable_url" : "not_found") }),
    elapsed_ms: Date.now() - startedAt,
  };
}

/**
 * Resolve a batch of company names with bounded concurrency.
 * Returns { model, results: [...] } preserving input order.
 */
async function lookupCompanyUrlsBatch(names, opts = {}) {
  const list = (Array.isArray(names) ? names : []).slice(0, MAX_BATCH).map(asString);
  const concurrency = Math.max(1, Math.min(10, Number(opts.concurrency) || DEFAULT_CONCURRENCY));
  const results = new Array(list.length);

  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= list.length) return;
      results[i] = await lookupCompanyUrl(list[i], opts);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));

  return { model: asString(opts.model).trim() || "(default)", results };
}

module.exports = {
  lookupCompanyUrl,
  lookupCompanyUrlsBatch,
  // exported for tests
  normalizeUrl,
  isRejectedHost,
  hostOf,
  MAX_BATCH,
};
