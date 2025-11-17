// api/index.js  register all functions (new programming model, CommonJS)

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
  console.log("[api] Registering: admin-companies");
  require("./admin-companies/index.js");
  console.log("[api] ✓ admin-companies registered");
} catch (e) {
  console.error("[api] ❌ Failed to load admin-companies:", e?.message || e);
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

console.log("[api/index.js] ✅ All handler registration complete!");
