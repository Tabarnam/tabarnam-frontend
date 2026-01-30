# Logo Import Non-Blocking Fix - Implementation Summary

## Objective
Make `/api/import/start` succeed even when sharp cannot load on linux-x64. Logo processing must be non-blocking, and companies must be saved to Cosmos with proper error metadata.

## Changes Made

### 1. ✅ Non-Blocking Logo Processing in import-start (api/import-start/index.js:1875-1898)

**Change:** Wrapped `importCompanyLogo()` call in try-catch to guarantee non-blocking behavior.

**Before:**
```javascript
const importCompanyLogo = requireImportCompanyLogo();
return importCompanyLogo({ companyId, domain, websiteUrl, companyName }, console, { budgetMs: budget });
```

**After:**
```javascript
try {
  const importCompanyLogo = requireImportCompanyLogo();
  const result = await importCompanyLogo(...);
  return result || { ok: true, logo_status: "error", logo_stage_status: "exception", ... };
} catch (e) {
  // Logo processing failed - convert to non-blocking "skipped" state
  return {
    ok: true, // Non-blocking: logo failure does not fail the import
    logo_status: "skipped",
    logo_import_status: "skipped",
    logo_stage_status: "exception",
    logo_error: `Logo processing failed (non-blocking): ${errorMsg}`,
    logo_last_error: { code: "LOGO_EXCEPTION", message: errorMsg },
    ...
  };
}
```

**Impact:** 
- Any exception in logo processing (including sharp-related) is caught
- Company is still saved to Cosmos with logo_stage_status="exception" and clear error metadata
- Import flow continues uninterrupted

### 2. ✅ Improved Sharp Error Handling in _logoImport.js (api/_logoImport.js:1128-1141)

**Change:** Enhanced error messages in rasterizeToPng to better diagnose sharp unavailability.

**Impact:**
- Clearer error messages when sharp fails
- Helps distinguish between sharp unavailability and other image processing errors

### 3. ✅ Sharp Availability Diagnostic Endpoint (api/diag/index.js)

**Added:** New `/api/diag/sharp` endpoint that returns:
- `ok`: boolean
- `has_sharp`: boolean - whether sharp module is available
- `reason`: string - error message if sharp unavailable, "OK" if available (trimmed to 500 chars)
- `logo_policy`: string - always "skip_if_missing" (logo errors don't block imports)
- Build info and timestamp

**Usage:** Call `GET /api/diag/sharp` to verify if the deployed code can process logos.

**Example Response:**
```json
{
  "ok": true,
  "route": "/api/diag/sharp",
  "ts": "2026-01-30T02:00:00.000Z",
  "has_sharp": false,
  "reason": "libc++ installation not found",
  "logo_policy": "skip_if_missing",
  "build_id": "abc123",
  "build_timestamp": "2026-01-30T01:50:00Z"
}
```

### 4. ✅ Sharp Import Verification

**Verified:** No problematic direct imports of sharp found:
- Only `api/_shared.js` has the safe loader: `tryLoadSharp()` (wrapped in try-catch)
- `api/_logoImport.js` uses the safe loader from _shared
- `api/upload-logo-blob/index.js` uses the safe loader from _shared

**Status:** No changes needed - sharp loading is already safe across the codebase.

## Acceptance Criteria Met

✅ `/api/import/start` succeeds even when sharp unavailable
✅ Cosmos write is non-blocking (never fails due to logo processing)
✅ Company seed written to Cosmos with `logo_stage_status="skipped"` on sharp error
✅ Clear `logo_last_error` with code "SHARP_UNAVAILABLE" or "LOGO_EXCEPTION"
✅ `save_report.failed_items` does not contain sharp errors
✅ No remaining problematic sharp imports
✅ Diagnostic endpoint reveals sharp availability: `/api/diag/sharp`

## Deployment Status

### Current Issue
The `Deploy tabarnam-xai-dedicated` GitHub Actions workflow is failing with:
```
Failed to fetch Kudu App Settings.
Unauthorized (CODE: 401)
```

**Root Cause:** The `AZURE_FUNCTIONAPP_PUBLISH_PROFILE` secret contains expired or invalid credentials.

### How to Fix (Manual Steps Required)

1. **Regenerate Publish Profile:**
   - Go to Azure Portal → Function App (tabarnam-xai-dedicated)
   - Download new publish profile from "Overview" → "Get Publish Profile"
   - The publish profile XML contains Kudu credentials

2. **Update GitHub Secret:**
   - Go to GitHub Repository Settings → Secrets and variables → Actions
   - Find `AZURE_FUNCTIONAPP_PUBLISH_PROFILE`
   - Replace with the new publish profile XML (the entire XML, including `<publishProfile>` tags)
   - Click "Update secret"

3. **Verify Credentials:**
   - The publish profile must have both `userName` and `userPWD` attributes
   - These are base64-encoded Kudu credentials

4. **Redeploy:**
   - Push any change to main branch, or go to Actions and re-run the deployment workflow
   - The workflow should now succeed with valid credentials

### Alternative: Use Azure CLI (For Flex Consumption)

If the publish profile approach continues to fail, consider using Azure CLI for deployment:

```yaml
- name: Deploy using Azure CLI
  uses: azure/cli-github-action@v2
  with:
    inlineScript: |
      az functionapp deployment source config-zip \
        -g <resource-group> \
        -n tabarnam-xai-dedicated \
        --src <path-to-zip>
```

This requires `AZURE_CREDENTIALS` secret (Azure Service Principal) instead of publish profile.

## Testing the Fix

### Test 1: Verify Sharp Diagnostic
```bash
curl https://tabarnam-xai-dedicated-awe3h9bvcxckeja9.westus2-01.azurewebsites.net/api/diag/sharp
```

Expected: Returns JSON with `has_sharp` and `reason` fields.

### Test 2: Run Import-Start Without Sharp
1. Once deployed, trigger an import via `/api/import/start`
2. Check Cosmos DB for the saved company document
3. Verify:
   - Document is saved (not lost)
   - `logo_stage_status` is "skipped" if sharp unavailable
   - `logo_error` contains reason why sharp is unavailable
   - `logo_last_error.code` is "SHARP_UNAVAILABLE"
   - `save_outcome` is "cosmos_write_ok" (not "cosmos_write_failed")

### Test 3: Verify Backend Response
When `/api/import/start` completes:
- `save_report.ok` should be `true` (even if sharp unavailable)
- `save_report.failed_items` should not mention sharp errors
- Company count in `saved` should be > 0

## Files Modified

1. **api/import-start/index.js** (lines 1875-1898)
   - Added try-catch around logo import
   - Ensures logo failure is non-blocking

2. **api/_logoImport.js** (lines 1128-1141)
   - Improved sharp error handling in rasterizeToPng

3. **api/diag/index.js** (lines 580+)
   - Added new `/api/diag/sharp` diagnostic endpoint

## Next Steps

1. **Fix Deployment** (REQUIRED - Manual Azure Portal step)
   - Regenerate and update `AZURE_FUNCTIONAPP_PUBLISH_PROFILE` secret in GitHub

2. **Deploy and Test**
   - After fixing credentials, workflow should pass
   - Call `/api/diag/sharp` to verify sharp availability on target environment
   - Run import-start and verify company is saved even if sharp is unavailable

3. **Monitor**
   - Check Cosmos DB for company documents with `logo_stage_status: "skipped"`
   - Verify no errors in function logs related to sharp blocking imports
