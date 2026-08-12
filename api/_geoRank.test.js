const test = require("node:test");
const assert = require("node:assert");
const { rankByDistance, haversineKm } = require("./_geoRank");

test("haversineKm: known distances", () => {
  // LA → NYC ≈ 3936 km
  const la = [34.05, -118.24];
  const nyc = [40.71, -74.01];
  const km = haversineKm(la[0], la[1], nyc[0], nyc[1]);
  assert.ok(Math.abs(km - 3936) < 40, `expected ~3936km, got ${Math.round(km)}`);
  assert.equal(Math.round(haversineKm(10, 10, 10, 10)), 0);
});

const origin = { lat: 34.1067, lng: -117.8067 };
const payload = {
  companies: [
    // [id, name, tagline, domain, hqLat, hqLng, mfg[], ...]
    // Sitting on the origin.
    ["near", "Near Co", "", "near.com", 34.1067, -117.8067, []],
    // New York — ~3900km.
    ["far", "Far Co", "", "far.com", 40.71, -74.01, []],
    // HQ in London (~8800km) but a plant ~12km from the origin.
    ["mfgnear", "Mfg Near", "", "m.com", 51.5, -0.12, [[34.2, -117.9, 0, "US", "US-CA"]]],
    ["nocoords", "No Coords", "", "n.com", null, null, []],
  ],
};

test("rankByDistance: orders by true distance, nearest first", () => {
  const ranked = rankByDistance(payload, origin, "manu");
  assert.deepEqual(ranked.map((r) => r.id), ["near", "mfgnear", "far"]);
  assert.ok(ranked[0].km < 1, "a company on the origin should be ~0km away");
});

test("rankByDistance: manu mode counts manufacturing sites, hq mode does not", () => {
  const manu = rankByDistance(payload, origin, "manu");
  const hq = rankByDistance(payload, origin, "hq");
  // manu mode: the London company ranks 2nd on the strength of its plant…
  assert.equal(manu[1].id, "mfgnear");
  assert.ok(manu[1].km < 20);
  // …but in HQ mode only its London office counts, so it falls behind NY.
  assert.deepEqual(hq.map((r) => r.id), ["near", "far", "mfgnear"]);
});

test("rankByDistance: skips companies with no usable coordinates", () => {
  const ids = rankByDistance(payload, origin, "manu").map((r) => r.id);
  assert.ok(!ids.includes("nocoords"));
});

test("rankByDistance: tolerates junk input", () => {
  assert.deepEqual(rankByDistance(null, origin), []);
  assert.deepEqual(rankByDistance(payload, { lat: NaN, lng: 1 }), []);
  assert.deepEqual(rankByDistance({ companies: ["junk", []] }, origin), []);
});

test("rankByDistance: ties are broken deterministically by id", () => {
  const same = {
    companies: [
      ["b", "B", "", "", 34.1, -117.8, []],
      ["a", "A", "", "", 34.1, -117.8, []],
    ],
  };
  assert.deepEqual(rankByDistance(same, origin).map((r) => r.id), ["a", "b"]);
});
