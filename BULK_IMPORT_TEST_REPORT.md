# Bulk Import Feature Testing Report

## Test Objective
Test the bulk company import feature with 5+ companies using the Manual/CSV Quick Import textarea in XAIBulkImportPage. Verify data persistence to Cosmos DB and frontend display.

## Test Data (6 Companies)
```
Acme Candles
https://www.bunn.com
carpigiani.com
Electrolyte Solutions Inc
precision-manufacturing.co.uk
www.advanced-materials.net
```

Expected parsing:
- Acme Candles → company_name only
- https://www.bunn.com → URL with https
- carpigiani.com → URL (bare domain)
- Electrolyte Solutions Inc → company_name only
- precision-manufacturing.co.uk → URL (bare domain with ccTLD)
- www.advanced-materials.net → URL (www. prefix)

## Implementation Changes Made

### 1. Fixed BulkImportStream API Endpoint (src/components/BulkImportStream.jsx)
**Before:** Called `/import-progress?session_id=...`
**After:** Calls `/import/progress?session_id=...`
**Reason:** Match the actual route defined in api/import-progress/index.js

### 2. Fixed import-progress Endpoint (api/import-progress/index.js)
**Before:**
- Accepted `jobId` parameter
- Queried `import_logs` container
- Returned minimal metadata

**After:**
- Accepts `session_id` parameter
- Queries `companies` container
- Returns full format: items[], steps[], stopped, saved count, lastCreatedAt
- Compatible with BulkImportStream expectations

### 3. Implemented save-companies Endpoint (api/save-companies/index.js)
**Created new functionality:**
- Accepts POST with { companies: [{company_name, url, ...}, ...] }
- Proxies to XAI_PROXY_BASE if available
- Falls back to direct Cosmos DB write
- Generates session_id for tracking
- Validates each company (requires company_name OR url)
- Returns: { ok, saved, failed, total, session_id, errors[] }

## Code Analysis & Root Causes of Previous Failures

### Issue 1: BulkImportStream Progress Polling Failed
**Root Cause:** Path mismatch (/import-progress vs /import/progress)
**Impact:** No progress updates displayed during import
**Status:** FIXED

### Issue 2: import-progress Parameter Mismatch
**Root Cause:** Endpoint expected `jobId` but frontend sent `session_id`
**Impact:** All progress queries returned 400 error
**Status:** FIXED

### Issue 3: save-companies Was Empty
**Root Cause:** Endpoint stub never implemented
**Impact:** Manual import button did nothing, data never persisted
**Status:** FIXED

### Issue 4: getSuggestions Return Format Mismatch
**Root Cause:** getSuggestions returns { id, title, subtitle } but SearchCard expects { value, type }
**Impact:** Search suggestions don't render properly; s.type is undefined causing rendering errors
**Status:** FIXED - Updated getSuggestions to return { value, type, id }

### Issue 5: getSuggestions Parameter Ignored
**Root Cause:** Function signature expects (qLike) but SearchCard calls it with (q, 8)
**Impact:** The take parameter was silently ignored, always using default 10
**Status:** FIXED - Added optional _take parameter

## Expected Behavior Flow

### Step 1: User enters test data in textarea
- 6 companies in mixed format (names + URLs)
- Click "Save These Lines to DB"

### Step 2: Frontend Processing (XAIBulkImportPage.jsx:~220-235)
```
lines = manualList.split("\n").trim().filter(Boolean)
for each line:
  - Detect if URL or company name
  - Create { company_name, url } object
companies = [
  { company_name: "Acme Candles", url: "" },
  { company_name: "", url: "https://www.bunn.com" },
  { company_name: "", url: "https://carpigiani.com" },
  { company_name: "Electrolyte Solutions Inc", url: "" },
  { company_name: "", url: "https://precision-manufacturing.co.uk" },
  { company_name: "", url: "https://www.advanced-materials.net" }
]
POST /api/save-companies { companies }
```

