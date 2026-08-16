// Tests for the structured-address helper module.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isTrustedAddressSource,
  normalizeAddressEntry,
  normalizeAddresses,
  mergeAddresses,
  addressKey,
} = require("./_addresses.js");

test("isTrustedAddressSource: known directory host returns true", () => {
  assert.equal(isTrustedAddressSource("https://coffeeroasternearme.com/roaster/x"), true);
  assert.equal(isTrustedAddressSource("https://www.coffeeroasternearme.com/roaster/x"), true);
  assert.equal(isTrustedAddressSource("https://localhoneymap.com/apiary/y"), true);
});

test("isTrustedAddressSource: subdomain of trusted host returns true", () => {
  assert.equal(isTrustedAddressSource("https://us.coffeeroasternearme.com/roaster/x"), true);
});

test("isTrustedAddressSource: unknown host returns false", () => {
  assert.equal(isTrustedAddressSource("https://randomcompany.com/contact"), false);
  assert.equal(isTrustedAddressSource(""), false);
  assert.equal(isTrustedAddressSource(null), false);
  assert.equal(isTrustedAddressSource("not-a-url"), false);
});

test("normalizeAddressEntry: accepts JSON-LD PostalAddress key names", () => {
  const entry = normalizeAddressEntry({
    streetAddress: "61 9th Ave",
    addressLocality: "New York",
    addressRegion: "NY",
    postalCode: "10011",
    addressCountry: "US",
    src: "https://coffeeroasternearme.com/roaster/x",
  });
  assert.ok(entry);
  assert.equal(entry.street, "61 9th Ave");
  assert.equal(entry.locality, "New York");
  assert.equal(entry.region, "NY");
  assert.equal(entry.postal_code, "10011");
  assert.equal(entry.country, "US");
  assert.equal(entry.source_url, "https://coffeeroasternearme.com/roaster/x");
});

test("normalizeAddressEntry: accepts canonical snake_case keys", () => {
  const entry = normalizeAddressEntry({
    street: "1 Test St",
    locality: "Portland",
    region: "OR",
    postal_code: "97201",
    country: "US",
    type: "manufacturing",
    source_url: "https://example.com/factory",
    fetched_at: "2026-08-06T00:00:00.000Z",
  });
  assert.ok(entry);
  assert.equal(entry.type, "manufacturing");
  assert.equal(entry.fetched_at, "2026-08-06T00:00:00.000Z");
});

test("normalizeAddressEntry: defaults type to 'hq' when unspecified", () => {
  const entry = normalizeAddressEntry({ street: "1 Test St", locality: "Portland" });
  assert.equal(entry.type, "hq");
});

test("normalizeAddressEntry: honors opts.defaultType when provided", () => {
  const entry = normalizeAddressEntry({ street: "1 Test St" }, { defaultType: "manufacturing" });
  assert.equal(entry.type, "manufacturing");
});

test("normalizeAddressEntry: rejects invalid type values, falls back", () => {
  const entry = normalizeAddressEntry({ street: "1 Test St", type: "nonsense" });
  assert.equal(entry.type, "hq");
});

test("normalizeAddressEntry: returns null for empty / meaningless input", () => {
  assert.equal(normalizeAddressEntry(null), null);
  assert.equal(normalizeAddressEntry({}), null);
  assert.equal(normalizeAddressEntry({ region: "NY", country: "US" }), null, "bare region+country isn't an address");
  assert.equal(normalizeAddressEntry("string"), null);
});

test("normalizeAddressEntry: is_public defaults from trusted-source rule", () => {
  const publicOne = normalizeAddressEntry({
    street: "61 9th Ave",
    source_url: "https://coffeeroasternearme.com/roaster/x",
  });
  assert.equal(publicOne.is_public, true, "trusted directory host defaults to public");

  const privateOne = normalizeAddressEntry({
    street: "1 Corporate Way",
    source_url: "https://randomcompany.com/contact",
  });
  assert.equal(privateOne.is_public, false, "unknown source stays private");

  const noSource = normalizeAddressEntry({ street: "1 Corporate Way" });
  assert.equal(noSource.is_public, false, "missing source stays private");
});

test("normalizeAddressEntry: explicit is_public wins over the default", () => {
  const forcedPrivate = normalizeAddressEntry({
    street: "61 9th Ave",
    source_url: "https://coffeeroasternearme.com/roaster/x",
    is_public: false,
  });
  assert.equal(forcedPrivate.is_public, false, "admin hide overrides the trust default");

  const forcedPublic = normalizeAddressEntry({
    street: "1 Corporate Way",
    source_url: "https://randomcompany.com/contact",
    is_public: true,
  });
  assert.equal(forcedPublic.is_public, true, "admin show overrides the private default");
});

test("normalizeAddresses: deduplicates entries by (street, locality, postal_code, type)", () => {
  const arr = normalizeAddresses([
    { street: "1 Test St", locality: "Portland", postal_code: "97201" },
    { street: "1 Test St", locality: "Portland", postal_code: "97201" },
    { street: "2 Other St", locality: "Portland", postal_code: "97201" },
  ]);
  assert.equal(arr.length, 2);
});

