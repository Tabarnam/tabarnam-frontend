const { xaiLiveSearch, extractTextFromXaiResponse } = require("./_xaiLiveSearch");
const { extractJsonFromText } = require("./_curatedReviewsXai");
const { buildSearchParameters } = require("./_buildSearchParameters");

const DEFAULT_REVIEW_EXCLUDE_DOMAINS = [
  "amazon.",
  "amzn.to",
  "google.",
  "g.co",
  "goo.gl",
  "yelp.",
];

function clampInt(value, { min, max, fallback }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  return Math.max(min, Math.min(max, i));
}

// Keep upstream calls safely under the SWA gateway wall-clock (~30s) with a buffer.
function clampStageTimeoutMs({ remainingMs, minMs = 2_500, maxMs = 8_000, safetyMarginMs = 1_200 } = {}) {
  const rem = Number.isFinite(Number(remainingMs)) ? Number(remainingMs) : 0;
  const min = clampInt(minMs, { min: 250, max: 60_000, fallback: 2_500 });
  const max = clampInt(maxMs, { min, max: 60_000, fallback: 8_000 });
  const safety = clampInt(safetyMarginMs, { min: 0, max: 20_000, fallback: 1_200 });

  const raw = Math.max(0, Math.trunc(rem - safety));
  return Math.max(min, Math.min(max, raw));
}

function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function normalizeDomain(raw) {
  const host = asString(raw).trim().toLowerCase();
  if (!host) return "";
  return host.replace(/^www\./, "").replace(/\.+$/, "");
}

function parseJsonFromXaiResponse(resp) {
  const text = extractTextFromXaiResponse(resp);
  const parsed = extractJsonFromText(text);
  return parsed;
}

function normalizeExcludeDomains({ normalizedDomain } = {}) {
  const nd = normalizeDomain(normalizedDomain);

  const out = [];
  const push = (v) => {
    const s = asString(v).trim();
    if (!s) return;
    out.push(s);
  };

  for (const d of DEFAULT_REVIEW_EXCLUDE_DOMAINS) push(d);
  if (nd) {
    push(nd);
    push(`www.${nd}`);
  }

  return Array.from(new Set(out));
}

async function fetchCuratedReviews({
  companyName,
  normalizedDomain,
  budgetMs = 25000,
  xaiUrl,
  xaiKey,
  model = "grok-4-latest",
} = {}) {
  const started = Date.now();

  const name = asString(companyName).trim();
  const domain = normalizeDomain(normalizedDomain);

  const excludeDomains = normalizeExcludeDomains({ normalizedDomain: domain });

  const prompt = `
Find independent third-party reviews for the company:
Name: ${name}
Domain: ${domain}

Rules:
- Use web search. Provide up to 10 candidates.
- Exclude sources from these domains or subdomains: ${excludeDomains.join(", ")}
- Each item must include: source_name, source_url, excerpt, and if available rating and review_count.
- Output STRICT JSON array only.

Return JSON array:
[
  { "source_name": "...", "source_url": "...", "excerpt": "...", "rating": 4.5, "review_count": 123 }
]
`.trim();

  // Budget clamp: if we can't safely run another upstream call, defer without terminalizing.
  const remaining = budgetMs - (Date.now() - started);
  if (remaining < 3000) {
    return {
      curated_reviews: [],
      reviews_stage_status: "deferred",
      diagnostics: { reason: "budget_too_low", remaining_ms: Math.max(0, remaining) },
    };
  }

  const searchBuild = buildSearchParameters({
    companyWebsiteHost: domain,
    additionalExcludedHosts: excludeDomains,
  });

  const r = await xaiLiveSearch({
    prompt,
    timeoutMs: clampStageTimeoutMs({ remainingMs: remaining, maxMs: 8_000 }),
    maxTokens: 900,
    model: asString(model).trim() || "grok-4-latest",
    xaiUrl,
    xaiKey,
    search_parameters: searchBuild.search_parameters,
  });

  if (!r.ok) {
    return {
      curated_reviews: [],
      reviews_stage_status: "upstream_unreachable",
      diagnostics: { error: r.error },
      search_telemetry: searchBuild.telemetry,
      excluded_hosts: searchBuild.excluded_hosts,
    };
  }

  const parsed = parseJsonFromXaiResponse(r.resp);

  let candidates = [];
  if (Array.isArray(parsed)) candidates = parsed;
  else if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.reviews)) candidates = parsed.reviews;
    else if (Array.isArray(parsed.items)) candidates = parsed.items;
  }

  const validated = (Array.isArray(candidates) ? candidates : [])
    .filter((x) => x && typeof x === "object")
    .map((x) => ({
      source_name: asString(x.source_name || x.source || x.site || x.provider).trim(),
      source_url: asString(x.source_url || x.url || x.link).trim(),
      excerpt: asString(x.excerpt || x.text || x.snippet || x.summary).trim(),
      rating: x.rating ?? null,
      review_count: x.review_count ?? null,
      title: asString(x.title || "").trim() || null,
    }))
    .filter((x) => x.source_url && x.excerpt && x.source_name)
    .filter((x) => !excludeDomains.some((d) => x.source_url.includes(d)));

  const curated_reviews = validated.slice(0, 2);

  if (curated_reviews.length === 0) {
    return {
      curated_reviews: [],
      reviews_stage_status: "exhausted",
      diagnostics: { candidate_count: candidates.length, validated_count: 0 },
      search_telemetry: searchBuild.telemetry,
      excluded_hosts: searchBuild.excluded_hosts,
    };
  }

  return {
    curated_reviews,
    reviews_stage_status: "ok",
    diagnostics: { candidate_count: candidates.length, validated_count: validated.length },
    search_telemetry: searchBuild.telemetry,
    excluded_hosts: searchBuild.excluded_hosts,
  };
}

