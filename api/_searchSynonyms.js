/**
 * Search synonyms loader from Azure Blob Storage
 * Loads and caches search_synonyms.json with TTL
 */

const { BlobServiceClient } = require("@azure/storage-blob");
const { stemWords } = require("./_stemmer");

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Common business name abbreviations (bidirectional).
 * Maps full word → abbreviation. Reverse mapping is built automatically.
 */
const BUSINESS_ABBREVIATIONS = {
  "company": "co",
  "corporation": "corp",
  "incorporated": "inc",
  "limited": "ltd",
  "manufacturing": "mfg",
  "laboratories": "labs",
  "laboratory": "lab",
  "international": "intl",
  "industries": "ind",
  "enterprise": "ent",
  "enterprises": "ent",
  "associates": "assoc",
  "brothers": "bros",
  "department": "dept",
  "services": "svc",
  "solutions": "sol",
  "technologies": "tech",
  "technology": "tech",
  "distribution": "dist",
  "distributors": "dist",
  "products": "prod",
  "national": "natl",
};

// Build reverse map: abbreviation → [full words]
const ABBREV_TO_FULL = {};
for (const [full, abbrev] of Object.entries(BUSINESS_ABBREVIATIONS)) {
  if (!ABBREV_TO_FULL[abbrev]) ABBREV_TO_FULL[abbrev] = [];
  ABBREV_TO_FULL[abbrev].push(full);
}

/**
 * Product synonym groups — each array is a set of interchangeable terms.
 * When a query contains any word in a group, we also search for the others.
 * These are per-word replacements applied within multi-word queries.
 */
