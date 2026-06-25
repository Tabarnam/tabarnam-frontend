// Drift guard for the admin allowlist.
//
// The admin email allowlist exists in two places that MUST stay in sync:
//   - backend  api/_adminAuth.js          (FALLBACK_ADMIN_EMAILS) — authoritative
//   - frontend src/lib/azureAuth.ts        (ADMIN_USERS) — drives the AdminRoute UI gate
//
// If they drift, the UI and the API disagree about who is an admin (e.g. someone
// removed from the backend can still see the admin shell, or vice-versa). This
// test reads both source files and fails CI if the lists diverge. The real fix
// for true single-sourcing is the ADMIN_EMAILS env var (read by the backend); the
// frontend fallback must mirror whatever ships as the default.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function extractEmails(src, varName) {
  const block = src.match(new RegExp(`${varName}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
  if (!block) return null;
  return [...block[1].matchAll(/['"`]([^'"`]+@[^'"`]+)['"`]/g)]
    .map((m) => m[1].trim().toLowerCase())
    .sort();
}

test("frontend and backend admin allowlists match", () => {
  const backendSrc = fs.readFileSync(path.join(__dirname, "_adminAuth.js"), "utf8");
  const frontendSrc = fs.readFileSync(
    path.join(__dirname, "..", "src", "lib", "azureAuth.ts"),
    "utf8"
  );

  const backend = extractEmails(backendSrc, "FALLBACK_ADMIN_EMAILS");
  const frontend = extractEmails(frontendSrc, "ADMIN_USERS");

  assert.ok(backend && backend.length, "could not parse FALLBACK_ADMIN_EMAILS from api/_adminAuth.js");
  assert.ok(frontend && frontend.length, "could not parse ADMIN_USERS from src/lib/azureAuth.ts");

  assert.deepStrictEqual(
    frontend,
    backend,
    "Admin allowlists drifted. Update BOTH api/_adminAuth.js (FALLBACK_ADMIN_EMAILS) and " +
      "src/lib/azureAuth.ts (ADMIN_USERS) so they match.\n" +
      `  backend:  ${JSON.stringify(backend)}\n  frontend: ${JSON.stringify(frontend)}`
  );
});
