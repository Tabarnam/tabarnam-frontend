const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolvePath,
  aggregate,
  injectIntoShell,
  countryPage,
  regionPage,
  indexPage,
  getShell,
  _resetShellCache,
  LIST_LIMIT,
} = require("./_madeInRender");

const QUIET = { warn() {} };

/**
 * Stubs the two URLs getShell fetches. `state` is mutated by the test to
 * simulate a frontend deploy landing between requests.
 */
function stubFetch(state) {
  const original = globalThis.fetch;
  const calls = { buildId: 0, shell: 0 };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("__build_id.txt")) {
      calls.buildId += 1;
      if (state.buildIdFails) throw new Error("network down");
      return { ok: true, text: async () => state.buildId };
    }
    calls.shell += 1;
    if (state.shellFails) throw new Error("network down");
    return { ok: true, text: async () => `<div id="root"></div><script src="/assets/index-${state.buildId}.js"></script>` };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

// A compact v5 pins row: [id, name, tagline, domain, hqLat, hqLng, mfg[],
// hqCC, mfgCCs[], hqRegion, mfgRegions[], hqLabel] where each mfg pin is
// [lat, lng, lowPrec01, cc, region, label].
function row(name, { hqCC = null, hqRegion = null, mfg = [], slug = undefined } = {}) {
  return [
    `id_${name}`,
    name,
    "",
    `${name.toLowerCase()}.com`,
    0,
    0,
    mfg.map((m) => [1, 2, 0, m.cc || null, m.region || null, m.label || null]),
    hqCC,
    [...new Set(mfg.map((m) => m.cc).filter(Boolean))],
    hqRegion,
    [...new Set(mfg.map((m) => m.region).filter(Boolean))],
    "HQ City",
    slug === undefined ? name.toLowerCase().replace(/[^a-z0-9]+/g, "-") : slug,
  ];
}

const PAYLOAD = {
  companies: [
    row("Acme", {
      hqCC: "US",
      hqRegion: "US-CA",
      mfg: [
        { cc: "US", region: "US-OH", label: "Akron, OH" },
        { cc: "VN", label: "Hanoi" },
      ],
    }),
    row("Borealis", { hqCC: "CA", mfg: [{ cc: "US", region: "US-OH", label: "Toledo, OH" }] }),
    row("Cyclo", { hqCC: "US", hqRegion: "US-CA", mfg: [{ cc: "VN", label: "Da Nang" }] }),
  ],
};

test("resolvePath maps the /made-in tree", () => {
  assert.deepEqual(resolvePath("/made-in"), { kind: "index" });
  assert.deepEqual(resolvePath("/made-in/"), { kind: "index" });
  assert.deepEqual(resolvePath("/made-in/usa"), { kind: "country", slug: "usa" });
  assert.deepEqual(resolvePath("/made-in/USA"), { kind: "country", slug: "usa" });
  assert.deepEqual(resolvePath("/made-in/usa/california"), { kind: "region", slug: "california" });
  assert.deepEqual(resolvePath("/made-in/usa/washington-dc"), {
    kind: "region",
    slug: "washington-dc",
  });
});

test("resolvePath 301s aliases to the canonical slug, matching the client router", () => {
  assert.deepEqual(resolvePath("/made-in/united-states"), {
    kind: "redirect",
    to: "/made-in/usa",
  });
  assert.deepEqual(resolvePath("/made-in/czechia"), {
    kind: "redirect",
    to: "/made-in/czech-republic",
  });
});

test("resolvePath sends unknown slugs to the directory rather than 404ing", () => {
  assert.deepEqual(resolvePath("/made-in/atlantis"), { kind: "redirect", to: "/made-in" });
  assert.deepEqual(resolvePath("/made-in/usa/west-atlantis"), {
    kind: "redirect",
    to: "/made-in/usa",
  });
});

test("resolvePath ignores non-/made-in paths", () => {
  assert.equal(resolvePath("/results"), null);
  assert.equal(resolvePath("/about"), null);
});