const PRODUCT_SYNONYM_GROUPS = [
  // Cutting/trimming tools
  ["clipper", "cutter", "trimmer"],
  ["clippers", "cutters", "trimmers"],
  // Containers
  ["bottle", "flask", "canteen"],
  ["bottles", "flasks", "canteens"],
  ["cup", "mug", "tumbler"],
  ["cups", "mugs", "tumblers"],
  ["jar", "container", "canister"],
  ["jars", "containers", "canisters"],
  // Furniture
  ["couch", "sofa", "loveseat"],
  ["couches", "sofas", "loveseats"],
  // Bags
  ["bag", "sack", "pouch"],
  ["bags", "sacks", "pouches"],
  ["backpack", "rucksack", "daypack"],
  ["backpacks", "rucksacks", "daypacks"],
  ["purse", "handbag", "clutch"],
  ["purses", "handbags", "clutches"],
  // Footwear
  ["sneakers", "trainers", "running shoes"],
  ["shoes", "footwear"],
  ["boots", "booties"],
  ["sandals", "flip flops", "slides"],
  // Clothing
  ["shirt", "tee", "top"],
  ["shirts", "tees", "tops"],
  ["pants", "trousers", "slacks"],
  ["jacket", "coat", "parka"],
  ["jackets", "coats", "parkas"],
  ["hoodie", "sweatshirt", "pullover"],
  ["hoodies", "sweatshirts", "pullovers"],
  ["sweater", "jumper", "knit"],
  ["sweaters", "jumpers", "knits"],
  ["beanie", "knit cap", "toque"],
  ["beanies", "knit caps", "toques"],
  // Bedding/linens
  ["blanket", "throw", "comforter"],
  ["blankets", "throws", "comforters"],
  ["pillow", "cushion"],
  ["pillows", "cushions"],
  ["sheets", "bedding", "linens"],
  ["towel", "washcloth"],
  ["towels", "washcloths"],
  // Kitchen
  ["pan", "skillet", "frying pan"],
  ["pot", "saucepan", "stockpot"],
  ["knife", "blade"],
  ["knives", "blades"],
  ["spatula", "turner", "flipper"],
  ["cutting board", "chopping board"],
  // Appliances — "fridge" is the everyday word for "refrigerator"; pair them
  // (and plurals) so either query reaches brands tagged with only one form.
  ["fridge", "refrigerator"],
  ["fridges", "refrigerators"],
  // "ice maker" and "ice machine" are the same appliance under different head
  // nouns (maker/machine), so neither query reaches a brand tagged only the
  // other way. Group + plurals.
  ["ice maker", "ice machine"],
  ["ice makers", "ice machines"],
  // Personal care
  ["soap", "cleanser", "wash"],
  ["shampoo", "hair wash"],
  ["lotion", "moisturizer", "cream"],
  ["lotions", "moisturizers", "creams"],
  ["deodorant", "antiperspirant"],
  ["toothbrush", "dental brush"],
  ["toothpaste", "dental paste"],
  ["razor", "shaver"],
  ["razors", "shavers"],
  // Bath bombs — "bath bomb" is the dominant term; "fizzy"/"fizzer"/"ball" name
  // the same fizzing bath product but share no head noun with it. Group + plurals.
  ["bath bomb", "bath fizzy", "bath fizzer", "bath ball"],
  ["bath bombs", "bath fizzies", "bath fizzers", "bath balls"],
  // Wellness / eye care
  // Essential oil ↔ aromatherapy/aroma/diffuser oil — same natural oil, different
  // qualifier, so "essential" AND "oil" won't reach an "aromatherapy oil" tag.
  ["essential oil", "aromatherapy oil", "aroma oil", "diffuser oil"],
  ["essential oils", "aromatherapy oils", "aroma oils", "diffuser oils"],
  // Eye drops ↔ ophthalmic drops / artificial tears / eye lubricant (+ solid
  // "eyedrops"): same product, genuinely different head nouns (drops/tears/lubricant).
  ["eye drops", "eyedrops", "ophthalmic drops", "artificial tears", "eye lubricant"],
  // Contact lens solution ↔ contact/lens solution / cleaner — the strict AND
  // ("contact" AND "lens" AND "solution") misses brands tagged "contact solution".
  ["contact lens solution", "contact solution", "lens solution", "contact lens cleaner"],
  ["contact lens solutions", "contact solutions", "lens solutions", "contact lens cleaners"],
  // Food/drink
  ["candy", "sweets", "confection"],
  ["soda", "pop", "soft drink"],
  ["chips", "crisps"],
  ["cookies", "biscuits"],
  ["jerky", "dried meat"],
  ["jam", "jelly", "preserves"],
  ["granola", "muesli", "cereal"],
  // Barbecue ↔ BBQ — "bbq" is the everyday shorthand (and "barbeque" a common
  // alt spelling); pair them (and plurals) so either query reaches brands
  // tagged with only one form.
  ["barbecue", "barbeque", "bbq"],
  ["barbecues", "barbeques", "bbqs"],
  // Wine ↔ winery — interchangeable so a "wine" search surfaces wineries
  // and a "winery" search surfaces wine sellers. Plural forms paired too;
  // stemming bridges wine↔wines and winery↔wineries on top of these.
  ["wine", "winery"],
  ["wines", "wineries"],
  // Materials
  ["cloth", "fabric", "textile"],
  ["leather", "hide"],
  ["wood", "timber", "lumber"],
  // Baby
  ["stroller", "pram", "buggy"],
  ["strollers", "prams", "buggies"],
  ["pacifier", "dummy", "binky"],
  ["diaper", "nappy"],
  ["diapers", "nappies"],
  // Electronics
  // electric ↔ electronic: "electric keyboard" must reach brands tagged
  // "electronic keyboard" (Casio, Korg…) — without this, the strict AND finds
  // nothing and the broadening fallback returns computer-keyboard brands.
  // Scoring is synonym-aware, so direct matches still outrank synonym-only.
  ["electric", "electronic"],
  // E-bike cluster: "e-bike" normalizes to "e bike" and the 1-char "e" is
  // dropped by tokenization, so without these the spellings searched as plain
  // "bike"/"bicycle" and returned disjoint (or non-electric) sets.
  // Cross-pollinates e-bike / e-bicycle / electric bike / electronic bicycle
  // (+ compact forms). "electronic *" must be listed explicitly — the
  // electric↔electronic word pair above expands only one hop and doesn't
  // chain into this group.
  ["ebike", "e bike", "electric bike", "electronic bike", "ebicycle", "e bicycle", "electric bicycle", "electronic bicycle"],
  ["ebikes", "e bikes", "electric bikes", "electronic bikes", "ebicycles", "e bicycles", "electric bicycles", "electronic bicycles"],
  ["headphones", "earphones", "earbuds"],
  ["charger", "adapter", "power supply"],
  ["cable", "cord", "wire"],
  ["cables", "cords", "wires"],
  // Phone accessories — holder / mount / stand / cradle / grip / dock all name a
  // device that holds a phone. Different HEAD NOUNS, so the strict token-AND
  // ("phone" AND "holder") can't bridge them — group so a search for any reaches
  // makers tagged with only one term. "cell phone mount" etc. already carry the
  // phone+mount tokens, so they're covered without listing them explicitly.
  ["phone holder", "phone mount", "phone stand", "phone cradle", "phone grip", "phone dock"],
  ["phone holders", "phone mounts", "phone stands", "phone cradles", "phone grips", "phone docks"],
  // Automotive — "windshield wipers" and "wiper blades" name the same part but
  // share no common head noun ("wipers" vs "blades"), so the token-AND can't
  // bridge them. Group US + UK ("windscreen") + combined forms, plural + singular.
  ["windshield wipers", "wiper blades", "windshield wiper blades", "windscreen wipers", "windscreen wiper blades"],
  ["windshield wiper", "wiper blade", "windshield wiper blade", "windscreen wiper", "windscreen wiper blade"],
  // Misc
  ["rug", "carpet", "mat"],
  ["rugs", "carpets", "mats"],
  ["candle", "taper", "votive"],
  ["candles", "tapers", "votives"],
  ["sunglasses", "shades", "sunnies"],
  ["umbrella", "parasol"],
  ["wallet", "billfold"],
  ["wallets", "billfolds"],
];

