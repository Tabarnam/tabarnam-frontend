# Logo Upload 500 Error - Fix Summary

## Issues Addressed

### 1. Logo Upload 500 Error (Fixed in API)
**Problem**: POST to `/api/upload-logo-blob` returning 500 with message "Server storage not configured"

**Root Cause**: Environment variables for Azure Storage Account were not being properly recognized by the Azure Function at runtime.

**Solutions Applied**:
- ✅ Updated `api/upload-logo-blob/index.js` with:
  - Fallback credential retrieval (tries multiple environment variable naming conventions)
  - Better error logging to diagnose future issues
  - Support for credentials from both direct env vars and `AzureWebJobsStorage`
  - More detailed error messages

### 2. Accessibility Warnings (Already Fixed)
**Problem**: Radix UI console warnings about missing DialogContent description

**Status**: ✅ Already properly configured in `src/components/admin/CompanyForm.jsx`:
```jsx
<Dialog open={showLogoDialog} onOpenChange={setShowLogoDialog}>
  <DialogContent className="max-w-md" aria-describedby="logo-upload-description">
    <DialogTitle className="sr-only">Update Company Logo</DialogTitle>
    <DialogDescription id="logo-upload-description" className="sr-only">
      Upload or set a logo URL for the company
    </DialogDescription>
    <LogoUploadDialog {...props} />
  </DialogContent>
</Dialog>
```

## What You Need to Do

### Step 1: Verify Azure Configuration (REQUIRED)
The environment variables you added to Azure are correct, but they need proper verification:

1. **Go to Azure Portal**
2. **Navigate**: Function App → `tabarnam-xai-dedicated` → Configuration
3. **Check** these application settings exist:
   - `AZURE_STORAGE_ACCOUNT_NAME` = `tabarnamstor2356`
   - `AZURE_STORAGE_ACCOUNT_KEY` = `yc2wE75NmkLuy74EoJMqMaNpNFm70vK2iptLuAzJ6XswlPOWREJEd5sNUS8sDNKV484jxhFLTPCo+AStzd3Kfw==`

4. **Verify** the values have NO extra spaces or quotes
5. **Click "Save"** to persist

### Step 2: Deploy the Updated Code
The updated API code needs to be deployed:

1. **The changes are committed** and will be automatically deployed when you push
2. The improved error logging will help diagnose any remaining issues

### Step 3: Test After Deployment
Once deployed:

1. Go to **https://tabarnam.com/admin**
2. Edit a company (e.g., YETI)
3. Click **"Add Logo"** or **"Replace or Edit Logo"**
4. Try uploading a logo

### Step 4: Check Function App Logs (If Still Failing)
If you still see the 500 error after deployment:

1. Go to Azure Portal → Function App → Log Stream
2. Try uploading a logo again
3. **Look for lines containing `[upload-logo-blob]`**
4. Check what environment variables are being detected

## Expected Success Indicators

✅ Logo uploads should work without 500 error
✅ No accessibility warnings in browser console  
✅ Function logs will show successful uploads with: `"[upload-logo-blob] Successfully uploaded logo for company..."`

## Troubleshooting

### If Still Getting 500 Error After Deployment:

**Check 1: Environment Variables**
```
Error message: "Server storage not configured"
→ The environment variables are still not being found
→ Go back to Step 1 and verify the exact values
→ Make sure there are NO extra spaces, quotes, or special characters
→ After adding them, restart the Function App (Azure Portal → Function App → Restart)
```

**Check 2: Container Creation**
```
If container creation fails:
→ Go to Storage Account (tabarnamstor2356) → Containers
→ Manually create a container named "company-logos" with "Blob" access level
```

**Check 3: Function App Logs**
```
After setting env vars, the logs should show:
"[upload-logo-blob] Storage config - accountName: tabarnamstor2356, key present: true"

If you see "accountName: NOT FOUND" → the variables aren't being read
```

## Technical Details

The updated API endpoint now:
1. Tries `AZURE_STORAGE_ACCOUNT_NAME` and `AZURE_STORAGE_ACCOUNT_KEY` environment variables
2. Falls back to parsing `AzureWebJobsStorage` if those aren't available
3. Provides detailed logging for every step
4. Validates file size, type, and content
5. Resizes images to max 500x500px using Sharp
6. Stores files in blob storage with unique names
7. Returns permanent Azure blob storage URLs

## Files Modified

- ✅ `api/upload-logo-blob/index.js` - Improved error handling and credential retrieval
- ✅ `src/components/admin/CompanyForm.jsx` - Already has proper accessibility attributes

## Timeline

- **Now**: Deploy these changes
- **Next**: Test logo upload functionality
- **If issues**: Check Function App logs and Azure configuration