test("aggregate counts manufacturing and HQ separately", () => {
  const { countries, regions } = aggregate(PAYLOAD);

  // Acme + Borealis manufacture in the US; Cyclo does not.
  assert.deepEqual(
    countries.get("US").mfg.map((e) => e.name),
    ["Acme", "Borealis"]
  );
  // Acme and Cyclo are HQ'd in the US, Borealis in Canada.
  assert.equal(countries.get("US").hqCount, 2);
  assert.equal(countries.get("CA").hqCount, 1);
  // Canada has no manufacturing in this fixture, only a headquarters.
  assert.equal(countries.get("CA").mfg.length, 0);
  assert.deepEqual(
    countries.get("VN").mfg.map((e) => e.name),
    ["Acme", "Cyclo"]
  );
});

test("aggregate labels a company with the plant in THAT place, not its HQ", () => {
  const { countries, regions } = aggregate(PAYLOAD);
  const acmeUS = countries.get("US").mfg.find((e) => e.name === "Acme");
  const acmeVN = countries.get("VN").mfg.find((e) => e.name === "Acme");
  assert.equal(acmeUS.label, "Akron, OH");
  assert.equal(acmeVN.label, "Hanoi");
  assert.equal(regions.get("US-OH").mfg.find((e) => e.name === "Acme").label, "Akron, OH");
});

test("aggregate counts a company once per place even with several plants there", () => {
  const twoPlants = {
    companies: [
      row("Duplex", {
        mfg: [
          { cc: "US", region: "US-OH", label: "Akron, OH" },
          { cc: "US", region: "US-OH", label: "Dayton, OH" },
        ],
      }),
    ],
  };
  const { countries, regions } = aggregate(twoPlants);
  assert.equal(countries.get("US").mfg.length, 1);
  assert.equal(regions.get("US-OH").mfg.length, 1);
});

test("country page carries the count in the title, description and canonical", () => {
  const agg = aggregate(PAYLOAD);
  const page = countryPage({ cc: "US", slug: "usa", name: "USA" }, agg);

  assert.match(page.title, /^Made in USA — 2 Companies That Manufacture in USA \| Tabarnam$/);
  assert.match(page.description, /^2 companies that manufacture in USA\. Browse the Tabarnam catalog/);
  // No accuracy claim: locations change, and the catalog is not a warranty.
  assert.doesNotMatch(page.description, /verified/i);
  assert.equal(page.canonical, "https://tabarnam.com/made-in/usa");
  // Both HQ and manufacturing counts are stated, because they differ.
  assert.match(page.body, /<strong>2<\/strong> companies in the Tabarnam catalog manufacture in USA/);
  assert.match(page.body, /2 are headquartered here/);
});

test("the lead sentence agrees in number for a single company", () => {
  const solo = { companies: [row("Lonely", { hqCC: "US", mfg: [{ cc: "US" }] })] };
  const page = countryPage({ cc: "US", slug: "usa", name: "USA" }, aggregate(solo));
  assert.match(page.body, /<strong>1<\/strong> company in the Tabarnam catalog manufactures in USA/);
  assert.match(page.body, /1 is headquartered here/);
});

test("the title and description agree in number for a single company", () => {
  // Belize, Zimbabwe, Afghanistan and 8 more shipped reading "1 Companies
  // That Manufacture" — the lead inflected, the headline copy did not.
  const solo = { companies: [row("Lonely", { hqCC: "US", mfg: [{ cc: "US" }] })] };
  const page = countryPage({ cc: "US", slug: "usa", name: "USA" }, aggregate(solo));
  assert.equal(page.title, "Made in USA — 1 Company That Manufactures in USA | Tabarnam");
  assert.match(page.description, /^1 company that manufactures in USA\. Browse the Tabarnam catalog/);
  assert.doesNotMatch(page.title, /1 Companies/);

  const region = regionPage(
    { code: "US-OH", slug: "ohio", name: "Ohio" },
    aggregate({ companies: [row("Solo", { hqCC: "US", mfg: [{ cc: "US", region: "US-OH" }] })] })
  );
  assert.equal(region.title, "Made in Ohio — 1 Company That Manufactures in Ohio | Tabarnam");
  assert.match(region.description, /^1 company that manufactures in Ohio\./);
});

test("a place with no manufacturers keeps the generic plural", () => {
  const page = countryPage({ cc: "IS", slug: "iceland", name: "Iceland" }, aggregate(PAYLOAD));
  assert.match(page.title, /^Made in Iceland — Companies That Manufacture in Iceland/);
  assert.match(page.description, /^Companies that manufacture in Iceland\./);
});

