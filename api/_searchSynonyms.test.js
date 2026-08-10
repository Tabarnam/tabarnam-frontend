const test = require("node:test");
const assert = require("node:assert/strict");

const { expandProductSynonyms, expandQueryTermsForFTS } = require("./_searchSynonyms");

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

test("expandProductSynonyms: ice maker ↔ ice machine", () => {
  assert.ok(expandProductSynonyms("ice maker").includes("ice machine"), "ice maker → ice machine");
  assert.ok(expandProductSynonyms("ice machine").includes("ice maker"), "ice machine → ice maker");
  assert.ok(expandProductSynonyms("ice makers").includes("ice machines"), "ice makers → ice machines");
  assert.ok(expandProductSynonyms("ice machines").includes("ice makers"), "ice machines → ice makers");
});

// Compound splits run BEFORE product synonym expansion, so a solid spelling
// chains all the way to the far side of its synonym group rather than stopping
// at the split form. Guard both the new chain and a pre-existing split.
test("expandQueryTermsForFTS: icemaker chains through the split to ice machine", async () => {
  const { phrases } = await expandQueryTermsForFTS("icemaker", "icemaker");
  assert.ok(phrases.includes("ice maker"), "icemaker → ice maker (split)");
  assert.ok(phrases.includes("ice machine"), "icemaker → ice machine (split then synonym)");
});

test("expandQueryTermsForFTS: existing lipgloss split still resolves after reorder", async () => {
  const { phrases } = await expandQueryTermsForFTS("lipgloss", "lipgloss");
  assert.ok(phrases.includes("lip gloss"), "lipgloss → lip gloss");
});

test("expandProductSynonyms: essential oils ↔ aromatherapy/aroma/diffuser oils", () => {
  assert.ok(expandProductSynonyms("essential oils").includes("aromatherapy oils"), "essential oils → aromatherapy oils");
  assert.ok(expandProductSynonyms("aromatherapy oil").includes("essential oil"), "aromatherapy oil → essential oil");
});

test("expandProductSynonyms: eye drops ↔ ophthalmic drops / artificial tears", () => {
  assert.ok(expandProductSynonyms("eye drops").includes("artificial tears"), "eye drops → artificial tears");
  assert.ok(expandProductSynonyms("artificial tears").includes("eye drops"), "artificial tears → eye drops");
});

test("expandProductSynonyms: contact lens solution ↔ contact solution", () => {
  assert.ok(expandProductSynonyms("contact lens solution").includes("contact solution"), "contact lens solution → contact solution");
  assert.ok(expandProductSynonyms("contact solution").includes("contact lens solution"), "contact solution → contact lens solution");
});

test("expandProductSynonyms: an unrelated word expands to nothing", () => {
  assert.deepEqual(expandProductSynonyms("rollerblade"), []);
});

// ── context-scoped provenance synonyms ──────────────────────────────────────
// heritage / traditional / ancient / heirloom are synonyms for FOOD only.
// Measured on the catalog, "traditional" is mostly kilts, rugs, soap and
// skincare, so these must not expand without food context in the query.

test("provenance synonyms: expand when the query has food context", () => {
  const out = expandProductSynonyms("heritage grains");
  assert.ok(out.includes("ancient grains"), `heritage grains → ancient grains; got ${JSON.stringify(out)}`);
  assert.ok(out.includes("heirloom grains"), "heritage grains → heirloom grains");
  assert.ok(out.includes("traditional grains"), "heritage grains → traditional grains");
});

test("provenance synonyms: all four cross-expand", () => {
  assert.ok(expandProductSynonyms("ancient wheat").includes("heirloom wheat"));
  assert.ok(expandProductSynonyms("heirloom pasta").includes("heritage pasta"));
  assert.ok(expandProductSynonyms("traditional bread").includes("ancient bread"));
});

test("provenance synonyms: work mid-phrase, preserving the other words", () => {
  const out = expandProductSynonyms("heritage wheat flour");
  assert.ok(out.includes("ancient wheat flour"), `got ${JSON.stringify(out)}`);
  assert.ok(out.includes("heirloom wheat flour"));
});

test("provenance synonyms: livestock context counts as food", () => {
  assert.ok(expandProductSynonyms("heritage breed pork").includes("heirloom breed pork"));
});

test("provenance synonyms: do NOT expand without food context", () => {
  // The exact non-food clusters these words occupy in the catalog. Note the
  // assertion: unrelated GLOBAL groups may still fire (soap→cleanser,
  // rugs→carpets) — that's correct and must keep working. What must NOT happen
  // is the provenance word itself being swapped for one of its siblings.
  const PROVENANCE = ["heritage", "traditional", "ancient", "heirloom"];
  for (const q of ["traditional soap", "traditional kilt", "heritage rugs", "traditional skincare"]) {
    const original = q.split(/\s+/).find((w) => PROVENANCE.includes(w));
    const siblings = PROVENANCE.filter((w) => w !== original);
    for (const variant of expandProductSynonyms(q)) {
      const swapped = siblings.filter((s) => variant.split(/\s+/).includes(s));
      assert.deepEqual(
        swapped,
        [],
        `"${q}" → "${variant}" swapped the provenance word outside food context`
      );
    }
  }
});

test("provenance synonyms: a bare one-word query supplies no context, so no expansion", () => {
  assert.deepEqual(expandProductSynonyms("heritage"), []);
  assert.deepEqual(expandProductSynonyms("ancient"), []);
});

test("provenance synonyms: scoped words are absent from the GLOBAL synonym map", () => {
  // Guard against someone later moving these into PRODUCT_SYNONYM_GROUPS,
  // which would silently drop the food scoping.
  assert.deepEqual(expandProductSynonyms("traditional kilt"), []);
});

// Regression guard: a pre-existing group still works, so the new entry
// didn't disturb the map build.
test("expandProductSynonyms: existing candle group still resolves", () => {
  const out = expandProductSynonyms("candle");
  assert.ok(out.includes("votive"), `candle should expand to include votive; got ${JSON.stringify(out)}`);
});
