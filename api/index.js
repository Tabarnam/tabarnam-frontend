// api/index.js  register all functions (new programming model, CommonJS)
const { app } = require("@azure/functions");

console.log("[api/index.js] Starting handler registration...");

try {
  console.log("[api] Registering: health");
  require("./health/index.js");
} catch (e) {
  console.error("[api] Failed to load health:", e?.message || e);
}

try {
  console.log("[api] Registering: ping");
  require("./ping/index.js");
  console.log("[api] ✓ ping registered");
} catch (e) {
  console.error("[api] Failed to load ping:", e?.message || e);
}

try {
  console.log("[api] Registering: hello");
  require("./hello/index.js");
} catch (e) {
  console.error("[api] Failed to load hello:", e?.message || e);
}

try {
  console.log("[api] Registering: proxy-xai");
  require("./proxy-xai/index.js");
} catch (e) {
  console.error("[api] Failed to load proxy-xai:", e?.message || e);
}

try {
  console.log("[api] Registering: submit-review");
  require("./submit-review/index.js");
} catch (e) {
  console.error("[api] Failed to load submit-review:", e?.message || e);
}

try {
  console.log("[api] Registering: get-reviews");
  require("./get-reviews/index.js");
} catch (e) {
  console.error("[api] Failed to load get-reviews:", e?.message || e);
}

try {
  console.log("[api] Registering: admin-reviews");
  require("./admin-reviews/index.js");
} catch (e) {
  console.error("[api] Failed to load admin-reviews:", e?.message || e);
}

try {
  console.log("[api] Registering: admin-update-logos");
  require("./admin-update-logos/index.js");
} catch (e) {
  console.error("[api] Failed to load admin-update-logos:", e?.message || e);
}

try {
  console.log("[api] Registering: search-companies");
  require("./search-companies/index.js");
} catch (e) {
  console.error("[api] Failed to load search-companies:", e?.message || e);
}

try {
  console.log("[api] Registering: suggest-refinements");
  const suggestRefinements = require("./suggest-refinements/index.js");
  console.log("[api] ✓ suggest-refinements registered");
} catch (e) {
  console.error("[api] ❌ Failed to load suggest-refinements:", e?.message || e);
  console.error("[api] Stack:", e?.stack || "no stack");
}

try {
  console.log("[api] Registering: save-companies");
  require("./save-companies/index.js");
} catch (e) {
  console.error("[api] Failed to load save-companies:", e?.message || e);
}

try {
  console.log("[api] Registering: logo-scrape");
  require("./logo-scrape/index.js");
} catch (e) {
  console.error("[api] Failed to load logo-scrape:", e?.message || e);
}

try {
  console.log("[api] Registering: import-start");
  require("./importStart/index.js");
} catch (e) {
  console.error("[api] Failed to load import-start:", e?.message || e);
}

try {
  console.log("[api] Registering: import-status");
  require("./import-status/index.js");
} catch (e) {
  console.error("[api] Failed to load import-status:", e?.message || e);
}

try {
  console.log("[api] Registering: import-progress");
  require("./import-progress/index.js");
} catch (e) {
  console.error("[api] Failed to load import-progress:", e?.message || e);
}

try {
  console.log("[api] Registering: google/geocode");
  require("./google/geocode/index.js");
} catch (e) {
  console.error("[api] Failed to load google/geocode:", e?.message || e);
}

try {
  console.log("[api] Registering: google/translate");
  require("./google/translate/index.js");
} catch (e) {
  console.error("[api] Failed to load google/translate:", e?.message || e);
}

try {
  console.log("[api] Registering: test-echo");
  require("./test-echo/index.js");
  console.log("[api] ✓ test-echo registered");
} catch (e) {
  console.error("[api] ❌ Failed to load test-echo:", e?.message || e);
  console.error(e);
}

