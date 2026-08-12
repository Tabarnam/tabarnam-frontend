const test = require("node:test");
const assert = require("node:assert");

const { pickNearbyBand } = require("./_geoRank");
const { resolveGeoScope } = require("./search-companies/index")._test;

const MI = 1.609344;

/** ranked entries at the given mile distances, ids a,b,c,... */
function rankedAt(...miles) {
  return miles.map((mi, i) => ({ id: String.fromCharCode(97 + i), km: mi * MI }));
}

test("nearby stops at the tightest band that holds enough companies", () => {
  // 30 companies inside 10 mi: the first band already qualifies.
  const ranked = rankedAt(...Array.from({ length: 30 }, (_, i) => 1 + i * 0.2));
  const band = pickNearbyBand(ranked, new Set(), { unit: "mi" });
  assert.strictEqual(band.radius, 10);
  assert.strictEqual(band.ids.length, 30);
});

test("nearby reaches further when the near bands are thin", () => {
  // Two companies close by, the rest 40 mi out: 10 and 25 mi are too thin.
  const ranked = rankedAt(2, 5, ...Array.from({ length: 30 }, () => 40));
  const band = pickNearbyBand(ranked, new Set(), { unit: "mi" });
  assert.strictEqual(band.radius, 50);
  assert.strictEqual(band.ids.length, 32);
});

test("a sparse region returns the widest band rather than nothing", () => {
  const ranked = rankedAt(200, 240);
  const band = pickNearbyBand(ranked, new Set(), { unit: "mi" });
  assert.strictEqual(band.radius, 250);
  assert.strictEqual(band.ids.length, 2);
});

test("nearby excludes companies already counted as in-scope", () => {
  const ranked = rankedAt(1, 2, 3, 4);
  const band = pickNearbyBand(ranked, new Set(["a", "c"]), { unit: "mi" });
  assert.deepStrictEqual(band.ids, ["b", "d"]);
});

test("bands are round numbers in the requested unit", () => {
  const ranked = [{ id: "a", km: 20 }, { id: "b", km: 30 }];
  const band = pickNearbyBand(ranked, new Set(), { unit: "km", minCount: 1 });
  assert.strictEqual(band.unit, "km");
  assert.strictEqual(band.radius, 25); // 25 KM, not 25 mi: 20km in, 30km out
  assert.deepStrictEqual(band.ids, ["a"]);
  // The same distances in miles fall inside the 25-MILE band, which is wider.
  const mi = pickNearbyBand(ranked, new Set(), { unit: "mi", minCount: 1 });
  assert.strictEqual(mi.radius, 25);
  assert.deepStrictEqual(mi.ids, ["a", "b"]);
});

// --- resolveGeoScope -------------------------------------------------------

const scopeSets = () => ({
  cityMfg: new Map([["US|san dimas", new Set(["a", "b"])]]),
  cityHq: new Map(),
  regionMfg: new Map([["US-CA", new Set(["a", "b", "c", "d"])]]),
  regionHq: new Map(),
});

const deps = (overrides = {}) => ({
  getScopeSets: async () => scopeSets(),
  getCountrySets: async () => ({ mfg: () => null, hq: () => null }),
  ...overrides,
});

test("in-scope companies come first, nearby after, both distance-ordered", async () => {
  const ranked = rankedAt(1, 2, 3, 4, 5); // a,b,c,d,e
  const out = await resolveGeoScope({
    container: {}, ranked, mode: "manu", unit: "mi",
    want: { city: "San Dimas", country: "US" }, deps: deps(),
  });
  assert.strictEqual(out.level, "city");
  assert.strictEqual(out.scopedCount, 2);
  assert.deepStrictEqual(out.orderedIds.slice(0, 2), ["a", "b"]);
  // Everything else falls into nearby, in distance order.
  assert.deepStrictEqual(out.orderedIds.slice(2), ["c", "d", "e"]);
});

test("a region scope large enough to stand alone gets no nearby band", async () => {
  // 30 companies in CA -> past SCOPE_STANDS_ALONE, and a region centroid is
  // the wrong origin for a "nearby" circle anyway.
  const ids = new Set(Array.from({ length: 30 }, (_, i) => `r${i}`));
  const ranked = Array.from({ length: 40 }, (_, i) => ({
    id: i < 30 ? `r${i}` : `x${i}`,
    km: i,
  }));
  const out = await resolveGeoScope({
    container: {}, ranked, mode: "manu", unit: "mi",
    want: { region: "US-CA" },
    deps: deps({ getScopeSets: async () => ({ ...scopeSets(), regionMfg: new Map([["US-CA", ids]]) }) }),
  });
  assert.strictEqual(out.level, "region");
  assert.strictEqual(out.nearby, null);
  assert.strictEqual(out.orderedIds.length, 30);
});

test("a thin scope still gets a nearby band whatever its level", async () => {
  const ranked = rankedAt(1, 2, 3, 4, 5);
  const out = await resolveGeoScope({
    container: {}, ranked, mode: "manu", unit: "mi",
    want: { region: "US-CA" }, deps: deps(),
  });
  // Only 4 companies in the region — below the stands-alone floor.
  assert.strictEqual(out.level, "region");
  assert.ok(out.nearby);
  assert.deepStrictEqual(out.nearby.ids, ["e"]);
});

test("country scope reads the country index, not city labels", async () => {
  const ranked = rankedAt(1, 2, 3);
  const out = await resolveGeoScope({
    container: {}, ranked, mode: "manu", unit: "mi",
    want: { country: "IT" },
    deps: deps({ getCountrySets: async () => ({ mfg: (cc) => (cc === "IT" ? new Set(["b"]) : null), hq: () => null }) }),
  });
  assert.strictEqual(out.level, "country");
  assert.strictEqual(out.scopedCount, 1);
  assert.deepStrictEqual(out.orderedIds[0], "b");
});

test("no scope inputs leaves the ranking untouched", async () => {
  const out = await resolveGeoScope({
    container: {}, ranked: rankedAt(1, 2), mode: "manu", unit: "mi",
    want: {}, deps: deps(),
  });
  assert.strictEqual(out, null);
});

test("a cold index degrades to the plain ranking instead of throwing", async () => {
  let seen = null;
  const out = await resolveGeoScope({
    container: {}, ranked: rankedAt(1, 2), mode: "manu", unit: "mi",
    want: { city: "San Dimas", country: "US" },
    onError: (e) => { seen = e; },
    deps: deps({ getScopeSets: async () => { throw new Error("blob cold"); } }),
  });
  assert.strictEqual(out, null);
  assert.match(seen.message, /blob cold/);
});

test("an unmatched city with no region resolves to no scope, not an empty one", async () => {
  const out = await resolveGeoScope({
    container: {}, ranked: rankedAt(1, 2), mode: "manu", unit: "mi",
    want: { city: "Nowhere", country: "US" }, deps: deps(),
  });
  assert.strictEqual(out, null);
});
