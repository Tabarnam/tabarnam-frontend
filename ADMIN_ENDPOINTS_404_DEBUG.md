# Admin Endpoints 404 Debug Summary

## Current Status
After extensive troubleshooting across 195 pull requests and multiple deployments:
- ✅ `/api/ping` returns 200 OK 
- ✅ `/api/search-companies` returns 200 OK with data
- ❌ `/api/admin-recent-imports` returns 404 Not Found
- ❌ `/api/admin-keywords` returns 404 Not Found  
- ❌ `/api/admin-companies` returns 404 Not Found
- ❌ All other `/api/admin-*` endpoints return 404 Not Found

## Root Cause Analysis

### Code Review Findings
1. **Function Names & Routes**: All admin endpoint handlers use kebab-case function names matching their routes ✓
   - Example: `app.http("admin-recent-imports", { route: "admin-recent-imports", ... })`

2. **Function.json Configuration**: All function.json files have correct structure with:
   - Uppercase HTTP methods (GET, POST, OPTIONS, etc.) ✓
   - Correct route values matching handler registration ✓
   - Anonymous auth level ✓

3. **Module Loading**: All admin modules are properly required in `api/index.js` with try-catch blocks ✓

4. **staticwebapp.config.json**: API routing is correctly configured:
   - `/api/*` route allows both authenticated and anonymous users ✓
   - All HTTP methods are allowed ✓

### The Mystery
The fact that `search-companies` works while all admin endpoints return 404 suggests:
- The Functions host IS running (ping works)
- The API routing IS working (search-companies works)
- But specifically the admin endpoints are not being discovered/registered

### Potential Issues

**Theory 1: POST Method Requirement**
- `search-companies` has POST in methods: `["GET", "POST", "OPTIONS"]`
- Several admin endpoints only have GET: `["GET", "OPTIONS"]`
- **Fix Applied**: Added POST to admin-recent-imports, admin-keywords, admin-analytics, admin-import-stats, and admin-undo-history

**Theory 2: Azure Functions v4 function.json vs app.http() Conflict**
- Earlier in the troubleshooting (item 21), removing function.json files was considered
- Current configuration has BOTH function.json AND app.http() registrations
- **Possible Issue**: Azure might not be honoring both registration methods together

**Theory 3: Deployment Caching**
- Multiple successful deployments but 404 persists
- Azure Static Web Apps might have a caching layer preventing route updates
- **Possible Fix**: Clear Azure cache or wait for new cold-start

## Recommended Next Steps

### Step 1: Redeploy with Latest Changes (POST Method Addition)
Push the latest changes that add POST method to admin endpoints and redeploy. Test:
```bash
curl https://tabarnam.com/api/admin-recent-imports?take=5
curl https://tabarnam.com/api/admin-keywords
curl https://tabarnam.com/api/admin-analytics
```

### Step 2: If Still 404 - Delete function.json Files
If POST addition doesn't work, try removing ALL function.json files and relying solely on `app.http()` registrations:
```bash
rm api/*/function.json
rm -rf api/admin-*/function.json
```
Then redeploy and test.

### Step 3: Check Azure Function Logs
In Azure Portal:
1. Navigate to Static Web App > tabarnam-frontend-v2 > Functions
2. Check Runtime logs for any errors during function registration
3. Look for messages about "admin-recent-imports" or similar

### Step 4: Verify Module Loading Order
The `api/index.js` loads modules in sequence. If an earlier module throws an error that breaks the require chain, later modules might not register. Check for any console errors during module loading.

## Configuration Details

### Current Working Endpoint (for reference)
```javascript
// api/search-companies/index.js
app.http("search-companies", {
  route: "search-companies",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => { ... }
});
```

### Admin Endpoint Structure (should be identical except for name)
```javascript
// api/admin-recent-imports/index.js
app.http("admin-recent-imports", {
  route: "admin-recent-imports",
  methods: ["GET", "POST", "OPTIONS"],  // NOW INCLUDES POST
  authLevel: "anonymous",
  handler: async (req, ctx) => { ... }
});
```

## Changes Made in This Session
- Added POST method to `admin-recent-imports/function.json`
- Added POST method to `admin-keywords/function.json`
- Added POST method to `admin-analytics/function.json`
- Added POST method to `admin-import-stats/function.json`
- Added POST method to `admin-undo-history/function.json`

**Rationale**: Ensuring all admin endpoints have consistent HTTP method declarations, matching the pattern of working endpoints.

## Next Investigation Points
If POST method addition doesn't solve the issue:
1. Compare byte-for-byte the exact function.json files between working and failing endpoints
2. Check if there's a naming conflict (e.g., folder name vs function name mismatch)
3. Review Azure Functions Runtime version compatibility
4. Test with a minimal admin handler to isolate logic vs routing issues
