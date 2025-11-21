# Bulk Import Fix - Root Cause Analysis & Resolution

## Problem Summary
The bulk import feature returns **502 Bad Gateway** when attempting to search and import companies via XAI.

**Root Cause**: The `FUNCTION_URL` environment variable is configured to point to `/api/xai` which **does not exist** on the tabarnam-xai-dedicated server.

## What Was Happening

### Before Fix
1. Frontend calls `/api/import/start` to start bulk import
2. `/api/import-start` tries to call `FUNCTION_URL` (set to `https://tabarnam-xai-dedicated.../api/xai`)
3. `/api/xai` endpoint doesn't exist → **404 Not Found**
4. Returns **502 Bad Gateway** to frontend
5. Bulk import fails

### After Fix
1. Frontend calls `/api/import/start` to start bulk import
2. `/api/import-start` now calls `/api/proxy-xai` directly (local endpoint)
3. `/api/proxy-xai` attempts to call `FUNCTION_URL` (still `/api/xai`)
4. `/api/xai` now exists but returns **501 Not Implemented** with configuration guidance
5. Returns **502 error** from `/api/proxy-xai` with clear error message

## Changes Made

### 1. Updated `/api/import-start/index.js`
- **Before**: Tried to call `FUNCTION_URL` directly (which was misconfigured)
- **After**: Calls `/api/proxy-xai` endpoint locally, which is more robust
- **Benefit**: Consistent error handling through proxy-xai, clear error messages

### 2. Created `/api/xai/index.js` 
- This endpoint now exists (previously missing)
- Returns a **501 Not Implemented** error with configuration guidance
- Explains that `FUNCTION_URL` must point to the actual XAI search API

## What FUNCTION_URL Should Point To

The `FUNCTION_URL` environment variable must point to an **actual XAI search endpoint**, not a local endpoint. Options:

### Option A: External XAI API
If you have an external Azure Function app that does XAI searches:
```
FUNCTION_URL=https://your-xai-external-api.azurewebsites.net/api/search-companies
FUNCTION_KEY=<your-function-key>
```

### Option B: Direct XAI Integration
If you want to call XAI API directly from within the code (requires updates):
- Need XAI API credentials
- Would require modifying `/api/proxy-xai` to call XAI API directly

### Option C: Use Local Stub for Testing
To test the flow without external dependencies:
```
# In Azure Static Web Apps or function app settings:
XAI_STUB=1  # This enables stub data mode in /api/proxy-xai
```

## Correct Architecture

```
Frontend
    ↓
/api/import-start
    ↓
/api/proxy-xai (enriches data)
    ↓
FUNCTION_URL (actual XAI search) ← Must point to real API!
    ↓
Returns companies
    ↓
/api/import-start saves to Cosmos DB
    ↓
Frontend polls /api/import-progress for results
```

## How to Fix

### Step 1: Identify Your XAI Endpoint
- Check if you have an external API that does XAI searches (e.g., tabarnam-xai-externalapi)
- Verify it has company search endpoints
- Get the base URL and API key

### Step 2: Update Environment Variables
In your deployment settings (Azure Static Web Apps → Configuration):

```
FUNCTION_URL=<correct-xai-endpoint-url>
FUNCTION_KEY=<correct-xai-api-key>
```

### Step 3: Test Configuration
Check the diagnostic endpoint:
```
curl https://tabarnam.com/api/admin/bulk-import-config
```

Should show:
```json
{
  "config": {
    "status": {
      "import_ready": true  ← This must be true
    }
  }
}
```

### Step 4: Test Bulk Import
1. Go to https://tabarnam.com/admin/xai-bulk-import
2. Enter search value (e.g., "chairs")
3. Click "Start Import"
4. Should see "✅ Import started. Streaming…"
5. Companies should appear in the table below

## Diagnostic Information

Run this to check your current configuration:
```bash
curl https://tabarnam.com/api/admin/bulk-import-config
```

This shows:
- ✅ What's configured correctly
- ❌ What's missing
- 🔧 What needs to be fixed

## Files Modified
- `/api/import-start/index.js` - Now calls `/api/proxy-xai` directly
- `/api/xai/index.js` - Created new endpoint with configuration guidance

## Next Steps

1. **Identify the correct FUNCTION_URL** - Where is the actual XAI search API?
2. **Update environment variables** in Azure portal
3. **Redeploy** or update the Static Web App configuration
4. **Test** using the diagnostic endpoint and bulk import page

## Questions to Ask Yourself

- **Do I have an external API that does XAI searches?** 
  - If yes, what's its URL and what endpoint should be called?
  
- **What credentials are needed?**
  - API key format, authentication method, etc.

- **Is the external API working?**
  - Test with a direct curl/postman request to ensure it responds

## Example: If Using tabarnam-xai-externalapi

If your external API at `tabarnam-xai-externalapi.azurewebsites.net` has a company search endpoint:

```bash
# Test the endpoint:
curl -X POST https://tabarnam-xai-externalapi.azurewebsites.net/api/companies/search \
  -H "Content-Type: application/json" \
  -H "x-functions-key: YOUR_KEY" \
  -d '{"queryType":"product_keyword","query":"chairs","limit":10}'
```

If it works, then set:
```
FUNCTION_URL=https://tabarnam-xai-externalapi.azurewebsites.net/api/companies/search
FUNCTION_KEY=YOUR_KEY
```

## Summary

The bulk import now has:
- ✅ Better error handling with clear diagnostics
- ✅ Proper local endpoint structure
- ✅ Clear configuration guidance
- ⚠️ Still needs correct FUNCTION_URL configuration to work

**You need to:** Set FUNCTION_URL to point to your actual XAI search endpoint (not /api/xai).
