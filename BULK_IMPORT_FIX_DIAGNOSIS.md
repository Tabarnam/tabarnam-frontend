# Bulk Import Fix - Root Cause & Solution

## Problem Summary

The bulk import feature at `/admin/xai-bulk-import` was hanging indefinitely with "Import started. Streaming…" and never returning results, even after 10+ minutes.

### What We Found

1. **External API was not receiving import requests**
   - Logs showed only ping requests (`/api/ping`)
   - No requests to `/import/start` or `/import/status`
   - This meant the request was never reaching the external API

2. **Root Cause**: The `/import/start` endpoint was trying to proxy to:
   ```
   https://tabarnam-xai-externalapi.azurewebsites.net/api/import/start
   ```
   **But this endpoint doesn't exist** on the external API. The external API only has `/save-companies` and other endpoints, but not the bulk import endpoints.

3. **Architecture Problem**
   ```
   Frontend (XAIBulkImportPage)
     ↓
   Local API (/api/import/start)
     ↓ [tries to proxy to]
   External API (/import/start) ← DOESN'T EXIST
   ```

## Solution Implemented

### Changes Made

#### 1. **api/import-start/index.js** (REWRITTEN)
- **OLD:** Tried to proxy to `XAI_EXTERNAL_BASE/import/start`
- **NEW:** Directly calls the XAI API using `FUNCTION_URL` and `FUNCTION_KEY` environment variables
- **Features:**
  - Calls XAI API directly
  - Saves results to Cosmos DB immediately
  - Returns session_id for polling
  - Includes comprehensive logging for debugging

#### 2. **api/import-progress/index.js** (SIMPLIFIED)
- **OLD:** Tried to call `/import/status` endpoint on external API
- **NEW:** Simply queries Cosmos DB for companies with matching session_id
- **Features:**
  - Fast, reliable Cosmos DB queries
  - No external API dependency
  - Returns results as they're saved

#### 3. **api/admin-bulk-import-config/index.js** (NEW)
- Diagnostic endpoint to check configuration
- Shows what's configured and what's missing
- Provides recommendations for fixing issues

### New Architecture

```
Frontend (XAIBulkImportPage)
  ↓
Local API (/api/import/start)
  ↓ [calls directly]
XAI API (via FUNCTION_URL)
  ↓
[Returns companies]
  ↓
[Save to Cosmos DB]
  ↓
Local API (/api/import/progress)
  ↓ [queries]
Cosmos DB
  ↓
[Return results to frontend]
```

## What's Required to Make It Work

### ⚠️ CRITICAL: Environment Variables

The bulk import feature requires these environment variables to be configured:

```
FUNCTION_URL=<XAI API endpoint URL>
FUNCTION_KEY=<XAI API authentication key>
```

**These are currently NOT SET**, which is why bulk import returns a stub response.

### Where to Get These Values

You need to identify:
1. **FUNCTION_URL**: The endpoint URL where XAI bulk import queries are available
   - Could be a separate Azure Function
   - Could be your external API with the right endpoint
   - Could be the main XAI API endpoint

2. **FUNCTION_KEY**: The authentication key for that endpoint
   - API key
   - Function code
   - Bearer token (depending on the service)

### How to Set Them

**Option 1: Using DevServerControl (Current Session)**
```
[Open Settings] → Environment Variables
Add:
  FUNCTION_URL = <your XAI API URL>
  FUNCTION_KEY = <your API key>
```

**Option 2: In Deployment (Azure Static Web Apps)**
1. Go to Azure Portal → Static Web Apps → tabarnam-frontend
2. Configuration → Application Settings
3. Add the variables there
4. Redeploy

**Option 3: In .env file (Local Development)**
```bash
echo "FUNCTION_URL=<your URL>" >> .env
echo "FUNCTION_KEY=<your key>" >> .env
```

## How to Verify Configuration

### Check Configuration Status
```bash
# Call the diagnostic endpoint
curl https://tabarnam.com/api/admin/bulk-import-config

# Response will show:
{
  "config": {
    "xai": {
      "function_url": {
        "configured": true/false,
        "status": "✅ CONFIGURED or ❌ MISSING"
      },
      "function_key": {
        "configured": true/false,
        "status": "✅ CONFIGURED or ❌ MISSING"
      }
    },
    "cosmos_db": { ... },
    "status": {
      "import_ready": true/false
    },
    "recommendations": [ ... ]
  }
}
```

## Testing After Configuration

### Step 1: Verify Configuration
```bash
curl https://tabarnam.com/api/admin/bulk-import-config
# Should show "import_ready": true
```

### Step 2: Test Bulk Import
1. Go to `https://tabarnam.com/admin/xai-bulk-import`
2. Enter search value (e.g., "electrolyte powder")
3. Click "Start Import"
4. **Expected:** Results appear within seconds/minutes

