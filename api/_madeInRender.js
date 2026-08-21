/**
 * Server-side HTML for the /made-in tree.
 *
 * Why this exists: tabarnam.com is a client-rendered SPA, so the raw response
 * for /made-in/usa was 1,890 bytes of shell with `<title>Tabarnam</title>` and
 * no body content — every ranking signal on the page (count-bearing title,
 * description, canonical, JSON-LD, the company list) was written by JS after
 * the pins index loaded. Googlebot renders JS and found it anyway; Bing is
 * unreliable at it, and the AI crawlers (GPTBot, ClaudeBot, PerplexityBot,
 * Applebot) largely do not execute JS at all. These pages exist purely to
 * rank, so they cannot depend on the reader running JavaScript.
 *
 * Approach — the SAME HTML for everyone, no user-agent sniffing:
 *   1. Fetch the deployed index.html once per worker and cache it. That keeps
 *      us in sync with whatever hashed asset filenames the frontend last
 *      shipped, without the API needing access to the frontend's dist.
 *   2. Rewrite its <head> with this page's real title/description/canonical/
 *      JSON-LD, and fill <div id="root"> with the page's real content.
 *   3. Ship it. ReactDOM.createRoot().render() clears #root on mount, so the
 *      SPA takes over with the interactive map and view toggle. Server HTML is
 *      what the reader sees until then — there is no hydration mismatch to
 *      reconcile because we are not hydrating, we are seeding.
 *
 * Serving the same bytes to crawlers and people is the point: nothing here
 * branches on who is asking.
 */

const { getPins } = require("./_pinsIndex");
const PLACES = require("./_madeInPlaces.json");

const {
  ORIGIN,
  esc,
  nf,
  getShell,
  _resetShellCache,
  injectIntoShell,
  standaloneDocument,
  htmlResponse,
} = require("./_appShell");

// How many companies to name in the page text. The full set stays on the map;
// this is the crawlable, readable slice. 250 keeps the largest page (USA,
// ~8.8k manufacturers) around 30KB instead of 800KB.
const LIST_LIMIT = 250;

const byCC = new Map(PLACES.countries.map((c) => [c.cc, c]));
const bySlug = new Map(PLACES.countries.map((c) => [c.slug, c]));
const regionByCode = new Map(PLACES.usRegions.map((r) => [r.code, r]));
const regionBySlug = new Map(PLACES.usRegions.map((r) => [r.slug, r]));

// ── aggregation ─────────────────────────────────────────────────────────────

let _agg = { generatedAt: "", data: null };

/**
 * Companies grouped by manufacturing country and by US subdivision.
 *
 * Reads the compact v5 pins rows directly — [id, name, tagline, domain, hqLat,
 * hqLng, mfg[], hqCC, mfgCCs[], hqRegion, mfgRegions[], hqLabel] — and keeps
 * only what the page text needs. Cached on the pins index's generatedAt, so a
 * 3.9MB parse happens once per rebuild per worker, not once per request.
 */
function aggregate(payload) {
  const countries = new Map();
  const regions = new Map();
  const bucket = (map, key) => {
    let b = map.get(key);
    if (!b) {
      b = { mfg: [], hqCount: 0 };
      map.set(key, b);
    }
    return b;
  };

  for (const row of Array.isArray(payload?.companies) ? payload.companies : []) {
    if (!Array.isArray(row) || row.length < 9) continue;
    const name = String(row[1] || "");
    if (!name) continue;

    // Each mfg pin is [lat, lng, lowPrec01, cc, region, label]. The label
    // shown next to a company must be the plant in THIS place — a company
    // that makes things in Ohio and Vietnam appears on both pages, and using
    // its HQ label (row[11]) would print the same city on both.
    const pins = Array.isArray(row[6]) ? row[6] : [];
    const labelFor = (key, idx) => {
      const pin = pins.find((p) => Array.isArray(p) && p[idx] === key);
      return pin && typeof pin[5] === "string" ? pin[5] : "";
    };

    for (const cc of new Set((row[8] || []).filter(Boolean))) {
      bucket(countries, cc).mfg.push({ name, label: labelFor(cc, 3) });
    }
    for (const r of new Set((row[10] || []).filter(Boolean))) {
      bucket(regions, r).mfg.push({ name, label: labelFor(r, 4) });
    }
    if (row[7]) bucket(countries, row[7]).hqCount += 1;
    if (row[9]) bucket(regions, row[9]).hqCount += 1;
  }

  const byName = (a, z) => a.name.localeCompare(z.name);
  for (const b of countries.values()) b.mfg.sort(byName);
  for (const b of regions.values()) b.mfg.sort(byName);
  return { countries, regions };
}