// Build a fast lookup: word → [synonym1, synonym2, ...]
// ── Context-scoped synonym groups ───────────────────────────────────────────
// Some words are only synonyms inside a particular domain. "heritage",
// "traditional", "ancient" and "heirloom" mean the same thing for a grain or a
// livestock breed, but NOT for the rest of the catalog — measured on this
// corpus, "traditional" is mostly kilts, rugs, soap and skincare (only ~44% of
// its matches are food), so treating it as a global synonym would rewrite
// queries that have nothing to do with provenance.
//
// Search has no industry information at query-expansion time (retrieval hasn't
// run yet), so the scope has to come from the query itself: expand only when
// another word in the query establishes the domain. "heritage grains" expands;
// "traditional soap" does not. The trade-off is that a bare one-word query
// ("heritage") supplies no context and is deliberately left alone.
const FOOD_CONTEXT_WORDS = new Set([
  // grains & milling — the densest cluster for these terms in this catalog
  "grain", "grains", "wheat", "flour", "flours", "durum", "einkorn", "emmer",
  "spelt", "farro", "kamut", "rye", "barley", "oat", "oats", "rice", "corn",
  "maize", "masa", "hominy", "grits", "polenta", "millet", "sorghum", "quinoa",
  "buckwheat", "semolina", "bran", "berries", "mill", "milled", "stoneground",
  // baked & pasta
  "bread", "breads", "sourdough", "bakery", "baked", "baking", "pasta",
  "noodle", "noodles", "tortilla", "tortillas", "cracker", "crackers",
  "pastry", "cereal", "granola", "porridge",
  // livestock & protein
  "breed", "breeds", "livestock", "cattle", "pork", "beef", "lamb", "mutton",
  "poultry", "chicken", "turkey", "duck", "goose", "bison", "meat", "meats",
  "charcuterie", "sausage", "jerky", "egg", "eggs",
  // dairy
  "dairy", "cheese", "milk", "butter", "yogurt", "ghee", "creamery",
  // produce & farm
  "farm", "farms", "farmstead", "orchard", "homestead", "seed", "seeds",
  "heirlooms", "tomato", "tomatoes", "apple", "apples", "bean", "beans",
  "pepper", "peppers", "chile", "chiles", "squash", "melon", "produce",
  "vegetable", "vegetables", "fruit", "fruits", "nut", "nuts", "olive",
  "olives",
  // pantry, condiments, sweets
  "food", "foods", "recipe", "recipes", "pantry", "grocery", "preserve",
  "preserves", "jam", "jelly", "pickle", "pickles", "vinegar", "sauce",
  "salsa", "spice", "spices", "herb", "herbs", "syrup", "honey", "molasses",
  "chocolate", "cacao", "candy", "snack", "snacks", "oil", "salt", "sugar",
  // beverages (food-adjacent; same provenance language)
  "coffee", "tea", "beer", "brew", "brewery", "cider", "wine", "winery",
  "vineyard", "mead", "spirits", "whiskey", "whisky", "bourbon", "rum",
  "distillery", "kombucha", "juice",
]);

