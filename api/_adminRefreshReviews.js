let axios;
try {
  axios = require("axios");
} catch {
  axios = null;
}

let CosmosClient;
try {
  ({ CosmosClient } = require("@azure/cosmos"));
} catch {
  CosmosClient = null;
}

const { createHash, randomUUID } = require("node:crypto");

const { getXAIEndpoint, getXAIKey, resolveXaiEndpointForModel } = require("./_shared");
const { getBuildInfo } = require("./_buildInfo");
const { loadCompanyById, toNormalizedDomain } = require("./_adminRefreshCompany");

const BUILD_INFO = getBuildInfo();
const HANDLER_ID = "refresh-reviews";

function json(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-functions-key",
      "X-Api-Handler": HANDLER_ID,
      "X-Api-Build-Id": String(BUILD_INFO.build_id || ""),
      "X-Api-Build-Source": String(BUILD_INFO.build_id_source || ""),
    },
    body: JSON.stringify(obj),
  };
}

function safeJsonParse(text) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readJsonBody(req) {
  if (!req) return {};

  if (typeof req.json === "function") {
    try {
      const val = await req.json();
      if (val && typeof val === "object") return val;
    } catch {}
  }

  if (req.body && typeof req.body === "object") return req.body;

  if (typeof req.body === "string" && req.body.trim()) {
    const parsed = safeJsonParse(req.body);
    if (parsed && typeof parsed === "object") return parsed;
  }

  const rawBody = req.rawBody;
  if (typeof rawBody === "string" && rawBody.trim()) {
    const parsed = safeJsonParse(rawBody);
    if (parsed && typeof parsed === "object") return parsed;
  }

  if (rawBody && (Buffer.isBuffer(rawBody) || rawBody instanceof Uint8Array)) {
    const parsed = safeJsonParse(Buffer.from(rawBody).toString("utf8"));
    if (parsed && typeof parsed === "object") return parsed;
  }

  return {};
}

function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function readTimeoutMs(value, fallback) {
  const raw = asString(value).trim();
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.max(5000, Math.min(300000, Math.floor(num)));
}

function readTake(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(200, Math.trunc(n)));
}

function getCompaniesContainer() {
  const endpoint = asString(process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_ENDPOINT).trim();
  const key = asString(process.env.COSMOS_DB_KEY || process.env.COSMOS_KEY).trim();
  const database = asString(process.env.COSMOS_DB_DATABASE || process.env.COSMOS_DB || "tabarnam-db").trim();
  const containerName = asString(process.env.COSMOS_DB_COMPANIES_CONTAINER || process.env.COSMOS_CONTAINER || "companies").trim();
  if (!endpoint || !key) return null;
  if (!CosmosClient) return null;

  try {
    const client = new CosmosClient({ endpoint, key });
    return client.database(database).container(containerName);
  } catch {
    return null;
  }
}

function parseJsonArrayFromText(text) {
  const raw = asString(text);
  if (!raw.trim()) return { items: [], parse_error: "Empty response" };

  try {
    const parsed = safeJsonParse(raw);
    if (Array.isArray(parsed)) return { items: parsed, parse_error: null };
  } catch {}

  try {
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return { items: [], parse_error: "No JSON array found" };
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return { items: [], parse_error: "Parsed value is not an array" };
    return { items: parsed, parse_error: null };
  } catch (e) {
    return { items: [], parse_error: e?.message || String(e) };
  }
}

function normalizeWhitespace(s) {
  return asString(s).replace(/\s+/g, " ").trim();
}

function normalizeForHash(s) {
  return normalizeWhitespace(s)
    .toLowerCase()
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeUrlForCompare(s) {
  const raw = asString(s).trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    u.hash = "";
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    const search = u.searchParams.toString();
    return `${u.protocol}//${host}${path}${search ? `?${search}` : ""}`;
  } catch {
    return raw.toLowerCase();
  }
}

function computeReviewHash(r) {
  const title = normalizeForHash(r?.title);
  const excerpt = normalizeForHash(r?.excerpt);
  const author = normalizeForHash(r?.author);
  const date = normalizeForHash(r?.date);
  const blob = [title, excerpt, author, date].filter(Boolean).join("|");
  if (!blob) return "";
  return createHash("sha256").update(blob).digest("hex");
}

function normalizeReviewCandidate(value) {
  const r = value && typeof value === "object" ? value : {};

  const source_url = normalizeWhitespace(r.source_url || r.url);
  const title = normalizeWhitespace(r.title);
  const excerpt = normalizeWhitespace(r.excerpt || r.abstract || r.text || r.summary);
  const source = normalizeWhitespace(r.source || r.platform) || "professional_review";
  const author = normalizeWhitespace(r.author || r.publication);
  const date = normalizeWhitespace(r.date);

  const ratingRaw = r.rating;
  const rating = typeof ratingRaw === "number" && Number.isFinite(ratingRaw) ? ratingRaw : null;

  if (!source_url && !title && !excerpt) return null;

  return {
    id: `proposed_${Date.now()}_${randomUUID()}`,
    source,
    source_url,
    title,
    excerpt,
    author,
    date: date || null,
    rating,
  };
}

