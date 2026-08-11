const test = require("node:test");
const assert = require("node:assert");
const { resolveLocationRegion } = require("./_regionResolve");
const { buildCompanyEntry } = require("./_pinsIndex");

test("resolveLocationRegion: 'City, ST, USA' shape", () => {
  assert.equal(resolveLocationRegion({ formatted: "Brea, CA, USA" }), "US-CA");
  assert.equal(resolveLocationRegion({ formatted: "Austin, TX, USA" }), "US-TX");
  assert.equal(resolveLocationRegion("Portland, OR, USA"), "US-OR");
});

test("resolveLocationRegion: full state names, with and without ZIP", () => {
  assert.equal(resolveLocationRegion({ formatted: "Santa Maria, California 93454, USA" }), "US-CA");
  assert.equal(resolveLocationRegion({ formatted: "Napa, California 94558, USA" }), "US-CA");
  assert.equal(resolveLocationRegion({ formatted: "Brooklyn, New York, USA" }), "US-NY");
});

test("resolveLocationRegion: bare state-centroid entries", () => {
  assert.equal(resolveLocationRegion({ formatted: "Oregon" }), "US-OR");
  assert.equal(resolveLocationRegion({ formatted: "Idaho", geocode_source: "state_center" }), "US-ID");
});

test("resolveLocationRegion: country-only stays null", () => {
  assert.equal(resolveLocationRegion({ formatted: "USA" }), null);
  assert.equal(resolveLocationRegion({ formatted: "United States" }), null);
  // Country we don't have a subdivision table for
  assert.equal(resolveLocationRegion({ formatted: "Rome, Italy" }), null);
  assert.equal(resolveLocationRegion(null), null);
});

test("resolveLocationRegion: DC and territories fall under US", () => {
  assert.equal(resolveLocationRegion({ formatted: "Washington, DC, USA" }), "US-DC");
  assert.equal(resolveLocationRegion({ formatted: "San Juan, Puerto Rico" }), "US-PR");
  assert.equal(resolveLocationRegion({ formatted: "Hagåtña, Guam" }), "US-GU");
});

test("resolveLocationRegion: Canadian provinces and Australian states", () => {
  assert.equal(resolveLocationRegion({ formatted: "Toronto, ON, Canada" }), "CA-ON");
  assert.equal(resolveLocationRegion({ formatted: "Vancouver, British Columbia, Canada" }), "CA-BC");
  assert.equal(resolveLocationRegion({ formatted: "Tanunda, South Australia, Australia" }), "AU-SA");
  assert.equal(resolveLocationRegion({ formatted: "Melbourne, Victoria, Australia" }), "AU-VIC");
});

test("resolveLocationRegion: structured fields win over the address text", () => {
  assert.equal(resolveLocationRegion({ state: "CA", formatted: "Somewhere, USA" }), "US-CA");
  assert.equal(resolveLocationRegion({ region: "Texas", country: "USA" }), "US-TX");
});

test("buildCompanyEntry: carries hqRegion and unique mfgRegions", () => {
  const entry = buildCompanyEntry({
    company_id: "c1",
    display_name: "Acme",
    hq_lat: 41.05,
    hq_lng: -73.53,
    headquarters: [{ address: "Stamford, CT, USA" }],
    manufacturing_geocodes: [
      { lat: 33.91, lng: -117.9, formatted: "Brea, CA, USA", geocode_status: "ok" },
      { lat: 34.05, lng: -118.24, formatted: "Los Angeles, CA, USA", geocode_status: "ok" },
      { lat: 45.52, lng: -122.68, formatted: "Portland, OR, USA", geocode_status: "ok" },
      { lat: 41.87, lng: 12.56, formatted: "Rome, Italy", geocode_status: "ok" },
    ],
  });
  const [, , , , , , , hqCC, mfgCCs, hqRegion, mfgRegions] = entry;
  assert.equal(hqCC, "US");
  assert.equal(hqRegion, "US-CT");
  assert.deepEqual([...mfgCCs].sort(), ["IT", "US"]);
  // CA deduped despite two entries; Italy contributes no region
  assert.deepEqual([...mfgRegions].sort(), ["US-CA", "US-OR"]);
});
