const axios = require("axios");
const { CosmosClient } = require("@azure/cosmos");
const { getXAIEndpoint, getXAIKey } = require("./_shared");

function json(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-functions-key",
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

function toNormalizedDomain(s = "") {
  try {
    const u = s.startsWith("http") ? new URL(s) : new URL(`https://${s}`);
    let h = u.hostname.toLowerCase();
    if (h.startsWith("www.")) h = h.slice(4);
    return h || "unknown";
  } catch {
    return "unknown";
  }
}

function normalizeStringList(input) {
  if (Array.isArray(input)) {
    return [...new Set(input.map((s) => asString(s).trim()).filter(Boolean))];
  }

  if (typeof input === "string") {
    return [
      ...new Set(
        input
          .split(/[,;|\n]/)
          .map((s) => s.trim())
          .filter(Boolean)
      ),
    ];
  }

  return [];
}

function normalizeLocationSources(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v) => v && typeof v === "object")
    .map((v) => {
      const location = asString(v.location).trim();
      const source_url = asString(v.source_url).trim();
      const source_type = asString(v.source_type).trim();
      const location_type = asString(v.location_type).trim();
      if (!location) return null;
      return {
        location,
        ...(source_url ? { source_url } : {}),
        ...(source_type ? { source_type } : {}),
        ...(location_type ? { location_type } : {}),
      };
    })
    .filter(Boolean);
}

function normalizeLocationConfidence(value) {
  const v = asString(value).trim().toLowerCase();
  if (v === "high" || v === "medium" || v === "low") return v;
  return "medium";
}

function normalizeManufacturingLocations(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => {
      if (typeof v === "string") {
        const s = v.trim();
        return s ? { location: s } : null;
      }
      if (v && typeof v === "object") {
        const formatted = asString(v.formatted).trim();
        const location = asString(v.location || v.address || v.full_address).trim();
        const city = asString(v.city).trim();
        const region = asString(v.region || v.state).trim();
        const country = asString(v.country).trim();
        const best = formatted || location || [city, region, country].filter(Boolean).join(", ");
        return best ? { location: best } : null;
      }
      return null;
    })
    .filter(Boolean);
}

function normalizeHeadquartersLocations(hqString) {
  const s = asString(hqString).trim();
  if (!s) return [];
  return [{ formatted: s, is_hq: true }];
}

function parseXaiCompaniesResponse(text) {
  const raw = asString(text);
  if (!raw.trim()) return { companies: [], parse_error: "Empty response" };

  try {
    const parsed = safeJsonParse(raw);
    if (Array.isArray(parsed)) return { companies: parsed, parse_error: null };
  } catch {}

  try {
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return { companies: [], parse_error: "No JSON array found" };
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return { companies: [], parse_error: "Parsed value is not an array" };
    return { companies: parsed, parse_error: null };
  } catch (e) {
    return { companies: [], parse_error: e?.message || String(e) };
  }
}