async function getAggregation(container) {
  const cache = await getPins(container);
  if (!cache || !cache.body) return null;
  if (_agg.generatedAt !== cache.generatedAt || !_agg.data) {
    _agg = { generatedAt: cache.generatedAt, data: aggregate(JSON.parse(cache.body)) };
  }
  return _agg.data;
}

// ── routing ─────────────────────────────────────────────────────────────────

/**
 * Parse the path a request was rewritten from into a page descriptor.
 * @returns {{kind: "index"|"country"|"region", slug?: string}
 *           | {kind: "redirect", to: string}
 *           | null} null = not a /made-in URL
 */
function resolvePath(pathname) {
  const clean = String(pathname || "").split("?")[0].replace(/\/+$/, "").toLowerCase();
  if (clean === "/made-in" || clean === "") return { kind: "index" };

  const parts = clean.split("/").filter(Boolean);
  if (parts[0] !== "made-in") return null;

  if (parts.length === 1) return { kind: "index" };

  if (parts.length === 2) {
    const slug = parts[1];
    // Alias slugs 301 to canonical, matching the client router's <Navigate
    // replace> — one URL per place, never two serving the same content.
    const canonical = PLACES.aliases[slug];
    if (canonical) return { kind: "redirect", to: `/made-in/${canonical}` };
    if (bySlug.has(slug)) return { kind: "country", slug };
    return { kind: "redirect", to: "/made-in" };
  }

  if (parts.length === 3 && parts[1] === "usa") {
    if (regionBySlug.has(parts[2])) return { kind: "region", slug: parts[2] };
    return { kind: "redirect", to: "/made-in/usa" };
  }

  return { kind: "redirect", to: "/made-in" };
}

// ── page content ────────────────────────────────────────────────────────────

function companyList(entries, placeName) {
  if (!entries.length) return "";
  const shown = entries.slice(0, LIST_LIMIT);
  const items = shown
    .map((e) => {
      const label = e.label ? ` <span class="mi-loc">${esc(e.label)}</span>` : "";
      // Names are plain text for now. They become links to /company/<slug>
      // when those pages exist — pointing 250 links per page at /results
      // search URLs would spend crawl budget on thin, JS-rendered pages.
      return `<li>${esc(e.name)}${label}</li>`;
    })
    .join("");
  const more =
    entries.length > shown.length
      ? `<p class="mi-more">Showing ${nf.format(shown.length)} of ${nf.format(entries.length)} companies. The full set is on the map above.</p>`
      : "";
  return `<h2>Companies manufacturing in ${esc(placeName)}</h2><ul class="mi-list">${items}</ul>${more}`;
}

function navList(items) {
  return `<ul class="mi-nav">${items
    .map((i) => `<li><a href="${esc(i.href)}">${esc(i.label)}</a>${i.count != null ? ` <span class="mi-loc">(${nf.format(i.count)})</span>` : ""}</li>`)
    .join("")}</ul>`;
}