### Step 3: Verify Data Saved
1. Check Azure Portal → Cosmos DB
2. Query the companies collection
3. Look for documents with `"source": "xai_import"`
4. Verify `session_id` matches the one shown in the UI

## Code Flow After Fix

### Import Start Flow
```javascript
1. Frontend sends POST /api/import/start
   ├─ session_id: unique ID
   ├─ query: search term
   ├─ queryType: "product_keyword" | "company_name" | etc.
   └─ limit: 1-25

2. Backend (import-start):
   ├─ Generates/uses session_id
   ├─ Calls XAI API (FUNCTION_URL with FUNCTION_KEY)
   ├─ Receives companies array
   ├─ Enriches data (normalizes fields)
   ├─ Saves to Cosmos DB with session_id
   └─ Returns { ok: true, session_id, companies }

3. Frontend gets response:
   ├─ Displays "Import started. Streaming…"
   ├─ Stores session_id
   └─ Starts polling /api/import/progress
```

### Import Progress Flow
```javascript
1. Frontend polls GET /api/import/progress?session_id=<id>&take=200

2. Backend (import-progress):
   ├─ Queries Cosmos DB
   ├─ WHERE session_id = <id>
   ├─ ORDER BY created_at DESC
   └─ Returns top N results

3. Frontend receives:
   ├─ items: [ { company_name, url, ... }, ... ]
   ├─ saved: count
   ├─ stopped: boolean
   └─ lastCreatedAt: timestamp

4. Frontend:
   ├─ Displays companies in real-time
   ├─ Updates "Saved so far" counter
   └─ Continues polling until stopped
```

## Troubleshooting

### Bulk Import Shows "Not configured" Message
- **Cause**: FUNCTION_URL or FUNCTION_KEY not set
- **Fix**: Set these environment variables (see "How to Set Them" above)

### Bulk Import Returns Empty Results
- **Cause 1**: FUNCTION_URL/FUNCTION_KEY point to wrong endpoint
- **Cause 2**: XAI API is not responding or returning no data
- **Fix**: 
  - Verify the endpoint is correct
  - Check XAI API logs for errors
  - Test the XAI endpoint directly

### Cosmos DB Shows No Data
- **Cause**: Cosmos DB connection issue or save failing silently
- **Fix**:
  - Check `COSMOS_DB_ENDPOINT` and `COSMOS_DB_KEY`
  - Verify Azure Cosmos DB is accessible
  - Check function logs for errors

### Import Hangs at "Streaming…"
- **Cause**: Frontend is polling but not getting results
- **Fix**:
  - Check browser console for errors
  - Verify XAI import-start returned successfully (check Network tab)
  - Check Cosmos DB for documents with that session_id

## Files Modified

1. `api/import-start/index.js` - Complete rewrite to call XAI directly
2. `api/import-progress/index.js` - Simplified to query Cosmos DB
3. `api/admin-bulk-import-config/index.js` - New diagnostic endpoint
4. `api/index.js` - Registered new diagnostic endpoint

## Environment Variables Checklist

- [ ] `FUNCTION_URL` - XAI API endpoint (REQUIRED for bulk import)
- [ ] `FUNCTION_KEY` - XAI API key (REQUIRED for bulk import)
- [x] `COSMOS_DB_ENDPOINT` - Already configured
- [x] `COSMOS_DB_KEY` - Already configured
- [x] `COSMOS_DB_DATABASE` - Defaults to "tabarnam-db"
- [x] `COSMOS_DB_COMPANIES_CONTAINER` - Defaults to "companies"

## Next Steps

1. **Identify XAI credentials**: Find out where the XAI API is and what the endpoint/key are
2. **Configure environment variables**: Set FUNCTION_URL and FUNCTION_KEY
3. **Test diagnostic endpoint**: Verify configuration is correct
4. **Test bulk import**: Run through the test steps above
5. **Monitor logs**: Check both local API and XAI API logs for any issues

## Notes

- The bulk import now saves results incrementally to Cosmos DB as they're received from XAI
- Frontend polling works via `/api/import/progress` which queries the database
- No dependency on the external API's import endpoints (they don't exist)
- All companies are enriched with normalized fields before saving
- Session tracking is reliable using unique session IDs

## Support

If bulk import still doesn't work after configuration:
1. Check the diagnostic endpoint: `/api/admin/bulk-import-config`
2. Review Azure Function logs for errors
3. Verify network connectivity between services
4. Check Cosmos DB for data (even if import appears to fail)
5. Review browser console for frontend errors

---

**Status**: Code changes complete ✅  
**Next**: Configure FUNCTION_URL and FUNCTION_KEY environment variables ⏳
