/**
 * Centralized Cosmos DB configuration resolver.
 *
 * Consolidates the many env-var alias fallback chains scattered across the
 * codebase into a single source of truth. Every module that needs Cosmos
 * credentials should `require("./_cosmosConfig")` instead of re-implementing
 * its own `process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT`
 * chain.
 *
 * Canonical env var names (set these in production):
 *   COSMOS_DB_ENDPOINT             – account endpoint URL
 *   COSMOS_DB_KEY                  – account primary key
 *   COSMOS_DB_DATABASE             – database id     (default: "tabarnam-db")
 *   COSMOS_DB_COMPANIES_CONTAINER  – container id    (default: "companies")
 *
 * Legacy aliases (still supported for backwards compatibility):
 *   COSMOS_DB_DB_ENDPOINT, COSMOS_ENDPOINT   → COSMOS_DB_ENDPOINT
 *   COSMOS_DB_DB_KEY, COSMOS_KEY             → COSMOS_DB_KEY
 *   COSMOS_DB                                → COSMOS_DB_DATABASE
 *   COSMOS_CONTAINER                         → COSMOS_DB_COMPANIES_CONTAINER
 */

function resolveCosmosEndpoint() {
  return (
    process.env.COSMOS_DB_ENDPOINT ||
    process.env.COSMOS_DB_DB_ENDPOINT ||
    process.env.COSMOS_ENDPOINT ||
    ""
  ).trim();
}

function resolveCosmosKey() {
  return (
    process.env.COSMOS_DB_KEY ||
    process.env.COSMOS_DB_DB_KEY ||
    process.env.COSMOS_KEY ||
    ""
  ).trim();
}

function resolveCosmosDatabaseId() {
  return (
    process.env.COSMOS_DB_DATABASE ||
    process.env.COSMOS_DB ||
    "tabarnam-db"
  ).trim();
}

function resolveCosmosContainerId() {
  return (
    process.env.COSMOS_DB_COMPANIES_CONTAINER ||
    process.env.COSMOS_CONTAINER ||
    "companies"
  ).trim();
}

/**
 * Returns all four resolved Cosmos config values in one call.
 * Useful when a module needs to create its own CosmosClient.
 */
function getCosmosConfig() {
  return {
    endpoint: resolveCosmosEndpoint(),
    key: resolveCosmosKey(),
    databaseId: resolveCosmosDatabaseId(),
    containerId: resolveCosmosContainerId(),
  };
}

module.exports = {
  resolveCosmosEndpoint,
  resolveCosmosKey,
  resolveCosmosDatabaseId,
  resolveCosmosContainerId,
  getCosmosConfig,
};
