# Diagnostic Guide for Admin Routes 404 Fix

## What Was Changed
Added startup logging to both `api/admin-keywords/index.js` and `api/admin-companies/index.js` to help diagnose why these endpoints are returning 404.

## Step 1: Deploy the Changes
1. Click the **Push/Create/PR** button in the top-right
2. Wait for the GitHub Actions deployment to complete (watch the deployment logs)
3. Verify it shows "✅ Deployment Complete"

## Step 2: Check Azure Function Logs

### Via Azure Portal (Recommended)
1. Go to Azure Portal (portal.azure.com)
2. Find your Static Web App resource (should be in your resource group)
3. In the left sidebar, find **Functions** or **Function App**
4. Look for **Log stream** or **Logs**
5. Watch for these startup messages from your functions:
   ```
   [admin-keywords] Module loading started
   [admin-keywords] Dependencies imported, app object acquired
   [admin-keywords] Registering with app.http...
   [admin-keywords] ✅ Successfully registered with app.http
   
   [admin-companies] Module loading started
   [admin-companies] Dependencies imported, app object acquired
   [admin-companies] Registering with app.http...
   [admin-companies] ✅ Successfully registered with app.http
   ```

### Via Azure CLI
```bash
# If you have Azure CLI installed, you can also view logs via:
az functionapp log tail --name <your-function-app-name> --resource-group <your-resource-group>
```

## Step 3: Test the Endpoints

### Test 1: Browser Developer Tools
1. Go to https://tabarnam.com/admin
2. Open DevTools (F12 → Console tab)
3. Look for any messages about `/api/admin-keywords`
4. Previous error (which should now be gone):
   ```
   GET https://tabarnam.com/api/admin-keywords 404 (Not Found)
   ```

### Test 2: Direct API Calls
In your browser console, run:
```javascript
fetch('/api/admin-keywords').then(r => r.json()).then(console.log)
fetch('/api/admin-companies').then(r => r.json()).then(console.log)
```

Should return JSON data, NOT 404

### Test 3: Actually Use the Admin Panel
1. Go to https://tabarnam.com/admin
2. Try to edit a company
3. Save the changes
4. Verify:
   - No 404 errors in console
   - The dialog closes
   - Changes are saved and reflected in the table

## Interpretation of Results

### ✅ Success Scenario
- **Startup logs appear** in Azure Function Logs → Functions are registered correctly
- **No 404 in browser console** → Routes are being found
- **Admin panel works** → Full flow is working

### ❌ Diagnostic Scenario 1: Startup logs don't appear
- **Meaning**: The require() in api/index.js is either not executing or failing
- **Next steps**:
  1. Check if there are any JavaScript syntax errors in the files
  2. Check if @azure/functions dependency is properly installed
  3. Look for error logs around the require statements

### ❌ Diagnostic Scenario 2: Startup logs appear, but still 404
- **Meaning**: Functions are registered but Azure Static Web Apps isn't routing to them
- **Next steps**:
  1. Check staticwebapp.config.json for /api/* route configuration
  2. Verify the custom domain (tabarnam.com) is correctly mapped to the SWA instance
  3. Check if there's a different backend URL being used
  4. Try accessing via the default Azure domain: https://thankful-mushroom-0000a931e.2.azurestaticapps.net/api/admin-keywords

## Key Diagnostic Points

### The route registration looks like this:
```javascript
app.http('admin-keywords', {
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'admin-keywords',  // This is CRITICAL - must match frontend expectation
  handler: adminKeywordsHandler,
});
```

### The Frontend Calls Them Like This:
```javascript
// GET /api/admin-keywords
await apiFetch('/admin-keywords', { method: 'GET' })

// PUT /api/admin-companies
await apiFetch('/admin-companies', { method: 'PUT', body: JSON.stringify({...}) })
```

The API base (`/api`) is added automatically by the frontend API layer, so the routes must be exactly `admin-keywords` and `admin-companies` (no `/api/` prefix).

## Troubleshooting Checklist

- [ ] Deployment completed successfully (green checkmark in GitHub Actions)
- [ ] Azure Function startup logs show the registration messages
- [ ] Browser console shows NO 404 for /api/admin-keywords
- [ ] Browser console shows NO 404 for /api/admin-companies
- [ ] Can edit a company in the admin panel
- [ ] Changes are saved without errors
- [ ] Changes appear in the table immediately after save

## If All Else Fails

If the diagnostic logging confirms the functions are registered but still returning 404:
1. This likely indicates an issue with Azure Static Web Apps configuration or the custom domain mapping
2. Try accessing via the default SWA domain instead of the custom domain
3. Contact Azure support with the startup logs as evidence that the functions ARE properly registered
