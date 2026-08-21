const test = require("node:test");
const assert = require("node:assert/strict");

const { assignSlugs, slugify, domainLabel } = require("./_companySlug");

// [id, name, tagline, domain, …] with slug written to index 12.
function row(id, name, domain) {
  return [id, name, "", domain, null, null, [], null, [], null, [], null];
}
const slugOf = (rows, name) => rows.find((r) => r[1] === name)?.[12];

test("slugify produces readable, URL-safe slugs", () => {
  assert.equal(slugify("Topo Athletic"), "topo-athletic");
  assert.equal(slugify("Boll & Branch"), "boll-and-branch");
  assert.equal(slugify("Ken's Foods"), "ken-s-foods");
  assert.equal(slugify("  Dr. Squatch  "), "dr-squatch");
  assert.equal(slugify("Café Möller"), "cafe-moller");
  assert.equal(slugify("(512) Brewing Company"), "512-brewing-company");
});

test("slugify never emits a leading, trailing or doubled separator", () => {
  for (const input of ["--weird--", "!!!", "a & b", "  ", "///x///"]) {
    const s = slugify(input);
    assert.doesNotMatch(s, /^-|-$|--/, `"${input}" → "${s}"`);
  }
});

test("slugify caps length without leaving a dangling hyphen", () => {
  const s = slugify("The Extremely Long Name Of A Company That Goes On And On And On Forever And Ever");
  assert.ok(s.length <= 70);
  assert.doesNotMatch(s, /-$/);
});

test("an uncontested name gets the plain slug", () => {
  const rows = [row("company_1", "Topo Athletic", "topoathletic.com")];
  assignSlugs(rows);
  assert.equal(rows[0][12], "topo-athletic");
});

test("every slug in a catalog is unique", () => {
  const rows = [
    row("company_1", "Eclipse", "eclipseglove.com"),
    row("company_2", "Eclipse", "eclipsemints.com.au"),
    row("company_3", "Quince", "quince.com"),
    row("company_4", "Lowercase", "lacausa.com"),
    row("company_5", "Lowercase", "lowercasenyc.com"),
  ];
  assignSlugs(rows);
  const slugs = rows.map((r) => r[12]);
  assert.equal(new Set(slugs).size, slugs.length);
  assert.ok(slugs.every(Boolean));
});

test("the oldest company keeps the bare slug; a later namesake is suffixed", () => {
  const rows = [
    row("company_1769120635532_a", "Eclipse", "eclipseglove.com"),
    row("company_1799999999999_b", "Eclipse", "eclipsemints.com.au"),
  ];
  assignSlugs(rows);
  assert.equal(slugOf(rows, "Eclipse"), "eclipse"); // first match = oldest
  assert.deepEqual(rows.map((r) => r[12]).sort(), ["eclipse", "eclipse-eclipsemints"]);
});

test("a NEW namesake never displaces an existing company's URL", () => {
  const existing = [row("company_1000000000000_a", "Eclipse", "eclipseglove.com")];
  assignSlugs(existing);
  const before = existing[0][12];

  const withNewcomer = [
    row("company_1000000000000_a", "Eclipse", "eclipseglove.com"),
    row("company_1999999999999_z", "Eclipse", "eclipsemints.com.au"),
  ];
  assignSlugs(withNewcomer);
  assert.equal(withNewcomer[0][12], before, "the incumbent URL must not move");
});

test("assignment is order-independent and deterministic", () => {
  const build = () => [
    row("company_3", "Eclipse", "eclipsemints.com.au"),
    row("company_1", "Eclipse", "eclipseglove.com"),
    row("company_2", "Quince", "quince.com"),
  ];
  const a = build();
  const b = build().reverse();
  assignSlugs(a);
  assignSlugs(b);
  const pick = (rows, id) => rows.find((r) => r[0] === id)[12];
  for (const id of ["company_1", "company_2", "company_3"]) {
    assert.equal(pick(a, id), pick(b, id), id);
  }
});

test("re-running assignment on the same data changes nothing (idempotent)", () => {
  const rows = [
    row("company_1", "Eclipse", "eclipseglove.com"),
    row("company_2", "Eclipse", "eclipsemints.com.au"),
  ];
  assignSlugs(rows);
  const first = rows.map((r) => r[12]);
  assignSlugs(rows);
  assert.deepEqual(rows.map((r) => r[12]), first);
});

test("a company with a unique name never loses its slug to another's tie-break", () => {
  // "eclipse-eclipsemints" exists as a real company name in its own right.
  const rows = [
    row("company_1", "Eclipse", "eclipseglove.com"),
    row("company_2", "Eclipse", "eclipsemints.com.au"),
    row("company_0", "Eclipse Eclipsemints", "someoneelse.com"),
  ];
  assignSlugs(rows);
  assert.equal(slugOf(rows, "Eclipse Eclipsemints"), "eclipse-eclipsemints");
  const slugs = rows.map((r) => r[12]);
  assert.equal(new Set(slugs).size, 3);
});

test("true duplicates — same name AND domain — still get distinct slugs", () => {
  const rows = [
    row("company_1", "PS Audio", "psaudio.com"),
    row("company_2", "PS Audio", "psaudio.com"),
    row("company_3", "PS Audio", "psaudio.com"),
  ];
  assignSlugs(rows);
  const slugs = rows.map((r) => r[12]);
  assert.equal(new Set(slugs).size, 3);
  assert.equal(slugs[0], "ps-audio");
  assert.ok(slugs.every((s) => s.startsWith("ps-audio")));
});

test("a company with no usable name is skipped rather than given an empty slug", () => {
  const rows = [row("company_1", "", "x.com"), row("company_2", "!!!", "y.com"), row("company_3", "Real", "z.com")];
  assignSlugs(rows);
  assert.equal(rows[0][12], undefined);
  assert.equal(rows[1][12], undefined);
  assert.equal(rows[2][12], "real");
});

test("a missing domain degrades to a numeric suffix instead of throwing", () => {
  const rows = [row("company_1", "Nameless", ""), row("company_2", "Nameless", "")];
  assignSlugs(rows);
  assert.deepEqual(rows.map((r) => r[12]), ["nameless", "nameless-2"]);
});

test("domainLabel takes the first label of a multi-part host", () => {
  assert.equal(domainLabel("eclipsemints.com.au"), "eclipsemints");
  assert.equal(domainLabel("drsquatch.com"), "drsquatch");
  assert.equal(domainLabel(""), "");
});
