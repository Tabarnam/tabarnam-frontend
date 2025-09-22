// Single entry for Node v4 model (@azure/functions).
// Tries to import each function module; logs if any are missing.

const modules = [
  "./get-reviews/index.js",
  "./submit-review/index.js",
  "./search-companies/index.js",
  "./save-companies/index.js",
  "./save-import-log/index.js",
  "./import-progress/index.js",
  "./google-geocode/index.js",
  "./google-translate/index.js",
  "./logo-scrape/index.js",
  "./proxy-xai/index.js",
  "./reviews-debug/index.js",
];

(async () => {
  for (const m of modules) {
    try {
      await import(new URL(m, import.meta.url));
      console.log("Loaded function:", m);
    } catch (err) {
      console.warn("Skipping", m, "-", err?.message || err);
    }
  }
  console.log("Function modules imported.");
})();
