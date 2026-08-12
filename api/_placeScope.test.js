const test = require("node:test");
const assert = require("node:assert");

const { buildSets, resolveScope, normalizeCityKey } = require("./_placeScope");

// Label shapes taken verbatim from the production pins index (2026-08-12).
const payload = {
  companies: [
    // [id, name, tagline, domain, hqLat, hqLng, mfgPins, hqCC, mfgCCs, hqRegion, mfgRegions, hqLabel]
    [
      "sd1", "Immortal Masks", "", "immortalmasks.com", 34.1067, -117.8067,
      [[34.1067, -117.8067, 0, "US", "US-CA", "San Dimas, CA"]],
      "US", ["US"], "US-CA", ["US-CA"], "San Dimas, CA",
    ],
    [
      "sd2", "Second Local", "", "b.com", 34.1067, -117.8067,
      [[34.1067, -117.8067, 0, "US", "US-CA", "San Dimas, CA"]],
      "US", ["US"], "US-CA", ["US-CA"], "San Dimas, CA",
    ],
    [
      "la1", "LA Maker", "", "c.com", 34.0522, -118.2437,
      [[34.0522, -118.2437, 0, "US", "US-CA", "Los Angeles, CA"]],
      "US", ["US"], "US-CA", ["US-CA"], "Los Angeles, CA",
    ],
    // Country-centroid only: no city, must never satisfy a city scope.
    [
      "cn1", "Offshore Co", "", "d.com", 40.7128, -74.006,
      [[35.8617, 104.1954, 1, "CN", null, "China"]],
      "US", ["CN"], "US-NY", [], "New York, NY",
    ],
    // Continental address formats.
    [
      "it1", "Vicenza Works", "", "e.com", 45.5462, 11.5414,
      [[45.5462, 11.5414, 0, "IT", null, "36100 Vicenza, Province of Vicenza"]],
      "IT", ["IT"], null, [], "36100 Vicenza, Province of Vicenza",
    ],
    [
      "it2", "Carpi Textiles", "", "f.com", 44.7828, 10.8853,
      [[44.7828, 10.8853, 0, "IT", null, "41012 Carpi MO, Italy"]],
      "IT", ["IT"], null, [], "41012 Carpi MO, Italy",
    ],
    // Homonym: Florence in two countries must stay separate.
    [
      "fl-us", "Florence Alabama Co", "", "g.com", 34.7998, -87.6773,
      [[34.7998, -87.6773, 0, "US", "US-AL", "Florence, AL"]],
      "US", ["US"], "US-AL", ["US-AL"], "Florence, AL",
    ],
    [
      "fl-it", "Firenze Leather", "", "h.com", 43.7696, 11.2558,
      [[43.7696, 11.2558, 0, "IT", null, "Florence, Metropolitan City of Florence"]],
      "IT", ["IT"], null, [], "Florence, Metropolitan City of Florence",
    ],
  ],
};

test("normalizeCityKey keeps the city and drops the administrative tail", () => {
  assert.strictEqual(normalizeCityKey("Los Angeles, CA"), "los angeles");
  assert.strictEqual(normalizeCityKey("Milan, Metropolitan City of Milan"), "milan");
  assert.strictEqual(normalizeCityKey("Shanghai, China"), "shanghai");
});

test("normalizeCityKey strips continental postal codes and province suffixes", () => {
  assert.strictEqual(normalizeCityKey("36100 Vicenza, Province of Vicenza"), "vicenza");
  assert.strictEqual(normalizeCityKey("41012 Carpi MO, Italy"), "carpi");
});

test("normalizeCityKey rejects country-level labels", () => {
  assert.strictEqual(normalizeCityKey("China"), null);
  assert.strictEqual(normalizeCityKey("USA"), null);
  assert.strictEqual(normalizeCityKey(""), null);
  assert.strictEqual(normalizeCityKey(null), null);
});

test("normalizeCityKey folds diacritics and case", () => {
  assert.strictEqual(normalizeCityKey("Zürich, Switzerland"), "zurich");
  assert.strictEqual(normalizeCityKey("SAN DIMAS, CA"), "san dimas");
});

test("city scope returns exactly the companies in that city", () => {
  const sets = buildSets(payload);
  const scope = resolveScope({ city: "San Dimas", country: "US" }, sets, "manu");
  assert.strictEqual(scope.level, "city");
  assert.deepStrictEqual([...scope.ids].sort(), ["sd1", "sd2"]);
});

test("a country-centroid company is never in a city scope", () => {
  const sets = buildSets(payload);
  const scope = resolveScope({ city: "San Dimas", country: "US" }, sets, "manu");
  assert.ok(!scope.ids.has("cn1"));
});

test("homonym cities stay separate by country", () => {
  const sets = buildSets(payload);
  const us = resolveScope({ city: "Florence", country: "US" }, sets, "manu");
  const it = resolveScope({ city: "Florence", country: "IT" }, sets, "manu");
  assert.deepStrictEqual([...us.ids], ["fl-us"]);
  assert.deepStrictEqual([...it.ids], ["fl-it"]);
});

test("an ambiguous city with no country resolves to nothing, not a merged set", () => {
  const sets = buildSets(payload);
  // Two Florences and no country to disambiguate: fall through rather than
  // claiming a count that spans two continents.
  const scope = resolveScope({ city: "Florence" }, sets, "manu");
  assert.strictEqual(scope, null);
});

test("an unambiguous city resolves without a country", () => {
  const sets = buildSets(payload);
  const scope = resolveScope({ city: "Vicenza" }, sets, "manu");
  assert.strictEqual(scope.level, "city");
  assert.deepStrictEqual([...scope.ids], ["it1"]);
});

test("region scope uses ISO codes and covers the whole state", () => {
  const sets = buildSets(payload);
  const scope = resolveScope({ region: "US-CA", country: "US" }, sets, "manu");
  assert.strictEqual(scope.level, "region");
  assert.deepStrictEqual([...scope.ids].sort(), ["la1", "sd1", "sd2"]);
});

test("city beats region when both are given", () => {
  const sets = buildSets(payload);
  const scope = resolveScope({ city: "San Dimas", region: "US-CA", country: "US" }, sets, "manu");
  assert.strictEqual(scope.level, "city");
  assert.strictEqual(scope.ids.size, 2);
});

test("an unknown city falls back to the region rather than claiming zero", () => {
  const sets = buildSets(payload);
  const scope = resolveScope({ city: "Nowheresville", region: "US-CA", country: "US" }, sets, "manu");
  assert.strictEqual(scope.level, "region");
  assert.strictEqual(scope.ids.size, 3);
});

test("hq mode scopes on headquarters, not plants", () => {
  const sets = buildSets(payload);
  // cn1 manufactures in China but is headquartered in New York.
  const scope = resolveScope({ city: "New York", country: "US" }, sets, "hq");
  assert.deepStrictEqual([...scope.ids], ["cn1"]);
  const manu = resolveScope({ city: "New York", country: "US" }, sets, "manu");
  assert.strictEqual(manu, null);
});

test("no scope inputs resolves to null", () => {
  const sets = buildSets(payload);
  assert.strictEqual(resolveScope({}, sets, "manu"), null);
  assert.strictEqual(resolveScope({ city: "San Dimas" }, null, "manu"), null);
});
