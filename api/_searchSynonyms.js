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
 */
function buildCommonWordSplits(word) {
  const splits = new Set();

  // Common compound words in product/business context - try these first
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
  };

  if (commonSplits[word]) {
    splits.add(commonSplits[word]);
  }

  // Also try all possible two-word splits for any word
  // This creates all possible single-position splits
  for (let i = 1; i < word.length; i++) {
    const left = word.substring(0, i);
    const right = word.substring(i);
    // Only include if both parts are at least 2 characters
    if (left.length >= 2 && right.length >= 2) {
      splits.add(`${left} ${right}`);
    }
  }

  return Array.from(splits);
}

module.exports = {
  loadSynonyms,
  expandQueryTerms,
};
