const test = require("node:test");
const assert = require("node:assert");
const { resolveTextCountry, resolveLocationCountry } = require("./_countryResolve");
const { buildCompanyEntry } = require("./_pinsIndex");

test("resolveTextCountry: country names, aliases, and casing", () => {
  assert.equal(resolveTextCountry("USA"), "US");
  assert.equal(resolveTextCountry("United States"), "US");
  assert.equal(resolveTextCountry("U.S.A."), "US");
  assert.equal(resolveTextCountry("Italy"), "IT");
  assert.equal(resolveTextCountry("italia"), "IT");
  assert.equal(resolveTextCountry("United Kingdom"), "GB");
  assert.equal(resolveTextCountry("England"), "GB");
  assert.equal(resolveTextCountry("Viet Nam"), "VN");
  assert.equal(resolveTextCountry("New Zealand"), "NZ");
  assert.equal(resolveTextCountry(""), null);
  assert.equal(resolveTextCountry("Atlantis"), null);
});

test("resolveTextCountry: bare subdivisions resolve to their country", () => {
  assert.equal(resolveTextCountry("Oregon"), "US");
  assert.equal(resolveTextCountry("California"), "US");
  assert.equal(resolveTextCountry("Puerto Rico"), "US");
  assert.equal(resolveTextCountry("Ontario"), "CA");
  assert.equal(resolveTextCountry("Queensland"), "AU");
  // Bare "Georgia" is the US state (the country needs explicit context)
  assert.equal(resolveTextCountry("Georgia"), "US");
});

test("resolveTextCountry: 2-letter tails only when they are known codes", () => {
  assert.equal(resolveTextCountry("IT"), "IT");
  assert.equal(resolveTextCountry("fr"), "FR");
  assert.equal(resolveTextCountry("XQ"), null);
});

test("resolveLocationCountry: resolution order and address tails", () => {
  assert.equal(resolveLocationCountry({ country_code: "de" }), "DE");
  assert.equal(resolveLocationCountry({ country: "United States" }), "US");
  assert.equal(resolveLocationCountry({ formatted: "Brea, CA, USA" }), "US");
  assert.equal(resolveLocationCountry({ geocode_formatted_address: "Milan, Metropolitan City of Milan, Italy" }), "IT");
  assert.equal(resolveLocationCountry({ formatted: "Oregon" }), "US");
  assert.equal(resolveLocationCountry({ address: "Tanunda, South Australia, Australia" }), "AU");
  assert.equal(resolveLocationCountry("Light Pass, South Australia, Australia"), "AU");
  assert.equal(resolveLocationCountry({ formatted: "Nowhere" }), null);
  assert.equal(resolveLocationCountry(null), null);
});

test("buildCompanyEntry: carries hqCC and unique mfgCCs", () => {
  const entry = buildCompanyEntry({
    company_id: "c1",
    display_name: "Acme",
    tagline: "t",
    normalized_domain: "acme.com",
    hq_lat: 41.05,
    hq_lng: -73.53,
    headquarters: [{ address: "Stamford, CT, USA" }],
    manufacturing_geocodes: [
      { lat: 33.91, lng: -117.9, formatted: "Brea, CA, USA", geocode_status: "ok" },
      { lat: 41.87, lng: 12.56, formatted: "Rome, Italy", geocode_status: "ok" },
      { lat: 41.9, lng: 12.5, formatted: "Milan, Italy", geocode_status: "ok" },
      // text-only entry (no coords) still contributes country attribution
      { formatted: "Hanoi, Vietnam" },
    ],
  });
  assert.ok(entry);
  const [, , , , , , mfg, hqCC, mfgCCs] = entry;
  assert.equal(hqCC, "US");
  assert.deepEqual([...mfgCCs].sort(), ["IT", "US", "VN"]);
  assert.equal(mfg.length, 3); // only the coordinate-bearing entries pin
});

test("buildCompanyEntry: falls back to headquarters_location string for hqCC", () => {
  const entry = buildCompanyEntry({
    company_id: "c2",
    display_name: "Bmax",
    hq_lat: 48.85,
    hq_lng: 2.35,
    headquarters_location: "Paris, France",
    manufacturing_geocodes: [],
  });
  const [, , , , , , , hqCC, mfgCCs] = entry;
  assert.equal(hqCC, "FR");
  assert.deepEqual(mfgCCs, []);
});
