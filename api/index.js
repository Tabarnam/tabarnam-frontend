// api/index.js - register all functions (CommonJS / v4 app model)
const { app } = require("./_app");

console.log("[api/index.js] Starting handler registration...");

const ROUTES_TEST_MODE = process.env.TABARNAM_API_INDEX_MODE === "routes-test";

if (ROUTES_TEST_MODE) {
  try {
    console.log("[api] Registering (routes-test): admin-refresh-company");
    require("./admin-refresh-company/index.js");
  } catch (e) {
    console.error("[api] ❌ Failed to load admin-refresh-company:", e?.message || e);
  }

  try {
    console.log("[api] Registering (routes-test): xadmin-api-refresh-company");
    require("./xadmin-api-refresh-company/index.js");
  } catch (e) {
    console.error("[api] ❌ Failed to load xadmin-api-refresh-company:", e?.message || e);
  }

  try {
    console.log("[api] Registering (routes-test): admin-refresh-reviews");
    require("./admin-refresh-reviews/index.js");
  } catch (e) {
    console.error("[api] ❌ Failed to load admin-refresh-reviews:", e?.message || e);
  }

  try {
    console.log("[api] Registering (routes-test): xadmin-api-refresh-reviews");
    require("./xadmin-api-refresh-reviews/index.js");
  } catch (e) {
    console.error("[api] ❌ Failed to load xadmin-api-refresh-reviews:", e?.message || e);
  }
} else {
  // -------------------------
  // Public endpoints
  // -------------------------
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
  console.log("[api] Registering: version");
  require("./version/index.js");
  console.log("[api] ✓ version registered");
} catch (e) {
  console.error("[api] Failed to load version:", e?.message || e);
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
  console.log("[api] Registering: xadmin-api-recalc-review-counts");
  require("./admin-recalc-review-counts/index.js");
} catch (e) {
  console.error("[api] Failed to load xadmin-api-recalc-review-counts:", e?.message || e);
}

try {
  console.log("[api] Registering: search-companies");
  require("./search-companies/index.js");
} catch (e) {
  console.error("[api] Failed to load search-companies:", e?.message || e);
}

try {
  console.log("[api] Registering: suggest-refinements");
  require("./suggest-refinements/index.js");
  console.log("[api] ✓ suggest-refinements registered");
} catch (e) {
  console.error("[api] ❌ Failed to load suggest-refinements:", e?.message || e);
}

try {
  console.log("[api] Registering: suggest-cities");
  require("./suggest-cities/index.js");
  console.log("[api] ✓ suggest-cities registered");
} catch (e) {
  console.error("[api] ❌ Failed to load suggest-cities:", e?.message || e);
}

try {
  console.log("[api] Registering: suggest-states");
  require("./suggest-states/index.js");
  console.log("[api] ✓ suggest-states registered");
} catch (e) {
  console.error("[api] ❌ Failed to load suggest-states:", e?.message || e);
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
  require("./import-start/index.js");
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
  console.log("[api] Registering: import-stop");
  require("./import-stop/index.js");
} catch (e) {
  console.error("[api] Failed to load import-stop:", e?.message || e);
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
}

try {
  console.log("[api] Registering: companies-list");
  require("./companies-list/index.js");
  console.log("[api] ✓ companies-list registered");
} catch (e) {
  console.error("[api] ❌ Failed to load companies-list:", e?.message || e);
}

try {
  console.log("[api] Registering: keywords-list");
  require("./keywords-list/index.js");
  console.log("[api] ✓ keywords-list registered");
} catch (e) {
  console.error("[api] ❌ Failed to load keywords-list:", e?.message || e);
}

try {
  console.log("[api] Registering: upload-logo-blob");
  require("./upload-logo-blob/index.js");
  console.log("[api] ✓ upload-logo-blob registered");
} catch (e) {
  console.error("[api] ❌ Failed to load upload-logo-blob:", e?.message || e);
}

try {
  console.log("[api] Registering: delete-logo-blob");
  require("./delete-logo-blob/index.js");
  console.log("[api] ✓ delete-logo-blob registered");
} catch (e) {
  console.error("[api] ❌ Failed to load delete-logo-blob:", e?.message || e);
}

try {
  console.log("[api] Registering: xadmin-api-logos");
  require("./xadmin-api-logos/index.js");
  console.log("[api] ✓ xadmin-api-logos registered");
} catch (e) {
  console.error("[api] ❌ Failed to load xadmin-api-logos:", e?.message || e);
}

try {
  console.log("[api] Registering: retry-logo-import");
  require("./retry-logo-import/index.js");
  console.log("[api] ✓ retry-logo-import registered");
} catch (e) {
  console.error("[api] ❌ Failed to load retry-logo-import:", e?.message || e);
}

// -------------------------
// Admin endpoints (v4 model)
// -------------------------

try {
  console.log("[api] Registering: admin-keywords");
  require("./admin-keywords/index.js");
  console.log("[api] ✓ admin-keywords registered");
} catch (e) {
  console.error("[api] ❌ Failed to load admin-keywords:", e?.message || e);
}

try {
  console.log("[api] Registering: admin-analytics");
  require("./admin-analytics/index.js");
  console.log("[api] ✓ admin-analytics registered");
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
  console.log("[api] Registering: admin-companies-v2");
  require("./admin-companies-v2/index.js");
  console.log("[api] ✓ admin-companies-v2 registered");
} catch (e) {
  console.error("[api] ❌ Failed to load admin-companies-v2:", e?.message || e);
}

try {
  console.log("[api] Registering: admin-company-history");
  require("./admin-company-history/index.js");
  console.log("[api] ✓ admin-company-history registered");
} catch (e) {
  console.error("[api] ❌ Failed to load admin-company-history:", e?.message || e);
}

