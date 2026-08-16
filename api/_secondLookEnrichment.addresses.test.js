// Second-look addresses piggyback (2026-08-16) — regression tests.
//
// Bug this closes: WPW (West Palm Wine Co.) import 2026-08-16 needed THREE
// enrichment cycles to capture its street address. Primary + second-look
// both missed because `addresses` was not in SECOND_LOOK_FIELDS — the
// second-look prompt never mentioned addresses and its parser wouldn't
// have understood them if the model had volunteered one. Only when a
// subsequent resume-worker cycle re-ran the primary canonical call and
// happened to browse /pages/contact did the address land.
//
// Fix (piggyback rider): every second-look call, regardless of which
// six-field trigger fired, now ALSO asks for addresses and merges any
// entries onto the doc via applyEnrichmentToCompany's existing
// addresses_block. Zero additional xAI calls; near-zero prompt-length
// delta; empty result is safe (mergeAddresses preserves existing entries).

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildSecondLookPrompt,
  parseSecondLookOutput,
  parseAddressBlocks,
  SECOND_LOOK_FIELDS,
} = require("./_secondLookEnrichment");

// ── Prompt shape ───────────────────────────────────────────────────────────

test("buildSecondLookPrompt always appends the addresses block, regardless of requested fields", () => {
  // Even a request that only asks for tagline gets the addresses rider.
  const p = buildSecondLookPrompt({
    companyName: "Wolfberger",
    websiteUrl: "https://wolfberger.com",
    fields: ["tagline"],
  });
  assert.match(p, /^Addresses:.*Address:/ms, "prompt must contain the Addresses instruction and the per-entry Address: label");
  assert.match(p, /type=hq\|manufacturing/, "prompt must document the type= tag");
  assert.match(p, /source=/, "prompt must document the source= tag");
  assert.match(p, /Addresses: none/, "prompt must document the 'none' sentinel");
});

test("buildSecondLookPrompt announces 'addresses' in the 'Fields to populate:' header line", () => {
  // Real-batch regression 2026-08-16: the address block WAS in the prompt
  // body but the model skipped it because addresses wasn't listed in the
  // authoritative "Fields to populate:" summary at the top. Announcing
  // it makes the model treat the rider as a first-class request.
  const p = buildSecondLookPrompt({
    companyName: "X",
    websiteUrl: "https://x.com",
    fields: ["reviews"],
  });
  assert.match(p, /Fields to populate:[^\n]*addresses/, "header line must include 'addresses'");
});

test("buildSecondLookPrompt includes addresses even when reviews is the only trigger (real second-look shape)", () => {
  const p = buildSecondLookPrompt({
    companyName: "X",
    websiteUrl: "https://x.com",
    fields: ["reviews"],
  });
  assert.match(p, /Address:/, "reviews-only trigger still gets the addresses rider");
});

test("addresses is NOT in SECOND_LOOK_FIELDS (piggyback, not a first-class field)", () => {
  // Deliberate: SECOND_LOOK_FIELDS drives request filtering, prompt-order
  // sorting, and per-field failure classification. Addresses is opportunistic;
  // an empty return should never count as a "failed field" and should never
  // be omitted based on the caller's requested list.
  assert.ok(!SECOND_LOOK_FIELDS.includes("addresses"), "addresses must remain outside SECOND_LOOK_FIELDS");
});

// ── Address-line parser ────────────────────────────────────────────────────

test("parseAddressBlocks: single canonical entry", () => {
  const entries = parseAddressBlocks([
    "Address: 3131 S. Dixie Highway | West Palm Beach | FL | 33405 | USA | type=hq | source=https://www.westpalmwine.com/pages/contact",
  ]);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    street: "3131 S. Dixie Highway",
    locality: "West Palm Beach",
    region: "FL",
    postal_code: "33405",
    country: "USA",
    type: "hq",
    source_url: "https://www.westpalmwine.com/pages/contact",
  });
});

test("parseAddressBlocks: multiple entries preserved in order", () => {
  const entries = parseAddressBlocks([
    "Address: 6 Grand'Rue | Eguisheim | Grand Est | 68420 | France | type=hq | source=https://wolfberger.com/en",
    "Address: 2 rue de Dublin | Schiltigheim | Grand Est | 67300 | France | type=hq | source=https://wolfberger.com/en",
  ]);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].locality, "Eguisheim");
  assert.equal(entries[1].locality, "Schiltigheim");
});

test("parseAddressBlocks: 'none' sentinel yields zero entries", () => {
  // parseSecondLookOutput drops the "Addresses: none" header line into
  // sections.addresses as the string "none" (via top.rest). Parser must
  // treat it as the explicit no-entries signal.
  assert.equal(parseAddressBlocks(["none"]).length, 0);
  assert.equal(parseAddressBlocks(["NONE"]).length, 0, "case-insensitive");
});

test("parseAddressBlocks: narrative lines without 'Address:' label are ignored", () => {
  const entries = parseAddressBlocks([
    "The company has one physical location:",
    "Address: 3131 S. Dixie Highway | West Palm Beach | FL | 33405 | USA | type=hq | source=https://x.com/contact",
    "Note: they also mention plans for a second location.",
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].street, "3131 S. Dixie Highway");
});

