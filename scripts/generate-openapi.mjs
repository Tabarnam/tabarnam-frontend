#!/usr/bin/env node
/**
 * generate-openapi.mjs
 *
 * Loads the API index to trigger all route registrations, then uses
 * app._test.listHttpRegistrations() to build an OpenAPI 3.0.3 spec
 * and writes it to api/openapi.json.
 */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "..");

// Set up a CJS require anchored at the project root so that
// require("./api/index.js") resolves correctly.
const require = createRequire(resolve(projectRoot, "package.json"));

// ---------------------------------------------------------------------------
// 1. Load the API index (CommonJS) to trigger all route registrations.
//    Some modules may log warnings about missing env vars -- that is fine.
// ---------------------------------------------------------------------------
let app;
try {
  app = require("./api/index.js");
} catch (err) {
  console.error("[generate-openapi] Failed to load api/index.js:", err.message);
  process.exit(1);
}

if (!app?._test?.listHttpRegistrations) {
  console.error(
    "[generate-openapi] app._test.listHttpRegistrations is not available."
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Retrieve all registered HTTP routes.
// ---------------------------------------------------------------------------
const registrations = app._test.listHttpRegistrations();
console.log(
  `[generate-openapi] Found ${registrations.length} registered route(s).`
);

// ---------------------------------------------------------------------------
// 3. Helpers
// ---------------------------------------------------------------------------

/** Classify a route into a tag name. */
function tagForRoute(route) {
  if (route.startsWith("xadmin-api-") || route.startsWith("xadmin-api/")) return "XAdmin";
  if (route.startsWith("admin-") || route.startsWith("admin/")) return "Admin";
  if (route.startsWith("import-") || route.startsWith("import/")) return "Import";
  return "Public";
}

/** Whether a route requires the admin security scheme. */
function isSecured(route) {
  const tag = tagForRoute(route);
  return tag === "Admin" || tag === "XAdmin";
}

/** Normalise method strings to lowercase. */
function normaliseMethods(methods) {
  if (!Array.isArray(methods) || methods.length === 0) {
    // If no methods specified, Azure Functions defaults to GET and POST.
    return ["get", "post"];
  }
  return methods
    .map((m) => String(m).toLowerCase())
    .filter((m) => m !== "options"); // OPTIONS is implied by CORS
}

// ---------------------------------------------------------------------------
// 4. Build the OpenAPI spec.
// ---------------------------------------------------------------------------
const paths = {};

for (const reg of registrations) {
  const { name, route } = reg;
  if (!route) continue;

  const pathKey = `/api/${route}`;
  const methods = normaliseMethods(reg.methods);
  const tag = tagForRoute(route);

  if (!paths[pathKey]) paths[pathKey] = {};

  for (const method of methods) {
    const operation = {
      operationId: name,
      summary: name,
      tags: [tag],
      responses: {
        "200": {
          description: "Successful response",
          content: {
            "application/json": {
              schema: {
                type: "object",
              },
            },
          },
        },
      },
    };

    if (isSecured(route)) {
      operation.security = [{ adminAuth: [] }];
    }

    // When multiple methods share the same path, append the method to
    // operationId so each one is unique (OpenAPI requires unique operationIds).
    if (methods.length > 1) {
      operation.operationId = `${name}_${method}`;
    }

    paths[pathKey][method] = operation;
  }
}

const spec = {
  openapi: "3.0.3",
  info: {
    title: "Tabarnam API",
    description:
      "Auto-generated OpenAPI specification for the Tabarnam Functions API.",
    version: "1.0.0",
  },
  servers: [
    {
      url: "/",
      description: "Default (relative)",
    },
  ],
  tags: [
    { name: "Public", description: "Public-facing endpoints" },
    { name: "Admin", description: "Admin endpoints (require authentication)" },
    {
      name: "XAdmin",
      description: "Cross-admin / super-admin endpoints (require authentication)",
    },
    { name: "Import", description: "Data import endpoints" },
  ],
  paths,
  components: {
    securitySchemes: {
      adminAuth: {
        type: "apiKey",
        in: "header",
        name: "x-admin-key",
        description: "Admin API key required for admin and xadmin routes.",
      },
    },
    schemas: {},
  },
};

// ---------------------------------------------------------------------------
// 5. Write the spec to disk.
// ---------------------------------------------------------------------------
const outPath = resolve(projectRoot, "api", "openapi.json");
writeFileSync(outPath, JSON.stringify(spec, null, 2) + "\n", "utf-8");

const totalOps = Object.values(paths)
  .flatMap((p) => Object.keys(p))
  .length;

console.log(
  `[generate-openapi] Wrote ${outPath} (${Object.keys(paths).length} paths, ${totalOps} operations).`
);
