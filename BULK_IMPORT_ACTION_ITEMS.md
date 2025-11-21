# Bulk Import Action Items

## Summary
The bulk import 502 error was caused by `FUNCTION_URL` pointing to a non-existent `/api/xai` endpoint. The system has been fixed to provide better error messages and diagnostics.

## What Was Fixed ✅

### 1. **Import-Start Endpoint**
- Now calls `/api/proxy-xai` directly (more robust than direct proxying)
- Better error handling and logging
- Returns clear diagnostic information when configuration is missing

### 2. **New /api/xai Endpoint**
- Created `/api/xai` endpoint (was previously missing)
- Returns **501 Not Implemented** with configuration guidance
- Explains what FUNCTION_URL should be

### 3. **Enhanced Logging**
- Added diagnostic logging for:
  - FUNCTION_URL configuration status
  - XAI_EXTERNAL_BASE status
  - Request/response details
  - Error messages with context

## The Real Issue: FUNCTION_URL Configuration

**Current Setting:**
```
FUNCTION_URL = https://tabarnam-xai-dedicated-awe3h9bvcxckeja9.westus2-01.azurewebsites.net/api/xai
```

**Problem:** 
The `/api/xai` endpoint doesn't do the actual XAI search. It just returns an error message.

**Solution:**
Update `FUNCTION_URL` to point to the **actual XAI search endpoint**.

## How to Determine the Correct FUNCTION_URL

### Option 1: Check Your External API
Your environment has `XAI_EXTERNAL_BASE`:
```
XAI_EXTERNAL_BASE = https://tabarnam-xai-externalapi.azurewebsites.net/api
```

**Questions to answer:**
- Does tabarnam-xai-externalapi have a company search endpoint?
- If yes, what's the endpoint path? (e.g., `/companies/search`, `/bulk-import`, etc.)
- What's the authentication method?

**Test it:**
```bash
curl -X POST https://tabarnam-xai-externalapi.azurewebsites.net/api/[ENDPOINT] \
  -H "Content-Type: application/json" \
  -H "x-functions-key: [KEY]" \
  -d '{"queryType":"product_keyword","query":"test","limit":5}'
```

### Option 2: Use Stub Data (for testing only)
To test the bulk import flow without external API:

**Set in Azure Portal:**
```
XAI_STUB = 1
```

This makes the system return sample data instead of calling external API.

### Option 3: Direct XAI API (if available)
If you have credentials for the actual XAI API at x.ai:
```
FUNCTION_URL = https://api.x.ai/v1/...
FUNCTION_KEY = sk-...
```

## What You Need To Do

### Step 1: Identify the Correct Endpoint
- Ask your team: "Where is the actual XAI company search API?"
- Options:
  - External function app (tabarnam-xai-externalapi)
  - Direct XAI API
  - A different service

### Step 2: Get the Endpoint URL & Key
- Get the full URL of the search endpoint
- Get the API key/authentication token

### Step 3: Test the Endpoint
Test it manually to ensure it works:
```bash
curl -X POST [FUNCTION_URL] \
  -H "Content-Type: application/json" \
  -H "x-functions-key: [FUNCTION_KEY]" \
  -d '{
    "queryType": "product_keyword",
    "query": "chairs",
    "limit": 5
  }'
```

Expected response should include a `companies` array.

### Step 4: Update Configuration
In Azure Portal → Static Web Apps → Configuration:

Update or create:
```
FUNCTION_URL = [Correct endpoint URL from Step 2]
FUNCTION_KEY = [API key from Step 2]
```

### Step 5: Redeploy
- Option A: Push code changes (triggers auto-deploy)
- Option B: Just update the configuration (no code changes needed)

### Step 6: Verify
Test the diagnostic endpoint:
```bash
curl https://tabarnam.com/api/admin/bulk-import-config
```

Look for:
```json
{
  "status": {
    "import_ready": true  ← Must be true!
  }
}
```

### Step 7: Test Bulk Import
1. Go to https://tabarnam.com/admin/xai-bulk-import
2. Enter a search term (e.g., "office chairs")
3. Click "Start Import"
4. Should see: "✅ Import started. Streaming…"
5. Companies should appear in the table

## Files Changed
- `api/import-start/index.js` - Updated to call proxy-xai, added better logging
- `api/xai/index.js` - Created new endpoint with configuration guidance
- `BULK_IMPORT_FIX_FINAL.md` - Detailed technical documentation

## Troubleshooting

### If you still get 502 error:
1. Check the diagnostic endpoint: `/api/admin/bulk-import-config`
2. Look for the error message in Azure Portal → Function App → Monitor
3. Verify FUNCTION_URL is actually pointing to a working endpoint

### If companies appear in table but seem incomplete:
1. Check if the external API is returning the right format
2. Look at the import progress logs
3. Verify Cosmos DB has the companies saved

### If you're not sure about FUNCTION_URL:
1. Ask your DevOps/API team where the XAI search endpoint is
2. Test the endpoint with curl before setting it
3. Check Azure Function app logs to see what endpoints are available

## Quick Checklist
- [ ] Identified the correct XAI search endpoint URL
- [ ] Tested the endpoint manually with curl
- [ ] Updated FUNCTION_URL in Azure Portal
- [ ] Updated FUNCTION_KEY in Azure Portal
- [ ] Verified settings with `/api/admin/bulk-import-config` endpoint
- [ ] Tested bulk import with a sample search term

## Need Help?
- Check `/api/admin/bulk-import-config` for detailed configuration status
- Look at Azure Function logs for detailed error messages
- Verify network connectivity to the XAI endpoint
- Ensure API key/authentication is correct
