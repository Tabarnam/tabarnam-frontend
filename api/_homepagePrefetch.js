"use strict";

/**
 * Phase 2.12 — homepage prefetch helper.
 *
 * Empirically (Eliza B → Flojos → Luna Sandals → Kiwi Sandals across Phases
 * 2.6–2.11): grok-4 frequently terminates the canonical call with `output:
 * [web_search_call only]` and 0 chars of text for small / niche brands.
 * Strict json_schema (Phase 2.10) did not force emission as predicted —
 * the model can still complete with `status: "completed"` having emitted
 * only tool calls. The companyHost include + reviews fallback (Phase 2.11)
 * helped the model FIND the company's site but didn't change the
 * "give up after 1-2 searches" pattern.
 *
 * Phase 2.12's structural fix: pre-fetch the company's homepage (and key
 * sub-pages) before the canonical call, extract clean text, and inject it
 * directly into the prompt as `Homepage Context: ...`. The model now has
 * the data in front of it on turn 0 — no need for tool-call rounds to find
 * tagline / HQ / product preview. Reduces tool-call pressure on complex
 * brands (no runaway) AND gives small brands the data they need (no
 * give-up-early).
 *
 * Design constraints:
 *   - No new npm dependencies. Use Node 18+ built-in `fetch` only.
 *   - Tight timeout (8s default per URL) — don't block the canonical call
 *     for slow homepages.
 *   - Graceful degradation — on fetch failure, return empty context. The
 *     prompt's existing prose-based research instructions still apply.
 *   - Cap output text length (3500 chars default) to keep prompt size
 *     bounded.
 */

const DEFAULT_FETCH_TIMEOUT_MS = 8000;
const DEFAULT_MAX_CONTEXT_CHARS = 3500;
const DEFAULT_PER_PAGE_CHARS = 1400;
const SUB_PATHS_TO_TRY = ["/", "/about", "/about-us"];

const USER_AGENT =
  "Mozilla/5.0 (compatible; TabarnamBot/1.0; +https://tabarnam.com/about) HomepagePrefetch";

function asString(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function safeWebsiteUrl(websiteUrl) {
  const raw = asString(websiteUrl).trim();
  if (!raw) return null;
  let candidate = raw;
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  try {
    const u = new URL(candidate);
    if (!u.hostname || !/[a-z0-9]/i.test(u.hostname)) return null;
    return u;
  } catch {
    return null;
  }
}

function buildSubPageUrl(baseUrl, subPath) {
  try {
    const u = new URL(subPath, baseUrl);
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Strip HTML tags + script/style blocks. Preserve sentence-level
 * whitespace. This is a deliberately small, regex-based extractor — no
 * cheerio / jsdom / DOM parsing — so we stay dependency-free and fast.
 *
 * Trade-off: on heavily JS-rendered SPAs we'll get a near-empty body.
 * That's acceptable; the canonical prompt still has prose instructions
 * to web_search if Homepage Context comes back thin.
 */
function extractTextFromHtml(html) {
  if (typeof html !== "string" || !html) return "";

  let text = html;

  // Drop script / style / noscript blocks entirely (often contain JSON
  // dumps that explode the size without adding signal).
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");
  text = text.replace(/<!--[\s\S]*?-->/g, " ");

  // Pull out title + meta description before stripping all tags so we can
  // surface them at the top of the extracted text.
  const titleMatch = text.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim() : "";

  const metaDescMatch = text.match(
    /<meta\b[^>]*?name\s*=\s*["']description["'][^>]*?content\s*=\s*["']([^"']*)["'][^>]*>/i
  );
  const metaDesc = metaDescMatch ? decodeEntities(metaDescMatch[1]).trim() : "";

  // Strip remaining tags.
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeEntities(text);

  // Compress whitespace — keep linebreaks as paragraph delimiters but
  // collapse runs of spaces.
  text = text.replace(/\r\n?/g, "\n");
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  // Prepend title + meta-description so they survive the per-page cap.
  const prefix = [];
  if (title) prefix.push(`Title: ${title}`);
  if (metaDesc) prefix.push(`Description: ${metaDesc}`);

  return prefix.length > 0 ? `${prefix.join("\n")}\n\n${text}` : text;
}

function decodeEntities(s) {
  return asString(s)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try { return String.fromCharCode(parseInt(h, 16)); } catch { return ""; }
    })
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCharCode(parseInt(n, 10)); } catch { return ""; }
    });
}

