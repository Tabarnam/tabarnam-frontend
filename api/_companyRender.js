/**
 * Server-side HTML for company pages (/company/<slug>).
 *
 * These exist to answer one query shape, which the catalog is uniquely placed
 * to answer and which nothing on the site could rank for before: "where is
 * <brand> made", "is <brand> made in china", "<brand> manufacturing". Company
 * records were previously reachable only at /results?q=…&expand=… — a search
 * URL, which Google deprioritises by design and which rendered nothing without
 * JavaScript.
 *
 * Data comes from the pins index: it already covers the whole catalog, is
 * already rebuilt on import and on save, and already carries the canonical
 * slug (see _companySlug.js). No per-request Cosmos read, so a crawler working
 * through thousands of these costs nothing beyond CPU.
 *
 * Industries, product terms and the rating come from a SECOND precomputed blob
 * (_companyFacets.js) rather than from the pins payload, so the consumer map
 * surfaces don't download data only these pages use. Facets are enrichment: a
 * company page renders completely without them, and it must, because the two
 * blobs age out independently.
 */

const { getPins } = require("./_pinsIndex");
const { getFacets } = require("./_companyFacets");
const PLACES = require("./_madeInPlaces.json");
const {
  ORIGIN,
  breadcrumbList,
  esc,
  getShell,
  injectIntoShell,
  standaloneDocument,
  htmlResponse,
} = require("./_appShell");

const countryByCC = new Map(PLACES.countries.map((c) => [c.cc, c]));
const regionByCode = new Map(PLACES.usRegions.map((r) => [r.code, r]));

// Row positions in the v6 pins payload. See markerData.js for the full shape.
const I = {
  id: 0, name: 1, tagline: 2, domain: 3,
  hqLat: 4, hqLng: 5, mfg: 6, hqCC: 7, mfgCCs: 8,
  hqRegion: 9, mfgRegions: 10, hqLabel: 11, slug: 12,
};

// ── index ───────────────────────────────────────────────────────────────────

let _index = { generatedAt: "", data: null };

function buildIndex(payload) {
  const bySlug = new Map();
  const byDomain = new Map();
  for (const row of Array.isArray(payload?.companies) ? payload.companies : []) {
    if (!Array.isArray(row)) continue;
    const slug = row[I.slug];
    if (typeof slug === "string" && slug) bySlug.set(slug, row);
    const domain = String(row[I.domain] || "").toLowerCase();
    // First writer wins: on a duplicated domain the older record (which holds
    // the bare slug) is the one a domain alias should land on.
    if (domain && !byDomain.has(domain)) byDomain.set(domain, row);
  }
  return { bySlug, byDomain };
}

async function getCompanyIndex(container) {
  const cache = await getPins(container);
  if (!cache || !cache.body) return null;
  if (_index.generatedAt !== cache.generatedAt || !_index.data) {
    _index = { generatedAt: cache.generatedAt, data: buildIndex(JSON.parse(cache.body)) };
  }
  return _index.data;
}

let _facets = { generatedAt: "", byId: null };

/**
 * Facets keyed by company id, or null when the blob isn't available.
 *
 * Never throws and never blocks the page: this is enrichment, and a company
 * page that dropped its heading because a secondary index was cold would be a
 * far worse outcome than one without a products list.
 */
async function getFacetsById(container, log = console) {
  try {
    const cache = await getFacets(container);
    if (!cache || !cache.body) return null;
    if (_facets.generatedAt !== cache.generatedAt || !_facets.byId) {
      const payload = JSON.parse(cache.body);
      const byId = new Map();
      for (const row of Array.isArray(payload?.companies) ? payload.companies : []) {
        if (Array.isArray(row) && row[0]) {
          byId.set(row[0], {
            industries: Array.isArray(row[1]) ? row[1] : [],
            products: Array.isArray(row[2]) ? row[2] : [],
            stars: typeof row[3] === "number" ? row[3] : null,
            reviews: typeof row[4] === "number" ? row[4] : 0,
          });
        }
      }
      _facets = { generatedAt: cache.generatedAt, byId };
    }
    return _facets.byId;
  } catch (err) {
    (log.warn || console.warn)(`[company-page] facets unavailable: ${err?.message || err}`);
    return null;
  }
}

