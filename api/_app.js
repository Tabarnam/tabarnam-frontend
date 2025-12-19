let azureApp = null;

try {
  ({ app: azureApp } = require("@azure/functions"));
} catch {
  azureApp = null;
}

const ROUTES_KEY = "__tabarnam_http_registrations";
const PATCHED_KEY = "__tabarnam_http_patched";

const fallbackRegistrations = [];

function normalizeRoute(value) {
  return String(value || "")
    .trim()
    .replace(/^\//, "")
    .toLowerCase();
}

function getRegistrations() {
  if (azureApp) {
    if (!Array.isArray(azureApp[ROUTES_KEY])) azureApp[ROUTES_KEY] = [];
    return azureApp[ROUTES_KEY];
  }
  return fallbackRegistrations;
}

function ensurePatched() {
  if (!azureApp) return;
  if (azureApp[PATCHED_KEY]) return;

  const registrations = getRegistrations();
  const originalHttp = typeof azureApp.http === "function" ? azureApp.http.bind(azureApp) : null;

  azureApp.http = (name, opts) => {
    registrations.push({ name, ...(opts || {}) });
    return originalHttp ? originalHttp(name, opts) : undefined;
  };

  azureApp[PATCHED_KEY] = true;
}

ensurePatched();

const app =
  azureApp ||
  ({
    http: (name, opts) => {
      getRegistrations().push({ name, ...(opts || {}) });
    },
  });

function listRoutes() {
  return getRegistrations()
    .map((r) => (r && typeof r === "object" ? r.route : ""))
    .map((r) => String(r || "").trim())
    .filter(Boolean);
}

function hasRoute(route) {
  const target = normalizeRoute(route);
  if (!target) return false;
  return getRegistrations().some((r) => normalizeRoute(r?.route) === target);
}

function listHttpRegistrations() {
  return getRegistrations().map((r) => ({
    name: String(r?.name || ""),
    route: String(r?.route || ""),
    methods: Array.isArray(r?.methods) ? [...r.methods] : undefined,
  }));
}

if (!app._test) app._test = {};
app._test.listRoutes = listRoutes;
app._test.listHttpRegistrations = listHttpRegistrations;
app._test.hasRoute = hasRoute;

module.exports = { app, hasRoute, listRoutes, listHttpRegistrations };