function countryPage(country, agg) {
  const b = agg.countries.get(country.cc) || { mfg: [], hqCount: 0 };
  const count = b.mfg.length;
  const display = country.name;
  const canonical = `${ORIGIN}/made-in/${country.slug}`;

  const title = `Made in ${display} — ${count > 0 ? `${nf.format(count)} ` : ""}Companies That Manufacture in ${display} | Tabarnam`;
  const description = `${count > 0 ? `${nf.format(count)} companies` : "Companies"} that manufacture in ${display}, with headquarters and manufacturing locations verified by Tabarnam. Find products actually made in ${display}.`;

  const lead =
    count > 0
      ? `<p class="mi-lead"><strong>${nf.format(count)}</strong> ${count === 1 ? "company" : "companies"} in the Tabarnam catalog ${count === 1 ? "manufactures" : "manufacture"} in ${esc(display)}${b.hqCount ? ` · ${nf.format(b.hqCount)} ${b.hqCount === 1 ? "is" : "are"} headquartered here` : ""}.</p>`
      : `<p class="mi-lead">We haven't verified any manufacturers in ${esc(display)} yet — the catalog grows daily.</p>`;

  // US state breakdown, biggest first.
  let states = "";
  if (country.cc === "US") {
    const rows = PLACES.usRegions
      .map((r) => ({ ...r, count: (agg.regions.get(r.code)?.mfg || []).length }))
      .filter((r) => r.count > 0)
      .sort((a, z) => z.count - a.count || a.name.localeCompare(z.name));
    if (rows.length) {
      states = `<h2>By state &amp; territory</h2>${navList(
        rows.map((r) => ({ href: `/made-in/usa/${r.slug}`, label: r.name, count: r.count }))
      )}`;
    }
  }

  const siblings = [...agg.countries.entries()]
    .filter(([cc, bb]) => bb.mfg.length > 0 && cc !== country.cc && byCC.has(cc))
    .sort((a, z) => z[1].mfg.length - a[1].mfg.length)
    .slice(0, 12)
    .map(([cc, bb]) => ({ href: `/made-in/${byCC.get(cc).slug}`, label: byCC.get(cc).name, count: bb.mfg.length }));

  const jsonLd =
    count > 0
      ? {
          "@context": "https://schema.org",
          "@type": "CollectionPage",
          name: `Companies that manufacture in ${display}`,
          description: `${count} companies in the Tabarnam catalog manufacture in ${display}.`,
          url: canonical,
          mainEntity: {
            "@type": "ItemList",
            numberOfItems: count,
            // Only the companies actually named in the page text: structured
            // data must describe content the visitor can see.
            itemListElement: b.mfg.slice(0, LIST_LIMIT).map((e, i) => ({
              "@type": "ListItem",
              position: i + 1,
              name: e.name,
            })),
          },
        }
      : null;

  const body = `
<nav class="mi-crumb"><a href="/made-in">Browse by country</a> / ${esc(display)}</nav>
<h1>Made in ${esc(display)}</h1>
${lead}
<p><a href="/results?country=${encodeURIComponent(display)}">Search within ${esc(display)}</a></p>
${companyList(b.mfg, display)}
${states}
${siblings.length ? `<h2>Also made in</h2>${navList(siblings)}` : ""}
<p><a href="/made-in">All countries</a></p>`;

  return { title, description, canonical, jsonLd, body };
}

