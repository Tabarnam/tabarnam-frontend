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
 * SWA rewrites carry the original path in x-ms-original-url; the {*path}
 * route param is the fallback for local dev and for direct calls to
 * /api/made-in-page/<slug>.
 */
function originalPath(req) {
  const header = req?.headers?.get
    ? req.headers.get("x-ms-original-url")
    : req?.headers?.["x-ms-original-url"];
  if (header) {
    try {
      return new URL(header, "https://tabarnam.com").pathname;
    } catch {
      // fall through to the route param
    }
  }
  const tail = String(req?.params?.path || "").replace(/^\/+/, "");
  return tail ? `/made-in/${tail}` : "/made-in";
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

app.http("made-in-page", {
  route: "made-in-page/{*path}",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: handleMadeInPage,
});

module.exports = app;
module.exports.handleMadeInPage = handleMadeInPage;
module.exports.originalPath = originalPath;
