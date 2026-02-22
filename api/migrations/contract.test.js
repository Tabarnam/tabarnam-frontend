const test = require("node:test");
const assert = require("node:assert/strict");

const {
  discoverMigrations,
  META_DOC_ID,
  META_PARTITION_KEY,
  KNOWN_CONTAINERS,
  _resolveContainerName,
} = require("../_migrationRunner");

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

test("discoverMigrations returns an array", () => {
  const migrations = discoverMigrations();
  assert.ok(Array.isArray(migrations), "should return an array");
});

test("discoverMigrations finds at least one migration", () => {
  const migrations = discoverMigrations();
  assert.ok(migrations.length >= 1, "should find at least the 0001 migration");
});

test("each discovered migration has id, description, and up function", () => {
  const migrations = discoverMigrations();
  for (const m of migrations) {
    assert.ok(typeof m.id === "string" && m.id.length > 0, `migration should have id, got: ${m.id}`);
    assert.ok(typeof m.description === "string", `migration ${m.id} should have description`);
    assert.ok(typeof m.up === "function", `migration ${m.id} should have up() function`);
    assert.ok(typeof m.file === "string", `migration ${m.id} should have file name`);
  }
});

test("migrations are sorted by file name", () => {
  const migrations = discoverMigrations();
  const files = migrations.map((m) => m.file);
  const sorted = [...files].sort();
  assert.deepStrictEqual(files, sorted, "migrations should be in file-name order");
});

