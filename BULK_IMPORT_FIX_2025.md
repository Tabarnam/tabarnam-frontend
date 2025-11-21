# Bulk Import Fix - Results Fallback Mechanism

## Problem
After PR #48 (removing proxy logic from save-companies), bulk import was hanging with "Import started. Streaming…" but no results appeared after 10 minutes.

### Root Cause
The external API (`tabarnam-xai-externalapi`) was not saving import results to Cosmos DB, either because:
1. The external API wasn't configured to save to Cosmos DB
2. The external API couldn't access Cosmos DB credentials
3. The external API failed silently on errors
4. There was a network issue between external API and Cosmos DB

### Current Architecture
```
Frontend                    Local API (tabarnam-xai-dedicated)     External API (tabarnam-xai-externalapi)
   |                                |                                     |
   | POST /import/start             |                                     |
   |----(session_id)--------------->| Proxy to                            |
   |                                |---(session_id)----->              /import/start
   |                                |                                     |
   |                                |<----------(returns companies?)<----
   |                                |                                     |
   | GET /import/progress            | Query Cosmos DB                    |
   |----(session_id)--------------->| (returns empty if external API     |
   |                                |  didn't save)                       |
   |<-------(empty items)-----------|                                     |
```

**The Issue:** External API never saves results to Cosmos DB, so polling returns empty.

## Solution: Automatic Results Fallback

### Changes Made

#### 1. **api/import-start/index.js**
- Modified to extract `companies` array from external API response (if returned)
- Automatically saves companies to Cosmos DB with the provided session_id
- Preserves session_id from frontend request for proper tracking
- Logs save results for debugging

**Key logic:**
```javascript
// Proxy to external API
const out = await httpRequest("POST", `${base}/import/start`, {
  headers: { "content-type": "application/json" },
  body: { ...bodyObj, session_id: sessionId },
});

// If external API returns companies, save them automatically
const companies = body?.companies || body?.results || [];
if (Array.isArray(companies) && companies.length > 0) {
  const saveResult = await saveCompaniesToCosmos(companies, sessionId);
  console.log(`Saved ${saveResult.saved} companies from external API`);
}
```

#### 2. **api/import-progress/index.js**
- First attempts to fetch from Cosmos DB (as before)
- If no results found locally, checks external API's `/import/status` endpoint
- If external API returns results, saves them to Cosmos DB automatically
- Returns results to frontend immediately

**Fallback logic:**
```javascript
// If no results in Cosmos DB
if (saved === 0) {
  // Try external API's import/status endpoint
  const statusUrl = `${base}/import/status?session_id=...`;
  const out = await httpRequest("GET", statusUrl);
  
  // If external API has results, save them and return
  const companies = statusBody?.companies || statusBody?.results || [];
  if (Array.isArray(companies) && companies.length > 0) {
    const saveResult = await saveCompaniesToCosmos(companies, sessionId);
    return json({ items: companies, saved: companies.length, ... });
  }
}
```

### Benefits

1. **Handles External API Failures Gracefully**
   - Works even if external API doesn't save to Cosmos DB
   - Detects and auto-saves results in fallback

2. **Maintains Session Tracking**
   - Session_id preserved throughout flow
   - Results properly associated with import request

3. **Supports Both Synchronous and Asynchronous Processing**
   - If external API returns results immediately: saved via import-start
   - If external API saves asynchronously: detected and saved via import-progress polling

4. **Backwards Compatible**
   - If external API is working correctly: no change in behavior
   - If external API is broken: automatic recovery

5. **Enhanced Debugging**
   - Added logging for save operations
   - Can track how many companies were saved and when

## Testing

### Scenario 1: Quick Manual Import (Uses Local /save-companies)
1. Go to `/admin/xai-bulk-import`
2. Paste company names in "Manual/CSV Quick Import" section
3. Click "Save These Lines to DB"
4. **Expected:** Immediate success with saved count

### Scenario 2: XAI Bulk Import (Uses External API)
1. Go to `/admin/xai-bulk-import`
2. Select search field and enter value (e.g., "water" for products)
3. Click "Start Import"
4. **Expected:** 
   - "Import started. Streaming…" message
   - Results appear in streaming panel
   - Session ID displayed for reference

### Verification
- Check Cosmos DB for documents with `source: "xai_import"`
- Verify `session_id` matches the displayed session ID
- Check browser console for `[import-start]` and `[import-progress]` logs

## Environment Variables

- `COSMOS_DB_ENDPOINT` - Cosmos DB endpoint URL
- `COSMOS_DB_KEY` - Cosmos DB authentication key
- `COSMOS_DB_DATABASE` - Database name (default: tabarnam-db)
- `COSMOS_DB_COMPANIES_CONTAINER` - Companies container name (default: companies)
- `XAI_EXTERNAL_BASE` - External API base URL (e.g., https://tabarnam-xai-externalapi.azurewebsites.net/api)
- `XAI_PROXY_BASE` - Optional proxy for routing

## Code Changes Summary

### Files Modified
1. **api/import-start/index.js** (~120 lines)
   - Added `saveCompaniesToCosmos()` function
   - Modified handler to extract and save external API results
   - Added error handling and logging

2. **api/import-progress/index.js** (~160 lines)
   - Added `saveCompaniesToCosmos()` function (same as import-start)
   - Modified handler to include fallback mechanism
   - Added external API status endpoint polling

### No Changes Required
- `src/pages/XAIBulkImportPage.jsx` - Works as-is
- `src/components/BulkImportStream.jsx` - Works as-is
- `api/save-companies/index.js` - Already working correctly

## Deployment

1. Test locally with `npm run dev`
2. Verify API endpoints:
   - `POST /api/import/start` - Should forward to external API
   - `GET /api/import/progress?session_id=...` - Should return results
3. Deploy changes to Azure Static Web Apps
4. Test bulk import feature end-to-end

## Future Improvements

1. Add retry mechanism with exponential backoff
2. Implement session timeout handling
3. Add metrics/monitoring for import success rates
4. Consider async job queue for large imports
5. Add webhook support if external API implements it
