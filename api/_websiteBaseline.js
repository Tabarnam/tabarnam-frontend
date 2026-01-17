const DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; TabarnamBot/1.0; +https://tabarnam.com)";

function asString(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function truncate(s, max) {
  const str = asString(s);
  if (str.length <= max) return str;
  return str.slice(0, max);
}

function decodeHtmlEntities(s) {
  const str = asString(s);
  if (!str) return "";
  return str
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeMarketingSentence(value) {
  const s = asString(value).trim();
  if (!s) return false;

  if (s.length > 60) return true;
  if (/[.!?]/.test(s)) return true;

  const words = s.split(/\s+/).filter(Boolean);
  if (words.length > 10) return true;

  if (/[,:;]\s/.test(s) && words.length > 6) return true;

  // A light heuristic to avoid "Premium ..." style sentences.
  if (/\b(premium|trusted|quality|since|discover|shop|buy|world|leading|supplements|nutrition)\b/i.test(s) && words.length > 4) {
    return true;
  }

  return false;
}

function cleanNameCandidate(raw) {
  const s = decodeHtmlEntities(raw);
  if (!s) return "";

  const parts = s
    .split(/\s*[|\-–•:]\s*/g)
    .map((p) => p.trim())
    .filter(Boolean);

  const first = parts[0] || s;
  const cleaned = first.replace(/\s+/g, " ").trim();
  if (cleaned.length < 2) return "";
  if (looksLikeMarketingSentence(cleaned)) return "";
  if (cleaned.length > 80) return cleaned.slice(0, 80).trim();
  return cleaned;
}

function getBrandTokenFromWebsiteUrl(websiteUrl) {
  try {
    const u = new URL(websiteUrl);
    let h = String(u.hostname || "").toLowerCase();
    h = h.replace(/^www\./i, "");
    const token = h.split(".")[0] || "";
    return token.trim();
  } catch {
    return "";
  }
}

function stripHtmlToText(html) {
  const raw = asString(html);
  if (!raw) return "";

  const withoutScripts = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ");

  const text = withoutScripts
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return decodeHtmlEntities(text);
}

function extractTagContent(html, tagName) {
  const raw = asString(html);
  if (!raw) return "";

  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = raw.match(re);
  if (!match) return "";
  return decodeHtmlEntities(match[1] || "");
}

function extractMetaContent(html, selector) {
  const raw = asString(html);
  if (!raw) return "";

  const re = new RegExp(`<meta[^>]+${selector}[^>]*>`, "ig");
  const tags = raw.match(re) || [];

  for (const tag of tags) {
    const contentMatch = tag.match(/content\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const value = contentMatch ? contentMatch[2] || contentMatch[3] || contentMatch[4] || "" : "";
    const decoded = decodeHtmlEntities(value);
    if (decoded) return decoded;
  }

  return "";
}

function extractNavCategoryPhrases(html, { max = 40 } = {}) {
  const raw = asString(html);
  if (!raw) return [];

  const blocks = [];
  const navMatches = raw.match(/<(nav|header)[^>]*>[\s\S]*?<\/(nav|header)>/gi);
  if (Array.isArray(navMatches) && navMatches.length > 0) blocks.push(...navMatches);
  if (blocks.length === 0) blocks.push(raw);

  const phrases = [];
  for (const block of blocks) {
    const anchorMatches = block.match(/<a\b[^>]*>([\s\S]*?)<\/a>/gi) || [];
    for (const aTag of anchorMatches) {
      const inner = aTag.replace(/<a\b[^>]*>/i, "").replace(/<\/a>/i, "");
      const text = decodeHtmlEntities(inner.replace(/<[^>]+>/g, " ")).trim();
      const cleaned = text.replace(/\s+/g, " ").trim();
      if (!cleaned) continue;
      if (cleaned.length < 3) continue;
      if (cleaned.length > 40) continue;
      if (/^(home|shop|about|contact|faq|support|account|log\s*in|sign\s*in|sign\s*up|cart)$/i.test(cleaned)) continue;
      if (!/[a-z]/i.test(cleaned)) continue;
      phrases.push(cleaned);
      if (phrases.length >= max) return phrases;
    }
  }

  return phrases;
}

function normalizeKeywordCandidates(list) {
  const out = [];
  const seen = new Set();

  for (const raw of list) {
    const s = asString(raw).trim();
    if (!s) continue;

    const normalized = s
      .replace(/[^a-z0-9\s&-]/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }

  return out;
}

function tokenizeForKeywords(text) {
  const raw = asString(text);
  if (!raw) return [];

  const stop = new Set([
    "the","and","for","with","from","this","that","your","you","our","their","they","are","was","were","has","have","had",
    "but","not","all","any","can","get","shop","buy","sale","new","now","more","less","best","about","contact","privacy","terms",
    "shipping","returns","faq","help","support","login","account","cart","search","menu","home",
  ]);

  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/g)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && t.length <= 24)
    .filter((t) => !stop.has(t));
}

function buildTopKeywordsFromText(text, { max = 25 } = {}) {
  const tokens = tokenizeForKeywords(text);
  const freq = new Map();

  for (const token of tokens) {
    freq.set(token, (freq.get(token) || 0) + 1);
  }

  const sorted = Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([word]) => word);

  return sorted;
}

function inferIndustriesFromText(text) {
  const t = asString(text).toLowerCase();
  if (!t) return [];

  const rules = [
    { industry: "Apparel", match: /(dress|shirt|pants|jeans|sweater|hoodie|jacket|clothing|apparel|activewear|denim|outerwear)/i },
    { industry: "Home goods", match: /(bedding|sheet|towel|bath|home|decor|furniture|sofa|chair|table|mattress|lamp|rug)/i },
    { industry: "Beauty", match: /(skincare|skin care|beauty|serum|moisturizer|cleanser|makeup|cosmetic)/i },
    { industry: "Food", match: /(coffee|tea|snack|chocolate|food|recipe|organic|grocery)/i },
    { industry: "Electronics", match: /(electronics|headphones|speaker|battery|charger|laptop|phone|smart)/i },
    { industry: "Baby", match: /(baby|toddler|diaper|stroller|crib)/i },
    { industry: "Pets", match: /(pet|dog|cat|treat|kibble|litter)/i },
    { industry: "Health", match: /(supplement|vitamin|wellness|protein|lab test|ingredients)/i },
  ];

  const out = [];
  for (const rule of rules) {
    if (rule.match.test(t)) out.push(rule.industry);
    if (out.length >= 3) break;
  }

  return out;
}

async function fetchText(url, { timeoutMs = 6000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    if (!res.ok) return { ok: false, status: res.status, text: "" };

    const contentType = asString(res.headers.get("content-type")).toLowerCase();
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml") && !contentType.includes("xml")) {
      return { ok: false, status: res.status, text: "" };
    }

    const text = await res.text();
    return { ok: true, status: res.status, text: typeof text === "string" ? text : "" };
  } catch (e) {
    return { ok: false, status: 0, text: "", error: e?.message || String(e) };
  } finally {
    clearTimeout(timeout);
  }
}