function buildReviewsPrompt({ companyName, websiteUrl, industries, take, existingContext }) {
  const hints = [
    companyName ? `Company: ${companyName}` : null,
    websiteUrl ? `Website: ${websiteUrl}` : null,
    industries ? `Industries: ${industries}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const existingBlock = existingContext
    ? `\n\nALREADY IMPORTED REVIEWS (avoid duplicates):\n${existingContext}`
    : "";

  return `You are a research assistant finding editorial and professional reviews.
For this company, find and summarize up to ${take} editorial/professional reviews ONLY.

${hints || "(no company hints provided)"}

CRITICAL REVIEW SOURCE REQUIREMENTS:
You MUST ONLY include editorial and professional sources. Do NOT include:
- Amazon customer reviews
- Google/Yelp reviews
- Customer testimonials or user-generated content
- Social media comments

ONLY accept reviews from:
- Magazines and industry publications
- News outlets and journalists
- Professional review websites
- Independent testing labs (ConsumerLab, Labdoor, etc.)
- Health/product analysis sites
- Major retailer editorial content (blogs, articles written in editorial voice)
- Company blog articles written in editorial/educational voice

Return a JSON array of review objects. Each review object MUST be:
{
  "source": "magazine|editorial_site|lab_test|news|professional_review",
  "source_url": "https://example.com/article",
  "title": "Article/review headline",
  "excerpt": "1-2 sentence summary of the editorial analysis or findings",
  "rating": null,
  "author": "Publication name or author name",
  "date": "YYYY-MM-DD" 
}

Return ONLY the JSON array and no other text.${existingBlock}`;
}

async function adminRefreshReviewsHandler(req, context, deps = {}) {
  if (req?.method === "OPTIONS") {
    return json({ ok: true }, 200);
  }

  const startedAt = Date.now();
  let stage = "start";

  const xaiTimeoutMs = readTimeoutMs(
    deps.xaiTimeoutMs ?? process.env.XAI_TIMEOUT_MS ?? process.env.XAI_REQUEST_TIMEOUT_MS,
    120000
  );

  const config = {
    COSMOS_DB_ENDPOINT_SET: Boolean(asString(process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_ENDPOINT).trim()),
    COSMOS_DB_KEY_SET: Boolean(asString(process.env.COSMOS_DB_KEY || process.env.COSMOS_KEY).trim()),
    COSMOS_DB_DATABASE_SET: Boolean(asString(process.env.COSMOS_DB_DATABASE || process.env.COSMOS_DB).trim()),
    COSMOS_DB_COMPANIES_CONTAINER_SET: Boolean(
      asString(process.env.COSMOS_DB_COMPANIES_CONTAINER || process.env.COSMOS_CONTAINER).trim()
    ),
    XAI_EXTERNAL_BASE_SET: Boolean(asString(process.env.XAI_EXTERNAL_BASE || process.env.FUNCTION_URL).trim()),
    XAI_EXTERNAL_KEY_SET: Boolean(
      asString(process.env.XAI_EXTERNAL_KEY || process.env.FUNCTION_KEY || process.env.XAI_API_KEY).trim()
    ),
    XAI_TIMEOUT_MS: xaiTimeoutMs,
  };

  try {
    stage = "parse_request";

    const method = asString(req?.method).toUpperCase();
    const body = method === "POST" ? await readJsonBody(req) : {};

    const query = req?.query && typeof req.query === "object" ? req.query : {};

    const companyId = asString(body.company_id || body.id || query.company_id || query.id).trim();
    const take = readTake(body.take ?? query.take, 10);
    const includeExistingInContext =
      body.include_existing_in_context === undefined && body.include_existing === undefined && body.includeExistingInContext === undefined
        ? true
        : Boolean(body.include_existing_in_context ?? body.include_existing ?? body.includeExistingInContext);

    if (!companyId) {
      return json(
        {
          ok: false,
          stage,
          error: "company_id required",
          config,
          elapsed_ms: Date.now() - startedAt,
        },
        400
      );
    }

    stage = "init_cosmos";
    const container = deps.companiesContainer || getCompaniesContainer();
    if (!container) {
      return json(
        {
          ok: false,
          stage,
          error: "Cosmos not configured",
          details: { message: "Set COSMOS_DB_ENDPOINT and COSMOS_DB_KEY" },
          config,
          elapsed_ms: Date.now() - startedAt,
        },
        500
      );
    }

    stage = "load_company";
    const loadFn = deps.loadCompanyById || loadCompanyById;
    const company = await loadFn(container, companyId);
    if (!company) {
      return json(
        {
          ok: false,
          stage,
          error: "Company not found",
          company_id: companyId,
          elapsed_ms: Date.now() - startedAt,
        },
        404
      );
    }

    const existingCurated = Array.isArray(company.curated_reviews) ? company.curated_reviews : [];
    const existingUrlSet = new Set(
      existingCurated
        .map((r) => normalizeUrlForCompare(r?.source_url || r?.url))
        .filter(Boolean)
    );
    const existingHashSet = new Set(existingCurated.map(computeReviewHash).filter(Boolean));

    const companyName = asString(company.company_name || company.name).trim();
    const websiteUrl = asString(company.website_url || company.canonical_url || company.url).trim();
    const industries = Array.isArray(company.industries) ? company.industries.join(", ") : asString(company.industries).trim();

    const existingContext = includeExistingInContext
      ? existingCurated
          .slice(0, 50)
          .map((r) => {
            const url = normalizeWhitespace(r?.source_url || r?.url);
            const title = normalizeWhitespace(r?.title);
            return url && title ? `- ${title} (${url})` : url ? `- ${url}` : title ? `- ${title}` : null;
          })
          .filter(Boolean)
          .join("\n")
      : "";

    stage = "init_xai";
    const xaiEndpointRaw = asString(deps.xaiUrl || getXAIEndpoint()).trim();
    const xaiModel = "grok-4-latest";
    const xaiUrl = resolveXaiEndpointForModel(xaiEndpointRaw, xaiModel);
    const xaiKey = asString(deps.xaiKey || getXAIKey()).trim();

    if (!xaiUrl || !xaiKey) {
      return json(
        {
          ok: false,
          stage,
          error: "XAI not configured",
          details: { message: "Set XAI_EXTERNAL_BASE and XAI_EXTERNAL_KEY" },
          config,
          elapsed_ms: Date.now() - startedAt,
        },
        500
      );
    }

    stage = "build_prompt";
    const prompt = buildReviewsPrompt({
      companyName,
      websiteUrl,
      industries,
      take,
      existingContext,
    });

    const payload = {
      messages: [{ role: "user", content: prompt }],
      model: xaiModel,
      temperature: 0.2,
      stream: false,
    };

    stage = "call_xai";
    const axiosPost = deps.axiosPost || (axios ? axios.post.bind(axios) : null);
    if (!axiosPost) {
      return json(
        {
          ok: false,
          stage,
          error: "Axios not available",
          config,
          elapsed_ms: Date.now() - startedAt,
        },
        500
      );
    }

    const headers = {
      "Content-Type": "application/json",
    };

    // If the configured upstream is an Azure Function proxy, it typically expects the
    // function key via x-functions-key rather than Authorization: Bearer.
    let useFunctionsKey = false;
    try {
      const u = new URL(xaiUrl);
      useFunctionsKey = /\.azurewebsites\.net$/i.test(String(u.hostname || ""));
    } catch {}

    if (useFunctionsKey) {
      headers["x-functions-key"] = xaiKey;
    } else {
      headers.Authorization = `Bearer ${xaiKey}`;
    }

    const resp = await axiosPost(xaiUrl, payload, {
      headers,
      timeout: xaiTimeoutMs,
      validateStatus: () => true,
    });

    stage = "parse_xai";
    const responseText =
      resp?.data?.choices?.[0]?.message?.content ||
      (typeof resp?.data === "string" ? resp.data : JSON.stringify(resp.data || {}));

    if (resp.status < 200 || resp.status >= 300) {
      return json(
        {
          ok: false,
          stage,
          error: "Upstream reviews fetch failed",
          status: resp.status,
          details: {
            upstream_preview: asString(responseText).slice(0, 8000),
            xai_model: xaiModel,
            resolved_upstream_url: xaiUrl,
            endpoint_source: xaiEndpointRaw ? "configured" : "missing",
          },
          config,
          elapsed_ms: Date.now() - startedAt,
        },
        502
      );
    }

    const { items, parse_error } = parseJsonArrayFromText(responseText);

    const proposed = (Array.isArray(items) ? items : [])
      .map(normalizeReviewCandidate)
      .filter(Boolean)
      .slice(0, take);

    const proposed_reviews = proposed.map((r) => {
      const urlKey = normalizeUrlForCompare(r.source_url);
      const hashKey = computeReviewHash(r);
      const duplicate = (urlKey && existingUrlSet.has(urlKey)) || (hashKey && existingHashSet.has(hashKey));
      return {
        ...r,
        duplicate,
        ...(duplicate ? { duplicate_key: urlKey || hashKey || "unknown" } : {}),
      };
    });

    stage = "done";
    return json({
      ok: true,
      company_id: companyId,
      requested_take: take,
      returned_count: proposed_reviews.length,
      proposed_reviews,
      ...(parse_error ? { parse_error } : {}),
      elapsed_ms: Date.now() - startedAt,
      hints: {
        company_name: companyName,
        website_url: websiteUrl,
        normalized_domain: asString(company.normalized_domain).trim() || toNormalizedDomain(websiteUrl),
        include_existing_in_context: includeExistingInContext,
      },
    });
  } catch (e) {
    context?.log?.("[admin-refresh-reviews] error", {
      stage,
      message: e?.message || String(e),
      stack: e?.stack,
    });

    return json(
      {
        ok: false,
        stage,
        error: e?.message || "Internal error",
        config,
        elapsed_ms: Date.now() - startedAt,
      },
      500
    );
  }
}

module.exports = {
  adminRefreshReviewsHandler,
  _test: {
    parseJsonArrayFromText,
    normalizeReviewCandidate,
    computeReviewHash,
    normalizeUrlForCompare,
  },
};
