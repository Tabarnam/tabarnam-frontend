const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveCompanyPath,
  buildIndex,
  companyPage,
  notFoundPage,
  manufacturingPlaces,
  joinProse,
} = require("./_companyRender");

// v6 pins row: [id, name, tagline, domain, hqLat, hqLng, mfg[], hqCC, mfgCCs[],
// hqRegion, mfgRegions[], hqLabel, slug]; mfg pin = [lat,lng,lowPrec,cc,region,label]
function row({
  id = "company_1",
  name = "Acme",
  tagline = "",
  domain = "acme.com",
  mfg = [],
  hqCC = "US",
  hqRegion = "US-CA",
  hqLabel = "Marina del Rey, CA",
  slug = "acme",
} = {}) {
  return [
    id, name, tagline, domain, 0, 0,
    mfg.map((m) => [1, 2, 0, m.cc || null, m.region || null, m.label || null]),
    hqCC,
    [...new Set(mfg.map((m) => m.cc).filter(Boolean))],
    hqRegion,
    [...new Set(mfg.map((m) => m.region).filter(Boolean))],
    hqLabel,
    slug,
  ];
}

test("joinProse reads as English", () => {
  assert.equal(joinProse([]), "");
  assert.equal(joinProse(["USA"]), "USA");
  assert.equal(joinProse(["USA", "Vietnam"]), "USA and Vietnam");
  assert.equal(joinProse(["USA", "Vietnam", "Italy"]), "USA, Vietnam and Italy");
});

test("resolveCompanyPath maps the /company tree", () => {
  assert.deepEqual(resolveCompanyPath("/company"), { kind: "index" });
  assert.deepEqual(resolveCompanyPath("/company/"), { kind: "index" });
  assert.deepEqual(resolveCompanyPath("/company/dr-squatch"), { kind: "company", slug: "dr-squatch" });
  assert.deepEqual(resolveCompanyPath("/company/DR-SQUATCH"), { kind: "company", slug: "dr-squatch" });
  assert.deepEqual(resolveCompanyPath("/company/a/b"), { kind: "redirect", to: "/company" });
  assert.equal(resolveCompanyPath("/made-in/usa"), null);
  assert.equal(resolveCompanyPath("/results"), null);
});

test("buildIndex keys by slug and by domain", () => {
  const { bySlug, byDomain } = buildIndex({
    companies: [row({ slug: "acme", domain: "acme.com" }), row({ id: "c2", slug: "beta", domain: "beta.io" })],
  });
  assert.equal(bySlug.get("acme")[1], "Acme");
  assert.equal(byDomain.get("beta.io")[12], "beta");
});

test("buildIndex gives a duplicated domain to the row holding the bare slug", () => {
  const { byDomain } = buildIndex({
    companies: [
      row({ id: "company_1", slug: "ps-audio", domain: "psaudio.com" }),
      row({ id: "company_2", slug: "ps-audio-2", domain: "psaudio.com" }),
    ],
  });
  assert.equal(byDomain.get("psaudio.com")[12], "ps-audio");
});

test("manufacturingPlaces dedupes identical plants", () => {
  const r = row({
    mfg: [
      { cc: "US", region: "US-OH", label: "Akron, OH" },
      { cc: "US", region: "US-OH", label: "Akron, OH" },
      { cc: "VN", label: "Hanoi" },
    ],
  });
  assert.deepEqual(manufacturingPlaces(r).map((p) => p.label), ["Akron, OH", "Hanoi"]);
});

test("the title targets the question people type", () => {
  const page = companyPage(
    row({ name: "Dr. Squatch", slug: "dr-squatch", mfg: [{ cc: "US", label: "Marina del Rey, CA" }] })
  );
  assert.equal(page.title, "Where Is Dr. Squatch Made? Manufacturing in USA | Tabarnam");
  assert.match(page.body, /<h1>Where is Dr\. Squatch made\?<\/h1>/);
});