async function fetchHeadquartersLocation({
  companyName,
  normalizedDomain,
  budgetMs = 20000,
  xaiUrl,
  xaiKey,
} = {}) {
  const started = Date.now();

  const name = asString(companyName).trim();
  const domain = normalizeDomain(normalizedDomain);

  const prompt = `
Find the headquarters location for the company:
Name: ${name}
Domain: ${domain}

Rules:
- Use web search.
- Prefer authoritative sources like LinkedIn, official filings, reputable business directories.
- Return best available as: "City, ST, Country" (minimum "City, Country" or "Country" if truly all you can find).
- Output STRICT JSON only.

Return:
{ "headquarters_location": "..." }
`.trim();

  const remaining = budgetMs - (Date.now() - started);
  if (remaining < 2500) {
    return {
      headquarters_location: "",
      hq_status: "deferred",
      diagnostics: { reason: "budget_too_low", remaining_ms: Math.max(0, remaining) },
    };
  }

  const r = await xaiLiveSearch({
    prompt,
    timeoutMs: clampStageTimeoutMs({ remainingMs: remaining, maxMs: 8_000 }),
    maxTokens: 300,
    model: "grok-2-latest",
    xaiUrl,
    xaiKey,
    search_parameters: { mode: "on" },
  });

  if (!r.ok) {
    return {
      headquarters_location: "",
      hq_status: "upstream_unreachable",
    };
  }

  const out = parseJsonFromXaiResponse(r.resp);
  const value = asString(out?.headquarters_location).trim();
  if (!value) {
    return { headquarters_location: "", hq_status: "not_found" };
  }

  // "Not disclosed" is a terminal sentinel (downstream treats it as complete).
  if (value.toLowerCase() === "not disclosed" || value.toLowerCase() === "not_disclosed") {
    return { headquarters_location: "Not disclosed", hq_status: "not_disclosed" };
  }

  return { headquarters_location: value, hq_status: "ok" };
}

async function fetchManufacturingLocations({
  companyName,
  normalizedDomain,
  budgetMs = 20000,
  xaiUrl,
  xaiKey,
} = {}) {
  const started = Date.now();

  const name = asString(companyName).trim();
  const domain = normalizeDomain(normalizedDomain);

  const prompt = `
Find manufacturing locations for the company:
Name: ${name}
Domain: ${domain}

Rules:
- Use web search.
- Return an array of locations. Prefer "Country" or "City, ST, Country" when known.
- If manufacturing is not publicly disclosed, return ["Not disclosed"].
- Output STRICT JSON only.

Return:
{ "manufacturing_locations": ["..."] }
`.trim();

  const remaining = budgetMs - (Date.now() - started);
  if (remaining < 2500) {
    return {
      manufacturing_locations: [],
      mfg_status: "deferred",
      diagnostics: { reason: "budget_too_low", remaining_ms: Math.max(0, remaining) },
    };
  }

  const r = await xaiLiveSearch({
    prompt,
    timeoutMs: clampStageTimeoutMs({ remainingMs: remaining, maxMs: 8_000 }),
    maxTokens: 400,
    model: "grok-2-latest",
    xaiUrl,
    xaiKey,
    search_parameters: { mode: "on" },
  });

  if (!r.ok) {
    return { manufacturing_locations: [], mfg_status: "upstream_unreachable" };
  }

  const out = parseJsonFromXaiResponse(r.resp);

  const arr = Array.isArray(out?.manufacturing_locations) ? out.manufacturing_locations : [];
  const cleaned = arr.map((x) => asString(x).trim()).filter(Boolean);

  if (cleaned.length === 0) {
    return { manufacturing_locations: [], mfg_status: "not_found" };
  }

  if (cleaned.length === 1 && cleaned[0].toLowerCase().includes("not disclosed")) {
    return { manufacturing_locations: ["Not disclosed"], mfg_status: "not_disclosed" };
  }

  return { manufacturing_locations: cleaned, mfg_status: "ok" };
}

module.exports = {
  DEFAULT_REVIEW_EXCLUDE_DOMAINS,
  fetchCuratedReviews,
  fetchHeadquartersLocation,
  fetchManufacturingLocations,
};