test("normalizeAddresses: same street with DIFFERENT type KEEPS both (2026-08-16 — HQ+Mfg at one location)", () => {
  // Small wineries and single-facility producers routinely have the same
  // physical address for HQ and Manufacturing. Both roles must survive
  // dedup so the admin editor and public projection can show them as two
  // distinct rows. Regression: Henri Giraud paste (71 Boulevard Charles
  // de Gaulle for both HQ and Mfg) landed only the hq entry before this.
  const arr = normalizeAddresses([
    { street: "1 Test St", locality: "Portland", type: "hq" },
    { street: "1 Test St", locality: "Portland", type: "manufacturing" },
  ]);
  assert.equal(arr.length, 2);
  const types = arr.map((a) => a.type).sort();
  assert.deepEqual(types, ["hq", "manufacturing"]);
});

test("normalizeAddresses: same street AND same type DEDUPES to one (defensive against dup source scrapes)", () => {
  // Type is part of identity; SAME type at SAME address is still one entry.
  const arr = normalizeAddresses([
    { street: "1 Test St", locality: "Portland", type: "hq", source_url: "https://a" },
    { street: "1 Test St", locality: "Portland", type: "hq", source_url: "https://b" },
  ]);
  assert.equal(arr.length, 1);
});

test("normalizeAddresses: filters out empty entries", () => {
  const arr = normalizeAddresses([
    { street: "1 Test St" },
    null,
    {},
    { country: "US" },
  ]);
  assert.equal(arr.length, 1);
});

test("normalizeAddresses: handles non-array input gracefully", () => {
  assert.deepEqual(normalizeAddresses(null), []);
  assert.deepEqual(normalizeAddresses("nope"), []);
  assert.deepEqual(normalizeAddresses(undefined), []);
});

test("mergeAddresses: preserves existing when incoming is empty", () => {
  const existing = [
    normalizeAddressEntry({ street: "1 Test St", locality: "Portland", is_public: true }),
  ];
  const merged = mergeAddresses(existing, []);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].street, "1 Test St");
  assert.equal(merged[0].is_public, true, "existing is_public preserved");
});

test("mergeAddresses: NEVER wipes existing when re-import returns null/undefined", () => {
  const existing = [
    normalizeAddressEntry({ street: "1 Test St", locality: "Portland" }),
  ];
  assert.equal(mergeAddresses(existing, null).length, 1);
  assert.equal(mergeAddresses(existing, undefined).length, 1);
});

test("mergeAddresses: SAME street + SAME type — existing is_public WINS, fact fields refresh (admin edits protected)", () => {
  // 2026-08-16 — type is now part of the identity key. Collision means
  // same street+locality+postal AND same type. is_public still stays
  // (admin-editable); source_url + fetched_at refresh from the new import.
  const existing = [
    { street: "1 Test St", locality: "Portland", postal_code: "97201",
      type: "hq", source_url: "https://old.example.com",
      fetched_at: "2026-01-01T00:00:00.000Z", is_public: true },
  ];
  const incoming = [
    { street: "1 Test St", locality: "Portland", postal_code: "97201",
      type: "hq", source_url: "https://new.example.com",
      fetched_at: "2026-08-06T00:00:00.000Z", is_public: false },
  ];
  const merged = mergeAddresses(existing, incoming);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].is_public, true, "admin's is_public stays");
  assert.equal(merged[0].source_url, "https://new.example.com", "fact fields refresh");
  assert.equal(merged[0].fetched_at, "2026-08-06T00:00:00.000Z");
});

test("mergeAddresses: SAME street + DIFFERENT type — BOTH entries coexist (2026-08-16 contract change)", () => {
  // Documents the trade-off: if admin previously changed type on an
  // existing entry, a re-import that comes back with the ORIGINAL type
  // now produces a duplicate (both stored) rather than silently keeping
  // the admin's correction. Acceptable cost for enabling HQ+Mfg-at-one-
  // location — admin can delete the duplicate from the editor.
  const existing = [
    { street: "1 Test St", locality: "Portland", postal_code: "97201",
      type: "manufacturing", is_public: true },
  ];
  const incoming = [
    { street: "1 Test St", locality: "Portland", postal_code: "97201",
      type: "hq", is_public: false },
  ];
  const merged = mergeAddresses(existing, incoming);
  assert.equal(merged.length, 2, "different types at same address are now distinct entries");
  const byType = Object.fromEntries(merged.map((m) => [m.type, m]));
  assert.equal(byType.manufacturing.is_public, true, "existing admin fields preserved on its own entry");
  assert.equal(byType.hq.is_public, false);
});

test("mergeAddresses: new distinct entries are appended", () => {
  const existing = [
    normalizeAddressEntry({ street: "1 Test St", locality: "Portland" }),
  ];
  const incoming = [
    { street: "2 Other Ave", locality: "Portland" },
  ];
  const merged = mergeAddresses(existing, incoming);
  assert.equal(merged.length, 2);
});

test("mergeAddresses: only fact fields refresh from incoming; blanks don't clear them", () => {
  const existing = [
    { street: "1 Test St", locality: "Portland", postal_code: "97201",
      country: "US", type: "hq", is_public: false },
  ];
  const incoming = [
    { street: "1 Test St", locality: "Portland", postal_code: "97201",
      country: "", type: "hq" }, // blank country
  ];
  const merged = mergeAddresses(existing, incoming);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].country, "US", "blank incoming field must not wipe existing");
});

test("addressKey: is stable and case-insensitive", () => {
  const a = normalizeAddressEntry({ street: "1 Test St", locality: "Portland", postal_code: "97201" });
  const b = normalizeAddressEntry({ street: "1 TEST ST", locality: "PORTLAND", postal_code: "97201" });
  assert.equal(addressKey(a), addressKey(b));
});