test("a company with no verified manufacturing says so instead of implying none", () => {
  const page = companyPage(row({ name: "Quiet Co", slug: "quiet-co", mfg: [] }));
  assert.match(page.title, /^Where Is Quiet Co Made\? Headquarters and Manufacturing/);
  assert.match(page.body, /hasn't verified where Quiet Co manufactures yet/);
  assert.match(page.body, /Absence here means unverified/);
});

test("the description states HQ and manufacturing as separate facts", () => {
  const page = companyPage(
    row({
      name: "Topo Athletic",
      slug: "topo-athletic",
      hqLabel: "Newton, MA",
      mfg: [{ cc: "CN", label: "China" }, { cc: "VN", label: "Vietnam" }],
    })
  );
  assert.match(page.description, /headquartered in Newton, MA/);
  assert.match(page.description, /manufactures in China and Vietnam/);
});

test("every manufacturing place links back to its /made-in pages", () => {
  const page = companyPage(
    row({ mfg: [{ cc: "US", region: "US-OH", label: "Akron, OH" }, { cc: "IT", label: "Milan" }] })
  );
  assert.match(page.body, /href="\/made-in\/usa\/ohio"/);
  assert.match(page.body, /href="\/made-in\/italy"/);
  assert.match(page.body, /href="\/made-in\/usa"/);
});

test("a country-precision plant reads 'China', never 'China (China)'", () => {
  const page = companyPage(row({ mfg: [{ cc: "CN", label: "China" }] }));
  assert.doesNotMatch(page.body, /China <span class="mi-loc">/);
  // The label still has to be reachable, so it becomes the link itself.
  assert.match(page.body, /<li><a href="\/made-in\/china">China<\/a><\/li>/);
});

test("a city-precision plant keeps both place links alongside its label", () => {
  const page = companyPage(row({ mfg: [{ cc: "US", region: "US-OH", label: "Akron, OH" }] }));
  assert.match(page.body, /Akron, OH <span class="mi-loc">\(<a href="\/made-in\/usa\/ohio">Ohio<\/a> · <a href="\/made-in\/usa">USA<\/a>\)<\/span>/);
});

test("canonical is the slug URL and JSON-LD claims our page, not theirs", () => {
  const page = companyPage(row({ name: "Acme", slug: "acme", domain: "acme.com" }));
  assert.equal(page.canonical, "https://tabarnam.com/company/acme");
  assert.equal(page.jsonLd["@type"], "Organization");
  // url/@id must be OUR page; their site is sameAs. Claiming their domain as
  // `url` would assert this page is their homepage.
  assert.equal(page.jsonLd.url, "https://tabarnam.com/company/acme");
  assert.equal(page.jsonLd["@id"], "https://tabarnam.com/company/acme");
  assert.deepEqual(page.jsonLd.sameAs, ["https://acme.com"]);
});

test("the outbound site link is nofollow — 14k of them is not an endorsement graph", () => {
  const page = companyPage(row({ domain: "acme.com" }));
  assert.match(page.body, /href="https:\/\/acme\.com" rel="noopener nofollow"/);
});

test("a company name cannot inject markup", () => {
  const page = companyPage(row({ name: '<script>alert(1)</script>', tagline: '"><img src=x>' }));
  assert.doesNotMatch(page.body, /<script>alert/);
  assert.match(page.body, /&lt;script&gt;alert/);
  assert.doesNotMatch(page.body, /<img src=x>/);
});

test("an unknown slug is a real 404 page, not a soft redirect", () => {
  const page = notFoundPage("nope");
  assert.match(page.title, /Company not found/);
  assert.equal(page.robots, "noindex, follow");
  assert.match(page.body, /no company at/i);
  assert.equal(page.jsonLd, null);
});

test("a missing domain simply omits the website row", () => {
  const page = companyPage(row({ domain: "" }));
  assert.doesNotMatch(page.body, /Website/);
  assert.equal(page.jsonLd.sameAs, undefined);
});

// ── facets (industries / products / rating) ─────────────────────────────────

const FACETS = {
  industries: ["Skincare", "Personal Care"],
  products: ["bar soap", "deodorant", "shaving cream"],
  stars: 4,
  reviews: 12,
};

test("facets are enrichment — the page is complete without them", () => {
  const page = companyPage(row({ name: "Acme" }), null);
  assert.match(page.body, /<h1>Where is Acme made\?<\/h1>/);
  assert.doesNotMatch(page.body, /What Acme makes/);
  assert.doesNotMatch(page.body, /Industry/);
  assert.equal(page.jsonLd.knowsAbout, undefined);
  assert.equal(page.jsonLd.aggregateRating, undefined);
});

test("industries and products render when facets are present", () => {
  const page = companyPage(row({ name: "Acme" }), FACETS);
  assert.match(page.body, /<dt>Industry<\/dt><dd>Skincare, Personal Care<\/dd>/);
  assert.match(page.body, /<h2>What Acme makes<\/h2><p>bar soap, deodorant, shaving cream\.<\/p>/);
});

test("knowsAbout carries the terms — never Product entities we can't back", () => {
  const page = companyPage(row(), FACETS);
  assert.deepEqual(page.jsonLd.knowsAbout, [
    "Skincare", "Personal Care", "bar soap", "deodorant", "shaving cream",
  ]);
  assert.equal(page.jsonLd.makesOffer, undefined);
});

test("knowsAbout is capped so structured data can't become a term dump", () => {
  const page = companyPage(row(), {
    industries: Array.from({ length: 12 }, (_, i) => `Ind${i}`),
    products: Array.from({ length: 20 }, (_, i) => `Prod${i}`),
    stars: null,
    reviews: 0,
  });
  assert.equal(page.jsonLd.knowsAbout.length, 24);
});

test("a rating is cited only when reviews back it", () => {
  const rated = companyPage(row(), FACETS);
  assert.match(rated.body, /<dt>Tabarnam rating<\/dt><dd>4 \/ 5 <span class="mi-loc">from 12 reviews<\/span>/);
  assert.equal(rated.jsonLd.aggregateRating.ratingValue, 4);
  assert.equal(rated.jsonLd.aggregateRating.reviewCount, 12);

  // Stars with nothing behind them: no claim on the page, no claim in schema.
  const unbacked = companyPage(row(), { ...FACETS, reviews: 0 });
  assert.doesNotMatch(unbacked.body, /Tabarnam rating/);
  assert.equal(unbacked.jsonLd.aggregateRating, undefined);
});

test("one review reads as singular", () => {
  const page = companyPage(row(), { ...FACETS, reviews: 1 });
  assert.match(page.body, /from 1 review<\/span>/);
  assert.doesNotMatch(page.body, /from 1 reviews/);
});

test("facet terms are escaped like everything else", () => {
  const page = companyPage(row(), {
    industries: ['<img src=x onerror=1>'],
    products: ['"><script>alert(1)</script>'],
    stars: null,
    reviews: 0,
  });
  assert.doesNotMatch(page.body, /<img src=x/);
  assert.doesNotMatch(page.body, /<script>alert/);
  assert.match(page.body, /&lt;img src=x/);
});