/**
 * Fetch a single URL with timeout. Returns the response body as text on
 * 2xx, otherwise returns null. Errors are swallowed and surfaced via the
 * `error` field on the diagnostic.
 */
async function fetchUrlText(url, { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);

  // Honour a parent abort signal if provided (worker cancellation).
  let parentAbortHandler = null;
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      return { ok: false, error: "parent_aborted", text: "" };
    }
    parentAbortHandler = () => {
      try { controller.abort("parent_aborted"); } catch {}
    };
    signal.addEventListener("abort", parentAbortHandler, { once: true });
  }

  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        "Accept-Language": "en-US,en;q=0.7",
      },
    });

    if (!res.ok) {
      return { ok: false, error: `http_${res.status}`, text: "" };
    }

    const ct = String(res.headers.get("content-type") || "").toLowerCase();
    if (ct && !ct.includes("text/html") && !ct.includes("application/xhtml")) {
      return { ok: false, error: `non_html_content_type:${ct.split(";")[0]}`, text: "" };
    }

    const text = await res.text();
    return { ok: true, error: null, text };
  } catch (err) {
    const reason =
      err?.name === "AbortError"
        ? (controller.signal.reason === "timeout" ? "timeout" : "aborted")
        : (err?.message || String(err) || "fetch_failed");
    return { ok: false, error: reason, text: "" };
  } finally {
    clearTimeout(timer);
    if (signal && parentAbortHandler) {
      try { signal.removeEventListener("abort", parentAbortHandler); } catch {}
    }
  }
}

/**
 * Public entry point.
 *
 * Fetches the company's homepage + a couple of common About paths, extracts
 * clean text, concatenates with per-page caps, and returns up to
 * `maxChars` of context suitable for prompt injection.
 *
 * Always resolves; never throws. On total fetch failure the function
 * returns `{ context: "", diagnostics: { ... } }` so the caller can decide
 * whether to inject a context line at all.
 */
async function prefetchHomepageContext({
  websiteUrl,
  maxChars = DEFAULT_MAX_CONTEXT_CHARS,
  perPageChars = DEFAULT_PER_PAGE_CHARS,
  perFetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  subPaths = SUB_PATHS_TO_TRY,
  signal,
} = {}) {
  const startedAt = Date.now();
  const diagnostics = {
    pages_attempted: 0,
    pages_ok: 0,
    pages_with_text: 0,
    elapsed_ms: 0,
    per_page: [],
    total_chars: 0,
    truncated: false,
  };

  const baseUrl = safeWebsiteUrl(websiteUrl);
  if (!baseUrl) {
    diagnostics.elapsed_ms = Date.now() - startedAt;
    diagnostics.skip_reason = "invalid_website_url";
    return { context: "", diagnostics };
  }

  const seen = new Set();
  const urls = [];
  for (const sub of subPaths) {
    const u = buildSubPageUrl(baseUrl, sub);
    if (u && !seen.has(u)) {
      seen.add(u);
      urls.push(u);
    }
  }

  // Fetch sequentially so a single slow upstream doesn't burn the whole
  // budget concurrently. Each fetch has its own timeout.
  const blocks = [];
  for (const url of urls) {
    if (signal?.aborted) break;
    if (blocks.join("\n\n").length >= maxChars) break;

    diagnostics.pages_attempted += 1;
    const fetched = await fetchUrlText(url, { timeoutMs: perFetchTimeoutMs, signal });

    const pageDiag = {
      url,
      ok: fetched.ok,
      error: fetched.error,
      raw_html_chars: fetched.text.length,
      extracted_chars: 0,
    };

    if (fetched.ok) {
      diagnostics.pages_ok += 1;
      const extracted = extractTextFromHtml(fetched.text).slice(0, perPageChars);
      pageDiag.extracted_chars = extracted.length;
      if (extracted) {
        diagnostics.pages_with_text += 1;
        blocks.push(`# ${url}\n${extracted}`);
      }
    }

    diagnostics.per_page.push(pageDiag);
  }

  let context = blocks.join("\n\n").trim();
  if (context.length > maxChars) {
    context = `${context.slice(0, maxChars - 12).trim()}\n[truncated]`;
    diagnostics.truncated = true;
  }
  diagnostics.total_chars = context.length;
  diagnostics.elapsed_ms = Date.now() - startedAt;

  return { context, diagnostics };
}

module.exports = {
  prefetchHomepageContext,
  // Exported for tests
  extractTextFromHtml,
  safeWebsiteUrl,
  buildSubPageUrl,
};
