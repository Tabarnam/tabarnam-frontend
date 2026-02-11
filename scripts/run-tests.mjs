#!/usr/bin/env node
/**
 * Cross-platform test runner that discovers all api/**\/*.test.js files
 * and runs them via `node --test`. Replaces the hardcoded file list in
 * package.json so new test files are picked up automatically.
 */
import { execSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";

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

const files = findTestFiles("api");
if (!files.length) {
  console.log("No test files found.");
  process.exit(0);
}

console.log(`Found ${files.length} test file(s):\n${files.map((f) => `  ${f}`).join("\n")}\n`);

try {
  execSync(
    `node --test --test-force-exit --test-timeout 60000 ${files.join(" ")}`,
    { stdio: "inherit" }
  );
} catch (e) {
  process.exit(e.status || 1);
}