// ── routing ─────────────────────────────────────────────────────────────────

/**
 * @returns {{kind: "company", slug: string} | {kind: "redirect", to: string}
 *           | {kind: "index"} | null}
 */
function resolveCompanyPath(pathname) {
  const clean = String(pathname || "").split("?")[0].replace(/\/+$/, "").toLowerCase();
  const parts = clean.split("/").filter(Boolean);
  if (parts[0] !== "company") return null;
  if (parts.length === 1) return { kind: "index" };
  if (parts.length === 2) return { kind: "company", slug: decodeURIComponent(parts[1]) };
  // Nothing deeper is published.
  return { kind: "redirect", to: "/company" };
}

// ── page ────────────────────────────────────────────────────────────────────

/** Unique manufacturing places, in a stable order, with their /made-in links. */
function manufacturingPlaces(row) {
  const pins = Array.isArray(row[I.mfg]) ? row[I.mfg] : [];
  const seen = new Set();
  const out = [];
  for (const pin of pins) {
    if (!Array.isArray(pin)) continue;
    const label = typeof pin[5] === "string" ? pin[5] : "";
    const cc = typeof pin[3] === "string" ? pin[3] : "";
    const region = typeof pin[4] === "string" ? pin[4] : "";
    const key = `${label}|${cc}|${region}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, cc, region });
  }
  return out;
}

function countryLinks(ccs) {
  return ccs
    .map((cc) => countryByCC.get(cc))
    .filter(Boolean)
    .map((c) => `<a href="/made-in/${c.slug}">${esc(c.name)}</a>`);
}

/** Prose list: "A", "A and B", "A, B and C". */
function joinProse(items) {
  if (items.length <= 1) return items[0] || "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function companyPage(row, facets = null) {
  const name = String(row[I.name] || "");
  const tagline = String(row[I.tagline] || "");
  const domain = String(row[I.domain] || "");
  const slug = String(row[I.slug] || "");
  const canonical = `${ORIGIN}/company/${slug}`;

  const mfgCCs = (Array.isArray(row[I.mfgCCs]) ? row[I.mfgCCs] : []).filter(Boolean);
  const mfgNames = mfgCCs.map((cc) => countryByCC.get(cc)?.name).filter(Boolean);
  const hqName = countryByCC.get(row[I.hqCC])?.name || "";
  const hqLabel = String(row[I.hqLabel] || "");
  const places = manufacturingPlaces(row);

  // The title targets the question people actually type — "where is X made",
  // "is X made in china" — rather than restating the brand name twice.
  const title = mfgNames.length
    ? `Where Is ${name} Made? Manufacturing in ${joinProse(mfgNames)} | Tabarnam`
    : `Where Is ${name} Made? Headquarters and Manufacturing | Tabarnam`;

  const descParts = [];
  if (hqLabel || hqName) descParts.push(`${name} is headquartered in ${hqLabel || hqName}`);
  else descParts.push(name);
  if (mfgNames.length) {
    descParts.push(
      `${descParts.length ? "and manufactures" : `${name} manufactures`} in ${joinProse(mfgNames)}`
    );
  }
  const description =
    `${descParts.join(" ")}. Headquarters and manufacturing locations from the Tabarnam catalog.`.replace(
      /\s+/g,
      " "
    );

  const facts = [];
  if (hqLabel || hqName) {
    const hqRegion = regionByCode.get(row[I.hqRegion]);
    const hqCountry = countryByCC.get(row[I.hqCC]);
    const links = [];
    if (hqRegion) links.push(`<a href="/made-in/usa/${hqRegion.slug}">${esc(hqRegion.name)}</a>`);
    if (hqCountry) links.push(`<a href="/made-in/${hqCountry.slug}">${esc(hqCountry.name)}</a>`);
    facts.push([
      "Headquarters",
      `${esc(hqLabel || hqName)}${links.length ? ` <span class="mi-loc">(${links.join(" · ")})</span>` : ""}`,
    ]);
  }
  if (domain) {
    facts.push([
      "Website",
      `<a href="https://${esc(domain)}" rel="noopener nofollow">${esc(domain)}</a>`,
    ]);
  }
  // facets.industries is deliberately NOT rendered — it is a search retrieval
  // lever an admin edits to make a company match a query, not a description of
  // the company. See api/_companyFacets.js.
  const products = facets?.products || [];
  // Only cite a rating that reviews actually back. A bare star count with no
  // reviews behind it is a number the page can't justify.
  if (facets?.stars != null && facets.reviews > 0) {
    facts.push([
      "Tabarnam rating",
      `${esc(facets.stars)} / 5 <span class="mi-loc">from ${facets.reviews} ${facets.reviews === 1 ? "review" : "reviews"}</span>`,
    ]);
  }

  // Products are the terms "<product> made in <place>" searches actually match
  // on. Rendered as prose rather than a chip wall, and already capped upstream
  // at 20 of a possible ~90, so the page reads as a description instead of a
  // keyword dump.
  const productsSection = products.length
    ? `<h2>What ${esc(name)} makes</h2><p>${products.map((p) => esc(p)).join(", ")}.</p>`
    : "";

  let mfgSection = "";
  if (places.length) {
    const items = places
      .map((p) => {
        const region = regionByCode.get(p.region);
        const country = countryByCC.get(p.cc);
        const label = p.label || country?.name || "Location not specified";
        // Skip a link whose text just repeats the label — a country-precision
        // plant would otherwise read "China (China)".
        const links = [];
        if (region && region.name !== label) {
          links.push(`<a href="/made-in/usa/${region.slug}">${esc(region.name)}</a>`);
        }
        if (country && country.name !== label) {
          links.push(`<a href="/made-in/${country.slug}">${esc(country.name)}</a>`);
        }
        // The label still has to be reachable, so link it directly when it is
        // the only thing we'd otherwise show.
        if (!links.length && country) {
          return `<li><a href="/made-in/${country.slug}">${esc(label)}</a></li>`;
        }
        return `<li>${esc(label)}${links.length ? ` <span class="mi-loc">(${links.join(" · ")})</span>` : ""}</li>`;
      })
      .join("");
    mfgSection = `<h2>Manufacturing locations</h2><ul class="mi-list">${items}</ul>`;
  } else {
    mfgSection = `<h2>Manufacturing locations</h2><p>The catalog doesn't list a manufacturing location for ${esc(name)} yet. That means we don't have one, not that the company manufactures nowhere.</p>`;
  }

  // Organization describes the company; @id and url are OUR page, with the
  // company's own site as sameAs. Claiming their domain as `url` would assert
  // this page is their homepage.
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": canonical,
    name,
    url: canonical,
    ...(tagline ? { description: tagline } : {}),
    ...(domain ? { sameAs: [`https://${domain}`] } : {}),
    // knowsAbout is the honest property for "what this organisation deals in".
    // Deliberately NOT makesOffer/Product: we hold keyword terms, not offers
    // with prices and availability, and asserting Product entities we can't
    // back would be structured data that misrepresents the page.
    //
    // Products only — never the industries lever. Structured data is a machine
    // -readable assertion about the company, so publishing retrieval tuning
    // there is worse than printing it, not better.
    ...(products.length ? { knowsAbout: products.slice(0, 24) } : {}),
    // aggregateRating only where reviews exist to support it — Google requires
    // the rating to be visible on the page, which it is, in the facts list.
    ...(facets?.stars != null && facets.reviews > 0
      ? {
          aggregateRating: {
            "@type": "AggregateRating",
            ratingValue: facets.stars,
            reviewCount: facets.reviews,
            bestRating: 5,
            worstRating: 1,
          },
        }
      : {}),
    ...(hqLabel || hqName
      ? {
          address: {
            "@type": "PostalAddress",
            ...(hqLabel ? { name: hqLabel } : {}),
            ...(row[I.hqCC] ? { addressCountry: row[I.hqCC] } : {}),
          },
        }
      : {}),
  };

  const body = `
<nav class="mi-crumb"><a href="/">Tabarnam</a> / ${esc(name)}</nav>
<h1>Where is ${esc(name)} made?</h1>
${tagline ? `<p class="mi-lead">${esc(tagline)}</p>` : ""}
<p class="mi-lead">${
    mfgNames.length
      ? `${esc(name)} manufactures in ${joinProse(countryLinks(mfgCCs)) || esc(joinProse(mfgNames))}`
      : `The Tabarnam catalog doesn't list a manufacturing location for ${esc(name)} yet`
  }${hqLabel || hqName ? `, and is headquartered in ${esc(hqLabel || hqName)}` : ""}.</p>
