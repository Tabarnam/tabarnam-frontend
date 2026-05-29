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

// ── Shared singleton CosmosClient ────────────────────────────────────────
// Creating a new CosmosClient per request leaks connections/handles and
// re-pays the TLS + endpoint-discovery cost. Cache one client per worker.
// Critically, the client is built with a `requestTimeout` so a slow/throttled
// query ABORTS instead of hanging the worker for the full function timeout
// (root cause of the recurring 500-storms: a hung search-companies query with
// no timeout pinned the single warm worker for ~10 min).
const COSMOS_REQUEST_TIMEOUT_MS = Number(process.env.COSMOS_REQUEST_TIMEOUT_MS || 30000);

let _cachedClient = null;
let _cachedClientKey = null;
let _cachedContainer = null;

function buildClient() {
  const { CosmosClient } = require("@azure/cosmos");
  const endpoint = resolveCosmosEndpoint();
  const key = resolveCosmosKey();
  if (!endpoint || !key) return null;
  // Cache key includes a key fingerprint so rotation invalidates the cached
  // client without needing a worker restart.
  const cacheKey = `${endpoint}|${key.length}:${key.slice(0, 4)}`;
  if (_cachedClient && _cachedClientKey === cacheKey) return _cachedClient;
  _cachedClient = new CosmosClient({
    endpoint,
    key,
    connectionPolicy: { requestTimeout: COSMOS_REQUEST_TIMEOUT_MS },
  });
  _cachedClientKey = cacheKey;
  _cachedContainer = null; // invalidate container cache when client changes
  return _cachedClient;
}

/**
 * Returns a process-wide cached CosmosClient (with requestTimeout), or null if
 * credentials are missing. Reuse this instead of `new CosmosClient(...)`.
 */
function getCosmosClient() {
  return buildClient();
}

/**
 * Returns the cached companies container (database + container resolved from
 * config), or null if credentials are missing.
 */
function getCompaniesContainer() {
  const client = buildClient();
  if (!client) return null;
  if (!_cachedContainer) {
    _cachedContainer = client
      .database(resolveCosmosDatabaseId())
      .container(resolveCosmosContainerId());
  }
  return _cachedContainer;
}

module.exports = {
  resolveCosmosEndpoint,
  resolveCosmosKey,
  resolveCosmosDatabaseId,
  resolveCosmosContainerId,
  getCosmosConfig,
  getCosmosClient,
  getCompaniesContainer,
  COSMOS_REQUEST_TIMEOUT_MS,
};