const SCOPED_SYNONYM_GROUPS = [
  {
    id: "provenance_food",
    words: ["heritage", "traditional", "ancient", "heirloom"],
    context: FOOD_CONTEXT_WORDS,
  },
];

const PRODUCT_SYNONYM_MAP = {};
for (const group of PRODUCT_SYNONYM_GROUPS) {
  for (const word of group) {
    const key = word.toLowerCase();
    if (!PRODUCT_SYNONYM_MAP[key]) PRODUCT_SYNONYM_MAP[key] = [];
    for (const other of group) {
      const otherLower = other.toLowerCase();
      if (otherLower !== key && !PRODUCT_SYNONYM_MAP[key].includes(otherLower)) {
        PRODUCT_SYNONYM_MAP[key].push(otherLower);
      }
    }
  }
}

/**
 * Expand a phrase by replacing individual words with product synonyms.
 * "nail clipper" → ["nail cutter", "nail trimmer"]
 * Multi-word synonyms are handled: "flip flops" in query → "sandals"
 */
function expandProductSynonyms(phrase) {
  if (!phrase) return [];
  const variants = new Set();
  const lower = phrase.toLowerCase();

  // Check for multi-word synonym matches first (e.g., "flip flops" → "sandals")
  for (const group of PRODUCT_SYNONYM_GROUPS) {
    for (const term of group) {
      if (term.includes(" ") && lower.includes(term)) {
        // Replace this multi-word term with each synonym
        for (const other of group) {
          if (other !== term) {
            variants.add(lower.replace(term, other));
          }
        }
      }
    }
  }

  // Single-word replacement: swap each word with its synonyms
  const words = lower.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const syns = PRODUCT_SYNONYM_MAP[words[i]];
    if (syns) {
      for (const syn of syns) {
        const variant = [...words];
        variant[i] = syn;
        variants.add(variant.join(" "));
      }
    }
  }

  // Context-scoped groups: only expand when another word in the query
  // establishes the domain (see SCOPED_SYNONYM_GROUPS). A one-word query
  // carries no context and is intentionally left unexpanded.
  for (const group of SCOPED_SYNONYM_GROUPS) {
    if (!words.some((w) => group.context.has(w))) continue;
    for (let i = 0; i < words.length; i++) {
      if (!group.words.includes(words[i])) continue;
      for (const other of group.words) {
        if (other === words[i]) continue;
        const variant = [...words];
        variant[i] = other;
        variants.add(variant.join(" "));
      }
    }
  }

  return Array.from(variants);
}

/**
 * Generate variants of a phrase by swapping business abbreviations.
 * "rocky mountain soda company" → ["rocky mountain soda co"]
 * "rocky mountain soda co" → ["rocky mountain soda company"]
 */