try {
  console.log("[api] Registering: companies-list");
  require("./companies-list/index.js");
  console.log("[api] ✓ companies-list registered");
} catch (e) {
  console.error("[api] ❌ Failed to load companies-list:", e?.message || e);
  console.error(e);
}

try {
  console.log("[api] Registering: admin-star-config");
  require("./admin-star-config/index.js");
  console.log("[api] ✓ admin-star-config registered");
} catch (e) {
  console.error("[api] ❌ Failed to load admin-star-config:", e?.message || e);
  console.error(e);
}

try {
  console.log("[api] Registering: admin-undo-history");
  require("./admin-undo-history/index.js");
} catch (e) {
  console.error("[api] Failed to load admin-undo-history:", e?.message || e);
}

try {
  console.log("[api] Registering: admin-notes");
  require("./admin-notes/index.js");
} catch (e) {
  console.error("[api] Failed to load admin-notes:", e?.message || e);
}

try {
  console.log("[api] Registering: admin-login");
  require("./admin-login/index.js");
} catch (e) {
  console.error("[api] Failed to load admin-login:", e?.message || e);
}

try {
  console.log("[api] Registering: admin-debug");
  require("./admin-debug/index.js");
  console.log("[api] ✓ admin-debug registered");
} catch (e) {
  console.error("[api] ❌ Failed to load admin-debug:", e?.message || e);
  console.error(e);
}

try {
  console.log("[api] Registering: admin-recalc-stars");
  require("./admin-recalc-stars/index.js");
  console.log("[api] ✓ admin-recalc-stars registered");
} catch (e) {
  console.error("[api] ❌ Failed to load admin-recalc-stars:", e?.message || e);
}

try {
  console.log("[api] Registering: admin-import-stats");
  require("./admin-import-stats/index.js");
  console.log("[api] ✓ admin-import-stats registered");
} catch (e) {
  console.error("[api] ❌ Failed to load admin-import-stats:", e?.message || e);
}

try {
  console.log("[api] Registering: admin-keywords");
  require("./adminKeywords/index.js");
  console.log("[api] ✓ admin-keywords registered");
} catch (e) {
  console.error("[api] ❌ Failed to load admin-keywords:", e?.message || e);
}

try {
  console.log("[api] Registering: admin-companies");
  require("./adminCompanies/index.js");
  console.log("[api] ✓ admin-companies registered");
} catch (e) {
  console.error("[api] ❌ Failed to load admin-companies:", e?.message || e);
}

try {
  console.log("[api] Registering: admin-undo");
  require("./admin-undo/index.js");
  console.log("[api] ✓ admin-undo registered");
} catch (e) {
  console.error("[api] ❌ Failed to load admin-undo:", e?.message || e);
}

try {
  console.log("[api] Registering: admin-analytics");
  require("./admin-analytics/index.js");
  console.log("[api] �� admin-analytics registered");
} catch (e) {
  console.error("[api] ❌ Failed to load admin-analytics:", e?.message || e);
}

try {
  console.log("[api] Registering: admin-batch-update");
  require("./admin-batch-update/index.js");
  console.log("[api] ✓ admin-batch-update registered");
} catch (e) {
  console.error("[api] ❌ Failed to load admin-batch-update:", e?.message || e);
}

try {
  console.log("[api] Registering: admin-bulk-import-config");
  require("./admin-bulk-import-config/index.js");
  console.log("[api] ✓ admin-bulk-import-config registered");
} catch (e) {
  console.error("[api] ❌ Failed to load admin-bulk-import-config:", e?.message || e);
}

try {
  console.log("[api] Registering: admin-save-diagnostic");
  require("./admin-save-diagnostic/index.js");
  console.log("[api] ✓ admin-save-diagnostic registered");
} catch (e) {
  console.error("[api] ❌ Failed to load admin-save-diagnostic:", e?.message || e);
}

console.log("[api/index.js] ✅ All handler registration complete!");

module.exports = app;
