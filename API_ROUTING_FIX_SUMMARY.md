# API Routing Fix - Root Cause and Solution

## Root Cause Identified

The 404 errors on all admin endpoints were caused by a **mismatch between function names and routes in `app.http()` declarations**.

Azure Static Web Apps uses the **first argument to `app.http()`** as the function identifier for HTTP routing. When this didn't match the route parameter, Azure would create HTTP routes based on the function name instead of the explicit route.

### The Problem

Example from `admin-recent-imports/index.js`:
```javascript
app.http("adminRecentImports", {        // ← Camelcase function name
  route: "admin-recent-imports",         // ← Kebab-case route
  ...
})
```

This caused Azure to route to `/api/adminRecentImports` (using the function name) instead of `/api/admin-recent-imports` (using the route), causing the **404 Not Found** response.

**Why ping worked:**
```javascript
app.http("ping", {
  route: "ping",
  ...
})
```
The function name and route matched, so it worked correctly.

## Solution Applied

Changed all 28 API endpoint function names from camelCase to kebab-case to match their routes.

### Admin Endpoints Fixed (17 total)

| Before | After |
|--------|-------|
| `app.http("adminRecentImports", ...)` | `app.http("admin-recent-imports", ...)` |
| `app.http("adminAnalytics", ...)` | `app.http("admin-analytics", ...)` |
| `app.http("adminBatchUpdate", ...)` | `app.http("admin-batch-update", ...)` |
| `app.http("adminCompanies", ...)` | `app.http("admin-companies", ...)` |
| `app.http("adminCompaniesV2", ...)` | `app.http("admin-companies-v2", ...)` |
| `app.http("adminDebug", ...)` | `app.http("admin-debug", ...)` |
| `app.http("adminImportStats", ...)` | `app.http("admin-import-stats", ...)` |
| `app.http("adminLogin", ...)` | `app.http("admin-login", ...)` |
| `app.http("adminNotes", ...)` | `app.http("admin-notes", ...)` |
| `app.http("adminRecalcStars", ...)` | `app.http("admin-recalc-stars", ...)` |
| `app.http("adminReviews", ...)` | `app.http("admin-reviews", ...)` |
| `app.http("adminSaveDiagnostic", ...)` | `app.http("admin-save-diagnostic", ...)` |
| `app.http("adminStarConfig", ...)` | `app.http("admin-star-config", ...)` |
| `app.http("adminUndo", ...)` | `app.http("admin-undo", ...)` |
| `app.http("adminUndoHistory", ...)` | `app.http("admin-undo-history", ...)` |
| `app.http("adminUpdateLogos", ...)` | `app.http("admin-update-logos", ...)` |

### Other Endpoints Fixed (11 total)

| Before | After |
|--------|-------|
| `app.http("companiesList", ...)` | `app.http("companies-list", ...)` |
| `app.http("getReviews", ...)` | `app.http("get-reviews", ...)` |
| `app.http("importProgress", ...)` | `app.http("import-progress", ...)` |
| `app.http("importStart", ...)` | `app.http("import-start", ...)` |
| `app.http("importStatus", ...)` | `app.http("import-status", ...)` |
| `app.http("logoScrape", ...)` | `app.http("logo-scrape", ...)` |
| `app.http("proxyXai", ...)` | `app.http("proxy-xai", ...)` |
| `app.http("saveCompanies", ...)` | `app.http("save-companies", ...)` |
| `app.http("searchCompanies", ...)` | `app.http("search-companies", ...)` |
| `app.http("submitReview", ...)` | `app.http("submit-review", ...)` |
| `app.http("suggestCities", ...)` | `app.http("suggest-cities", ...)` |
| `app.http("suggestRefinements", ...)` | `app.http("suggest-refinements", ...)` |
| `app.http("suggestStates", ...)` | `app.http("suggest-states", ...)` |
| `app.http("testEcho", ...)` | `app.http("test-echo", ...)` |

## Files Modified

28 API handler files across `api/` directory were updated with corrected function names.

## Expected Results After Deployment

✅ `/api/admin-recent-imports?take=25` → 200 OK (instead of 404)  
✅ `/api/admin-keywords` → 200 OK  
✅ `/api/admin-companies` → 200 OK  
✅ `/api/admin-analytics` → 200 OK  
✅ All other admin and public endpoints → 200 OK

The bulk import page (`/admin/xai-bulk-import`) should now load Recent Imports without console errors.

## Why This Fix Works

By making the function name match the route, Azure Static Web Apps can now:
1. Discover the function by name
2. Map HTTP requests to the correct route
3. Properly invoke the handler
4. Return responses instead of 404s
