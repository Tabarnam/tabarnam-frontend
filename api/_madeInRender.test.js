const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolvePath,
  aggregate,
  injectIntoShell,
  countryPage,
  regionPage,
  indexPage,
  LIST_LIMIT,
} = require("./_madeInRender");

// A compact v5 pins row: [id, name, tagline, domain, hqLat, hqLng, mfg[],
// hqCC, mfgCCs[], hqRegion, mfgRegions[], hqLabel] where each mfg pin is
// [lat, lng, lowPrec01, cc, region, label].
function row(name, { hqCC = null, hqRegion = null, mfg = [] } = {}) {
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
  assert.match(page.description, /^2 companies that manufacture in USA/);
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

test("country page names companies as body text and mirrors them in the ItemList", () => {
  const agg = aggregate(PAYLOAD);
  const page = countryPage({ cc: "US", slug: "usa", name: "USA" }, agg);

  assert.match(page.body, /<li>Acme/);
  assert.match(page.body, /<li>Borealis/);
  assert.doesNotMatch(page.body, /Cyclo/); // manufactures in Vietnam only

  const items = page.jsonLd.mainEntity.itemListElement.map((i) => i.name);
  assert.deepEqual(items, ["Acme", "Borealis"]);
  assert.equal(page.jsonLd.mainEntity.numberOfItems, 2);
});

test("structured data never claims more items than the page shows", () => {
  const many = { companies: [] };
  for (let i = 0; i < LIST_LIMIT + 25; i += 1) {
    many.companies.push(row(`Co${String(i).padStart(4, "0")}`, { mfg: [{ cc: "US" }] }));
  }
  const page = countryPage({ cc: "US", slug: "usa", name: "USA" }, aggregate(many));

  assert.equal(page.jsonLd.mainEntity.numberOfItems, LIST_LIMIT + 25);
  assert.equal(page.jsonLd.mainEntity.itemListElement.length, LIST_LIMIT);
  const listed = (page.body.match(/<li>Co\d{4}/g) || []).length;
  assert.equal(listed, LIST_LIMIT);
  assert.match(page.body, /Showing 250 of 275 companies/);
});

test("an empty place says so instead of rendering a bare zero", () => {
  const page = countryPage({ cc: "IS", slug: "iceland", name: "Iceland" }, aggregate(PAYLOAD));
  assert.match(page.title, /^Made in Iceland — Companies That Manufacture in Iceland/);
  assert.match(page.body, /haven't verified any manufacturers in Iceland yet/);
  assert.equal(page.jsonLd, null);
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
  assert.match(page.body, /<li>Acme/);
  assert.match(page.body, /<li>Borealis/);
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
  assert.match(html, /<li>Acme/);
});

test("injectIntoShell replaces the shell's fallback description rather than duplicating it", () => {
  const page = countryPage({ cc: "US", slug: "usa", name: "USA" }, aggregate(PAYLOAD));
  const html = injectIntoShell(SHELL, page);

  assert.equal((html.match(/name="description"/g) || []).length, 1);
  assert.doesNotMatch(html, /static fallback/);
  assert.equal((html.match(/property="og:title"/g) || []).length, 1);
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

test("injectIntoShell refuses a shell it cannot splice, so we never ship a gutted page", () => {
  const page = countryPage({ cc: "US", slug: "usa", name: "USA" }, aggregate(PAYLOAD));
  assert.equal(injectIntoShell("", page), "");
  assert.equal(injectIntoShell("<html><body>no root, no head</body></html>", page), "");
});