${facts.length ? `<dl class="mi-facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>` : ""}
${mfgSection}
${productsSection}
<h2>About this listing</h2>
<p>Headquarters and manufacturing are recorded separately, because they are
often different places: a brand headquartered in one country frequently
manufactures in another. Tabarnam lists what the catalog holds and marks the
rest unknown. Entries come from public sources and may be incomplete or out of
date — production moves.</p>
<p><a href="/results?q=${encodeURIComponent(name)}">Search ${esc(name)} on Tabarnam</a> · <a href="/made-in">Browse companies by country</a></p>`;

  // Two levels, matching the visible <nav>: the company page hangs off the
  // site root, not off a place — a company with plants in three countries has
  // no single parent to claim.
  const crumbs = breadcrumbList([
    { name: "Tabarnam", path: "/" },
    { name, path: `/company/${slug}` },
  ]);

  return { title, description, canonical, jsonLd: [jsonLd, crumbs].filter(Boolean), body };
}

/** Real 404 for a slug we don't publish — never a soft redirect to home. */
function notFoundPage(slug) {
  return {
    title: "Company not found | Tabarnam",
    description: "This company page doesn't exist on Tabarnam.",
    canonical: `${ORIGIN}/company`,
    robots: "noindex, follow",
    jsonLd: null,
    body: `