function expandBusinessAbbreviations(phrase) {
  if (!phrase) return [];
  const words = phrase.split(/\s+/);
  const variants = [];

  for (let i = 0; i < words.length; i++) {
    const word = words[i];

    // Full → abbreviation
    if (BUSINESS_ABBREVIATIONS[word]) {
      const variant = [...words];
      variant[i] = BUSINESS_ABBREVIATIONS[word];
      variants.push(variant.join(" "));
    }

    // Abbreviation → full word(s)
    if (ABBREV_TO_FULL[word]) {
      for (const full of ABBREV_TO_FULL[word]) {
        const variant = [...words];
        variant[i] = full;
        variants.push(variant.join(" "));
      }
    }
  }

  return variants;
}

let synonymCache = null;
let cacheExpiresAt = 0;

function env(k, d = "") {
  const v = process.env[k];
  return (v == null ? d : String(v)).trim();
}

/**
 * Load synonyms from Azure Storage with caching
 * Returns an object mapping normalized terms to arrays of synonyms
 * Example: { "bodywash": ["body wash"], "body wash": ["body wash"], ... }
 */
async function loadSynonyms() {
  const now = Date.now();
  
  // Return cached synonyms if still valid
  if (synonymCache && cacheExpiresAt > now) {
    return synonymCache;
  }

  try {
    const connectionString = env("AZURE_STORAGE_CONNECTION_STRING", "");
    if (!connectionString) {
      console.warn("[searchSynonyms] No AZURE_STORAGE_CONNECTION_STRING configured");
      return {};
    }

    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    const containerClient = blobServiceClient.getContainerClient("config");
    const blockBlobClient = containerClient.getBlockBlobClient("search_synonyms.json");

    const downloadBlockBlobResponse = await blockBlobClient.download(0);
    const downloadedData = await streamToString(downloadBlockBlobResponse.readableStreamBody);
    
    let synonyms = {};
    try {
      synonyms = JSON.parse(downloadedData);
      if (typeof synonyms !== "object" || synonyms === null) {
        synonyms = {};
      }
    } catch (e) {
      console.error("[searchSynonyms] Failed to parse search_synonyms.json:", e.message);
      synonyms = {};
    }

    // Cache the synonyms
    synonymCache = synonyms;
    cacheExpiresAt = now + CACHE_TTL_MS;

    return synonyms;
  } catch (e) {
    console.warn("[searchSynonyms] Failed to load synonyms from Azure Storage:", e.message);
    // Return empty synonyms but don't fail the search
    return {};
  }
}

async function streamToString(readableStream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readableStream.on("data", (data) => {
      chunks.push(data.toString("utf8"));
    });
    readableStream.on("end", () => {
      resolve(chunks.join(""));
    });
    readableStream.on("error", reject);
  });
}

/**
 * Expand a query into a set of search terms using synonyms
 * Takes normalized and compact forms, looks up in synonyms, returns arrays of terms to search
 * Also includes built-in common transformations (space → no-space variants)
 */
