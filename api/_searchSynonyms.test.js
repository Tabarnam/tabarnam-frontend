const test = require("node:test");
const assert = require("node:assert/strict");

const { expandProductSynonyms, expandQueryTermsForFTS, splitCompoundQuery } = require("./_searchSynonyms");

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

test("splitCompoundQuery: known compounds split, everything else is left alone", () => {
  assert.equal(splitCompoundQuery("lipgloss"), "lip gloss");
  assert.equal(splitCompoundQuery("icemaker"), "ice maker");
  assert.equal(splitCompoundQuery("bodywash"), "body wash");
  // Already spaced — nothing to do.
  assert.equal(splitCompoundQuery("lip gloss"), null);
  // Not in the curated map: never guess a middle-split ("gra nola").
  assert.equal(splitCompoundQuery("granola"), null);
  // Short tokens are too collision-prone to split.
  assert.equal(splitCompoundQuery("soap"), null);
  assert.equal(splitCompoundQuery(""), null);
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

test("expandProductSynonyms: flying-insect control terms cross-expand", () => {
  const fromZapper = expandProductSynonyms("bug zapper");
  assert.ok(fromZapper.includes("flying insect trap"), "bug zapper → flying insect trap");
  assert.ok(fromZapper.includes("mosquito control"), "bug zapper → mosquito control");
  assert.ok(!fromZapper.includes("pest control"), "pest control was intentionally excluded (too broad)");
  assert.ok(expandProductSynonyms("mosquito control").includes("bug zapper"), "mosquito control → bug zapper");
  assert.ok(
    expandProductSynonyms("electric insect killer").includes("flying insect trap"),
    "electric insect killer → flying insect trap"
  );
});

test("expandProductSynonyms: the insect group needs the full phrase, no bare-word leak", () => {
  // "bug" and "control" alone must not trigger the group.
  assert.deepEqual(expandProductSynonyms("bug"), []);
  assert.ok(
    !expandProductSynonyms("remote control").some((v) => /zapper|mosquito|insect|pest/.test(v)),
    "'remote control' must not pull in insect-control synonyms"
  );
});

test("expandProductSynonyms: artificial plants/flowers cross-expand (modifier + noun)", () => {
  const fromFake = expandProductSynonyms("fake plants");
  assert.ok(fromFake.includes("artificial plants"), "fake plants → artificial plants");
  assert.ok(fromFake.includes("faux plants"), "fake plants → faux plants");
  assert.ok(fromFake.includes("silk plants"), "fake plants → silk plants");
  assert.ok(fromFake.includes("artificial flowers"), "fake plants → artificial flowers (cross-noun)");
  assert.ok(expandProductSynonyms("silk flowers").includes("faux flowers"), "silk flowers → faux flowers");
  // Singular queries bridge too.
  assert.ok(expandProductSynonyms("artificial flower").includes("faux flower"), "artificial flower → faux flower");
});

test("expandProductSynonyms: the artificial-plant group needs the full phrase", () => {
  // Bare nouns/modifiers must not trigger it.
  assert.deepEqual(expandProductSynonyms("plants"), []);
  assert.deepEqual(expandProductSynonyms("flowers"), []);
  assert.ok(
    !expandProductSynonyms("fresh flowers").some((v) => /faux|silk|artificial|fake|synthetic/.test(v)),
    "'fresh flowers' must not pull in the artificial cluster"
  );
});

test("splitCompoundQuery: preworkout splits to 'pre workout' (direct, not synonym)", () => {
  // Uses the compound-split path (COMPOUND_SPLITS), which scores as a DIRECT
  // match — NOT the synonym-group path, which would penalize it below the
  // "loosely related" divider.
  assert.equal(splitCompoundQuery("preworkout"), "pre workout");
  // "pre" alone must NOT split/map to preworkout (audio-preamp territory).
  assert.equal(splitCompoundQuery("pre"), null);
  assert.deepEqual(expandProductSynonyms("pre"), []);
});

test("expandProductSynonyms: aquarium ↔ fish tank / fishbowl cross-expand", () => {
  const fromAquarium = expandProductSynonyms("aquarium");
  assert.ok(fromAquarium.includes("fish tank"), "aquarium → fish tank");
  assert.ok(fromAquarium.includes("fishbowl"), "aquarium → fishbowl");
  assert.ok(expandProductSynonyms("fish tank").includes("aquarium"), "fish tank → aquarium");
  assert.ok(expandProductSynonyms("fish tanks").includes("aquariums"), "fish tanks → aquariums (plural)");
});

test("expandProductSynonyms: building toys ↔ construction toys / blocks / sets", () => {
  const out = expandProductSynonyms("building toys");
  assert.ok(out.includes("construction toys"), "building toys → construction toys");
  assert.ok(out.includes("building blocks"), "building toys → building blocks");
  assert.ok(out.includes("building sets"), "building toys → building sets");
  assert.ok(expandProductSynonyms("construction toys").includes("building toys"), "construction toys → building toys");
  assert.ok(expandProductSynonyms("building blocks").includes("construction toys"), "building blocks → construction toys");
  // Singular forms bridge too.
  assert.ok(expandProductSynonyms("building block").includes("construction toy"), "building block → construction toy");
  // The broader STEM/educational neighbor band is folded in (both directions).
  assert.ok(out.includes("stem toys"), "building toys → stem toys");
  assert.ok(out.includes("educational toys"), "building toys → educational toys");
  assert.ok(expandProductSynonyms("stem toys").includes("building toys"), "stem toys → building toys");
  assert.ok(expandProductSynonyms("educational toys").includes("building blocks"), "educational toys → building blocks");
});

test("expandProductSynonyms: building-toy group needs the full toy-anchored phrase (no bare-word leak)", () => {
  const toyCluster = /building toys?|construction toys?|building blocks?|building sets?|construction sets?/;
  // Bare ambiguous words must NOT pull in the toy cluster.
  assert.deepEqual(expandProductSynonyms("building"), []);
  assert.deepEqual(expandProductSynonyms("construction"), []);
  assert.deepEqual(expandProductSynonyms("blocks"), []);
  // Neighboring non-toy uses of the same ambiguous words stay clean.
  for (const q of ["office building", "construction equipment", "cinder blocks", "kayak building kit"]) {
    assert.ok(
      !expandProductSynonyms(q).some((v) => toyCluster.test(v)),
      `"${q}" must not pull in the building-toy cluster`
    );
  }
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