test("every named company links to its own page", () => {
  // This is how /company/<slug> gets discovered and VALUED, rather than merely
  // listed in a sitemap: ~250 links per place page into the company tree.
  const page = countryPage({ cc: "US", slug: "usa", name: "USA" }, aggregate(PAYLOAD));
  assert.match(page.body, /<li><a href="\/company\/acme">Acme<\/a>/);
  assert.match(page.body, /<li><a href="\/company\/borealis">Borealis<\/a>/);
});

test("state pages link their companies too", () => {
  const page = regionPage({ code: "US-OH", slug: "ohio", name: "Ohio" }, aggregate(PAYLOAD));
  assert.match(page.body, /<a href="\/company\/acme">Acme<\/a>/);
  assert.match(page.body, /<a href="\/company\/borealis">Borealis<\/a>/);
});

test("a company without a slug stays plain text — never /company/null", () => {
  // Pre-v6 pins payloads carry no slug.
  const legacy = { companies: [row("Slugless", { mfg: [{ cc: "US" }], slug: "" })] };
  const page = countryPage({ cc: "US", slug: "usa", name: "USA" }, aggregate(legacy));
  assert.match(page.body, /<li>Slugless<\/li>/);
  assert.doesNotMatch(page.body, /\/company\//);
});

test("the company link carries the name, and the place label stays outside it", () => {
  const page = countryPage({ cc: "US", slug: "usa", name: "USA" }, aggregate(PAYLOAD));
  assert.match(
    page.body,
    /<li><a href="\/company\/acme">Acme<\/a> <span class="mi-loc">Akron, OH<\/span><\/li>/
  );
});

test("country page names companies as body text and mirrors them in the ItemList", () => {
  const agg = aggregate(PAYLOAD);
  const page = countryPage({ cc: "US", slug: "usa", name: "USA" }, agg);

  assert.match(page.body, /<li><a href="\/company\/acme">Acme</);
  assert.match(page.body, /<li><a href="\/company\/borealis">Borealis</);
  assert.doesNotMatch(page.body, /Cyclo/); // manufactures in Vietnam only

  const items = collectionOf(page).mainEntity.itemListElement.map((i) => i.name);
  assert.deepEqual(items, ["Acme", "Borealis"]);
  assert.equal(collectionOf(page).mainEntity.numberOfItems, 2);
});

test("structured data never claims more items than the page shows", () => {
  const many = { companies: [] };
  for (let i = 0; i < LIST_LIMIT + 25; i += 1) {
    many.companies.push(row(`Co${String(i).padStart(4, "0")}`, { mfg: [{ cc: "US" }] }));
  }
  const page = countryPage({ cc: "US", slug: "usa", name: "USA" }, aggregate(many));

  assert.equal(collectionOf(page).mainEntity.numberOfItems, LIST_LIMIT + 25);
  assert.equal(collectionOf(page).mainEntity.itemListElement.length, LIST_LIMIT);
  const listed = (page.body.match(/<li><a href="\/company\/co\d{4}">Co\d{4}<\/a>/g) || []).length;
  assert.equal(listed, LIST_LIMIT);
  assert.match(page.body, /Showing 250 of 275 companies/);
});

test("an empty place says so instead of rendering a bare zero", () => {
  const page = countryPage({ cc: "IS", slug: "iceland", name: "Iceland" }, aggregate(PAYLOAD));
  assert.match(page.title, /^Made in Iceland — Companies That Manufacture in Iceland/);
  assert.match(page.body, /doesn't list any manufacturers in Iceland yet/);
  // No CollectionPage — there is no collection. The breadcrumb still applies.
  assert.equal(collectionOf(page), undefined);
  assert.ok(crumbsOf(page));
});

test("US country page links every state that has manufacturing", () => {
  const page = countryPage({ cc: "US", slug: "usa", name: "USA" }, aggregate(PAYLOAD));
  assert.match(page.body, /href="\/made-in\/usa\/ohio"/);
  assert.doesNotMatch(page.body, /href="\/made-in\/usa\/california"/); // HQ only, no plants
});

test("state page renders its own canonical and breadcrumb", () => {
  const page = regionPage({ code: "US-OH", slug: "ohio", name: "Ohio" }, aggregate(PAYLOAD));
  assert.equal(page.canonical, "https://tabarnam.com/made-in/usa/ohio");
  assert.match(page.body, /href="\/made-in\/usa"/);
  assert.match(page.body, /<li><a href="\/company\/acme">Acme</);
  assert.match(page.body, /<li><a href="\/company\/borealis">Borealis</);
});

test("index page lists countries with manufacturing, biggest first", () => {
  const page = indexPage(aggregate(PAYLOAD));
  const order = [...page.body.matchAll(/href="\/made-in\/([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["usa", "vietnam"]);
  assert.equal(page.canonical, "https://tabarnam.com/made-in");
});

test("markup is escaped so a company name cannot inject HTML", () => {
  const nasty = {
    companies: [row('<script>alert(1)</script>', { mfg: [{ cc: "US", label: '"onload="x' }] })],
  };
  const page = countryPage({ cc: "US", slug: "usa", name: "USA" }, aggregate(nasty));
  assert.doesNotMatch(page.body, /<script>alert/);
  assert.match(page.body, /&lt;script&gt;alert/);
  assert.doesNotMatch(page.body, /"onload="/);
});

test("JSON-LD escapes angle brackets so it cannot break out of the script tag", () => {
  const nasty = {
    companies: [row("</script><img src=x>", { mfg: [{ cc: "US" }] })],
  };
  const page = countryPage({ cc: "US", slug: "usa", name: "USA" }, aggregate(nasty));
  const { injectIntoShell: inject } = require("./_madeInRender");
  const html = inject(SHELL, page);
  assert.doesNotMatch(html, /<\/script><img/);
  assert.match(html, /\\u003c\/script\\u003e/);
});

// Mirrors the real production shell, including the `crossorigin` attribute
// Vite emits between `type="module"` and `src` and the hashed asset names.
const SHELL = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Tabarnam</title>
    <meta name="description" content="static fallback" />
    <meta property="og:title" content="Tabarnam" />
    <meta property="og:image" content="https://tabarnam.com/tabarnam.png" />
    <script type="module" crossorigin src="/assets/index-DtK6FmWq.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/vendor-react-DtnsZ-Nn.js">
    <link rel="stylesheet" crossorigin href="/assets/index-Dn-PiWXk.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

test("injectIntoShell keeps the app's own script and style tags so React still boots", () => {
  const page = countryPage({ cc: "US", slug: "usa", name: "USA" }, aggregate(PAYLOAD));
  const html = injectIntoShell(SHELL, page);

  assert.match(html, /<script type="module" crossorigin src="\/assets\/index-DtK6FmWq\.js"><\/script>/);
  assert.match(html, /rel="modulepreload" crossorigin href="\/assets\/vendor-react-DtnsZ-Nn\.js"/);
  assert.match(html, /rel="stylesheet" crossorigin href="\/assets\/index-Dn-PiWXk\.css"/);
  assert.match(html, /<title>Made in USA — 2 Companies/);
  assert.match(html, /<link rel="canonical" href="https:\/\/tabarnam\.com\/made-in\/usa"/);
  assert.match(html, /<div id="root"><div class="mi-seo">/);
  assert.match(html, /<li><a href="\/company\/acme">Acme</);
});

test("injectIntoShell replaces the shell's fallback description rather than duplicating it", () => {
  const page = countryPage({ cc: "US", slug: "usa", name: "USA" }, aggregate(PAYLOAD));
  const html = injectIntoShell(SHELL, page);

  assert.equal((html.match(/name="description"/g) || []).length, 1);
  assert.doesNotMatch(html, /static fallback/);
  assert.equal((html.match(/property="og:title"/g) || []).length, 1);
});

// ── breadcrumbs ─────────────────────────────────────────────────────────────
// Without these a search result shows the bare URL. With them it shows a
// clickable trail, so they have to match the visible <nav> on the page.

const collectionOf = (page) =>
  (Array.isArray(page.jsonLd) ? page.jsonLd : [page.jsonLd]).find(
    (b) => b && b["@type"] === "CollectionPage"
  );

const crumbsOf = (page) =>
  (Array.isArray(page.jsonLd) ? page.jsonLd : [page.jsonLd]).find(
    (b) => b && b["@type"] === "BreadcrumbList"
  );

test("a country page carries the trail its <nav> shows", () => {
  const page = countryPage({ cc: "US", slug: "usa", name: "USA" }, aggregate(PAYLOAD));
  const crumbs = crumbsOf(page);
  assert.deepEqual(
    crumbs.itemListElement.map((i) => [i.position, i.name, i.item]),
    [
      [1, "Tabarnam", "https://tabarnam.com/"],
      [2, "Made in", "https://tabarnam.com/made-in"],
      [3, "USA", "https://tabarnam.com/made-in/usa"],
    ]
  );
});

test("a state page nests under its country", () => {
  const page = regionPage({ code: "US-OH", slug: "ohio", name: "Ohio" }, aggregate(PAYLOAD));
  assert.deepEqual(
    crumbsOf(page).itemListElement.map((i) => i.name),
    ["Tabarnam", "Made in", "USA", "Ohio"]
  );
  assert.equal(
    crumbsOf(page).itemListElement[3].item,
    "https://tabarnam.com/made-in/usa/ohio"
  );
});

test("the directory page still gets a two-step trail", () => {
  assert.deepEqual(
    crumbsOf(indexPage(aggregate(PAYLOAD))).itemListElement.map((i) => i.name),
    ["Tabarnam", "Made in"]
  );
});

test("the CollectionPage survives alongside the breadcrumbs", () => {
  const page = countryPage({ cc: "US", slug: "usa", name: "USA" }, aggregate(PAYLOAD));
  assert.ok(Array.isArray(page.jsonLd));
  const types = page.jsonLd.map((b) => b["@type"]).sort();
  assert.deepEqual(types, ["BreadcrumbList", "CollectionPage"]);
});

test("both entities ship in one ld+json block", () => {
  const page = countryPage({ cc: "US", slug: "usa", name: "USA" }, aggregate(PAYLOAD));
  const html = injectIntoShell(SHELL, page);
  assert.equal((html.match(/application\/ld\+json/g) || []).length, 1);
  assert.match(html, /BreadcrumbList/);
  assert.match(html, /CollectionPage/);
});

test("og:image points at the opaque card, never the transparent logo file", () => {
  // tabarnam.png is transparent and 2.2:1, so platforms composite it on their
  // own chrome and crop 240px per side to reach 1.91:1 — straight through the
  // arm. og-card.png is opaque 1200x630 with the mark inset clear of any crop.
  const page = countryPage({ cc: "US", slug: "usa", name: "USA" }, aggregate(PAYLOAD));
  const html = injectIntoShell(SHELL, page);
  assert.match(html, /<meta property="og:image" content="https:\/\/tabarnam\.com\/og-card\.png" \/>/);
  assert.doesNotMatch(html, /og:image" content="[^"]*tabarnam\.png"/);
  assert.match(html, /<meta property="og:image:width" content="1200" \/>/);
  assert.match(html, /<meta property="og:image:height" content="630" \/>/);
});

test("the twitter:* tags the strip removes are restated for THIS page", () => {
  // index.html's twitter tags describe the homepage. Stripping them without
  // re-adding would leave server-rendered pages with a card type and no card.
  const page = countryPage({ cc: "US", slug: "usa", name: "USA" }, aggregate(PAYLOAD));
  const html = injectIntoShell(SHELL, page);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image" \/>/);
  assert.match(html, /<meta name="twitter:image" content="https:\/\/tabarnam\.com\/og-card\.png" \/>/);
  assert.match(html, /<meta name="twitter:title" content="Made in USA — 2 Companies/);
  assert.match(html, /<meta name="twitter:description" content="2 companies that manufacture in USA/);
  for (const tag of ["twitter:card", "twitter:title", "twitter:description", "twitter:image"]) {
    assert.equal((html.match(new RegExp(`name="${tag}"`, "g")) || []).length, 1, tag);
  }
});

test("og:image sub-properties are de-duplicated, not just og:image itself", () => {
  // `property="og:image"` does not match `property="og:image:width"`, so the
  // strip needs the optional suffix group or the document ships two of each.
  const withSubs = SHELL.replace(
    '<meta property="og:image" content="https://tabarnam.com/tabarnam.png" />',
    '<meta property="og:image" content="https://tabarnam.com/og-card.png" />\n    <meta property="og:image:width" content="1200" />\n    <meta property="og:image:height" content="630" />\n    <meta property="og:image:alt" content="Tabarnam" />'
  );
  const page = countryPage({ cc: "US", slug: "usa", name: "USA" }, aggregate(PAYLOAD));
  const html = injectIntoShell(withSubs, page);
  for (const tag of ["og:image", "og:image:width", "og:image:height", "og:image:alt"]) {
    const n = (html.match(new RegExp(`property="${tag}"`, "g")) || []).length;
    assert.equal(n, 1, `${tag} appears ${n} times`);
  }
});

test("injectIntoShell de-duplicates every head tag it restates, across line breaks", () => {
  // index.html writes long meta tags over several lines; the strip has to cope.
  const multiline = SHELL.replace(
    '<meta name="description" content="static fallback" />',
    '<meta\n      name="description"\n      content="static fallback"\n    />\n    <meta property="og:type" content="website" />\n    <meta name="twitter:card" content="summary_large_image" />\n    <meta property="og:site_name" content="Tabarnam" />'
  );
  const page = countryPage({ cc: "US", slug: "usa", name: "USA" }, aggregate(PAYLOAD));
  const html = injectIntoShell(multiline, page);

  for (const tag of ['name="description"', 'property="og:type"', 'name="twitter:card"']) {
    assert.equal((html.match(new RegExp(tag.replace(/"/g, '"'), "g")) || []).length, 1, tag);
  }
  assert.doesNotMatch(html, /static fallback/);
  // Site-wide and still correct — left alone.
  assert.equal((html.match(/property="og:site_name"/g) || []).length, 1);
});

// ── shell caching ───────────────────────────────────────────────────────────
// Regression: the shell was cached on a 15-minute timer. It names hashed asset
// files that a frontend deploy replaces and DELETES, so a shell cached even a
// little too long pointed browsers at /assets/index-<oldhash>.js, which 404'd
// and left React unable to boot. Shipped broken on 2026-08-20.

test("a frontend deploy invalidates the cached shell immediately", async () => {
  _resetShellCache();
  const state = { buildId: "aaaa1111" };
  const { calls, restore } = stubFetch(state);
  try {
    const first = await getShell(QUIET);
    assert.match(first, /index-aaaa1111\.js/);
    assert.equal(calls.shell, 1);

    // Same build: served from cache, no second shell fetch.
    await getShell(QUIET);
    assert.equal(calls.shell, 1);

    // Deploy lands. The very next render must see the new hashes — no window.
    state.buildId = "bbbb2222";
    const after = await getShell(QUIET);
    assert.match(after, /index-bbbb2222\.js/);
    assert.doesNotMatch(after, /index-aaaa1111\.js/);
    assert.equal(calls.shell, 2);
  } finally {
    restore();
  }
});

test("the build id is checked on every render, not memoized", async () => {
  _resetShellCache();
  const state = { buildId: "cccc3333" };
  const { calls, restore } = stubFetch(state);
  try {
    await getShell(QUIET);
    await getShell(QUIET);
    await getShell(QUIET);
    assert.equal(calls.buildId, 3);
    assert.equal(calls.shell, 1); // but the 3.4KB shell is fetched once
  } finally {
    restore();
  }
});

test("an unreachable build id keeps serving the last good shell", async () => {
  _resetShellCache();
  const state = { buildId: "dddd4444" };
  const { restore } = stubFetch(state);
  try {
    await getShell(QUIET);
    state.buildIdFails = true;
    const stale = await getShell(QUIET);
    // Correct when fetched, and the alternative is no app at all.
    assert.match(stale, /index-dddd4444\.js/);
  } finally {
    restore();
  }
});

test("a cold worker that cannot reach anything returns empty, not a broken page", async () => {
  _resetShellCache();
  const { restore } = stubFetch({ buildId: "e", buildIdFails: true, shellFails: true });
  try {
    assert.equal(await getShell(QUIET), "");
  } finally {
    restore();
  }
});

test("a shell without a #root mount is rejected rather than cached", async () => {
  _resetShellCache();
  const original = globalThis.fetch;
  globalThis.fetch = async (url) =>
    String(url).endsWith("__build_id.txt")
      ? { ok: true, text: async () => "ffff6666" }
      : { ok: true, text: async () => "<html><body>maintenance</body></html>" };
  try {
    assert.equal(await getShell(QUIET), "");
  } finally {
    globalThis.fetch = original;
  }
});

test("injectIntoShell refuses a shell it cannot splice, so we never ship a gutted page", () => {
  const page = countryPage({ cc: "US", slug: "usa", name: "USA" }, aggregate(PAYLOAD));
  assert.equal(injectIntoShell("", page), "");
  assert.equal(injectIntoShell("<html><body>no root, no head</body></html>", page), "");
});
