/**
 * Server-rendered HTML for the /made-in tree.
 *
 * public/staticwebapp.config.json rewrites /made-in and /made-in/* here, so
 * this function — not the SPA fallback — answers those URLs for everyone:
 * crawlers, answer engines and people get identical bytes. See
 * api/_madeInRender.js for why, and for how the app shell is spliced in so the
 * React app still boots on top.
 *
 * Failure policy: if the renderer declines (no catalog data) or throws, serve
 * the plain app shell so the SPA renders the page client-side exactly as it
 * did before this function existed. A /made-in page that renders late is a
 * degraded page; a /made-in page that 500s is a lost one.
 *
 * Note the fallback returns the shell's BYTES rather than redirecting: SWA
 * routes match on path only, so any redirect back to /made-in/... would be
 * rewritten straight back here and loop.
 *
 * DEPLOY ORDER MATTERS. api/** ships via "Deploy tabarnam-xai-dedicated" and
 * public/staticwebapp.config.json via "Deploy SWA" — two workflows that run in
 * parallel off the same push. If the config lands first, /made-in/* rewrites to
 * a function that does not exist yet and the whole tree 404s until the API
 * catches up. Ship this function first, confirm it answers, then ship the
 * config.
 */

let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}

const { renderMadeIn, getShell } = require("../_madeInRender");

function env(k, d = "") {
  const v = process.env[k];
  return (v == null ? d : String(v)).trim();
}

function getCompaniesContainer() {
  try {
    if (!env("COSMOS_DB_ENDPOINT") || !env("COSMOS_DB_KEY")) return null;
    const client = require("../_cosmosConfig").getCosmosClient();
    return client
      .database(env("COSMOS_DB_DATABASE", "tabarnam-db"))
      .container(env("COSMOS_DB_COMPANIES_CONTAINER", "companies"));
  } catch (err) {
    console.error("[made-in] Failed to initialize Cosmos container:", err);
    return null;
  }
}

/**
 * The path the visitor actually asked for.
 *
 * SWA rewrites carry the original path in x-ms-original-url; the {slug} and
 * {state} route params are the fallback for local dev and for direct calls to
 * /api/made-in-page/<slug>.
 */
function originalPath(req) {
  const header = req?.headers?.get
    ? req.headers.get("x-ms-original-url")
    : req?.headers?.["x-ms-original-url"];
  if (header) {
    try {
      const { pathname } = new URL(header, "https://tabarnam.com");
      // Only trust it if it names a page we serve. `new URL` does NOT throw on
      // junk — it resolves it against the base, so "::::" yields "/::::",
      // which would 404 instead of falling back to the route params.
      if (/^\/made-in(\/|$)/i.test(pathname)) return pathname;
    } catch {
      // fall through to the route params
    }
  }
  const parts = [req?.params?.slug, req?.params?.state]
    .map((p) => String(p || "").replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
  return parts.length ? `/made-in/${parts.join("/")}` : "/made-in";
}

/**
 * Serve the unmodified app shell, so the SPA renders this page client-side
 * exactly as it did before this function existed.
 *
 * If we have never managed to fetch a shell either, 503 is the honest answer:
 * a crawler treats it as "come back later" and keeps the URL, where a 200 with
 * an empty page would teach it the page has no content.
 */
async function spaFallback(log) {
  const shell = await getShell(log);
  if (shell) {
    return {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
      body: shell,
    };
  }
  return {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "30" },
    body: "Temporarily unavailable — please retry.",
  };
}

async function handleMadeInPage(req, context) {
  const pathname = originalPath(req);
  const log = context || console;

  try {
    const res = await renderMadeIn(pathname, getCompaniesContainer(), log);
    // status 0 = renderer declined (no catalog data yet).
    if (!res.status) return spaFallback(log);
    return res;
  } catch (err) {
    (log.error || console.error)(`[made-in] render failed for ${pathname}: ${err?.stack || err}`);
    return spaFallback(log);
  }
}

// Three explicit routes rather than one `made-in-page/{*path}` catch-all.
// The catch-all form shipped in 07685d46 and 404'd in production: it showed up
// in /api/diag (which reports what app.http was CALLED with) but the Functions
// host never bound it — the same registered-locally/dead-in-prod signature as
// the admin* routes that forced the xadmin-api-* naming. Explicit params are
// the shape already proven on this app by xadmin-api-companies/{id?}.
//
// The path depth mirrors the site: /made-in, /made-in/<country>,
// /made-in/usa/<state>. Anything deeper is not a page we publish.
const MADE_IN_ROUTES = [
  ["made-in-page", "made-in-page"],
  ["made-in-page-country", "made-in-page/{slug}"],
  ["made-in-page-region", "made-in-page/{slug}/{state}"],
];

for (const [name, route] of MADE_IN_ROUTES) {
  app.http(name, {
    route,
    methods: ["GET"],
    authLevel: "anonymous",
    handler: handleMadeInPage,
  });
}

module.exports = app;
module.exports.handleMadeInPage = handleMadeInPage;
module.exports.originalPath = originalPath;
