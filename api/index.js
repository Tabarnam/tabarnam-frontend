/* eslint-disable no-console */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// This file only auto-loads sub-function folders (e.g. proxy-xai, import-progress, etc).
// DO NOT register a /proxy-xai handler here; it lives in /api/proxy-xai/index.js.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXCLUDE = new Set(["node_modules", "scripts", "bin", ".git", ".vscode"]);

for (const entry of fs.readdirSync(__dirname, { withFileTypes: true })) {
  if (!entry.isDirectory() || EXCLUDE.has(entry.name)) continue;
  const abs = path.join(__dirname, entry.name, "index.js");
  if (!fs.existsSync(abs)) continue;

  try {
    const spec = new URL(`./${entry.name}/index.js`, import.meta.url);
    await import(spec);
    console.log(`Loaded function: ${entry.name}`);
  } catch (e) {
    console.warn(`Failed to load ./${entry.name}/index.js → ${e.message}`);
  }
}

console.log("Function modules imported.");