function resolveUrl(baseUrl, path) {
  try {
    const base = new URL(baseUrl);
    const url = new URL(path, base);
    return url.toString();
  } catch {
    return "";
  }
}

function shouldFillString(value) {
  return !asString(value).trim();
}

function shouldFillArray(value) {
  return !Array.isArray(value) || value.length === 0;
}

function normalizeKeywordList(value) {
  if (Array.isArray(value)) {
    return value.map((v) => asString(v).trim()).filter(Boolean);
  }
  const raw = asString(value);
  if (!raw) return [];
  return raw
    .split(/\s*[,;|]\s*/g)
    .map((v) => v.trim())
    .filter(Boolean);
}

async function fillCompanyBaselineFromWebsite(company, { timeoutMs = 6000, extraPageTimeoutMs = 4000 } = {}) {
  const base = company && typeof company === "object" ? company : {};
  const websiteUrl = asString(base.website_url || base.canonical_url || base.url).trim();
  if (!websiteUrl) return base;

  const first = await fetchText(websiteUrl, { timeoutMs });
  if (!first.ok || !first.text) return base;

  const pages = [
    { url: websiteUrl, html: first.text },
  ];

  const extraPaths = ["/about", "/contact", "/faq", "/pages/about", "/pages/contact", "/about-us", "/contact-us"];
  for (const path of extraPaths) {
    if (pages.length >= 3) break;
    const nextUrl = resolveUrl(websiteUrl, path);
    if (!nextUrl) continue;
    const r = await fetchText(nextUrl, { timeoutMs: extraPageTimeoutMs });
    if (r.ok && r.text) {
      pages.push({ url: nextUrl, html: r.text });
    }
  }

  const homeHtml = pages[0].html;

  const title = extractTagContent(homeHtml, "title");
  const metaDescription = extractMetaContent(homeHtml, "name\\s*=\\s*(['\"]?)description\\1");
  const ogSiteName = extractMetaContent(homeHtml, "property\\s*=\\s*(['\"]?)og:site_name\\1");
  const ogDescription = extractMetaContent(homeHtml, "property\\s*=\\s*(['\"]?)og:description\\1");
  const ogTitle = extractMetaContent(homeHtml, "property\\s*=\\s*(['\"]?)og:title\\1");

  const homeText = stripHtmlToText(homeHtml);
  const supplementalText = pages.slice(1).map((p) => stripHtmlToText(p.html)).join(" ");
  const combinedText = `${homeText} ${supplementalText}`.trim();

  const headings = normalizeKeywordCandidates([
    extractTagContent(homeHtml, "h1"),
    extractTagContent(homeHtml, "h2"),
    extractTagContent(homeHtml, "h3"),
  ]);

  const navPhrases = extractNavCategoryPhrases(homeHtml, { max: 50 });

  const keywordSeeds = normalizeKeywordCandidates([
    ...navPhrases,
    ...headings,
    title,
    ogSiteName,
  ]);

  const textKeywords = buildTopKeywordsFromText(combinedText, { max: 30 });
  const mergedKeywords = normalizeKeywordCandidates([...keywordSeeds, ...textKeywords]).slice(0, 25);

  const inferredIndustries = inferIndustriesFromText(combinedText);

  const nameCandidate = cleanNameCandidate(ogSiteName || ogTitle || title);

  // If the "name" candidate looks like a sentence, treat it as tagline fallback.
  const taglineFallbackFromTitle = truncate(nameCandidate ? "" : cleanNameCandidate("") , 180);
  const taglineCandidate = truncate(ogDescription || metaDescription || "", 180) || truncate(ogTitle || title || "", 180);

  const patch = { ...base };

  // Improve company_name for URL-shortcut runs (helps downstream enrichment like reviews).
  // Only override when the existing name is empty or looks auto-generated from the hostname.
  const existingName = asString(patch.company_name || patch.name).trim();
  const token = getBrandTokenFromWebsiteUrl(websiteUrl);
  const looksAuto =
    !existingName ||
    (token && existingName.toLowerCase().replace(/\s+/g, "") === token.toLowerCase().replace(/\s+/g, ""));

  if (looksAuto && nameCandidate) {
    patch.company_name = nameCandidate;
  }

  if (shouldFillString(patch.tagline) && taglineCandidate) {
    patch.tagline = taglineCandidate;
  }

  if (shouldFillArray(patch.industries) && inferredIndustries.length > 0) {
    patch.industries = inferredIndustries;
  }

  const existingKeywords = normalizeKeywordList(patch.keywords);
  if (existingKeywords.length < 8 && mergedKeywords.length > 0) {
    patch.keywords = normalizeKeywordCandidates([...existingKeywords, ...mergedKeywords]).slice(0, 25);
    patch.product_keywords = patch.keywords.join(", ");
  } else if (shouldFillString(patch.product_keywords) && mergedKeywords.length > 0) {
    patch.product_keywords = mergedKeywords.join(", ");
    patch.keywords = existingKeywords.length > 0 ? existingKeywords : mergedKeywords.slice(0, 25);
  }

  return patch;
}

module.exports = {
  fillCompanyBaselineFromWebsite,
};
