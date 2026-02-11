/**
 * Inline enrichment functions for import-start.
 *
 * Extracted from import-start/index.js. Each function receives an `enrichCtx`
 * object containing the handler-scoped dependencies it needs:
 *   { xaiUrl, xaiKey, postXaiJsonWithBudgetRetry, getRemainingMs, timeout, debugOutput }
 */

let createHash;
try {
  ({ createHash } = require("crypto"));
} catch {
  createHash = null;
}

const { checkUrlHealthAndFetchText } = require("../_reviewQuality");
const {
  fetchTagline: fetchTaglineGrok,
  fetchIndustries: fetchIndustriesGrok,
  fetchProductKeywords: fetchProductKeywordsGrok,
  enrichCompanyFields: enrichCompanyFieldsUnified,
} = require("../_grokEnrichment");
const { sanitizeIndustries, sanitizeKeywords } = require("../_requiredFields");

const {
  XAI_SYSTEM_PROMPT,
  AcceptedResponseError,
  extractXaiResponseText,
  toHostPathOnlyForLog,
} = require("./_importStartRequestUtils");

const {
  normalizeIndustries,
  normalizeProductKeywords,
  keywordListToString,
  toNormalizedDomain,
} = require("./_importStartCompanyUtils");

const DEADLINE_SAFETY_BUFFER_MS = 1_500;

// ---------------------------------------------------------------------------
// mapWithConcurrency — pure utility, no dependencies
// ---------------------------------------------------------------------------

