/**
 * Startup configuration validation.
 * Logs warnings for missing environment variables so misconfigurations
 * are caught immediately on cold start rather than at request time.
 *
 * Uses _cosmosConfig.js for centralized Cosmos DB env var resolution
 * (handles legacy aliases like COSMOS_DB_DB_ENDPOINT automatically).
 */

const { getCosmosConfig } = require("./_cosmosConfig");

const REQUIRED = [
  "COSMOS_DB_ENDPOINT",
  "COSMOS_DB_KEY",
  "COSMOS_DB_DATABASE",
  "COSMOS_DB_COMPANIES_CONTAINER",
];

const RECOMMENDED = [
  "XAI_EXTERNAL_BASE",
  "XAI_API_KEY",
  "AZURE_STORAGE_ACCOUNT_NAME",
  "AZURE_STORAGE_ACCOUNT_KEY",
];

// Legacy env var names that should be migrated to canonical names.
const LEGACY_ALIASES = {
  COSMOS_DB_DB_ENDPOINT: "COSMOS_DB_ENDPOINT",
  COSMOS_ENDPOINT: "COSMOS_DB_ENDPOINT",
  COSMOS_DB_DB_KEY: "COSMOS_DB_KEY",
  COSMOS_KEY: "COSMOS_DB_KEY",
  COSMOS_DB: "COSMOS_DB_DATABASE",
  COSMOS_CONTAINER: "COSMOS_DB_COMPANIES_CONTAINER",
  XAI_BASE_URL: "XAI_EXTERNAL_BASE",
  FUNCTION_URL: "XAI_EXTERNAL_BASE",
  XAI_BASE: "XAI_EXTERNAL_BASE",
  XAI_INTERNAL_BASE: "XAI_EXTERNAL_BASE",
  XAI_UPSTREAM_BASE: "XAI_EXTERNAL_BASE",
  FUNCTION_KEY: "XAI_API_KEY or XAI_EXTERNAL_KEY",
  XAI_UPSTREAM_KEY: "XAI_API_KEY or XAI_EXTERNAL_KEY",
  GOOGLE_GEOCODE_KEY: "GOOGLE_MAPS_KEY",
};

function validateConfig() {
  const missing = [];
  const unset = [];

  // Check required vars via centralized config (handles aliases automatically)
  const cosmos = getCosmosConfig();
  if (!cosmos.endpoint) missing.push("COSMOS_DB_ENDPOINT");
  if (!cosmos.key) missing.push("COSMOS_DB_KEY");
  // database and container have defaults, so just check the env var directly
  if (!process.env.COSMOS_DB_DATABASE && !process.env.COSMOS_DB) missing.push("COSMOS_DB_DATABASE");
  if (!process.env.COSMOS_DB_COMPANIES_CONTAINER && !process.env.COSMOS_CONTAINER) missing.push("COSMOS_DB_COMPANIES_CONTAINER");

  for (const key of RECOMMENDED) {
    if (!process.env[key]) unset.push(key);
  }

  if (missing.length) {
    console.error(
      `[config] MISSING required env vars (API may fail): ${missing.join(", ")}`
    );
  }
  if (unset.length) {
    console.warn(
      `[config] Unset recommended env vars (some features disabled): ${unset.join(", ")}`
    );
  }

  // Warn about legacy alias usage
  const legacyInUse = [];
  for (const [legacy, canonical] of Object.entries(LEGACY_ALIASES)) {
    if (process.env[legacy]) {
      legacyInUse.push(`${legacy} → ${canonical}`);
    }
  }
  if (legacyInUse.length) {
    console.warn(
      `[config] Legacy env vars detected (migrate to canonical names): ${legacyInUse.join(", ")}`
    );
  }

  if (!missing.length && !unset.length) {
    console.log("[config] All required and recommended env vars are set.");
  }

  return { missing, unset, legacyInUse };
}

module.exports = { validateConfig, LEGACY_ALIASES };
