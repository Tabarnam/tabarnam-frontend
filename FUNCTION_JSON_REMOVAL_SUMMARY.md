# Function.json Removal - Aggressive Approach

## Summary
All 37 `function.json` files have been deleted from the `api/` directory to test if they are conflicting with Azure Functions v4's new JavaScript programming model (`@azure/functions` with `app.http()`).

## Date
2025-12-02

## Rationale
After extensive troubleshooting (196 pull requests, 5 deployments), the admin endpoints continue to return 404 errors despite:
- Correct function names and routes in `app.http()` calls
- Proper HTTP method declarations (including POST)
- Uppercase HTTP methods in function.json files
- Correct authLevel and route configurations

The fact that `ping` and `search-companies` work (both GET requests) while all admin endpoints fail suggests a conflict between:
1. Old-style `function.json` bindings (Azure Functions v3)
2. New `app.http()` registrations (Azure Functions v4)

## Hypothesis
Azure Functions v4 with programmatic registration (`app.http()`) may not require `function.json` files. When both are present, Azure may get confused about how to route requests, resulting in 404 errors.

## Solution
Remove ALL 37 `function.json` files and rely entirely on the programmatic registration in `api/*/index.js` files, which all use the v4 `app.http()` API.

## Files Deleted (37 total)

### Admin Endpoints (18)
- api/admin-analytics/function.json
- api/admin-batch-update/function.json
- api/admin-bulk-import-config/function.json
- api/admin-companies/function.json
- api/admin-companies-v2/function.json
- api/admin-debug/function.json
- api/admin-import-stats/function.json
- api/admin-keywords/function.json
- api/admin-login/function.json
- api/admin-notes/function.json
- api/admin-recalc-stars/function.json
- api/admin-recent-imports/function.json
- api/admin-reviews/function.json
- api/admin-save-diagnostic/function.json
- api/admin-star-config/function.json
- api/admin-undo/function.json
- api/admin-undo-history/function.json
- api/admin-update-logos/function.json

### Public Endpoints (19)
- api/companies-list/function.json
- api/get-reviews/function.json
- api/health/function.json
- api/hello/function.json
- api/import-progress/function.json
- api/import-start/function.json
- api/import-status/function.json
- api/importStart/function.json
- api/keywords-list/function.json
- api/logo-scrape/function.json
- api/ping/function.json
- api/proxy-xai/function.json
- api/save-companies/function.json
- api/search-companies/function.json
- api/submit-review/function.json
- api/suggest-cities/function.json
- api/suggest-refinements/function.json
- api/suggest-states/function.json
- api/test-echo/function.json

## Expected Behavior After Deployment
With function.json files removed, the Azure Functions runtime should:
1. Use only the `app.http()` registrations
2. Properly map routes from the kebab-case route names in `app.http()` calls
3. All endpoints should return 200 OK instead of 404

## Testing Plan
After deployment, test:
- `GET https://tabarnam.com/api/ping` → should be 200
- `GET https://tabarnam.com/api/admin-recent-imports?take=5` → should be 200
- `GET https://tabarnam.com/api/admin-keywords` → should be 200
- `GET https://tabarnam.com/api/search-companies?q=test` → should be 200

## Rollback Plan
If this breaks more endpoints (unlikely), the deleted files are still in git history and can be restored:
```bash
git restore api/*/function.json
```

## References
- Previous investigation: ADMIN_ENDPOINTS_404_DEBUG.md
- Azure Functions v4 documentation: https://learn.microsoft.com/en-us/azure/azure-functions/functions-reference-node
- PR #196: Added POST methods to admin endpoints (ineffective)
- PR #195: Fixed app.http() function names to kebab-case (partially effective for non-admin endpoints)
