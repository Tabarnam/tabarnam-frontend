// Generates public/sitemap.xml from the live pins index.
//
// Why generated: the hand-maintained sitemap listed every country slug whether
// or not the catalog had a single company there, and carried a hardcoded
// lastmod that stopped being true the day after it was typed. A sitemap full of
// thin/empty URLs with a stale lastmod trains a crawler to ignore it — and the
// counts on these pages change with every import, so "when did this page last
// change" is a real, knowable date, not a constant.
//
// Runs as part of `npm run build`. It is deliberately FAIL-SOFT: if the pins
// index can't be reached (offline dev, API down mid-deploy) it leaves the
// existing sitemap.xml untouched and exits 0 rather than shipping an empty one.
//
// Usage:
//   node scripts/generate-sitemap.mjs
//   SITEMAP_PINS_URL=http://127.0.0.1:7071/api/map-pins node scripts/generate-sitemap.mjs
//   node scripts/generate-sitemap.mjs --require-live   (CI: fail loudly instead)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { countrySlug, regionSlug, US_REGIONS } from "../src/lib/madeInSlugs.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "public", "sitemap.xml");
const COUNTRIES = path.join(ROOT, "public", "geo", "countries.json");

const ORIGIN = "https://tabarnam.com";
// Keep in sync with PINS_PAYLOAD_VERSION in src/components/results/map/pinsIndexClient.js.
const PINS_VERSION = 5;
const PINS_URL = process.env.SITEMAP_PINS_URL || `${ORIGIN}/api/map-pins?v=${PINS_VERSION}`;
const REQUIRE_LIVE = process.argv.includes("--require-live");
const FETCH_TIMEOUT_MS = 120_000;

// A place page with only a handful of companies is thin content: it competes
// with nothing, and in bulk it dilutes how the whole tree is crawled. Below
// this the page still exists and still gets internal links — it just isn't
// advertised in the sitemap until the catalog fills in.
const MIN_COMPANIES = Number(process.env.SITEMAP_MIN_COMPANIES ?? 3);

// Static pages that aren't derived from catalog data.
const STATIC_ROUTES = [
  ["/", "1.0"],
  ["/made-in", "0.9"],
  ["/about", "0.7"],
  ["/how-it-works", "0.7"],
  ["/privacy", "0.3"],
];

function log(msg) {
  console.log(`[generate-sitemap] ${msg}`);
}

/**
 * Count distinct companies per manufacturing country and per US subdivision.
 *
 * Reads the compact v5 row format directly — [id, name, tagline, domain,
 * hqLat, hqLng, mfg[], hqCC, mfgCCs[], hqRegion, mfgRegions[], hqLabel] — as
 * documented in src/components/results/map/markerData.js. Only positions 8 and
 * 10 matter here, so this stays a plain read rather than pulling the app's
 * decoder (which builds a full Map of marker-shaped objects for 14k rows).
 */
function countByPlace(payload) {
  const byCC = new Map();
  const byRegion = new Map();
  const rows = Array.isArray(payload?.companies) ? payload.companies : [];
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 9) continue;
    const mfgCCs = Array.isArray(row[8]) ? row[8] : [];
    const mfgRegions = Array.isArray(row[10]) ? row[10] : [];
    // Dedupe within a company: two plants in Ohio are one company on the page.
    for (const cc of new Set(mfgCCs.filter((c) => typeof c === "string" && c))) bump(byCC, cc);
    for (const r of new Set(mfgRegions.filter((r) => typeof r === "string" && r))) bump(byRegion, r);
  }
  return { byCC, byRegion, total: rows.length };
}

function isoDate(value) {
  const d = value ? new Date(value) : new Date();
  return (Number.isNaN(d.getTime()) ? new Date() : d).toISOString().slice(0, 10);
}

function urlEntry(loc, lastmod, priority) {
  return `  <url><loc>${ORIGIN}${loc}</loc><lastmod>${lastmod}</lastmod><priority>${priority}</priority></url>`;
}

async function fetchPins() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(PINS_URL, {
      headers: { accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`map-pins responded ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  let payload;
  try {
    log(`fetching ${PINS_URL}`);
    payload = await fetchPins();
  } catch (err) {
    const msg = `could not reach the pins index (${err?.message || err})`;
    if (REQUIRE_LIVE) {
      console.error(`[generate-sitemap] ${msg} — --require-live was set, failing.`);
      process.exit(1);
    }
    log(`${msg}; leaving the existing sitemap.xml in place.`);
    process.exit(0);
  }

  const { byCC, byRegion, total } = countByPlace(payload);
  // The pins index stamps when it was last rebuilt — which is exactly when
  // these pages last changed, since every number on them derives from it.
  const lastmod = isoDate(payload?.generated_at);
  log(`pins index: ${total} companies, generated_at=${payload?.generated_at || "unknown"}`);

  const countries = JSON.parse(fs.readFileSync(COUNTRIES, "utf8"));
  const lines = [];

  for (const [loc, priority] of STATIC_ROUTES) lines.push(urlEntry(loc, lastmod, priority));

  // Countries, most-populated first so the highest-value pages lead the file.
  const countryRows = countries
    .map(({ code, name }) => ({ cc: String(code || "").toUpperCase(), name }))
    .filter(({ cc, name }) => /^[A-Z]{2}$/.test(cc) && name)
    .map((row) => ({ ...row, count: byCC.get(row.cc) || 0 }))
    .filter((row) => row.count >= MIN_COMPANIES)
    .sort((a, z) => z.count - a.count || a.name.localeCompare(z.name));

  for (const { cc, name, count } of countryRows) {
    // Priority tracks catalog depth: a 8,800-company page and a 4-company page
    // should not ask for the same share of a crawl budget.
    const priority = count >= 1000 ? "0.8" : count >= 100 ? "0.7" : "0.6";
    lines.push(urlEntry(`/made-in/${countrySlug(cc, name)}`, lastmod, priority));
  }

  const regionRows = US_REGIONS.map(([code, name]) => ({
    code,
    name,
    count: byRegion.get(code) || 0,
  }))
    .filter((row) => row.count >= MIN_COMPANIES)
    .sort((a, z) => z.count - a.count || a.name.localeCompare(z.name));

  for (const { code, name, count } of regionRows) {
    const priority = count >= 500 ? "0.7" : count >= 50 ? "0.6" : "0.5";
    lines.push(urlEntry(`/made-in/usa/${regionSlug(code, name)}`, lastmod, priority));
  }

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...lines,
    "</urlset>",
    "",
  ].join("\n");

  fs.writeFileSync(OUT, xml, "utf8");
  log(
    `wrote ${lines.length} URLs → public/sitemap.xml ` +
      `(${STATIC_ROUTES.length} static, ${countryRows.length} countries, ${regionRows.length} US regions; ` +
      `min ${MIN_COMPANIES} companies, lastmod ${lastmod})`
  );

  const skippedCountries = byCC.size - countryRows.length;
  if (skippedCountries > 0) {
    log(`skipped ${skippedCountries} countries below the ${MIN_COMPANIES}-company threshold.`);
  }
}

main().catch((err) => {
  console.error(`[generate-sitemap] unexpected failure: ${err?.stack || err}`);
  process.exit(REQUIRE_LIVE ? 1 : 0);
});