async function expandQueryTerms(q_norm, q_compact) {
  const synonyms = await loadSynonyms();

  const terms_norm = new Set();
  const terms_compact = new Set();

  // Always include the original normalized and compact forms
  if (q_norm) terms_norm.add(q_norm);
  if (q_compact) terms_compact.add(q_compact);

  // If the normalized form is in the synonyms map, add the mapped synonyms and their compact forms
  if (q_norm && synonyms[q_norm]) {
    const mappedSynonyms = synonyms[q_norm];
    if (Array.isArray(mappedSynonyms)) {
      for (const synonym of mappedSynonyms) {
        if (synonym && typeof synonym === "string") {
          terms_norm.add(synonym.toLowerCase().trim());
          const compact = synonym.toLowerCase().trim().replace(/\s+/g, "");
          if (compact) terms_compact.add(compact);
        }
      }
    }
  }

    // Also check the compact form in synonyms (e.g., "bodywash" → ["body wash"])
  if (q_compact && q_compact !== q_norm && synonyms[q_compact]) {
    const mappedSynonyms = synonyms[q_compact];
    if (Array.isArray(mappedSynonyms)) {
      for (const synonym of mappedSynonyms) {
        if (synonym && typeof synonym === "string") {
          terms_norm.add(synonym.toLowerCase().trim());
          const compact = synonym.toLowerCase().trim().replace(/\s+/g, "");
          if (compact) terms_compact.add(compact);
        }
      }
    }
  }

  // Expand business abbreviations in both directions
  // "rocky mountain soda company" → also search "rocky mountain soda co" (and vice versa)
  for (const term of [...terms_norm]) {
    for (const variant of expandBusinessAbbreviations(term)) {
      terms_norm.add(variant);
      const compact = variant.replace(/\s+/g, "");
      if (compact) terms_compact.add(compact);
    }
  }

  // Product synonym expansion (e.g., "nail clipper" → "nail cutter", "nail trimmer")
  for (const term of [...terms_norm]) {
    for (const variant of expandProductSynonyms(term)) {
      terms_norm.add(variant);
      const compact = variant.replace(/\s+/g, "");
      if (compact) terms_compact.add(compact);
    }
  }

  // Built-in common transformation: if query has no spaces, try adding space variants
  // This handles "bodywash" → also search for "body wash"
  if (q_norm && !q_norm.includes(" ") && q_norm.length > 4) {
    // Try some common space insertions for common compound words
    const commonSplits = buildCommonWordSplits(q_norm);
    // Limit to first 5 most likely splits to avoid excessive OR conditions
    for (let i = 0; i < Math.min(5, commonSplits.length); i++) {
      const split = commonSplits[i];
      terms_norm.add(split);
      const compact = split.replace(/\s+/g, "");
      if (compact) terms_compact.add(compact);
    }
  }

  // Add stemmed variants of all collected terms so plurals/singulars match
  for (const term of [...terms_norm]) {
    const stemmed = stemWords(term);
    if (stemmed && stemmed !== term) terms_norm.add(stemmed);
  }
  for (const term of [...terms_compact]) {
    const stemmed = stemWords(term);
    if (stemmed && stemmed !== term) terms_compact.add(stemmed);
  }

  return {
    terms_norm: Array.from(terms_norm).slice(0, 10),  // Limit to 10 terms max to avoid huge SQL
    terms_compact: Array.from(terms_compact).slice(0, 10),
  };
}

/**
 * Build common word splits for compound words without spaces
 * E.g., "bodywash" → ["body wash"]
 * This is a simple heuristic; more sophisticated solutions would use a dictionary
 * Returns splits ordered by likelihood (most likely first)
 */
function buildCommonWordSplits(word) {
  const splits = [];

  // Common compound words in product/business context - these are most likely
  const commonSplits = {
    "bodywash": "body wash",
    "bodywashe": "body wash",  // common misspelling
    "hairwash": "hair wash",
    "haircare": "hair care",
    "skincare": "skin care",
    "facewash": "face wash",
    "facecare": "face care",
    "eyecare": "eye care",
    "eyewash": "eye wash",
    "handwash": "hand wash",
    "handcare": "hand care",
    "lipscare": "lips care",
    "lipcare": "lip care",
  };

  // Add the exact match if it exists (highest priority)
  if (commonSplits[word]) {
    splits.push(commonSplits[word]);
  }

  // Add likely splits (common word lengths near middle)
  // For "bodywash" (9 chars), try splits near 4-5 which would give "body wash"
  const likelyPositions = [];
  if (word.length > 4) {
    const mid = Math.floor(word.length / 2);
    // Add positions around the middle
    for (let offset = -2; offset <= 2; offset++) {
      const pos = mid + offset;
      if (pos > 1 && pos < word.length - 1) {
        likelyPositions.push(pos);
      }
    }
  }

  // Add likely splits in order (without duplicates)
  const addedSplits = new Set(splits);
  for (const pos of likelyPositions) {
    const left = word.substring(0, pos);
    const right = word.substring(pos);
    // Only include if both parts are at least 2 characters
    if (left.length >= 2 && right.length >= 2) {
      const split = `${left} ${right}`;
      if (!addedSplits.has(split)) {
        splits.push(split);
        addedSplits.add(split);
      }
    }
  }

  // Finally, add all other possible splits
  for (let i = 2; i < word.length - 1; i++) {
    const left = word.substring(0, i);
    const right = word.substring(i);
    if (left.length >= 2 && right.length >= 2) {
      const split = `${left} ${right}`;
      if (!addedSplits.has(split)) {
        splits.push(split);
        addedSplits.add(split);
      }
    }
  }

  return splits;
}