test("parseAddressBlocks: tolerates markdown bullet prefix on entry lines", () => {
  const entries = parseAddressBlocks([
    "- Address: 5 Rue des Gravières | Rilly-la-Montagne | Marne | 51500 | France | type=hq | source=https://champagnevilmart.fr/en",
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].postal_code, "51500");
});

test("parseAddressBlocks: type= and source= scanned regardless of tail order", () => {
  // Some model outputs reverse type/source order.
  const entries = parseAddressBlocks([
    "Address: 100 Main St | Buffalo | NY | 14201 | USA | source=https://x.com/contact | type=manufacturing",
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, "manufacturing");
  assert.equal(entries[0].source_url, "https://x.com/contact");
});

test("parseAddressBlocks: missing tail fields leave slots empty (still parsable)", () => {
  // A model that drops postal/country still gets its entry captured.
  // Downstream normalizeAddressEntry validates and drops entries without
  // at least one identifying part.
  const entries = parseAddressBlocks([
    "Address: 100 Main St | Buffalo | NY | | | type=hq |",
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].street, "100 Main St");
  assert.equal(entries[0].postal_code, "");
  assert.equal(entries[0].country, "");
  assert.equal(entries[0].source_url, "");
});

test("parseAddressBlocks: entry with fewer than 2 fields is dropped", () => {
  const entries = parseAddressBlocks([
    "Address: 100 Main St",           // no city, dropped
    "Address: 100 Main St | Buffalo", // minimum shape, kept
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].locality, "Buffalo");
});

test("parseAddressBlocks: empty input yields empty array", () => {
  assert.deepEqual(parseAddressBlocks([]), []);
  assert.deepEqual(parseAddressBlocks([""]), []);
  assert.deepEqual(parseAddressBlocks(["   "]), []);
});

// ── End-to-end via parseSecondLookOutput ──────────────────────────────────

test("parseSecondLookOutput: addresses section captured alongside a normal field response", () => {
  // Real-ish second-look output that the model might emit for a reviews-
  // only trigger with a bonus address rider.
  const raw = [
    "West Palm Wine Co.",
    "Reviews:",
    "Source: WineExample",
    "Author: A Person",
    "URL: https://example.com/r",
    "Title: A review",
    "Date: 2026-08-01",
    "Text: Good store.",
    "",
    "Addresses:",
    "Address: 3131 S. Dixie Highway | West Palm Beach | FL | 33405 | USA | type=hq | source=https://www.westpalmwine.com/pages/contact",
  ].join("\n");
  const { found_any, labels_found, parsed } = parseSecondLookOutput(raw);
  assert.ok(found_any);
  assert.ok(labels_found.includes("reviews"));
  assert.ok(labels_found.includes("addresses"));
  assert.equal(parsed.addresses.length, 1);
  assert.equal(parsed.addresses[0].street, "3131 S. Dixie Highway");
});

test("parseSecondLookOutput: 'Addresses: none' yields empty parsed.addresses (no false-positive entries)", () => {
  const raw = [
    "Wolfberger",
    "Tagline: Cave viticole depuis 1902",
    "Addresses: none",
  ].join("\n");
  const { parsed } = parseSecondLookOutput(raw);
  assert.deepEqual(parsed.addresses, [], "'none' must NOT create phantom entries");
});

test("parseSecondLookOutput: model that skips the Addresses label leaves parsed.addresses empty", () => {
  // Not every response will include an Addresses section (the block is
  // optional and the model may drop it silently). Absence must produce an
  // empty array, NOT throw or accidentally consume other sections.
  const raw = [
    "Wolfberger",
    "Tagline: Cave viticole depuis 1902",
    "Industries: Wine, Spirits, Retail",
  ].join("\n");
  const { parsed } = parseSecondLookOutput(raw);
  assert.deepEqual(parsed.addresses, []);
  assert.equal(parsed.tagline, "Cave viticole depuis 1902");
  assert.deepEqual(parsed.industries, ["Wine", "Spirits", "Retail"]);
});

test("scenario: WPW-shape second-look — mfg trigger, model volunteers the missing address", () => {
  // Reproduces the WPW gap: primary missed addresses, second-look fired
  // for manufacturing_locations, prior to the fix the address WAS in the
  // model's browse but was silently ignored because addresses wasn't
  // requested. Post-fix the model is asked, answers, and the entry lands.
  const raw = [
    "West Palm Wine Co.",
    "Manufacturing: n/a",
    "Keywords: natural wine, biodynamic, organic",
    "Addresses:",
    "Address: 3131 S. Dixie Highway | West Palm Beach | FL | 33405 | USA | type=hq | source=https://www.westpalmwine.com/pages/contact",
  ].join("\n");
  const { parsed } = parseSecondLookOutput(raw);
  assert.equal(parsed.addresses.length, 1);
  assert.equal(parsed.addresses[0].street, "3131 S. Dixie Highway");
  assert.equal(parsed.addresses[0].type, "hq");
  assert.equal(parsed.addresses[0].source_url, "https://www.westpalmwine.com/pages/contact");
});
