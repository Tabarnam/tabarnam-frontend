/**
 * _reviewScrape.js — Extract review metadata from a single article URL.
 *
 * Strategies (by priority):
 *   1. JSON-LD structured data (Article, Review, BlogPosting, VideoObject, etc.)
 *   2. Open Graph / meta tags (og:*, twitter:*, article:*, itemprop)
 *   3. HTML elements (<title>, <h1>, <time>, byline patterns)
 *   4. Domain fallback for source_name
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function decodeHtmlEntities(s) {
  const str = String(s || "");
  if (!str) return str;
  return str
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripHtmlTags(s) {
  return decodeHtmlEntities(
    String(s || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function* walkJson(value) {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const v of value) yield* walkJson(v);
    return;
  }
  if (typeof value === "object") {
    yield value;
    for (const v of Object.values(value)) yield* walkJson(v);
  }
}

function extractFirstMatch(html, re) {
  const m = re.exec(html);
  if (!m || !m[1]) return "";
  return decodeHtmlEntities(m[1].trim());
}

/**
 * Extract text content from a <meta> tag by property, name, or itemprop.
 * Unlike _logoImport's extractMetaProperty, this returns raw text (not absolutized URLs).
 */
function extractMetaContent(html, key) {
  const property = String(key || "").trim();
  if (!property) return "";

  const patterns = [
    new RegExp(`<meta\\b[^>]*property=["']${property}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta\\b[^>]*content=["']([^"']+)["'][^>]*property=["']${property}["'][^>]*>`, "i"),
    new RegExp(`<meta\\b[^>]*name=["']${property}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta\\b[^>]*content=["']([^"']+)["'][^>]*name=["']${property}["'][^>]*>`, "i"),
    new RegExp(`<meta\\b[^>]*itemprop=["']${property}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta\\b[^>]*content=["']([^"']+)["'][^>]*itemprop=["']${property}["'][^>]*>`, "i"),
  ];

  for (const re of patterns) {
    const found = extractFirstMatch(html, re);
    if (found) return found;
  }
  return "";
}

/**
 * Attempt to normalise a date string to YYYY-MM-DD.
 * Handles ISO-8601, common US/EU formats, and month-name dates.
 */
function normalizeDate(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";

  // ISO-8601 with optional time: 2024-01-15 or 2024-01-15T10:30:00Z
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // Try Date.parse for common formats
  const ts = Date.parse(s);
  if (Number.isFinite(ts)) {
    const d = new Date(ts);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    if (yyyy >= 1990 && yyyy <= 2100) return `${yyyy}-${mm}-${dd}`;
  }

  return s;
}

function extractSiteName(finalUrl) {
  try {
    const url = new URL(finalUrl);
    let host = url.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    const parts = host.split(".");
    if (parts.length < 2) return host;
    const name = parts[0];
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    return "";
  }
}

function truncateExcerpt(text, maxLen = 500) {
  const s = String(text || "").trim();
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen).replace(/\s+\S*$/, "") + "…";
}

/**
 * Strip common site-name suffixes from <title> tags.
 * e.g. "My Video Title - YouTube" → "My Video Title"
 */
