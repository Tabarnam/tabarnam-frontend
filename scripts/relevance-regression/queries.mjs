// Curated query set for the search relevance-regression harness.
//
// `class` tags which retrieval path the query exercises, so a diff can be read
// with the fuzzy-gate change (or any ranking change) in mind:
//   A = strong name / exact brand  → hasStrongNameMatch true, fuzzy already skipped (should NOT move)
//   B = brand + category, thin pool → fuzzy legitimately needed (should NOT move)
//   C = common category word, healthy keyword pool, no name match → fuzzy fires today;
//       THIS is the class the fuzzy-gate would change. Watch these for drop-outs.
// The set is intentionally weighted toward class C (what we're de-risking) while
// keeping A/B anchors that must stay pinned.
export const QUERIES = [
  // A — exact brands / strong name match (anchors that must not move)
  { q: "patagonia", class: "A" },
  { q: "yeti", class: "A" },
  { q: "hydro flask", class: "A" },
  { q: "blue bottle coffee", class: "A" },
  { q: "sub-zero", class: "A" },
  { q: "allbirds", class: "A" },
  { q: "clif bar", class: "A" },
  { q: "the north face", class: "A" },

  // B — brand + category where the brand isn't tagged for the category (thin pool → fuzzy needed)
  { q: "alo yoga", class: "B" },
  { q: "my pillow", class: "B" },
  { q: "death wish coffee", class: "B" },
  { q: "grand teton organic grains", class: "B" },

  // C — common category words: healthy keyword pool, no name-prefix match → fuzzy fires today
  { q: "coffee", class: "C" },
  { q: "water", class: "C" },
  { q: "shoes", class: "C" },
  { q: "socks", class: "C" },
  { q: "granola", class: "C" },
  { q: "tea", class: "C" },
  { q: "soap", class: "C" },
  { q: "candles", class: "C" },
  { q: "honey", class: "C" },
  { q: "chocolate", class: "C" },
  { q: "backpack", class: "C" },
  { q: "mattress", class: "C" },
  { q: "sunglasses", class: "C" },
  { q: "jeans", class: "C" },
  { q: "sneakers", class: "C" },
  { q: "pillow", class: "C" },
  { q: "knife", class: "C" },
  { q: "watch", class: "C" },
  { q: "toothpaste", class: "C" },
  { q: "shampoo", class: "C" },
  { q: "olive oil", class: "C" },
  { q: "hot sauce", class: "C" },

  // Synonyms (retrieval expands; scoring maxes over phrases)
  { q: "fridge", class: "C", note: "synonym→refrigerator" },
  { q: "lipgloss", class: "C", note: "synonym→lip gloss" },

  // Typo-prone (fuzzy is the intended path — must survive any gate)
  { q: "cliff bar", class: "B", note: "typo→clif bar" },

  // BP — brand + product qualifier. The NAMED brand must rise to the top (a
  // change vs baseline is the DESIRED outcome here, not a regression).
  { q: "natrulo tallow soap", class: "BP", note: "Natrulo must lead (currently buried)" },
  { q: "viking blade chef knife", class: "BP", note: "Viking Blade must lead" },
  { q: "true primal maple granola", class: "BP", note: "True Primal must lead" },

  // TRAP — a common product word that is ALSO a brand-ish word. The fix must NOT
  // pin a company here (these must stay UNCHANGED vs baseline).
  { q: "apple pie", class: "TRAP", note: "must not pin an 'Apple' company" },
  { q: "orange marmalade", class: "TRAP", note: "common word 'orange'" },
  { q: "olive tapenade", class: "TRAP", note: "common word 'olive'" },
  { q: "honey soap", class: "TRAP", note: "both words common" },

  // TYPO — auto-applied spelling correction. The literal query finds nothing
  // worth showing, so the backend re-runs on the correction and returns
  // meta.corrected_query. A change vs baseline here is the DESIRED outcome.
  { q: "oilve oil", class: "TYPO", note: "must now return olive oil makers, not motor oil" },
  { q: "paintt", class: "TYPO", note: "must now return paint makers" },
  { q: "puzle", class: "TYPO", note: "must now return puzzle makers" },

  // TYPO-TRAP — real brands that a naive corrector would rewrite. These must
  // NEVER be auto-corrected: they retrieve and name-match, so the pool is not
  // junk and the second pass must not run.
  { q: "padron", class: "TYPO-TRAP", note: "real brand; must NOT become 'patron'" },
  { q: "pillowz", class: "TYPO-TRAP", note: "deliberate brand spelling" },
  { q: "froot", class: "TYPO-TRAP", note: "deliberate brand spelling" },

  // PROV — provenance synonyms (heritage/traditional/ancient/heirloom), scoped
  // to food. The first three must cross-match; the last two must NOT expand,
  // because those words are non-food in this catalog (kilts, rugs, soap).
  { q: "heritage grains", class: "PROV", note: "must surface ancient/heirloom grain makers" },
  { q: "heirloom wheat", class: "PROV", note: "must surface heritage/ancient wheat" },
  { q: "traditional wheat flour", class: "PROV", note: "mid-phrase expansion" },
  { q: "traditional kilt", class: "PROV-TRAP", note: "must NOT get provenance expansion" },
  { q: "traditional soap", class: "PROV-TRAP", note: "soap→cleanser is fine; provenance swap is not" },

  // Qualifier + head-noun (adjective + noun): the noun-maker must survive even
  // when it doesn't tag the qualifier. Watch these for ENTRANTS (the intended
  // gain from the head-noun penalty softening), and the noun-only baseline for
  // the reference set.
  { q: "custom emblem", class: "N", note: "head-noun=emblem; must keep emblem makers" },
  { q: "emblem", class: "N", note: "head-noun reference" },
  { q: "organic honey", class: "N", note: "head-noun=honey" },
  { q: "stainless knife", class: "N", note: "head-noun=knife" },
  { q: "leather wallet", class: "N", note: "head-noun=wallet" },
];
