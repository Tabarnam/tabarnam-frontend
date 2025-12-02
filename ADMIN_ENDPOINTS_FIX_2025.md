# Admin Endpoints 404 Fix - Restored function.json Files

## Problem Summary
After deleting all function.json files (PR #197) in an attempt to rely solely on Azure Functions v4's programmatic app.http() registration, admin endpoints and keywords-list endpoints returned 404 errors, while ping and search-companies continued to work.

**Test Results After Deletion:**
- ✅ /api/ping → 200 OK
- ✅ /api/search-companies → 200 OK
- ❌ /api/admin-recent-imports → 404
- ❌ /api/admin-keywords → 404
- ❌ /api/admin-companies → 404
- ❌ /api/keywords-list → 404

## Root Cause Analysis
While Azure Functions v4 supports programmatic function registration via `app.http()`, Azure Static Web Apps (which hosts our functions) may still require `function.json` files for proper discovery and routing in certain configurations. The issue appears to be specific to functions that:
1. Have more complex handler code
2. Require additional modules (Cosmos DB, axios, bcryptjs)
3. Use context.log() for diagnostics

## Solution Applied
**Restored function.json files for all admin endpoints and keywords-list** with proper configuration:

### Files Restored (18 total)
1. api/admin-analytics/function.json
2. api/admin-batch-update/function.json
3. api/admin-bulk-import-config/function.json
4. api/admin-companies/function.json
5. api/admin-companies-v2/function.json
6. api/admin-debug/function.json
7. api/admin-import-stats/function.json
8. api/admin-keywords/function.json
9. api/admin-login/function.json
10. api/admin-notes/function.json
11. api/admin-recalc-stars/function.json
12. api/admin-recent-imports/function.json
13. api/admin-reviews/function.json
14. api/admin-save-diagnostic/function.json
15. api/admin-star-config/function.json
16. api/admin-undo/function.json
17. api/admin-undo-history/function.json
18. api/admin-update-logos/function.json
19. api/keywords-list/function.json

### Configuration Details
Each function.json follows this pattern:
```json
{
  "scriptFile": "index.js",
  "bindings": [
    {
      "authLevel": "anonymous",
      "type": "httpTrigger",
      "direction": "in",
      "name": "req",
      "methods": ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      "route": "admin-specific-route"
    },
    {
      "type": "http",
      "direction": "out",
      "name": "$return"
    }
  ]
}
```

### Parameter Fixes
Fixed parameter naming inconsistencies in handlers:
- `api/admin-recent-imports/index.js`: Changed parameter from `ctx` to `context`
- `api/admin-login/index.js`: Changed parameter from `ctx` to `context`
- Updated `console.log()` calls to `context.log()` for proper Azure Functions logging

## Why This Works
1. **Hybrid Approach**: Combines Azure Functions v4's programmatic registration (`app.http()`) with Azure Static Web Apps' traditional function.json discovery mechanism
2. **Backward Compatibility**: function.json files don't conflict with app.http() registrations; both can coexist
3. **SWA Routing**: Azure Static Web Apps can now properly map HTTP requests to the correct function handlers

## Expected Outcome
After deployment, all admin endpoints should return 200 OK:
- ✅ /api/admin-recent-imports?take=5 → 200
- ✅ /api/admin-keywords → 200
- ✅ /api/admin-companies → 200
- ✅ /api/admin-analytics → 200
- ✅ /api/admin-login → 200
- ✅ /api/keywords-list → 200

## Deployment Steps
1. Push these changes to GitHub
2. GitHub Actions will trigger Azure deployment
3. Azure Static Web Apps will discover functions from both function.json and app.http()
4. Test the endpoints immediately after deployment

## Testing After Deployment
```bash
# Test admin endpoints
curl -i https://tabarnam.com/api/admin-recent-imports?take=5
curl -i https://tabarnam.com/api/admin-keywords
curl -i https://tabarnam.com/api/admin-companies

# Should all return 200 OK with JSON responses
```

## Next Steps if Issue Persists
1. Check Azure Functions logs for runtime errors
2. Verify environment variables (COSMOS_DB_ENDPOINT, COSMOS_DB_KEY, etc.) are set correctly
3. Check if there are any authorization/authentication issues
4. Consider if additional module dependencies need to be installed

## Files Modified
- Created/Restored: 19 function.json files (as listed above)
- Modified: 
  - api/admin-recent-imports/index.js (parameter naming)
  - api/admin-login/index.js (parameter naming)