function cleanTitle(raw, siteName) {
  let s = String(raw || "").trim();
  if (!s) return "";

  // Strip well-known suffixes
  s = s.replace(/\s*[-|–—]\s*(YouTube|Vimeo|Medium|Forbes|TechCrunch|Wired|The Verge|Reddit|Twitter|X)$/i, "");

  // Generic: strip trailing " - <site_name>" or " | <site_name>" using the extracted site name
  if (siteName) {
    const escaped = siteName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\s*[-|–—]\\s*${escaped}\\s*$`, "i");
    s = s.replace(re, "");
  }

  return s.trim();
}

// ─── HTML Fetch ───────────────────────────────────────────────────────────────

async function fetchHtml(url, timeoutMs = 12000) {
  const normalizedUrl = String(url || "").trim();
  if (!normalizedUrl) return { ok: false, status: 0, finalUrl: "", html: "", error: "empty url" };

  let parsed;
  try {
    parsed = normalizedUrl.includes("://") ? new URL(normalizedUrl) : new URL(`https://${normalizedUrl}`);
  } catch {
    return { ok: false, status: 0, finalUrl: "", html: "", error: "invalid url" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, status: 0, finalUrl: "", html: "", error: "unsupported protocol" };
  }

  async function attempt(retryCount) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const userAgent = retryCount === 0 ? USER_AGENTS[0] : USER_AGENTS[retryCount % USER_AGENTS.length];
      const res = await fetch(parsed.href, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": userAgent,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
          "Cache-Control": "no-cache",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Sec-Fetch-User": "?1",
          "Upgrade-Insecure-Requests": "1",
        },
      });
      const html = await res.text();
      return { ok: res.ok, status: res.status, finalUrl: res.url || parsed.href, html };
    } catch (e) {
      if (retryCount === 0) {
        clearTimeout(timeout);
        await sleep(500);
        return attempt(1);
      }
      return { ok: false, status: 0, finalUrl: parsed.href, html: "", error: e?.message || "fetch failed" };
    } finally {
      clearTimeout(timeout);
    }
  }

  return attempt(0);
}

// ─── JSON-LD Extraction ──────────────────────────────────────────────────────

const JSONLD_TYPES = new Set([
  "article", "newsarticle", "blogposting", "review",
  "webpage", "techarticle", "scholarlyarticle", "report",
  "socialmediaposting", "creativework",
  "videoobject", "audioobject", "mediaobject",
  "podcastepisode", "musicrecording",
  "product", "softwareapplication",
]);

function extractFromJsonLd(html) {
  const result = {
    title: "",
    excerpt: "",
    author: "",
    date: "",
    source_name: "",
    rating: null,
  };

  const scriptRe = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;

  while ((m = scriptRe.exec(html)) !== null) {
    const raw = String(m[1] || "").trim();
    const parsed = safeJsonParse(raw);
    if (!parsed) continue;

    for (const obj of walkJson(parsed)) {
      const type = String(obj["@type"] || "").toLowerCase();
      if (!JSONLD_TYPES.has(type)) continue;

      if (!result.title) {
        result.title = String(obj.headline || obj.name || "").trim();
      }
      if (!result.excerpt) {
        result.excerpt = String(obj.description || obj.abstract || obj.articleBody || "").trim();
      }
      if (!result.author) {
        const author = obj.author;
        if (typeof author === "string") {
          result.author = author.trim();
        } else if (Array.isArray(author) && author.length > 0) {
          result.author = String(author[0]?.name || author[0] || "").trim();
        } else if (author && typeof author === "object") {
          result.author = String(author.name || "").trim();
        }
      }
      if (!result.date) {
        result.date = String(obj.datePublished || obj.dateCreated || obj.uploadDate || obj.dateModified || "").trim();
      }
      if (!result.source_name) {
        const pub = obj.publisher;
        if (typeof pub === "string") {
          result.source_name = pub.trim();
        } else if (pub && typeof pub === "object") {
          result.source_name = String(pub.name || "").trim();
        }
      }

      // Review-specific: extract rating
      if (type === "review" && result.rating == null) {
        const rv = obj.reviewRating;
        if (rv && typeof rv === "object") {
          const val = Number(rv.ratingValue);
          if (Number.isFinite(val)) result.rating = val;
        }
      }
    }
  }

  return result;
}

// ─── Meta / OG Extraction ────────────────────────────────────────────────────

function extractFromMeta(html) {
  return {
    title: extractMetaContent(html, "og:title") || extractMetaContent(html, "twitter:title"),
    excerpt:
      extractMetaContent(html, "og:description") ||
      extractMetaContent(html, "description") ||
      extractMetaContent(html, "twitter:description"),
    author:
      extractMetaContent(html, "article:author") ||
      extractMetaContent(html, "author"),
    date:
      extractMetaContent(html, "article:published_time") ||
      extractMetaContent(html, "article:modified_time") ||
      extractMetaContent(html, "date"),
    source_name: extractMetaContent(html, "og:site_name"),
  };
}

