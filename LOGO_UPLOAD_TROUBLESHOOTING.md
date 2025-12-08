# Logo Upload 500 Error - Troubleshooting Guide

## Problem
The logo upload endpoint (`POST /api/upload-logo-blob`) returns a 500 error with message:
```
Server storage not configured - check AZURE_STORAGE_ACCOUNT_NAME and AZURE_STORAGE_ACCOUNT_KEY environment variables
```

This means the Azure Function App cannot read the required environment variables.

## Step 1: Verify Environment Variables in Azure Portal

**This is the most critical step.**

1. Go to **Azure Portal** → Search for "tabarnam-xai-dedicated" (your Function App)
2. Click **Settings** → **Configuration** (in left sidebar)
3. Under **Application settings** tab, look for these exact variable names:
   - `AZURE_STORAGE_ACCOUNT_NAME`
   - `AZURE_STORAGE_ACCOUNT_KEY`

**IMPORTANT**: They must be in "Application settings", not "Connection strings"!

### If Variables Are Missing:
1. Click **+ New application setting**
2. Add variable 1:
   - **Name**: `AZURE_STORAGE_ACCOUNT_NAME`
   - **Value**: `tabarnamstor2356`
   - Click **OK**
3. Click **+ New application setting**
4. Add variable 2:
   - **Name**: `AZURE_STORAGE_ACCOUNT_KEY`
   - **Value**: `yc2wE75NmkLuy74EoJMqMaNpNFm70vK2iptLuAzJ6XswlPOWREJEd5sNUS8sDNKV484jxhFLTPCo+AStzd3Kfw==`
   - Click **OK**
5. Click **Save** (at the top)
6. **Wait for the notification** confirming the changes were saved
7. Click **Continue** when prompted about app restart

### If Variables Already Exist:
- Verify the values are EXACTLY correct (no extra spaces, quotes, etc.)
- If they look correct, proceed to Step 2

## Step 2: Restart the Function App

1. Go to your Function App page (tabarnam-xai-dedicated)
2. Click **Restart** button at the top
3. Wait 2-3 minutes for restart to complete
4. You'll see "Running" status when ready

## Step 3: Verify Configuration Was Applied

After restart, test the diagnostic endpoint:

1. Open your browser and visit:
   ```
   https://tabarnam.com/api/xadmin-api-storage-config
   ```

2. You should see JSON output showing:
   ```json
   {
     "environmentStatus": {
       "AZURE_STORAGE_ACCOUNT_NAME": "SET",
       "AZURE_STORAGE_ACCOUNT_KEY": "SET",
       ...
     },
     "recommendations": ["✅ Storage configuration appears correct!"]
   }
   ```

**If you see "NOT SET"**:
- Go back to Step 1 and verify variables are in Application settings (not Connection strings)
- Make sure you clicked **Save** and waited for confirmation
- Try restarting again

## Step 4: Test Logo Upload

1. Go to **https://tabarnam.com/admin**
2. Edit a company (e.g., YETI)
3. Click "Update Company Logo" button
4. Try uploading a test image (PNG, JPG, SVG, or GIF)

**Expected**: Logo uploads successfully with success message
**If 500 error persists**: Continue to Step 5

## Step 5: Check Azure Function Logs

If diagnostic endpoint shows variables are SET but upload still fails:

1. Go to Function App → **Monitor** → **Log stream**
2. Perform a logo upload attempt
3. Look for `[upload-logo-blob]` entries in the logs
4. These will show the actual error

**Common errors**:
- Storage account name incorrect
- Storage account key invalid
- Storage container "company-logos" doesn't exist
- Storage account unreachable

## Step 6: Verify Storage Account and Container

1. Go to **Azure Portal** → Search for "tabarnamstor2356" (your Storage Account)
2. Click **Containers** in left sidebar
3. Look for "company-logos" container
   - **If missing**: Click **+ Container**, name it "company-logos", set access level to "Blob", click Create
4. Go back to **Access keys** tab
   - Copy the account name and one of the keys
   - Verify they match what you entered in Function App Configuration

## Quick Checklist

- [ ] Logged into Azure Portal
- [ ] Navigated to Function App Configuration
- [ ] Both `AZURE_STORAGE_ACCOUNT_NAME` and `AZURE_STORAGE_ACCOUNT_KEY` exist in Application settings
- [ ] Values are exactly correct (no extra spaces)
- [ ] Clicked Save and waited for confirmation
- [ ] Restarted Function App
- [ ] Tested diagnostic endpoint and verified "SET" status
- [ ] "company-logos" container exists in Storage Account
- [ ] Attempted logo upload and it succeeded

## Still Not Working?

If you've completed all steps and it still fails:

1. Check the **Log stream** for specific error messages
2. Verify the Storage Account is in the same region as Function App (ideally)
3. Check if there are any access control (IAM) restrictions on the Storage Account
4. Ensure the Storage Account is not "premium" tier (use standard)
5. Consider clearing browser cache and trying a different image file

## Manual Alternative (Temporary Workaround)

If you need to add a logo without using the upload feature:

1. Upload logo directly to Azure Blob Storage using Azure Storage Explorer
2. Get the blob URL (e.g., `https://tabarnamstor2356.blob.core.windows.net/company-logos/...`)
3. In admin form, paste the URL in "From URL" tab of logo dialog
4. Save the company

This bypasses the upload endpoint but allows the same functionality.