test("migration ids are unique", () => {
  const migrations = discoverMigrations();
  const ids = migrations.map((m) => m.id);
  const unique = new Set(ids);
  assert.equal(ids.length, unique.size, "all migration ids should be unique");
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test("META_DOC_ID is _db_migrations", () => {
  assert.equal(META_DOC_ID, "_db_migrations");
});

test("META_PARTITION_KEY is import", () => {
  assert.equal(META_PARTITION_KEY, "import");
});

// ---------------------------------------------------------------------------
// Container resolution
// ---------------------------------------------------------------------------

test("KNOWN_CONTAINERS has at least 8 entries", () => {
  assert.ok(KNOWN_CONTAINERS.length >= 8, `expected >= 8, got ${KNOWN_CONTAINERS.length}`);
});

test("_resolveContainerName returns default for spec without env vars", () => {
  const spec = { envKey: "NONEXISTENT_ENV_VAR_XYZ_123", default: "test-container" };
  assert.equal(_resolveContainerName(spec), "test-container");
});

test("_resolveContainerName returns name property directly", () => {
  const spec = { name: "analytics" };
  assert.equal(_resolveContainerName(spec), "analytics");
});

// ---------------------------------------------------------------------------
// 0001 migration module
// ---------------------------------------------------------------------------

test("0001_ensure-containers exports correct shape", () => {
  const migration = require("./0001_ensure-containers");
  assert.equal(migration.id, "0001_ensure-containers");
  assert.ok(typeof migration.description === "string" && migration.description.length > 0);
  assert.ok(typeof migration.up === "function");
});

test("0001_ensure-containers up() in dry-run mode does not throw", async () => {
  const migration = require("./0001_ensure-containers");
  const logs = [];
  const ctx = {
    database: null,
    containers: new Map(),
    log: (...args) => logs.push(args.join(" ")),
    dryRun: true,
  };

  await migration.up(ctx);
  assert.ok(logs.length >= 8, `should log for each container, got ${logs.length} log lines`);
  assert.ok(logs.every((l) => l.includes("[dry-run]")), "all logs should be dry-run messages");
});

// ---------------------------------------------------------------------------
// runMigrations (unit-level with mock database)
// ---------------------------------------------------------------------------

test("runMigrations requires database handle", async () => {
  const { runMigrations } = require("../_migrationRunner");
  await assert.rejects(
    () => runMigrations({ database: null }),
    (err) => err.message.includes("database handle is required")
  );
});

test("runMigrations applies pending migrations to mock database", async () => {
  const { runMigrations } = require("../_migrationRunner");

  // Build a minimal mock database that tracks calls
  const upserted = [];
  const created = [];

  const mockContainer = {
    item: () => ({
      read: async () => {
        const err = new Error("Not found");
        err.code = 404;
        throw err;
      },
    }),
    items: {
      upsert: async (doc, opts) => {
        upserted.push({ doc, opts });
        return { resource: doc };
      },
    },
    // Support container-level read/replace for migrations that modify container config
    read: async () => ({
      resource: {
        id: "companies",
        partitionKey: { paths: ["/normalized_domain"] },
        indexingPolicy: { indexingMode: "consistent", automatic: true, includedPaths: [{ path: "/*" }], excludedPaths: [] },
      },
    }),
    replace: async (def) => ({ resource: def }),
  };

  const mockDatabase = {
    container: (name) => mockContainer,
    containers: {
      createIfNotExists: async (spec) => {
        created.push(spec);
        return { container: mockContainer };
      },
    },
  };

  const logs = [];
  const result = await runMigrations({
    database: mockDatabase,
    log: (...args) => logs.push(args.join(" ")),
    dryRun: false,
  });

  assert.ok(result.applied.length >= 1, "should apply at least 1 migration");
  assert.ok(result.total >= 1, "total should be >= 1");
  assert.ok(upserted.length >= 1, "should upsert migration state doc");

  // Verify the state document structure
  const stateDoc = upserted[upserted.length - 1]?.doc;
  assert.equal(stateDoc.id, "_db_migrations");
  assert.equal(stateDoc.normalized_domain, "import");
  assert.ok(Array.isArray(stateDoc.applied_migrations));
  assert.ok(stateDoc.applied_migrations.length >= 1);
  assert.ok(typeof stateDoc.version === "number" && stateDoc.version >= 1);
  assert.ok(typeof stateDoc.updated_at === "string");
});

test("runMigrations skips already-applied migrations", async () => {
  const { runMigrations, discoverMigrations } = require("../_migrationRunner");

  const allMigrations = discoverMigrations();
  const allIds = allMigrations.map((m) => m.id);

  const mockContainer = {
    item: () => ({
      read: async () => ({
        resource: {
          id: "_db_migrations",
          applied_migrations: allIds,
          version: allIds.length,
        },
      }),
    }),
    items: {
      upsert: async () => ({}),
    },
  };

  const mockDatabase = {
    container: () => mockContainer,
    containers: { createIfNotExists: async () => ({}) },
  };

  const result = await runMigrations({
    database: mockDatabase,
    log: () => {},
    dryRun: false,
  });

  assert.equal(result.applied.length, 0, "nothing should be applied");
  assert.deepStrictEqual(result.skipped, allIds, "all should be skipped");
});

test("runMigrations dry-run does not write state", async () => {
  const { runMigrations } = require("../_migrationRunner");

  const upserted = [];

  const mockContainer = {
    item: () => ({
      read: async () => {
        const err = new Error("Not found");
        err.code = 404;
        throw err;
      },
    }),
    items: {
      upsert: async (doc) => {
        upserted.push(doc);
        return { resource: doc };
      },
    },
    // Support container-level read/replace for migrations that modify container config
    read: async () => ({
      resource: {
        id: "companies",
        partitionKey: { paths: ["/normalized_domain"] },
        indexingPolicy: { indexingMode: "consistent", automatic: true, includedPaths: [{ path: "/*" }], excludedPaths: [] },
      },
    }),
    replace: async (def) => ({ resource: def }),
  };

  const mockDatabase = {
    container: () => mockContainer,
    containers: { createIfNotExists: async () => ({}) },
  };

  const result = await runMigrations({
    database: mockDatabase,
    log: () => {},
    dryRun: true,
  });

  assert.ok(result.applied.length >= 1, "should report applied even in dry-run");
  assert.equal(upserted.length, 0, "should NOT write state doc in dry-run mode");
});

test("runMigrations propagates migration errors", async () => {
  const { runMigrations } = require("../_migrationRunner");

  // This test confirms that if a migration's up() throws, runMigrations re-throws
  const mockContainer = {
    item: () => ({
      read: async () => {
        const err = new Error("Not found");
        err.code = 404;
        throw err;
      },
    }),
    items: {
      upsert: async () => ({}),
    },
  };

  const mockDatabase = {
    container: () => mockContainer,
    containers: {
      // Force a failure in the 0001 migration
      createIfNotExists: async () => {
        throw new Error("Simulated Cosmos failure");
      },
    },
  };

  await assert.rejects(
    () => runMigrations({ database: mockDatabase, log: () => {}, dryRun: false }),
    (err) => err.message.includes("Simulated Cosmos failure")
  );
});