<h1>Company not found</h1>
<p class="mi-lead">There's no company at <code>/company/${esc(slug)}</code>.</p>
<p><a href="/">Search the Tabarnam catalog</a> · <a href="/made-in">Browse companies by country</a></p>`,
  };
}

/**
 * Build the response for a /company URL.
 * @returns {{status: number, headers: object, body?: string}} status 0 means
 *   "declined — serve the SPA shell instead".
 */
async function renderCompany(pathname, container, log = console) {
  const route = resolveCompanyPath(pathname);
  if (!route) return { status: 404, headers: { "Cache-Control": "no-store" } };

  if (route.kind === "redirect") {
    return { status: 301, headers: { Location: route.to, "Cache-Control": "public, max-age=3600" } };
  }
  if (route.kind === "index") {
    // No company directory exists; search is the real entry point. 302 rather
    // than 301 so introducing one later isn't fighting a cached permanent.
    return { status: 302, headers: { Location: "/", "Cache-Control": "public, max-age=300" } };
  }

  const index = await getCompanyIndex(container);
  if (!index) return { status: 0, headers: {} };

  const row = index.bySlug.get(route.slug);
  if (!row) {
    // A pasted website URL is a natural way to reach a company page, and the
    // domain is reliable identity where the name is not — so /company/acme.com
    // sends you to the canonical slug rather than a dead end.
    const byDomain = index.byDomain.get(route.slug);
    if (byDomain && byDomain[I.slug]) {
      return {
        status: 301,
        headers: { Location: `/company/${byDomain[I.slug]}`, "Cache-Control": "public, max-age=86400" },
      };
    }
    const shell404 = await getShell(log);
    const page = notFoundPage(route.slug);
    return {
      ...htmlResponse(injectIntoShell(shell404, page) || standaloneDocument(page)),
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" },
    };
  }

  // Enrichment, so a cold or failed facets blob costs the page its products
  // list and nothing else.
  const facetsById = await getFacetsById(container, log);
  const page = companyPage(row, facetsById?.get(row[I.id]) || null);
  const shell = await getShell(log);
  return htmlResponse(injectIntoShell(shell, page) || standaloneDocument(page));
}

module.exports = {
  renderCompany,
  // exported for tests
  resolveCompanyPath,
  buildIndex,
  companyPage,
  notFoundPage,
  manufacturingPlaces,
  joinProse,
  I,
};