function buildPrompt({ companyName, websiteUrl, normalizedDomain }) {
  const hints = [
    companyName ? `Company name: ${companyName}` : null,
    websiteUrl ? `Website URL: ${websiteUrl}` : null,
    normalizedDomain ? `Domain: ${normalizedDomain}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return `You are a business research assistant specializing in headquarters and manufacturing location extraction.

Your task: Enrich ONE specific company, matching the target company as closely as possible.
Do NOT return competitors or similarly named companies.

TARGET COMPANY HINTS:
${hints || "(no hints provided)"}

FORMAT YOUR RESPONSE AS A VALID JSON ARRAY with EXACTLY 1 object. The object MUST have:
- company_name (string)
- website_url (string)
- industries (array)
- product_keywords (string): Comma-separated list of up to 25 concrete product keywords (real products/product lines/categories; avoid vague marketing terms)
- headquarters_location (string): "City, State/Region, Country" (or "" if truly unknown)
- manufacturing_locations (array): Array of location strings. Country-only is acceptable (e.g. "United States")
- location_sources (array): Array of objects { location, source_url, source_type, location_type }
- red_flag (boolean)
- red_flag_reason (string)
- tagline (string, optional)
- social (object, optional): {linkedin, instagram, x, twitter, facebook, tiktok, youtube}
- location_confidence (string, optional): "high", "medium", or "low"

Return ONLY the JSON array, with no additional text.`;
}

function getCompaniesContainer() {
  const endpoint = asString(process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_ENDPOINT).trim();
  const key = asString(process.env.COSMOS_DB_KEY || process.env.COSMOS_KEY).trim();
  const database = asString(process.env.COSMOS_DB_DATABASE || process.env.COSMOS_DB || "tabarnam-db").trim();
  const containerName = asString(process.env.COSMOS_DB_COMPANIES_CONTAINER || process.env.COSMOS_CONTAINER || "companies").trim();
  if (!endpoint || !key) return null;
  const client = new CosmosClient({ endpoint, key });
  return client.database(database).container(containerName);
}

async function loadCompanyById(container, companyId) {
  const querySpec = {
    query: "SELECT * FROM c WHERE c.id = @id",
    parameters: [{ name: "@id", value: companyId }],
  };
  const { resources } = await container.items.query(querySpec, { enableCrossPartitionQuery: true }).fetchAll();
  const docs = Array.isArray(resources) ? resources : [];
  return docs[0] || null;
}

function buildProposedCompanyFromXaiResult(xaiCompany) {
  const src = xaiCompany && typeof xaiCompany === "object" ? xaiCompany : {};

  const company_name = asString(src.company_name || src.name).trim();
  const website_url = asString(src.website_url || src.canonical_url || src.url || src.website).trim();
  const industries = normalizeStringList(src.industries);
  const keywords = normalizeStringList(src.product_keywords);

  const headquarters_locations = normalizeHeadquartersLocations(src.headquarters_location);
  const manufacturing_locations = normalizeManufacturingLocations(src.manufacturing_locations);

  const location_sources = normalizeLocationSources(src.location_sources);
  const red_flag = Boolean(src.red_flag);
  const red_flag_reason = asString(src.red_flag_reason).trim();
  const tagline = asString(src.tagline).trim();

  const normalized_domain = toNormalizedDomain(website_url || src.canonical_url || src.url || src.amazon_url || "");

  const proposed = {
    ...(company_name ? { company_name } : {}),
    ...(website_url ? { website_url } : {}),
    ...(tagline ? { tagline } : {}),
    ...(industries.length ? { industries } : {}),
    ...(keywords.length ? { keywords } : {}),
    ...(headquarters_locations.length ? { headquarters_locations } : {}),
    ...(manufacturing_locations.length ? { manufacturing_locations } : {}),
    ...(location_sources.length ? { location_sources } : {}),
    ...(asString(src.headquarters_location).trim() ? { headquarters_location: asString(src.headquarters_location).trim() } : {}),
    ...(Array.isArray(src.manufacturing_locations) ? { manufacturing_locations_raw: src.manufacturing_locations } : {}),
    ...(typeof src.red_flag === "boolean" ? { red_flag } : {}),
    ...(red_flag_reason ? { red_flag_reason } : {}),
    ...(src.location_confidence ? { location_confidence: normalizeLocationConfidence(src.location_confidence) } : {}),
    ...(normalized_domain ? { normalized_domain } : {}),
    ...(src.social && typeof src.social === "object" ? { social: src.social } : {}),
    ...(asString(src.amazon_url).trim() ? { amazon_url: asString(src.amazon_url).trim() } : {}),
  };

  for (const key of [
    "logo_url",
    "rating",
    "rating_icon_type",
    "notes_entries",
    "notes",
    "star_rating",
    "star_overrides",
    "admin_manual_extra",
    "star_notes",
    "star_explanation",
  ]) {
    delete proposed[key];
  }

  return proposed;
}

async function adminRefreshCompanyHandler(req, context, deps = {}) {
  if (req?.method === "OPTIONS") {
    return json({ ok: true }, 200);
  }

  const startedAt = Date.now();
  let stage = "start";

  const config = {
    COSMOS_DB_ENDPOINT_SET: Boolean(asString(process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_ENDPOINT).trim()),
    COSMOS_DB_KEY_SET: Boolean(asString(process.env.COSMOS_DB_KEY || process.env.COSMOS_KEY).trim()),
    COSMOS_DB_DATABASE_SET: Boolean(asString(process.env.COSMOS_DB_DATABASE || process.env.COSMOS_DB).trim()),
    COSMOS_DB_COMPANIES_CONTAINER_SET: Boolean(
      asString(process.env.COSMOS_DB_COMPANIES_CONTAINER || process.env.COSMOS_CONTAINER).trim()
    ),
    XAI_EXTERNAL_BASE_SET: Boolean(asString(process.env.XAI_EXTERNAL_BASE || process.env.FUNCTION_URL).trim()),
    XAI_EXTERNAL_KEY_SET: Boolean(asString(process.env.XAI_EXTERNAL_KEY || process.env.FUNCTION_KEY || process.env.XAI_API_KEY).trim()),
  };

  try {
    stage = "parse_body";
    const body = await readJsonBody(req);
    const companyId = asString(body.company_id || body.id).trim();

    if (!companyId) {
      return json(
        {
          ok: false,
          stage,
          error: "company_id required",
          config,
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
    const existing = await loadFn(container, companyId);
    if (!existing) {
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

    stage = "prepare_prompt";
    const companyName = asString(existing.company_name || existing.name).trim();
    const websiteUrl = asString(existing.website_url || existing.canonical_url || existing.url).trim();
    const normalizedDomain = asString(existing.normalized_domain).trim() || toNormalizedDomain(websiteUrl);

    stage = "init_xai";
    const xaiUrl = asString(deps.xaiUrl || getXAIEndpoint()).trim();
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

    const prompt = buildPrompt({ companyName, websiteUrl, normalizedDomain });
    const payload = {
      messages: [{ role: "user", content: prompt }],
      model: "grok-4-latest",
      temperature: 0.1,
      stream: false,
    };

    stage = "call_xai";
    const axiosPost = deps.axiosPost || axios.post.bind(axios);
    const resp = await axiosPost(xaiUrl, payload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${xaiKey}`,
      },
      timeout: 25000,
      validateStatus: () => true,
    });

    stage = "parse_xai";
    const responseText =
      resp?.data?.choices?.[0]?.message?.content ||
      (typeof resp?.data === "string" ? resp.data : JSON.stringify(resp.data || {}));

    const { companies, parse_error } = parseXaiCompaniesResponse(responseText);

    if (resp.status < 200 || resp.status >= 300) {
      return json(
        {
          ok: false,
          stage,
          error: "Upstream enrichment failed",
          status: resp.status,
          details: { parse_error, upstream_preview: asString(responseText).slice(0, 8000) },
          elapsed_ms: Date.now() - startedAt,
        },
        502
      );
    }

    if (!Array.isArray(companies) || companies.length === 0) {
      return json(
        {
          ok: false,
          stage,
          error: "No proposed company returned",
          details: { parse_error, upstream_preview: asString(responseText).slice(0, 8000) },
          elapsed_ms: Date.now() - startedAt,
        },
        502
      );
    }

    stage = "build_proposed";
    const proposed = buildProposedCompanyFromXaiResult(companies[0]);

    stage = "done";
    return json({
      ok: true,
      company_id: companyId,
      elapsed_ms: Date.now() - startedAt,
      proposed,
      hints: {
        company_name: companyName,
        website_url: websiteUrl,
        normalized_domain: normalizedDomain,
      },
    });
  } catch (e) {
    context?.log?.("[admin-refresh-company] error", {
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
  adminRefreshCompanyHandler,
  buildProposedCompanyFromXaiResult,
  buildPrompt,
  parseXaiCompaniesResponse,
  loadCompanyById,
  toNormalizedDomain,
};
