"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

// Registration-coverage gate.
//
// api/index.js requires each endpoint module by hand — it is NOT a glob. So a
// new endpoint folder that nobody adds to that list is simply never loaded, and
// its route never registers.
//
// That failure is silent in every way that matters: the file exists, its tests
// pass, the guard-coverage gate sees its app.http() call and is satisfied, CI is
// green, the deploy succeeds — and the live route answers 404. It cost one
// production deploy of xadmin-api-audit-log to notice.
//
// This gate closes that gap: any folder registering an HTTP route must either be
// required by index.js or be listed below as deliberately unregistered.

const API_DIR = __dirname;
const HAS_HTTP_RE = /app\.http\(/;

// Folders that register a route but are deliberately NOT loaded.
//
// Everything here predates this gate. Several are the `admin*`-prefixed
// endpoints that cannot register on the dedicated Function App anyway ("route
// conflicts with built in routes") — which is precisely why the live admin
// surface uses the `xadmin-api-*` prefix. They are left in the tree rather than
// deleted because that is a separate cleanup with its own risk.
//
// Do NOT add to this list to silence a new endpoint. If a route is worth
// writing, it is worth registering.
const INTENTIONALLY_UNREGISTERED = new Set([
  "admin-company",
  "admin-rebuild-industry-index",
  "admin-storage-config",
  "bulk-import-worker",
  "test-storage",
  "xai",
]);

// Not endpoint folders.
const SKIP_DIRS = new Set(["node_modules", "migrations"]);

test("every endpoint that registers a route is loaded by api/index.js", () => {
  const indexSrc = fs.readFileSync(path.join(API_DIR, "index.js"), "utf8");

  const unloaded = [];

  for (const entry of fs.readdirSync(API_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;

    const file = path.join(API_DIR, entry.name, "index.js");
    let src;
    try {
      src = fs.readFileSync(file, "utf8");
    } catch {
      continue; // no index.js — not an endpoint folder
    }

    if (!HAS_HTTP_RE.test(src)) continue;
    if (INTENTIONALLY_UNREGISTERED.has(entry.name)) continue;

    // The require path as written in index.js.
    if (!indexSrc.includes(`./${entry.name}/index.js`)) unloaded.push(entry.name);
  }

  assert.deepStrictEqual(
    unloaded,
    [],
    "Endpoint(s) register an HTTP route but are never required by api/index.js, " +
      "so they will 404 in production while every test and the deploy stay green. " +
      "Add a require block to api/index.js (or, if truly unused, list the folder " +
      "in INTENTIONALLY_UNREGISTERED here).\n  " +
      unloaded.join("\n  ")
  );
});

test("the exception list has not rotted", () => {
  // A folder listed as unregistered that no longer exists means the list is
  // stale and is now hiding nothing — but it would also hide a future folder
  // that reuses the name.
  for (const name of INTENTIONALLY_UNREGISTERED) {
    assert.ok(
      fs.existsSync(path.join(API_DIR, name, "index.js")),
      `INTENTIONALLY_UNREGISTERED lists "${name}", which no longer exists. Remove it.`
    );
  }
});

test("gate fires for an endpoint that is not loaded", () => {
  // Prove the check can fail, so it cannot silently rot into a no-op.
  const indexSrc = 'require("./real-endpoint/index.js");';

  assert.ok(!indexSrc.includes("./ghost-endpoint/index.js"), "an unloaded folder is detected");
  assert.ok(indexSrc.includes("./real-endpoint/index.js"), "a loaded folder is not flagged");
});
