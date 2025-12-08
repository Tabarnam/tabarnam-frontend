# Accessibility Fixes and Logo Upload Debugging Summary

## ✅ Accessibility Issues FIXED

### Issue: DialogContent Missing `aria-describedby`
The Radix UI DialogContent components were missing the `aria-describedby` attribute and related IDs on DialogDescription elements, causing console warnings.

### Files Fixed:
1. **src/components/admin/XAIImportModal.jsx**
   - Added `aria-describedby="xai-import-description"` to DialogContent
   - Added `id="xai-import-description"` to DialogDescription

2. **src/components/admin/BulkEditModal.jsx**
   - Added `aria-describedby="bulk-edit-description"` to DialogContent
   - Added `id="bulk-edit-description"` to DialogDescription

3. **src/components/admin/CompanyForm.jsx** (Already Fixed)
   - Main dialog has `aria-describedby="company-form-description"`
   - Nested logo upload dialog has `aria-describedby="logo-upload-description"`

### Result:
These fixes eliminate the Radix UI warnings about missing DialogTitle or aria-describedby. You should no longer see these console warnings after deployment and hard browser cache refresh (Ctrl+Shift+R).

---

## 🔍 Logo Upload 500 Error - Debugging

### Current Status:
- **Environment Variables**: ✅ Correctly set in Azure Function App (confirmed via PowerShell)
  - `AZURE_STORAGE_ACCOUNT_NAME`: tabarnamstor2356
  - `AZURE_STORAGE_ACCOUNT_KEY`: [correctly set]
  - `AzureWebJobsStorage`: [connection string with credentials]

- **API Code**: ✅ Has fallback logic to read credentials from AzureWebJobsStorage
- **Error**: Still returning 500 "Server storage not configured"

### Root Cause Analysis:
The environment variables ARE set in Azure, but the Function App process isn't reading them properly. This typically happens when:
1. The Function App process cache hasn't been cleared
2. The deployment didn't fully propagate the env var changes
3. There's a race condition between deployment and env var setting

### Debugging Steps - In Order:

#### Step 1: Test the New Diagnostic Endpoint (AFTER DEPLOYMENT)
After these changes are deployed, visit:
```
https://tabarnam.com/api/admin-storage-config
```

This endpoint will show:
- ✓ Whether direct env vars are accessible (AZURE_STORAGE_ACCOUNT_NAME, AZURE_STORAGE_ACCOUNT_KEY)
- ✓ Whether fallback credentials can be extracted from AzureWebJobsStorage
- ✓ A recommendation for fixing any issues
- ✓ List of all AZURE_* and STORAGE_* env vars present

**Share the JSON output** - this will tell us exactly what the Function App can see.

#### Step 2: Force Environment Variable Reload (in Azure Portal)
Even though variables are set, they might not be loaded by the running process:

1. Go to Azure Portal → Function App (`tabarnam-xai-dedicated`)
2. Left sidebar → **Configuration**
3. Find `AZURE_STORAGE_ACCOUNT_NAME` and `AZURE_STORAGE_ACCOUNT_KEY`
4. Click **Save** at the top (this forces a reload)
5. Wait for "Settings updated successfully" notification (usually ~1 minute)
6. Click **Restart** button at the very top
7. Wait for Function App status to show "Running" (2-3 minutes)

#### Step 3: Test Logo Upload
1. Go to https://tabarnam.com/admin
2. Edit any company (e.g., YETI)
3. Click "Add Logo" or "Replace Logo"
4. Upload a test image
5. Check for success or error

#### Step 4: Check Function App Logs
If step 3 still fails:
1. Azure Portal → Function App → **Log stream** (left sidebar under Monitoring)
2. Look for lines containing `[upload-logo-blob]`
3. These logs will show which env vars the API could find
4. Share these logs with the debugging team

---

## 📋 API Changes Made

### New File: api/admin-storage-config/index.js
- Diagnostic endpoint to check storage configuration
- Returns detailed JSON about env vars and credentials
- Helps troubleshoot the 500 error

### Enhanced File: api/upload-logo-blob/index.js
- Already has comprehensive logging and fallback logic
- Logs which credentials are found (direct or from connection string)
- Lists all STORAGE/AZURE env vars for debugging

---

## 🚀 Next Steps

1. **Deploy these changes**
   - Commit and push these files
   - GitHub Actions will deploy automatically

2. **Wait 5-10 minutes** for deployment to complete

3. **Hard refresh browser cache**
   - Press Ctrl+Shift+R (Windows) or Cmd+Shift+R (Mac)
   - Clear browser cache entirely if warnings persist

4. **Test diagnostic endpoint first**
   - Visit: https://tabarnam.com/api/admin-storage-config
   - Share the output

5. **If diagnostic shows credentials are available:**
   - Proceed to Step 2 above (Force reload in Azure Portal)

6. **If diagnostic shows credentials are missing:**
   - Something else is wrong; share the diagnostic output for further analysis

---

## 📝 Important Notes

- The accessibility warnings **will not prevent logo uploads** from working
- They're just console warnings that don't affect functionality
- Once environment variables are properly loaded, uploads will work
- The diagnostic endpoint is a powerful debugging tool - check it first before other steps

---

## Contact & Support

If the diagnostic endpoint shows credentials are available but uploads still fail, the issue is likely deeper and may require:
- Function App restart after deployment
- Checking Azure Function Runtime logs
- Verifying the blob storage container exists ("company-logos")