// ─── HTML Element Extraction ─────────────────────────────────────────────────

function extractFromHtmlElements(html) {
  const title =
    extractFirstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i) ||
    stripHtmlTags(extractFirstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i));

  const dateMatch =
    extractFirstMatch(html, /<time[^>]*datetime=["']([^"']+)["'][^>]*>/i) ||
    extractFirstMatch(html, /<time[^>]*>([\s\S]*?)<\/time>/i);

  // Byline patterns: class*="byline" or class*="author" on inline elements
  // Also check itemprop="name" on link/meta (used by YouTube for channel name)
  const author =
    stripHtmlTags(extractFirstMatch(html, /<[^>]*class="[^"]*\bbyline\b[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i)) ||
    stripHtmlTags(extractFirstMatch(html, /<[^>]*class="[^"]*\bauthor\b[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i)) ||
    stripHtmlTags(extractFirstMatch(html, /<[^>]*rel=["']author["'][^>]*>([\s\S]*?)<\/[^>]+>/i)) ||
    extractFirstMatch(html, /<link[^>]*itemprop=["']name["'][^>]*content=["']([^"']+)["'][^>]*>/i);

  return { title, date: dateMatch, author };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function scrapeReviewFromUrl(url) {
  const targetUrl = String(url || "").trim();
  if (!targetUrl) {
    return { ok: false, error: "Missing url", title: "", excerpt: "", author: "", date: "", source_name: "", source_url: "", rating: null, strategy: "" };
  }

  const fetched = await fetchHtml(targetUrl);
  if (!fetched.ok || !fetched.html) {
    return {
      ok: false,
      error: fetched.error || `Fetch failed (HTTP ${fetched.status})`,
      title: "",
      excerpt: "",
      author: "",
      date: "",
      source_name: "",
      source_url: fetched.finalUrl || targetUrl,
      rating: null,
      strategy: "",
    };
  }

  const html = fetched.html;
  const finalUrl = fetched.finalUrl || targetUrl;

  // Run all extraction strategies
  const jsonLd = extractFromJsonLd(html);
  const meta = extractFromMeta(html);
  const elements = extractFromHtmlElements(html);

  // Merge with priority: JSON-LD > meta > HTML elements > fallback
  // Resolve source_name first so cleanTitle can use it
  const source_name = jsonLd.source_name || meta.source_name || extractSiteName(finalUrl) || "";
  const rawTitle = jsonLd.title || meta.title || elements.title || "";
  const title = cleanTitle(rawTitle, source_name);
  const excerpt = truncateExcerpt(jsonLd.excerpt || meta.excerpt || "");
  const author = jsonLd.author || meta.author || elements.author || "";
  const rawDate = jsonLd.date || meta.date || elements.date || "";
  const date = normalizeDate(rawDate);
  const rating = jsonLd.rating;

  // Build strategy string showing which sources contributed
  const strategies = [];
  if (jsonLd.title || jsonLd.excerpt || jsonLd.author || jsonLd.date || jsonLd.source_name) strategies.push("jsonld");
  if (meta.title || meta.excerpt || meta.author || meta.date || meta.source_name) strategies.push("og");
  if (elements.title || elements.author || elements.date) strategies.push("html");
  if (!strategies.length) strategies.push("minimal");
  const strategy = strategies.join("+");

  const hasContent = Boolean(title || excerpt);

  return {
    ok: hasContent,
    title: stripHtmlTags(title),
    excerpt,
    author: stripHtmlTags(author),
    date,
    source_name: stripHtmlTags(source_name),
    source_url: finalUrl,
    rating,
    strategy,
    error: hasContent ? "" : "Could not extract meaningful content from page",
  };
}

module.exports = {
  scrapeReviewFromUrl,
  // Exposed for testing
  _test: {
    extractMetaContent,
    extractFromJsonLd,
    extractFromMeta,
    extractFromHtmlElements,
    normalizeDate,
    extractSiteName,
    stripHtmlTags,
    decodeHtmlEntities,
    truncateExcerpt,
    cleanTitle,
  },
};