function regionPage(region, agg) {
  const b = agg.regions.get(region.code) || { mfg: [], hqCount: 0 };
  const count = b.mfg.length;
  const name = region.name;
  const canonical = `${ORIGIN}/made-in/usa/${region.slug}`;

  const title = `Made in ${name} — ${count > 0 ? `${nf.format(count)} ` : ""}Companies That Manufacture in ${name} | Tabarnam`;
  const description = `${count > 0 ? `${nf.format(count)} companies` : "Companies"} that manufacture in ${name}, with headquarters and manufacturing locations verified by Tabarnam. Find products made in ${name}.`;

  const lead =
    count > 0
      ? `<p class="mi-lead"><strong>${nf.format(count)}</strong> ${count === 1 ? "company" : "companies"} in the Tabarnam catalog ${count === 1 ? "manufactures" : "manufacture"} in ${esc(name)}${b.hqCount ? ` · ${nf.format(b.hqCount)} ${b.hqCount === 1 ? "is" : "are"} headquartered here` : ""}.</p>`
      : `<p class="mi-lead">We haven't verified any manufacturers in ${esc(name)} yet — the catalog grows daily.</p>`;

  const siblings = PLACES.usRegions
    .map((r) => ({ ...r, count: (agg.regions.get(r.code)?.mfg || []).length }))
    .filter((r) => r.count > 0 && r.code !== region.code)
    .sort((a, z) => z.count - a.count || a.name.localeCompare(z.name))
    .slice(0, 12)
    .map((r) => ({ href: `/made-in/usa/${r.slug}`, label: r.name, count: r.count }));

  const jsonLd =
    count > 0
      ? {
          "@context": "https://schema.org",
          "@type": "CollectionPage",
          name: `Companies that manufacture in ${name}`,
          description: `${count} companies in the Tabarnam catalog manufacture in ${name}.`,
          url: canonical,
          mainEntity: {
            "@type": "ItemList",
            numberOfItems: count,
            itemListElement: b.mfg.slice(0, LIST_LIMIT).map((e, i) => ({
              "@type": "ListItem",
              position: i + 1,
              name: e.name,
            })),
          },
        }
      : null;

  const body = `
<nav class="mi-crumb"><a href="/made-in">Browse by country</a> / <a href="/made-in/usa">USA</a> / ${esc(name)}</nav>
<h1>Made in ${esc(name)}</h1>
${lead}
${companyList(b.mfg, name)}
${siblings.length ? `<h2>Other states</h2>${navList(siblings)}` : ""}
<p><a href="/made-in/usa">All US states</a> · <a href="/made-in">All countries</a></p>`;

  return { title, description, canonical, jsonLd, body };
}

function indexPage(agg) {
  const rows = [...agg.countries.entries()]
    .filter(([cc, b]) => b.mfg.length > 0 && byCC.has(cc))
    .sort((a, z) => z[1].mfg.length - a[1].mfg.length)
    .map(([cc, b]) => ({ href: `/made-in/${byCC.get(cc).slug}`, label: byCC.get(cc).name, count: b.mfg.length }));

  const total = rows.reduce((n, r) => n + r.count, 0);
  const title = "Made in… — Browse Companies by Manufacturing Country | Tabarnam";
  const description = `Browse ${nf.format(rows.length)} countries where companies in the Tabarnam catalog manufacture. See who makes what, and where, with locations verified by Tabarnam.`;

  const body = `
<h1>Made in…</h1>
<p class="mi-lead">Every country where a company in the Tabarnam catalog manufactures — ${nf.format(rows.length)} countries, ${nf.format(total)} company-country pairs.</p>
<h2>Browse by country</h2>
${navList(rows)}`;

  return {
    title,
    description,
    canonical: `${ORIGIN}/made-in`,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: "Made in — browse by manufacturing country",
      description,
      url: `${ORIGIN}/made-in`,
      mainEntity: { "@type": "ItemList", numberOfItems: rows.length },
    },
    body,
  };
}

/**
 * Build the response for a /made-in URL.
 * @returns {{status: number, headers: object, body?: string}}
 */
async function renderMadeIn(pathname, container, log = console) {
  const route = resolvePath(pathname);
  if (!route) return { status: 404, headers: { "Cache-Control": "no-store" } };

  if (route.kind === "redirect") {
    return {
      status: 301,
      headers: { Location: route.to, "Cache-Control": "public, max-age=3600" },
    };
  }

  const agg = await getAggregation(container);
  if (!agg) {
    // No catalog data: fall through to the SPA rather than render a page that
    // claims every place has zero companies.
    return { status: 0, headers: {} };
  }

  let page;
  if (route.kind === "index") page = indexPage(agg);
  else if (route.kind === "country") page = countryPage(bySlug.get(route.slug), agg);
  else page = regionPage(regionBySlug.get(route.slug), agg);

  const shell = await getShell(log);
  return htmlResponse(injectIntoShell(shell, page) || standaloneDocument(page));
}

module.exports = {
  renderMadeIn,
  getShell,
  // exported for tests
  _resetShellCache,
  resolvePath,
  aggregate,
  injectIntoShell,
  countryPage,
  regionPage,
  indexPage,
  esc,
  LIST_LIMIT,
};
