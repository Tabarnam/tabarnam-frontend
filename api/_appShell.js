/**
 * Shared plumbing for server-rendered SPA pages (/made-in/*, /company/*).
 *
 * The approach, in one paragraph: fetch the deployed index.html, rewrite its
 * <head> with this page's real metadata, fill <div id="root"> with this page's
 * real content, and ship it. ReactDOM.createRoot().render() clears #root on
 * mount, so the SPA takes over afterwards — we are SEEDING the document, not
 * hydrating it, which is why no React-on-Node is involved and there is no
 * mismatch to reconcile. Everyone gets identical bytes; nothing branches on
 * user agent.
 *
 * Extracted from _madeInRender.js when company pages needed the same
 * machinery. One module means one shell cache per worker instead of two.
 */

const ORIGIN = "https://tabarnam.com";
const SHELL_URL = `${ORIGIN}/index.html`;
// Written by scripts/write-build-id.mjs on every frontend build, and excluded
// from the SPA navigation fallback, so it is a 41-byte source of truth for
// "which asset hashes are live right now".
const BUILD_ID_URL = `${ORIGIN}/__build_id.txt`;
const SHELL_TIMEOUT_MS = 8000;
const BUILD_ID_TIMEOUT_MS = 4000;

function esc(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * JSON destined for a <script> block. `<` must not survive or a company named
 * with an angle bracket could close the tag; the standard trio also blocks
 * `</script>` and HTML-comment-open sequences.
 */
function jsonForScript(obj) {
  return JSON.stringify(obj)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

const nf = new Intl.NumberFormat("en-US");

// ── shell ───────────────────────────────────────────────────────────────────

let _shell = { html: "", buildId: "", inflight: null };

async function fetchText(url, timeoutMs, accept) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { accept }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${url} responded ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchShell() {
  const html = await fetchText(SHELL_URL, SHELL_TIMEOUT_MS, "text/html");
  if (!html.includes('id="root"')) throw new Error("index.html has no #root mount");
  return html;
}

/**
 * The app shell, cached per FRONTEND BUILD rather than on a timer.
 *
 * A time-based cache is actively wrong here and shipped broken once: the shell
 * names hashed asset files, a frontend deploy replaces them and deletes the
 * old ones, so a shell cached even a minute too long tells browsers to fetch
 * /assets/index-<oldhash>.js — which 404s, leaving React unable to boot and
 * the visitor staring at the server-rendered text forever. Observed in
 * production on 2026-08-20: pages served index-DOqXNMDJ.js after the deploy
 * had moved to index-C6jRf-mO.js.
 *
 * __build_id.txt changes exactly when those hashes change and costs 41 bytes,
 * so it is checked on every render. That is one tiny round trip in the steady
 * state — strictly cheaper than re-fetching index.html each time — with no
 * staleness window at all.
 *
 * Returns "" only if we have never successfully fetched a shell.
 */
async function getShell(log = console) {
  let buildId = "";
  try {
    buildId = (await fetchText(BUILD_ID_URL, BUILD_ID_TIMEOUT_MS, "text/plain")).trim();
  } catch (err) {
    // Can't confirm freshness. A shell we already hold is still the best
    // available answer — it was correct when fetched, and the alternative is
    // no app at all.
    (log.warn || console.warn)(`[app-shell] build id check failed: ${err?.message || err}`);
    if (_shell.html) return _shell.html;
  }

  if (buildId && _shell.html && _shell.buildId === buildId) return _shell.html;
  if (_shell.inflight) return _shell.inflight;

  _shell.inflight = fetchShell()
    .then((html) => {
      _shell = { html, buildId, inflight: null };
      return html;
    })
    .catch((err) => {
      _shell.inflight = null;
      (log.warn || console.warn)(`[app-shell] shell fetch failed: ${err?.message || err}`);
      // Stale-if-error. Empty string means "never had one" and the caller
      // falls back to a document-only page.
      return _shell.html || "";
    });

  return _shell.inflight;
}

/** Test seam: drop the cached shell so a test starts from a cold worker. */
function _resetShellCache() {
  _shell = { html: "", buildId: "", inflight: null };
}

// ── assembly ────────────────────────────────────────────────────────────────

// Minimal styling for the pre-hydration document. Scoped to .mi-seo so it
// cannot leak into the React app, which replaces this markup wholesale.
const SEO_CSS = `
.mi-seo{max-width:64rem;margin:0 auto;padding:1.5rem 1rem 3rem;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5}
.mi-seo h1{font-size:1.875rem;font-weight:700;margin:.75rem 0}
.mi-seo h2{font-size:1.125rem;font-weight:600;margin:2rem 0 .5rem}
.mi-seo a{color:inherit}
.mi-crumb,.mi-loc,.mi-more{opacity:.7;font-size:.875rem}
.mi-lead{font-size:1.125rem}
.mi-list,.mi-nav{list-style:none;padding:0;margin:.5rem 0;display:grid;gap:.25rem;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))}
.mi-facts{margin:.5rem 0;display:grid;grid-template-columns:max-content 1fr;gap:.35rem 1rem;font-size:.95rem}
.mi-facts dt{opacity:.7}
.mi-facts dd{margin:0}`;

function headTags(page) {
  return [
    `<meta name="description" content="${esc(page.description)}" />`,
    `<link rel="canonical" href="${esc(page.canonical)}" />`,
    page.robots ? `<meta name="robots" content="${esc(page.robots)}" />` : "",
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${esc(page.title)}" />`,
    `<meta property="og:description" content="${esc(page.description)}" />`,
    `<meta property="og:url" content="${esc(page.canonical)}" />`,
    // og-card.png, not the logo file: tabarnam.png is transparent and 2.2:1,
    // so platforms composite it on their own chrome and crop 240px per side to
    // reach 1.91:1 — through the arm. This one is opaque 1200x630 with margins.
    `<meta property="og:image" content="${ORIGIN}/og-card.png" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="Tabarnam" />`,
    // The strip above removes index.html's generic twitter:* tags (they would
    // describe the homepage on every page), so the page-specific ones have to
    // be restated here. X does fall back to the og:* tags, but leaving a hole
    // we opened ourselves is not a plan.
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(page.title)}" />`,
    `<meta name="twitter:description" content="${esc(page.description)}" />`,
    `<meta name="twitter:image" content="${ORIGIN}/og-card.png" />`,
    page.jsonLd ? `<script type="application/ld+json">${jsonForScript(page.jsonLd)}</script>` : "",
    `<style>${SEO_CSS}</style>`,
  ]
    .filter(Boolean)
    .join("\n    ");
}

/**
 * Splice the page into the app shell.
 *
 * Both edits are anchored on markup index.html actually contains; if either
 * anchor is missing we return "" and the caller falls back, rather than
 * shipping a page that silently lost its content or its <title>.
 */
function injectIntoShell(shell, page) {
  if (!shell) return "";

  const titled = shell.replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(page.title)}</title>`);
  if (titled === shell && !/<title>/i.test(shell)) return "";

  // Drop every head tag this page is about to restate, so the document never
  // carries two descriptions or two og:titles. index.html writes these across
  // multiple lines, hence [\s\S] rather than . — and og:site_name is
  // deliberately NOT in the list: it is site-wide and correct as-is.
  // og:image now has sub-properties (width/height/alt) in index.html, and
  // `property="og:image"` does not match `property="og:image:width"` — without
  // the optional suffix group those survive the strip and the document ships
  // two of each.
  const stripped = titled.replace(
    /\s*<meta\s+(?:name="description"|property="og:(?:type|title|description|url|image(?::(?:width|height|alt|type|secure_url))?)"|name="twitter:(?:card|title|description|image)")[\s\S]*?\/>/gi,
    ""
  );

  const headed = stripped.replace(/<\/head>/i, `    ${headTags(page)}\n  </head>`);
  if (headed === stripped) return "";

  const mounted = headed.replace(
    /(<div id="root">)(\s*)(<\/div>)/i,
    (_m, open, _ws, close) => `${open}<div class="mi-seo">${page.body}</div>${close}`
  );
  if (mounted === headed) return "";

  return mounted;
}

/** Document-only fallback used when the app shell can't be fetched at all. */
function standaloneDocument(page) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${esc(page.title)}</title>
    ${headTags(page)}
  </head>
  <body><div class="mi-seo">${page.body}</div></body>
</html>`;
}

/** Standard success response for a rendered page. */
function htmlResponse(html) {
  return {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Content moves only when an import lands. Short freshness plus a long
      // stale window keeps repeat crawls and human visits off the cold path.
      "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
      Vary: "Accept-Encoding",
    },
    body: html,
  };
}

module.exports = {
  ORIGIN,
  esc,
  jsonForScript,
  nf,
  getShell,
  _resetShellCache,
  headTags,
  injectIntoShell,
  standaloneDocument,
  htmlResponse,
  SEO_CSS,
};
