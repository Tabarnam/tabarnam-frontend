const net = require("node:net");

function escapeRegExp(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeCompanyName(name) {
  const raw = String(name || "").trim();
  if (!raw) return "";
  return raw
    .replace(/\b(inc|inc\.|llc|l\.l\.c\.|ltd|ltd\.|co|co\.|corp|corp\.|corporation|company|group|holdings|limited)\b/gi, " ")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function toBrandTokenFromUrl(urlOrDomain) {
  try {
    const u = String(urlOrDomain || "").trim();
    if (!u) return "";
    const url = u.includes("://") ? new URL(u) : new URL(`https://${u}`);
    let host = url.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    const parts = host.split(".").filter(Boolean);
    if (parts.length < 2) return "";
    return parts[0] || "";
  } catch {
    return "";
  }
}

function normalizeUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;

  try {
    const url = raw.includes("://") ? new URL(raw) : new URL(`https://${raw}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function isPrivateIp(host) {
  const ip = net.isIP(host);
  if (!ip) return false;

  const h = host.toLowerCase();
  if (ip === 4) {
    const parts = h.split(".").map((p) => Number(p));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return true;
    const [a, b] = parts;

    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
  }

  // IPv6
  if (h === "::1") return true;
  if (h.startsWith("fe80:")) return true;
  if (h.startsWith("fc") || h.startsWith("fd")) return true;
  return false;
}

function isDisallowedHostname(hostname) {
  const h = String(hostname || "").trim().toLowerCase();
  if (!h) return true;
  if (h === "localhost") return true;
  if (h.endsWith(".localhost")) return true;
  if (h.endsWith(".local")) return true;
  if (h === "metadata.google.internal") return true;
  if (h === "169.254.169.254") return true;
  if (isPrivateIp(h)) return true;
  return false;
}

async function readResponseTextLimited(res, maxBytes) {
  const body = res.body;
  if (!body) return "";

  if (typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks = [];
    let received = 0;

    try {
      while (received < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          received += value.byteLength || value.length || 0;
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }

    const merged = new Uint8Array(Math.min(received, maxBytes));
    let offset = 0;
    for (const c of chunks) {
      const arr = c instanceof Uint8Array ? c : new Uint8Array(c);
      const copy = Math.min(arr.byteLength, merged.byteLength - offset);
      if (copy <= 0) break;
      merged.set(arr.subarray(0, copy), offset);
      offset += copy;
    }

    return new TextDecoder("utf-8", { fatal: false }).decode(merged);
  }

  const txt = await res.text();
  return txt.length > maxBytes ? txt.slice(0, maxBytes) : txt;
}

function htmlToText(html) {
  const raw = String(html || "");
  if (!raw) return "";

  const noScript = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");

  const withSpaces = noScript.replace(/<[^>]+>/g, " ");

  const decoded = withSpaces
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();

  return decoded;
}

function looksLikeNotFound(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return false;

  const patterns = [
    /\b404\b/, 
    /page\s+not\s+found/, 
    /not\s+found/, 
    /doesn\s*'?t\s+exist/, 
    /no\s+longer\s+available/, 
    /error\s+404/, 
    /we\s+can\s*'?t\s+find/, 
  ];

  return patterns.some((p) => p.test(t));
}

function buildBrandTerms({ companyName, websiteUrl, normalizedDomain }) {
  const terms = new Set();
  const company = String(companyName || "").trim();
  const normalized = normalizeCompanyName(company);
  const token = toBrandTokenFromUrl(websiteUrl || normalizedDomain || "");

  const add = (s) => {
    const v = String(s || "").trim();
    if (!v) return;
    if (v.length < 3) return;
    terms.add(v);
  };

  add(company);
  add(normalized);
  add(token);

  if (company && normalized && company.toLowerCase() !== normalized.toLowerCase()) add(normalized);
  if (token && company && !company.toLowerCase().includes(token.toLowerCase())) add(token);

  return Array.from(terms);
}

function countMentions(text, term) {
  const t = String(text || "");
  const s = String(term || "").trim();
  if (!t || !s) return 0;

  const termEsc = escapeRegExp(s);

  // Use word boundaries for simple tokens, but allow spaces/hyphens for multi-word terms.
  const hasSpace = /\s/.test(s);
  const rx = hasSpace
    ? new RegExp(termEsc, "ig")
    : new RegExp(`\\b${termEsc}\\b`, "ig");

  const matches = t.match(rx);
  return matches ? matches.length : 0;
}

function extractEvidenceSnippets(text, matchedTerms, opts = {}) {
  const maxSnippets = Math.max(1, Number(opts.maxSnippets ?? 2));
  const minWords = Math.max(1, Number(opts.minWords ?? 10));
  const maxWords = Math.max(minWords, Number(opts.maxWords ?? 25));

  const full = String(text || "").trim();
  if (!full) return [];

  const lower = full.toLowerCase();
  const snippets = [];
  const used = new Set();

  for (const term of matchedTerms || []) {
    if (snippets.length >= maxSnippets) break;
    const t = String(term || "").trim();
    if (!t) continue;

    const idx = lower.indexOf(t.toLowerCase());
    if (idx < 0) continue;

    const window = full.slice(Math.max(0, idx - 500), Math.min(full.length, idx + 500));
    const words = window.split(/\s+/).filter(Boolean);
    if (words.length < minWords) continue;

    const windowLower = window.toLowerCase();
    const relIdx = windowLower.indexOf(t.toLowerCase());

    let wordPos = 0;
    if (relIdx >= 0) {
      const before = windowLower.slice(0, relIdx);
      wordPos = before.split(/\s+/).filter(Boolean).length;
    }

    const start = Math.max(0, wordPos - Math.floor(maxWords / 2));
    const end = Math.min(words.length, start + maxWords);
    const snippet = words.slice(start, end).join(" ").trim();

    const snippetWords = snippet.split(/\s+/).filter(Boolean);
    if (snippetWords.length < minWords) continue;

    const key = snippet.toLowerCase();
    if (used.has(key)) continue;
    used.add(key);
    snippets.push(snippet);
  }

  return snippets.slice(0, maxSnippets);
}

function computeMatchConfidence({ title, text, brandTerms }) {
  const titleStr = String(title || "");
  const textStr = String(text || "");

  let totalMentions = 0;
  let titleHit = false;

  for (const term of brandTerms || []) {
    if (!term) continue;
    if (!titleHit && titleStr && titleStr.toLowerCase().includes(String(term).toLowerCase())) {
      titleHit = true;
    }
    totalMentions += countMentions(textStr, term);
  }

  if (titleHit) return 0.95;
  if (totalMentions >= 5) return 0.85;
  if (totalMentions >= 2) return 0.75;
  if (totalMentions >= 1) return 0.55;
  return 0.0;
}

async function checkUrlHealthAndFetchText(url, opts = {}) {
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs ?? 8000));
  const maxBytes = Math.max(2048, Number(opts.maxBytes ?? 60000));

  const normalized = normalizeUrl(url);
  if (!normalized) {
    return { ok: false, link_status: "blocked", status: null, final_url: null, text: "" };
  }

  const parsed = new URL(normalized);
  if (isDisallowedHostname(parsed.hostname)) {
    return { ok: false, link_status: "blocked", status: null, final_url: null, text: "" };
  }

  if (parsed.port && parsed.port !== "80" && parsed.port !== "443") {
    return { ok: false, link_status: "blocked", status: null, final_url: null, text: "" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const headers = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "User-Agent": "TabarnamReviewValidator/1.0",
    Range: `bytes=0-${Math.max(2047, maxBytes - 1)}`,
  };

  try {
    // Fast fail with HEAD where possible.
    try {
      const headRes = await fetch(normalized, {
        method: "HEAD",
        redirect: "follow",
        signal: controller.signal,
        headers,
      });

      if (headRes.status === 404 || headRes.status === 410) {
        return { ok: false, link_status: "not_found", status: headRes.status, final_url: headRes.url || normalized, text: "" };
      }

      if (headRes.status >= 500) {
        return { ok: false, link_status: "blocked", status: headRes.status, final_url: headRes.url || normalized, text: "" };
      }
    } catch {
      // ignore HEAD failures
    }

    const res = await fetch(normalized, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers,
    });

    const status = res.status;
    const finalUrl = res.url || normalized;

    if (status === 404 || status === 410) {
      return { ok: false, link_status: "not_found", status, final_url: finalUrl, text: "" };
    }

    if (status === 401 || status === 403 || status === 429) {
      return { ok: false, link_status: "blocked", status, final_url: finalUrl, text: "" };
    }

    if (status >= 500) {
      return { ok: false, link_status: "blocked", status, final_url: finalUrl, text: "" };
    }

    if (status < 200 || status >= 300) {
      return { ok: false, link_status: "blocked", status, final_url: finalUrl, text: "" };
    }

    const rawText = await readResponseTextLimited(res, maxBytes);
    const text = htmlToText(rawText);

    if (!text || looksLikeNotFound(text)) {
      return { ok: false, link_status: "not_found", status, final_url: finalUrl, text: text || "" };
    }

    const link_status = res.redirected && finalUrl !== normalized ? "redirected" : "ok";
    return { ok: true, link_status, status, final_url: finalUrl, text };
  } finally {
    clearTimeout(timeout);
  }
}

function isExcludedSourceValue(sourceOrUrl) {
  const v = String(sourceOrUrl || "").toLowerCase();
  if (!v) return false;

  // New rules: only exclude Amazon/Google; Facebook is allowed.
  return v.includes("amazon") || v.includes("google");
}

async function validateCuratedReviewCandidate(input, opts = {}) {
  const companyName = String(input?.companyName || "").trim();
  const websiteUrl = String(input?.websiteUrl || "").trim();
  const normalizedDomain = String(input?.normalizedDomain || "").trim();
  const url = String(input?.url || "").trim();
  const title = String(input?.title || "").trim();

  if (!companyName || !url) {
    return {
      is_valid: false,
      link_status: "blocked",
      brand_mentions_found: false,
      matched_brand_terms: [],
      evidence_snippets: [],
      match_confidence: 0,
      final_url: null,
      reason_if_rejected: "missing company_name or url",
    };
  }

  if (isExcludedSourceValue(url)) {
    return {
      is_valid: false,
      link_status: "blocked",
      brand_mentions_found: false,
      matched_brand_terms: [],
      evidence_snippets: [],
      match_confidence: 0,
      final_url: null,
      reason_if_rejected: "excluded source",
    };
  }

  const brandTerms = buildBrandTerms({ companyName, websiteUrl, normalizedDomain });

  // Try to validate via a real fetch.
  // NOTE: Many review sites block bots. When that happens, we still want to keep
  // credible candidates rather than returning 0 reviews for well-known brands.
  const health = await checkUrlHealthAndFetchText(url, opts);

  const candidateText = String(input?.text || input?.abstract || input?.excerpt || "").trim();
  const titleText = title;

  // Strong matching is based on the company name itself (normalized), not just a domain token.
  // This avoids false positives for generic tokens (e.g. "advance") while still allowing
  // fallbacks when pages are blocked/JS-heavy and we can only rely on the upstream excerpt.
  const companyNorm = normalizeCompanyName(companyName).toLowerCase();
  const candidateNorm = normalizeCompanyName(candidateText).toLowerCase();
  const titleNorm = normalizeCompanyName(titleText).toLowerCase();
  const candidateMentionsCompany =
    !!companyNorm &&
    ((candidateNorm && candidateNorm.includes(companyNorm)) || (titleNorm && titleNorm.includes(companyNorm)));

  if (!health.ok) {
    // If the URL is truly "page not found", never accept it.
    if (health.link_status === "not_found") {
      return {
        is_valid: false,
        link_status: health.link_status,
        brand_mentions_found: false,
        matched_brand_terms: [],
        evidence_snippets: [],
        match_confidence: 0,
        final_url: health.final_url,
        reason_if_rejected: "url not found",
      };
    }

    // Some legit sources block bots (403/429, etc). In those cases we still allow a
    // low-confidence fallback when the candidate itself clearly mentions the company name.
    const titleLower = titleText.toLowerCase();
    const candidateLower = candidateText.toLowerCase();

    const matched = [];
    for (const term of brandTerms) {
      const t = String(term || "").trim();
      if (!t) continue;
      const tl = t.toLowerCase();
      if ((titleLower && titleLower.includes(tl)) || (candidateLower && candidateLower.includes(tl))) {
        matched.push(term);
      }
    }

    if (candidateMentionsCompany) {
      const evidence = [];
      if (candidateText) evidence.push(candidateText.slice(0, 240));
      if (!evidence.length && titleText) evidence.push(titleText);

      return {
        is_valid: true,
        link_status: health.link_status || "unverified",
        last_checked_at: new Date().toISOString(),
        brand_mentions_found: true,
        matched_brand_terms: matched.length ? matched : [companyName],
        evidence_snippets: evidence.slice(0, 2),
        match_confidence: 0.25,
        final_url: health.final_url,
        reason_if_rejected: null,
      };
    }

    return {
      is_valid: false,
      link_status: health.link_status,
      brand_mentions_found: false,
      matched_brand_terms: [],
      evidence_snippets: [],
      match_confidence: 0,
      final_url: health.final_url,
      reason_if_rejected: "url not accessible",
    };
  }

  const text = health.text || "";

  const matched = [];
  for (const term of brandTerms) {
    if (!term) continue;
    if (countMentions(text, term) > 0) matched.push(term);
  }

  if (matched.length === 0) {
    // Some pages are JS-heavy and our HTML fetch may not include the article body even though
    // the URL is real (HTTP 200). If the upstream excerpt clearly mentions the company name,
    // accept the review so imports don't end up with 0 reviews.
    if (candidateMentionsCompany) {
      const evidence = [];
      if (candidateText) evidence.push(candidateText.slice(0, 240));
      if (!evidence.length && titleText) evidence.push(titleText);

      return {
        is_valid: true,
        link_status: health.link_status,
        last_checked_at: new Date().toISOString(),
        brand_mentions_found: true,
        matched_brand_terms: [companyName],
        evidence_snippets: evidence.slice(0, 2),
        match_confidence: 0.2,
        final_url: health.final_url,
        reason_if_rejected: null,
      };
    }

    return {
      is_valid: false,
      link_status: health.link_status,
      brand_mentions_found: false,
      matched_brand_terms: [],
      evidence_snippets: [],
      match_confidence: 0,
      final_url: health.final_url,
      reason_if_rejected: "brand/company not mentioned in page text",
    };
  }

  let evidence = extractEvidenceSnippets(text, matched, opts);

  // Evidence extraction can fail on short/templated pages even when the brand is
  // clearly mentioned. In that case, fall back to using the provided excerpt/title
  // so we don't drop all reviews for a company.
  if (!evidence.length) {
    const fallback = [];
    if (candidateText) fallback.push(candidateText.slice(0, 240));
    if (!fallback.length && titleText) fallback.push(titleText);

    const match_confidence = computeMatchConfidence({ title, text, brandTerms: matched });

    return {
      is_valid: true,
      link_status: health.link_status,
      last_checked_at: new Date().toISOString(),
      brand_mentions_found: true,
      matched_brand_terms: matched,
      evidence_snippets: fallback,
      match_confidence: Math.max(0.35, match_confidence || 0),
      final_url: health.final_url,
      reason_if_rejected: null,
    };
  }

  const match_confidence = computeMatchConfidence({ title, text, brandTerms: matched });

  return {
    is_valid: true,
    link_status: health.link_status,
    last_checked_at: new Date().toISOString(),
    brand_mentions_found: true,
    matched_brand_terms: matched,
    evidence_snippets: evidence,
    match_confidence,
    final_url: health.final_url,
    reason_if_rejected: null,
  };
}

module.exports = {
  normalizeUrl,
  normalizeCompanyName,
  toBrandTokenFromUrl,
  buildBrandTerms,
  isDisallowedHostname,
  checkUrlHealthAndFetchText,
  validateCuratedReviewCandidate,
  computeMatchConfidence,
};
