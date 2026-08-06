const test = require("node:test");
const assert = require("node:assert/strict");

const { expandProductSynonyms } = require("./_searchSynonyms");

// wine ↔ winery interchangeability (2026). A "wine" search should surface
// wineries and a "winery" search should surface wine sellers. The original
// term is added to the phrase set by expandQueryTermsForFTS separately; here
// we assert the synonym EXPANSION produces the counterpart.

test("expandProductSynonyms: wine expands to winery", () => {
  assert.deepEqual(expandProductSynonyms("wine"), ["winery"]);
});

test("expandProductSynonyms: winery expands to wine", () => {
  assert.deepEqual(expandProductSynonyms("winery"), ["wine"]);
});

test("expandProductSynonyms: plural wines ↔ wineries", () => {
  assert.deepEqual(expandProductSynonyms("wines"), ["wineries"]);
  assert.deepEqual(expandProductSynonyms("wineries"), ["wines"]);
});

test("expandProductSynonyms: barbecue ↔ bbq (and barbeque) cross-expand", () => {
  assert.deepEqual(expandProductSynonyms("bbq"), ["barbecue", "barbeque"]);
  assert.deepEqual(expandProductSynonyms("barbecue"), ["barbeque", "bbq"]);
  assert.deepEqual(expandProductSynonyms("barbeque"), ["barbecue", "bbq"]);
});

test("expandProductSynonyms: phone holder ↔ mount/stand/cradle/grip/dock", () => {
  const fromHolder = expandProductSynonyms("phone holder");
  assert.ok(fromHolder.includes("phone mount") && fromHolder.includes("phone stand") && fromHolder.includes("phone cradle"), "phone holder → mount/stand/cradle");
  const fromMount = expandProductSynonyms("phone mount");
  assert.ok(fromMount.includes("phone holder") && fromMount.includes("phone stand"), "phone mount → holder/stand");
});

test("expandProductSynonyms: windshield wipers ↔ wiper blades", () => {
  assert.ok(expandProductSynonyms("windshield wipers").includes("wiper blades"), "windshield wipers → wiper blades");
  assert.ok(expandProductSynonyms("wiper blades").includes("windshield wipers"), "wiper blades → windshield wipers");
});

test("expandProductSynonyms: bath bomb ↔ fizzy/fizzer/ball", () => {
  assert.ok(expandProductSynonyms("bath bomb").includes("bath fizzy"), "bath bomb → bath fizzy");
  assert.ok(expandProductSynonyms("bath fizzy").includes("bath bomb"), "bath fizzy → bath bomb");
});

test("expandProductSynonyms: an unrelated word expands to nothing", () => {
  assert.deepEqual(expandProductSynonyms("rollerblade"), []);
});

// Regression guard: a pre-existing group still works, so the new entry
// didn't disturb the map build.
test("expandProductSynonyms: existing candle group still resolves", () => {
  const out = expandProductSynonyms("candle");
  assert.ok(out.includes("votive"), `candle should expand to include votive; got ${JSON.stringify(out)}`);
});
