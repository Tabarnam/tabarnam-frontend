/**
 * Server-rendered HTML for company pages.
 *
 * public/staticwebapp.config.json rewrites /company and /company/* here, so
 * this function — not the SPA fallback — answers those URLs for everyone.
 * Same bytes for crawlers and people; nothing branches on user agent. See
 * api/_companyRender.js for what the page says and api/_appShell.js for how
 * the React app is spliced back around it.
 *
 * Routes are explicit rather than a `{*path}` catch-all: the catch-all form
 * registers locally but is never bound by the Functions host on this app, and
 * 404s in production (learned the hard way on made-in-page, 07685d46).
 *
 * DEPLOY ORDER MATTERS. api/** ships via "Deploy tabarnam-xai-dedicated" and
 * public/staticwebapp.config.json via "Deploy SWA" — two workflows running in
 * parallel off the same push. Ship this function first, confirm it answers,
 * then ship the config, or /company/* 404s in the gap.
 */

let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}

const { renderCompany } = require("../_companyRender");
const { getShell } = require("../_appShell");

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
    console.error("[company-page] Failed to initialize Cosmos container:", err);
    return null;
  }
}

/**
 * The path the visitor actually asked for. SWA rewrites carry it in
 * x-ms-original-url; the {slug} route param covers local dev and direct calls.
 */
function originalPath(req) {
  const header = req?.headers?.get
    ? req.headers.get("x-ms-original-url")
    : req?.headers?.["x-ms-original-url"];
  if (header) {
    try {
      const { pathname } = new URL(header, "https://tabarnam.com");
      // `new URL` does NOT throw on junk — it resolves it against the base, so
      // "::::" would yield "/::::" and 404 instead of falling back.
      if (/^\/company(\/|$)/i.test(pathname)) return pathname;
    } catch {
      // fall through to the route param
    }
  }
  const slug = String(req?.params?.slug || "").replace(/^\/+|\/+$/g, "");
  return slug ? `/company/${slug}` : "/company";
}

/** Serve the unmodified app shell so the SPA renders this page client-side. */
async function spaFallback(log) {
  const shell = await getShell(log);
  if (shell) {
    return {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" },
      body: shell,
    };
  }
  // A crawler reads 503 as "come back later" and keeps the URL; a 200 with an
  // empty page would teach it the page has no content.
  return {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "30" },
    body: "Temporarily unavailable — please retry.",
  };
}

async function handleCompanyPage(req, context) {
  const pathname = originalPath(req);
  const log = context || console;

  try {
    const res = await renderCompany(pathname, getCompaniesContainer(), log);
    // status 0 = renderer declined (no catalog data yet).
    if (!res.status) return spaFallback(log);
    return res;
  } catch (err) {
    (log.error || console.error)(`[company-page] render failed for ${pathname}: ${err?.stack || err}`);
    return spaFallback(log);
  }
}

const COMPANY_ROUTES = [
  ["company-page", "company-page"],
  ["company-page-slug", "company-page/{slug}"],
];

for (const [name, route] of COMPANY_ROUTES) {
  app.http(name, {
    route,
    methods: ["GET"],
    authLevel: "anonymous",
    handler: handleCompanyPage,
  });
}

module.exports = app;
module.exports.handleCompanyPage = handleCompanyPage;
module.exports.originalPath = originalPath;