try {
  console.log("[api] Registering: xadmin-api-debug");
  require("./admin-debug/index.js");
  console.log("[api] ✓ xadmin-api-debug registered");
} catch (e) {
  console.error("[api] ❌ Failed to load xadmin-api-debug:", e?.message || e);
}

try {
  console.log("[api] Registering: admin-echo");
  require("./admin-echo/index.js");
  console.log("[api] ✓ admin-echo registered");
} catch (e) {
  console.error("[api] ❌ Failed to load admin-echo:", e?.message || e);
}

try {
  console.log("[api] Registering: admin-import-stats");
  require("./admin-import-stats/index.js");
  console.log("[api] ✓ admin-import-stats registered");
} catch (e) {
  console.error("[api] ❌ Failed to load admin-import-stats:", e?.message || e);
}

try {
  console.log("[api] Registering: admin-login");
  require("./admin-login/index.js");
  console.log("[api] ✓ admin-login registered");
} catch (e) {
  console.error("[api] ❌ Failed to load admin-login:", e?.message || e);
}

try {
  console.log("[api] Registering: admin-notes");
  require("./admin-notes/index.js");
  console.log("[api] ✓ admin-notes registered");
} catch (e) {
  console.error("[api] ❌ Failed to load admin-notes:", e?.message || e);
}

try {
  console.log("[api] Registering: admin-recalc-stars");
  require("./admin-recalc-stars/index.js");
  console.log("[api] ✓ admin-recalc-stars registered");
} catch (e) {
  console.error("[api] ❌ Failed to load admin-recalc-stars:", e?.message || e);
}

try {
  console.log("[api] Registering: admin-reviews");
  require("./admin-reviews/index.js");
  console.log("[api] ✓ admin-reviews registered");
} catch (e) {
  console.error("[api] ❌ Failed to load admin-reviews:", e?.message || e);
}

try {
  console.log("[api] Registering: admin-save-diagnostic");
  require("./admin-save-diagnostic/index.js");
  console.log("[api] ✓ admin-save-diagnostic registered");
} catch (e) {
  console.error("[api] ❌ Failed to load admin-save-diagnostic:", e?.message || e);
}

try {
  console.log("[api] Registering: admin-star-config");
  require("./admin-star-config/index.js");
  console.log("[api] ✓ admin-star-config registered");
} catch (e) {
  console.error("[api] ❌ Failed to load admin-star-config:", e?.message || e);
}

try {
  console.log("[api] Registering: admin-undo");
  require("./admin-undo/index.js");
  console.log("[api] ✓ admin-undo registered");
} catch (e) {
  console.error("[api] ❌ Failed to load admin-undo:", e?.message || e);
}

try {
  console.log("[api] Registering: admin-undo-history");
  require("./admin-undo-history/index.js");
  console.log("[api] ✓ admin-undo-history registered");
} catch (e) {
  console.error("[api] ❌ Failed to load admin-undo-history:", e?.message || e);
}

try {
  console.log("[api] Registering: admin-update-logos");
  require("./admin-update-logos/index.js");
  console.log("[api] ✓ admin-update-logos registered");
} catch (e) {
  console.error("[api] ❌ Failed to load admin-update-logos:", e?.message || e);
}

try {
  console.log("[api] Registering: admin-recent-imports");
  require("./admin-recent-imports/index.js");
  console.log("[api] ✓ admin-recent-imports registered");
} catch (e) {
  console.error("[api] ❌ Failed to load admin-recent-imports:", e?.message || e);
}

try {
  console.log("[api] Registering: admin-refresh-import");
  require("./admin-refresh-import/index.js");
  console.log("[api] ✓ admin-refresh-import registered");
} catch (e) {
  console.error("[api] ❌ Failed to load admin-refresh-import:", e?.message || e);
}

try {
  console.log("[api] Registering: admin-refresh-company");
  require("./admin-refresh-company/index.js");
  console.log("[api] ✓ admin-refresh-company registered");
} catch (e) {
  console.error("[api] ❌ Failed to load admin-refresh-company:", e?.message || e);
}

try {
  console.log("[api] Registering: xadmin-api-refresh-company");
  require("./xadmin-api-refresh-company/index.js");
  console.log("[api] ✓ xadmin-api-refresh-company registered");
} catch (e) {
  console.error("[api] ❌ Failed to load xadmin-api-refresh-company:", e?.message || e);
}

try {
  console.log("[api] Registering: admin-refresh-reviews");
  require("./admin-refresh-reviews/index.js");
  console.log("[api] ✓ admin-refresh-reviews registered");
} catch (e) {
  console.error("[api] ❌ Failed to load admin-refresh-reviews:", e?.message || e);
}

try {
  console.log("[api] Registering: xadmin-api-refresh-reviews");
  require("./xadmin-api-refresh-reviews/index.js");
  console.log("[api] ✓ xadmin-api-refresh-reviews registered");
} catch (e) {
  console.error("[api] ❌ Failed to load xadmin-api-refresh-reviews:", e?.message || e);
}

try {
  console.log("[api] Registering: admin-geocode-location");
  require("./admin-geocode-location/index.js");
  console.log("[api] ✓ admin-geocode-location registered");
} catch (e) {
  console.error("[api] ❌ Failed to load admin-geocode-location:", e?.message || e);
}
}

console.log("[api/index.js] ✅ All handler registration complete! Exporting app.");

// Critical for v4 model: export the shared app so the Functions runtime can discover handlers
module.exports = app;

// Test helpers (works in local dev even when @azure/functions is not installed)
module.exports._test = app._test;