async function mapWithConcurrency(items, concurrency, mapper) {
  const out = new Array(items.length);
  let idx = 0;

  const workers = new Array(Math.max(1, concurrency)).fill(0).map(async () => {
    while (idx < items.length) {
      const cur = idx++;
      try {
        out[cur] = await mapper(items[cur], cur);
      } catch {
        out[cur] = items[cur];
      }
    }
  });

  const results = await Promise.allSettled(workers);
  for (const r of results) {
    if (r.status === "rejected") {
      console.warn(`[import-start] mapWithConcurrency worker rejected: ${r.reason?.message || String(r.reason || "")}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// generateProductKeywords
// ---------------------------------------------------------------------------

async function generateProductKeywords(company, { timeoutMs }, enrichCtx) {
  const { xaiUrl, postXaiJsonWithBudgetRetry } = enrichCtx;
  const companyName = String(company?.company_name || company?.name || "").trim();
  const websiteUrl = String(company?.website_url || company?.url || "").trim();
  const tagline = String(company?.tagline || "").trim();

  const websiteText = await (async () => {
    const h = await checkUrlHealthAndFetchText(websiteUrl, {
      timeoutMs: Math.min(8000, timeoutMs),
      maxBytes: 80000,
    }).catch(() => null);
    return h?.ok ? String(h.text || "").slice(0, 4000) : "";
  })();

  const prompt = `SYSTEM (KEYWORDS / PRODUCTS LIST)
You are generating a comprehensive product keyword list for a company to power search and filtering.
Company:
\u2022 Name: ${companyName}
\u2022 Website: ${websiteUrl}
\u2022 Short description/tagline (if available): ${tagline}
Rules:
\u2022 Output ONLY a JSON object with a single field: "keywords".
\u2022 "keywords" must be an array of 15 to 25 short product phrases the company actually sells or makes.
\u2022 Use product-level specificity (e.g., "insulated cooler", "hard-sided cooler", "travel tumbler") not vague categories (e.g., "outdoor", "quality", "premium").
\u2022 Do NOT include brand name, company name, marketing adjectives, or locations.
\u2022 Do NOT repeat near-duplicates.
\u2022 If uncertain, infer from the website content and product collections; prioritize what is most likely sold.
${websiteText ? `\nWebsite content excerpt:\n${websiteText}\n` : ""}
Output JSON only:
{ "keywords": ["...", "..."] }`;

  const payload = {
    model: "grok-4-latest",
    messages: [
      { role: "system", content: XAI_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    temperature: 0.2,
    stream: false,
  };

  console.log(`[import-start] Calling XAI API (keywords) at: ${toHostPathOnlyForLog(xaiUrl)}`);
  const res = await postXaiJsonWithBudgetRetry({
    stageKey: "keywords",
    stageBeacon: "xai_keywords_fetch_start",
    body: JSON.stringify(payload),
    stageCapMsOverride: timeoutMs,
  });

  const text = extractXaiResponseText(res?.data) || "";

  let obj = null;
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) obj = JSON.parse(match[0]);
  } catch {
    obj = null;
  }

  const keywords = normalizeProductKeywords(obj?.keywords, { companyName, websiteUrl });

  const prompt_hash = (() => {
    try {
      if (!createHash) return null;
      return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
    } catch {
      return null;
    }
  })();

  return {
    prompt,
    prompt_hash,
    source_url: websiteUrl || null,
    source_text_preview: websiteText ? websiteText.slice(0, 800) : "",
    raw_response: text.length > 20000 ? text.slice(0, 20000) : text,
    keywords,
  };
}

// ---------------------------------------------------------------------------
// generateIndustries
// ---------------------------------------------------------------------------

async function generateIndustries(company, { timeoutMs }, enrichCtx) {
  const { postXaiJsonWithBudgetRetry } = enrichCtx;
  const companyName = String(company?.company_name || company?.name || "").trim();
  const websiteUrl = String(company?.website_url || company?.url || "").trim();
  const keywordText = String(company?.product_keywords || "").trim();

  const prompt = `SYSTEM (INDUSTRIES)
You are classifying a company into a small set of industries for search filtering.
Company:
\u2022 Name: ${companyName}
\u2022 Website: ${websiteUrl}
\u2022 Products: ${keywordText}
Rules:
\u2022 Output ONLY valid JSON with a single field: "industries".
\u2022 "industries" must be an array of 1 to 4 short industry names.
\u2022 Use commonly understood industries (e.g., "Textiles", "Apparel", "Industrial Equipment", "Electronics", "Food & Beverage").
\u2022 Do NOT include locations.
Output JSON only:
{ "industries": ["..."] }`;

  const payload = {
    model: "grok-4-latest",
    messages: [
      { role: "system", content: XAI_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    temperature: 0.1,
    stream: false,
  };

  const res = await postXaiJsonWithBudgetRetry({
    stageKey: "keywords",
    stageBeacon: "xai_industries_fetch_start",
    body: JSON.stringify(payload),
    stageCapMsOverride: timeoutMs,
  });

  const text = extractXaiResponseText(res?.data) || "";

  let obj = null;
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) obj = JSON.parse(match[0]);
  } catch {
    obj = null;
  }

  const industries = normalizeIndustries(obj?.industries).slice(0, 6);

  const prompt_hash = (() => {
    try {
      if (!createHash) return null;
      return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
    } catch {
      return null;
    }
  })();

  return {
    prompt,
    prompt_hash,
    source_url: websiteUrl || null,
    raw_response: text.length > 20000 ? text.slice(0, 20000) : text,
    industries,
  };
}

// ---------------------------------------------------------------------------
// tryUnifiedEnrichment
// ---------------------------------------------------------------------------

async function tryUnifiedEnrichment(company, enrichCtx) {
  const { xaiUrl, xaiKey, getRemainingMs, timeout } = enrichCtx;
  const companyName = String(company?.company_name || company?.name || "").trim();
  const websiteUrl = String(company?.website_url || company?.url || "").trim();
  const normalizedDomain = String(company?.normalized_domain || toNormalizedDomain(websiteUrl)).trim();

  if (!companyName || !websiteUrl) return false;

  const budgetMs = Math.min(
    240_000,
    Math.max(30_000, (typeof getRemainingMs === "function" ? getRemainingMs() : timeout) - DEADLINE_SAFETY_BUFFER_MS)
  );

  try {
    const ecf = await enrichCompanyFieldsUnified({
      companyName, websiteUrl, normalizedDomain, budgetMs, xaiUrl, xaiKey,
    });

    if (!ecf || !ecf.ok || !ecf.proposed) return false;

    const proposed = ecf.proposed;
    const statuses = ecf.field_statuses || {};

    company.enrichment_debug =
      company.enrichment_debug && typeof company.enrichment_debug === "object" ? company.enrichment_debug : {};

    if (typeof proposed.tagline === "string" && proposed.tagline.trim()) {
      company.tagline = proposed.tagline.trim();
    }

    if (Array.isArray(proposed.product_keywords) && proposed.product_keywords.length > 0) {
      const stats = sanitizeKeywords({ product_keywords: proposed.product_keywords.join(", "), keywords: [] });
      const sanitized = Array.isArray(stats?.sanitized) ? stats.sanitized : proposed.product_keywords;
      company.keywords = sanitized.slice(0, 25);
      company.product_keywords = keywordListToString(sanitized);
      company.keywords_source = "grok_unified";
      company.product_keywords_source = "grok_unified";
      company.enrichment_debug.keywords = {
        source: "unified",
        keyword_count: sanitized.length,
        stage_status: statuses.product_keywords || "ok",
      };
    }

    if (Array.isArray(proposed.industries) && proposed.industries.length > 0) {
      const sanitized = sanitizeIndustries(proposed.industries);
      if (sanitized.length > 0) {
        company.industries = sanitized;
        company.industries_unknown = false;
        company.industries_source = "grok_unified";
        company.enrichment_debug.industries = {
          source: "unified",
          industries: sanitized,
          stage_status: statuses.industries || "ok",
        };
      }
    }

    if (typeof proposed.headquarters_location === "string" && proposed.headquarters_location.trim()) {
      company.headquarters_location = proposed.headquarters_location.trim();
      company.hq_unknown = false;
      company.hq_unknown_reason = null;
    } else if (statuses.headquarters_location === "not_disclosed") {
      company.headquarters_location = "Not disclosed";
      company.hq_unknown = true;
      company.hq_unknown_reason = "not_disclosed";
    }

    if (Array.isArray(proposed.manufacturing_locations) && proposed.manufacturing_locations.length > 0) {
      company.manufacturing_locations = proposed.manufacturing_locations;
      company.mfg_unknown = false;
      company.mfg_unknown_reason = null;
    } else if (statuses.manufacturing_locations === "not_disclosed") {
      company.manufacturing_locations = ["Not disclosed"];
      company.mfg_unknown = true;
      company.mfg_unknown_reason = "not_disclosed";
    }

    if (Array.isArray(proposed.reviews) && proposed.reviews.length > 0) {
      company._unified_reviews = proposed.reviews;
      company._unified_reviews_status = statuses.reviews || "ok";
    }

    company.enrichment_method = ecf.method || "unified";
    company.last_enrichment_raw_response = ecf.raw_response || null;
    company.last_enrichment_at = new Date().toISOString();
    company._unified_enrichment_done = true;

    return true;
  } catch (e) {
    if (e instanceof AcceptedResponseError) throw e;
    console.warn(`[import-start] unified enrichment failed for ${companyName}: ${e?.message || String(e)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// ensureCompanyKeywords
// ---------------------------------------------------------------------------

async function ensureCompanyKeywords(company, enrichCtx) {
  const { xaiUrl, xaiKey, getRemainingMs, timeout, debugOutput } = enrichCtx;
  const companyName = String(company?.company_name || company?.name || "").trim();
  const websiteUrl = String(company?.website_url || company?.url || "").trim();

  // Try unified enrichment first (single Grok call for ALL fields)
  if (companyName && websiteUrl && !company._unified_enrichment_done) {
    const unifiedOk = await tryUnifiedEnrichment(company, enrichCtx);
    if (unifiedOk && company._unified_enrichment_done) {
      const debugEntry = {
        company_name: companyName,
        website_url: websiteUrl,
        initial_count: 0,
        initial_keywords: [],
        generated: true,
        generated_count: (company.keywords || []).length,
        final_count: (company.keywords || []).length,
        final_keywords: company.keywords || [],
        prompt: null,
        raw_response: null,
        source: "unified",
      };
      if (debugOutput) debugOutput.keywords_debug.push(debugEntry);
      return company;
    }
  }

  // Fallback: individual Grok calls (original behavior)

  // Tagline: prefer Grok live search
  if (!String(company?.tagline || "").trim() && companyName && websiteUrl) {
    const normalizedDomain = String(company?.normalized_domain || toNormalizedDomain(websiteUrl)).trim();
    const budgetMs = Math.min(
      8_000,
      Math.max(3_000, (typeof getRemainingMs === "function" ? getRemainingMs() : timeout) - DEADLINE_SAFETY_BUFFER_MS)
    );

    try {
      const grok = await fetchTaglineGrok({ companyName, normalizedDomain, budgetMs, xaiUrl, xaiKey, model: "grok-4-latest" });
      if (String(grok?.tagline_status || "").trim() === "ok" && String(grok?.tagline || "").trim()) {
        company.tagline = String(grok.tagline).trim();
      }
    } catch (e) {
      if (e instanceof AcceptedResponseError) throw e;
    }
  }

  const initialList = normalizeProductKeywords(company?.keywords || company?.product_keywords, {
    companyName, websiteUrl,
  });

  let finalList = initialList.slice(0, 25);
  const debugEntry = {
    company_name: companyName,
    website_url: websiteUrl,
    initial_count: initialList.length,
    initial_keywords: initialList,
    generated: false,
    generated_count: 0,
    final_count: 0,
    final_keywords: [],
    prompt: null,
    raw_response: null,
  };

  company.enrichment_debug =
    company.enrichment_debug && typeof company.enrichment_debug === "object" ? company.enrichment_debug : {};
  if (Array.isArray(initialList) && initialList.length > 0) {
    company.enrichment_debug.raw_site_terms = initialList.slice(0, 200);
  }

  let keywordsAll = [];

  // Primary source: Grok live search
  if (companyName && websiteUrl && keywordsAll.length < 10) {
    const normalizedDomain = String(company?.normalized_domain || toNormalizedDomain(websiteUrl)).trim();
    const budgetMs = Math.min(
      12_000,
      Math.max(4_000, (typeof getRemainingMs === "function" ? getRemainingMs() : timeout) - DEADLINE_SAFETY_BUFFER_MS)
    );

    try {
      const grok = await fetchProductKeywordsGrok({
        companyName, normalizedDomain, budgetMs, xaiUrl, xaiKey, model: "grok-4-latest",
      });

      const listRaw = Array.isArray(grok?.keywords) ? grok.keywords : [];
      const stats = sanitizeKeywords({ product_keywords: listRaw.join(", "), keywords: [] });
      const sanitized = Array.isArray(stats?.sanitized) ? stats.sanitized : [];

      if (sanitized.length >= 20) {
        keywordsAll = sanitized;
        company.keywords_source = "grok";
        company.product_keywords_source = "grok";

        company.enrichment_debug =
          company.enrichment_debug && typeof company.enrichment_debug === "object" ? company.enrichment_debug : {};
        company.enrichment_debug.keywords = {
          prompt_hash: null,
          source_url: null,
          source_text_preview: null,
          raw_response_preview: null,
          error: null,
          stage_status: String(grok?.keywords_status || "").trim() || null,
          completeness: String(grok?.keywords_completeness || "").trim() || null,
          incomplete_reason: grok?.keywords_incomplete_reason ?? null,
          keyword_count: sanitized.length,
        };
      }
    } catch (e) {
      if (e instanceof AcceptedResponseError) throw e;
    }
  }

  company.keywords = Array.isArray(keywordsAll) ? keywordsAll.slice(0, 25) : [];
  company.product_keywords = keywordListToString(Array.isArray(keywordsAll) ? keywordsAll : []);

  // Industries
  const existingIndustries = normalizeIndustries(company?.industries);
  if (existingIndustries.length > 0) {
    company.enrichment_debug.raw_site_industries = existingIndustries;
  }

  let industriesFinal = [];

  if (industriesFinal.length === 0 && companyName && websiteUrl) {
    const normalizedDomain = String(company?.normalized_domain || toNormalizedDomain(websiteUrl)).trim();
    const budgetMs = Math.min(
      10_000,
      Math.max(3_500, (typeof getRemainingMs === "function" ? getRemainingMs() : timeout) - DEADLINE_SAFETY_BUFFER_MS)
    );

    try {
      const grok = await fetchIndustriesGrok({
        companyName, normalizedDomain, budgetMs, xaiUrl, xaiKey, model: "grok-4-latest",
      });
      const list = Array.isArray(grok?.industries) ? grok.industries : [];
      const sanitized = sanitizeIndustries(list);

      if (Array.isArray(sanitized) && sanitized.length > 0) {
        industriesFinal = sanitized;
        company.industries_source = "grok";
        company.industries_unknown = false;

        company.enrichment_debug =
          company.enrichment_debug && typeof company.enrichment_debug === "object" ? company.enrichment_debug : {};
        company.enrichment_debug.industries = {
          prompt_hash: null,
          source_url: null,
          raw_response_preview: null,
          industries: industriesFinal,
          error: null,
          stage_status: String(grok?.industries_status || "").trim() || null,
        };
      }
    } catch (e) {
      if (e instanceof AcceptedResponseError) throw e;
    }
  }

  company.industries_unknown = industriesFinal.length === 0;
  company.industries = industriesFinal;

  debugEntry.final_keywords = Array.isArray(keywordsAll) ? keywordsAll : [];
  debugEntry.final_count = Array.isArray(keywordsAll) ? keywordsAll.length : 0;

  if (debugOutput) debugOutput.keywords_debug.push(debugEntry);

  return company;
}

module.exports = {
  mapWithConcurrency,
  generateProductKeywords,
  generateIndustries,
  tryUnifiedEnrichment,
  ensureCompanyKeywords,
};
