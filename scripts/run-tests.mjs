#!/usr/bin/env node
/**
 * Cross-platform test runner. With no args, discovers all api/**\/*.test.js
 * files and runs them via `node --test`. With args, runs `node --test` on
 * the given files (used by lint-staged so the bypass env applies on Windows).
 */
import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

function findTestFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") {
      results.push(...findTestFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".test.js")) {
      // Use forward slashes for node --test compatibility
      results.push(full.split("\\").join("/"));
    }
  }
  return results;
}

const argFiles = process.argv.slice(2).map((f) => f.split("\\").join("/"));
const files = argFiles.length ? argFiles : findTestFiles(join(PROJECT_ROOT, "api"));
if (!files.length) {
  console.log("No test files found.");
  process.exit(0);
}

console.log(`Found ${files.length} test file(s):\n${files.map((f) => `  ${f}`).join("\n")}\n`);

try {
  execSync(
    `node --test --test-force-exit --test-timeout 60000 ${files.join(" ")}`,
    {
      stdio: "inherit",
      // Bypass adminGuard (api/_adminAuth.js) so admin contract tests can
      // exercise handler logic without supplying a SWA principal header.
      env: { ...process.env, TABARNAM_DEV_BYPASS: "1" },
    }
  );
} catch (e) {
  process.exit(e.status || 1);
}