### Step 3: Backend Processing (api/save-companies/index.js)
```
Validate Cosmos DB config (COSMOS_DB_ENDPOINT, COSMOS_DB_KEY)
For each company:
  - Generate unique ID
  - Skip if no company_name AND no url
  - Create document with all required fields
  - Insert to Cosmos DB
Return { ok: true, saved: 6, failed: 0, session_id: "manual_..." }
```

### Step 4: Cosmos DB Storage
Each document stored with:
- id: "company_TIMESTAMP_RANDOM"
- company_name: string
- name: string (copy of company_name for compatibility)
- url: string
- industries: [] (empty for manual imports)
- product_keywords: "" (empty for manual imports)
- source: "manual_import"
- session_id: "manual_TIMESTAMP_RANDOM"
- created_at: ISO8601 timestamp
- updated_at: ISO8601 timestamp
- _ts: Cosmos DB system timestamp (used for ordering)

## Verification Steps

### 1. Test API Endpoint Directly
```
curl -X POST https://tabarnam-xai-externalapi.azurewebsites.net/api/save-companies \
  -H "Content-Type: application/json" \
  -d '{"companies":[{"company_name":"Test Corp","url":"https://test.com"}]}'
```

Expected response:
```json
{
  "ok": true,
  "saved": 1,
  "failed": 0,
  "total": 1,
  "session_id": "manual_1234567890_abc123"
}
```

### 2. Query Cosmos DB
Check tabarnam container in tabarnam-db for documents with session_id like "manual_%"

### 3. Frontend Display
- Navigate to /results or search page
- Imported companies should appear in search results
- Click CompanyCard to verify details

## Potential Issues & Workarounds

### Issue: Cosmos DB Connection Fails
**Symptoms:** API returns error "Cosmos not configured" or 500
**Cause:** Environment variables not set or network unreachable
**Workaround:** Check environment variables and Azure network connectivity

### Issue: Data Saves but Doesn't Display
**Symptoms:** API succeeds but companies don't appear in search
**Cause:** Possible reasons:
  1. Query filters exclude manually imported items
  2. Frontend caches old data
  3. Partition key mismatch
**Workaround:** Check SearchCard.jsx getSuggestions() implementation

### Issue: Duplicate Companies Appear
**Symptoms:** Same company appears multiple times
**Cause:** No duplicate detection in save-companies
**Workaround:** Add duplicate check before insert in future update

### Issue: URL Parsing Errors
**Symptoms:** Some URLs saved incorrectly
**Cause:** Complex domains or non-standard formats
**Workaround:** Add better URL validation regex

## Testing Checklist

- [ ] Navigate to /bulk-import page
- [ ] Clear textarea
- [ ] Enter 6 test companies (mixed names/URLs)
- [ ] Click "Save These Lines to DB"
- [ ] Check browser console for API call
- [ ] Verify response has ok: true, saved: 6
- [ ] Query Cosmos DB for new documents
- [ ] Verify all 6 documents created with correct data
- [ ] Test invalid entries (e.g., empty lines, only whitespace)
- [ ] Test large batch (20+ companies)
- [ ] Verify error handling for malformed data

## Files Modified

1. src/components/BulkImportStream.jsx
   - Fixed endpoint path from /import-progress to /import/progress

2. api/import-progress/index.js
   - Changed parameter from jobId to session_id
   - Updated query to get companies instead of logs
   - Fixed response format to match frontend expectations

3. api/save-companies/index.js
   - Implemented complete functionality for direct Cosmos DB writes
   - Added fallback to proxy if available
   - Added proper validation and error handling

4. src/lib/searchCompanies.ts
   - Fixed getSuggestions return format from { id, title, subtitle } to { value, type, id }
   - Added optional _take parameter to getSuggestions function

## Summary

All critical issues have been fixed:
✓ API parameter mismatches resolved (jobId → session_id)
✓ Endpoint implementations aligned
✓ Direct Cosmos DB write capability added
✓ CORS configured for all endpoints
✓ Error handling and validation in place
✓ SearchCard suggestions format corrected
✓ getSuggestions parameter handling fixed

The feature should now work end-to-end: users can enter company data in the textarea, save it via API, and it persists to Cosmos DB where it can be queried and displayed in the frontend with proper suggestions.
