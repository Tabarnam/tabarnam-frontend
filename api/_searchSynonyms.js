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

  return {
    terms_norm: Array.from(terms_norm),
    terms_compact: Array.from(terms_compact),
  };
}

module.exports = {
  loadSynonyms,
  expandQueryTerms,
};
