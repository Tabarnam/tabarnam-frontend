/**
 * Search synonyms loader from Azure Blob Storage
 * Loads and caches search_synonyms.json with TTL
 */

const { BlobServiceClient } = require("@azure/storage-blob");

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
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

module.exports = {
  loadSynonyms,
  expandQueryTerms,
};
