/**
 * Startup configuration validation.
 * Logs warnings for missing environment variables so misconfigurations
 * are caught immediately on cold start rather than at request time.
 */

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

function validateConfig() {
  const missing = [];
  const unset = [];

  for (const key of REQUIRED) {
    if (!process.env[key]) missing.push(key);
  }
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
  if (!missing.length && !unset.length) {
    console.log("[config] All required and recommended env vars are set.");
  }

  return { missing, unset };
}

module.exports = { validateConfig };
