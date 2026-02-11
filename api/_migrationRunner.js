/**
 * Database migration framework for Cosmos DB.
 *
 * Tracks applied migrations in a metadata document stored in the companies
 * container with id "_db_migrations" and partition key "import" (reusing the
 * well-established control-document partition).
 *
 * Each migration is a CommonJS module in api/migrations/ exporting:
 *   module.exports = { id, description, up(ctx) }
 *
 * `ctx` provides:  { database, containers, log, dryRun }
 *   - database:   CosmosClient database handle
 *   - containers: Map<name, containerHandle>  (pre-resolved)
 *   - log:        function(...args)
 *   - dryRun:     boolean
 */

const { readdirSync } = require("node:fs");
const { join } = require("node:path");

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = join(__dirname, "migrations");

function discoverMigrations() {
  let files;
  try {
    files = readdirSync(MIGRATIONS_DIR);
  } catch {
    return [];
  }

  return files
    .filter((f) => /^\d{4}[_-]/.test(f) && f.endsWith(".js"))
    .sort()
    .map((f) => {
      const mod = require(join(MIGRATIONS_DIR, f));
      if (!mod || typeof mod.up !== "function" || !mod.id) {
        throw new Error(`Migration file ${f} must export { id, description, up }`);
      }
      return { file: f, ...mod };
    });
}

// ---------------------------------------------------------------------------
// State management (Cosmos metadata document)
// ---------------------------------------------------------------------------

const META_DOC_ID = "_db_migrations";
const META_PARTITION_KEY = "import";

async function readMigrationState(container) {
  try {
    const { resource } = await container.item(META_DOC_ID, META_PARTITION_KEY).read();
    return resource || null;
  } catch (e) {
    if (e?.code === 404) return null;
    throw e;
  }
}

async function writeMigrationState(container, state) {
  const doc = {
    ...state,
    id: META_DOC_ID,
    normalized_domain: META_PARTITION_KEY,
    partition_key: META_PARTITION_KEY,
    updated_at: new Date().toISOString(),
  };
  await container.items.upsert(doc, { partitionKey: META_PARTITION_KEY });
  return doc;
}

// ---------------------------------------------------------------------------
// Container resolver — lazily resolves all known containers
// ---------------------------------------------------------------------------

const KNOWN_CONTAINERS = [
  { envKey: "COSMOS_DB_COMPANIES_CONTAINER", envAlias: "COSMOS_CONTAINER", default: "companies" },
  { envKey: "COSMOS_DB_REVIEWS_CONTAINER", default: "reviews" },
  { envKey: "COSMOS_DB_NOTES_CONTAINER", default: "notes" },
  { envKey: "COSMOS_DB_NOTES_ADMIN_CONTAINER", default: "notes_admin" },
  { envKey: "COSMOS_DB_COMPANY_EDIT_HISTORY_CONTAINER", default: "company_edit_history" },
  { envKey: "COSMOS_DB_LOGS_CONTAINER", default: "import_logs" },
  { name: "analytics" },
  { name: "keywords" },
];

function resolveContainerName(spec) {
  if (spec.name) return spec.name;
  const primary = process.env[spec.envKey];
  if (primary) return primary.trim();
  if (spec.envAlias) {
    const alt = process.env[spec.envAlias];
    if (alt) return alt.trim();
  }
  return spec.default;
}

function getContainerHandles(database) {
  const map = new Map();
  for (const spec of KNOWN_CONTAINERS) {
    const name = resolveContainerName(spec);
    if (name && !map.has(name)) {
      map.set(name, database.container(name));
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function runMigrations({ database, log = console.log, dryRun = false } = {}) {
  if (!database) throw new Error("database handle is required");

  const migrations = discoverMigrations();
  if (migrations.length === 0) {
    log("[migrations] No migration files found in", MIGRATIONS_DIR);
    return { applied: [], skipped: [], total: 0 };
  }

  const containers = getContainerHandles(database);

  // Read current state from the companies container
  const companiesContainer = containers.get(
    resolveContainerName(KNOWN_CONTAINERS[0])
  );
  if (!companiesContainer) {
    throw new Error("Cannot resolve companies container for migration state");
  }

  const state = (await readMigrationState(companiesContainer)) || {
    applied_migrations: [],
    version: 0,
  };

  const appliedSet = new Set(state.applied_migrations || []);
  const pending = migrations.filter((m) => !appliedSet.has(m.id));

  if (pending.length === 0) {
    log(`[migrations] All ${migrations.length} migration(s) already applied.`);
    return { applied: [], skipped: migrations.map((m) => m.id), total: migrations.length };
  }

  log(`[migrations] ${pending.length} pending migration(s) to apply (${dryRun ? "DRY RUN" : "LIVE"}).`);

  const applied = [];
  const ctx = { database, containers, log, dryRun };

  for (const migration of pending) {
    log(`[migrations] Running: ${migration.id} — ${migration.description || "(no description)"}`);
    try {
      await migration.up(ctx);
      applied.push(migration.id);

      if (!dryRun) {
        state.applied_migrations = [...(state.applied_migrations || []), migration.id];
        state.version = (state.version || 0) + 1;
        state.last_applied = migration.id;
        state.last_applied_at = new Date().toISOString();
        await writeMigrationState(companiesContainer, state);
      }

      log(`[migrations] Done: ${migration.id}`);
    } catch (e) {
      log(`[migrations] FAILED: ${migration.id} — ${e?.message || String(e)}`);
      throw e;
    }
  }

  return {
    applied,
    skipped: migrations.filter((m) => appliedSet.has(m.id)).map((m) => m.id),
    total: migrations.length,
  };
}

module.exports = {
  discoverMigrations,
  readMigrationState,
  writeMigrationState,
  runMigrations,
  getContainerHandles,
  KNOWN_CONTAINERS,
  META_DOC_ID,
  META_PARTITION_KEY,
  // Exposed for testing
  _resolveContainerName: resolveContainerName,
};