/**
 * Expand query terms for Cosmos DB Full-Text Search.
 *
 * Unlike expandQueryTerms(), this returns only normalized phrases (no compact,
 * no stemmed variants) because FTS handles tokenization and stemming natively.
 * Each returned phrase represents an alternative search — the caller should
 * build FullTextContainsAll for each phrase and OR them together.
 *
 * Returns: { phrases: string[] }
 * Example: { phrases: ["rocky mountain soda company", "rocky mountain soda co"] }
 */
async function expandQueryTermsForFTS(q_norm, q_compact) {
  const synonyms = await loadSynonyms();
  const phrases = new Set();

  // Always include the original normalized form
  if (q_norm) phrases.add(q_norm);

  // Synonym lookup on normalized form
  if (q_norm && synonyms[q_norm]) {
    const mapped = synonyms[q_norm];
    if (Array.isArray(mapped)) {
      for (const s of mapped) {
        if (s && typeof s === "string") phrases.add(s.toLowerCase().trim());
      }
    }
  }

  // Synonym lookup on compact form
  if (q_compact && q_compact !== q_norm && synonyms[q_compact]) {
    const mapped = synonyms[q_compact];
    if (Array.isArray(mapped)) {
      for (const s of mapped) {
        if (s && typeof s === "string") phrases.add(s.toLowerCase().trim());
      }
    }
  }

  // Business abbreviation expansion
  for (const phrase of [...phrases]) {
    for (const variant of expandBusinessAbbreviations(phrase)) {
      phrases.add(variant);
    }
  }

  // Compound word splits — only use known dictionary matches (e.g., "bodywash" → "body wash")
  // Arbitrary middle-splits (e.g., "granola" → "gra nola") generate noise.
  // MUST run BEFORE product synonym expansion so a split form then feeds the
  // synonym groups (icemaker → "ice maker" → "ice machine"). While this ran
  // last, a solid spelling reached its split form and stopped there.
  if (q_norm && !q_norm.includes(" ") && q_norm.length > 4) {
    const knownSplits = {
      bodywash: "body wash", bodywashe: "body wash", hairwash: "hair wash",
      haircare: "hair care", skincare: "skin care", facewash: "face wash",
      facecare: "face care", eyecare: "eye care", eyewash: "eye wash",
      handwash: "hand wash", handcare: "hand care", lipscare: "lips care",
      lipcare: "lip care", lipgloss: "lip gloss", lipglosses: "lip gloss",
      lipbalm: "lip balm", lipliner: "lip liner",
      icemaker: "ice maker", icemakers: "ice makers",
      icemachine: "ice machine", icemachines: "ice machines",
    };
    if (knownSplits[q_norm]) {
      phrases.add(knownSplits[q_norm]);
    }
  }

  // Product synonym expansion (e.g., "nail clipper" → "nail cutter", "nail trimmer")
  for (const phrase of [...phrases]) {
    for (const variant of expandProductSynonyms(phrase)) {
      phrases.add(variant);
    }
  }

  // No stemming — FTS handles it natively
  // No compact forms — FTS tokenizes by whitespace

  return {
    phrases: Array.from(phrases).slice(0, 10),
  };
}

module.exports = {
  loadSynonyms,
  expandQueryTerms,
  expandQueryTermsForFTS,
  expandBusinessAbbreviations,
  expandProductSynonyms,
  SCOPED_SYNONYM_GROUPS,
  FOOD_CONTEXT_WORDS,
};
