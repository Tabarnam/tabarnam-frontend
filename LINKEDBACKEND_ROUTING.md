# Azure Static Web App (SWA) Linked Backend Routing

This document explains the SWA linked backend configuration and how API requests are routed from the frontend to the Function App.

## Quick Reference

The linked backend configuration is defined in the repo in these files:

| File | Purpose | Key Content |
|------|---------|------------|
| `linkedBackend.json` | ARM resource for linked backend | Backend resource ID, routing path, region |
| `linkedBackend.parameters.json` | Parameter values for ARM template | Function App ID, SWA name, routing path |
| `linkedBackend.template.json` | ARM template definition | Deployment template structure |
| `linkedBackend.resource.json` | Additional resource definitions | Extra configuration |

## Current Configuration (from repo)

### Linked Backend Target

```json
// From linkedBackend.json
{
  "properties": {
    "backendResourceId": "/subscriptions/78b03a8f-1fcd-4944-8793-8371ed2c7f55/resourceGroups/tabarnam-mvp-rg/providers/Microsoft.Web/sites/tabarnam-xai-dedicated",
    "region": "westus2",
    "routingPath": "/api",
    "managedServiceIdentityType": "None"
  }
}
```

**What this means:**
- The linked backend is the Function App: `tabarnam-xai-dedicated`
- All requests to `/api/*` on the SWA will be routed to this Function App
- Region must match for proper routing: `westus2`
- No managed identity is used for authentication between SWA and Function App

### Function App Parameters

```json
// From linkedBackend.parameters.json
{
  "functionAppId": {
    "value": "/subscriptions/78b03a8f-1fcd-4944-8793-8371ed2c7f55/resourceGroups/tabarnam-mvp-rg/providers/Microsoft.Web/sites/tabarnam-xai-externalapi"
  },
  "staticSiteName": {
    "value": "tabarnam-frontend-v2"
  },
  "routingPath": {
    "value": "/api"
  },
  "region": {
    "value": "West US 2"
  },
  "linkName": {
    "value": "funcapi"
  }
}
```

**Key parameters:**
- `functionAppId`: Points to the external API Function App (used in parameters but may not be the active linked backend)
- `staticSiteName`: The SWA resource name
- `routingPath`: The path on SWA that routes to the backend (`/api`)
- `linkName`: Identifier for the link (`funcapi`)

## How SWA Linked Backend Routing Works

### Request Flow

```
Frontend Request
    ↓
GET/POST to /api/search-companies
    ↓
SWA (tabarnam-frontend-v2) receives request
    ↓
SWA checks routing rules:
  Path matches "/api"? YES
  ↓
SWA routes to linked backend (tabarnam-xai-dedicated)
    ↓
Function App receives request
    ↓
Path is now: /api/search-companies
    ↓
Function App handler processes request
    ↓
Response sent back to SWA
    ↓
SWA returns response to frontend
```

### URL Routing Examples

| Frontend Request | SWA Path Match | Linked Backend Route | Function App Handler |
|---|---|---|---|
| `https://tabarnam-frontend-v2.azurestaticapps.net/api/search-companies` | `/api/search-companies` | Route to backend | `/api/search-companies` |
| `https://tabarnam-frontend-v2.azurestaticapps.net/api/save-companies` | `/api/save-companies` | Route to backend | `/api/save-companies` |
| `https://tabarnam-frontend-v2.azurestaticapps.net/admin` | `/admin` | No match | Served by SWA (SPA route) |
| `https://tabarnam.com/api/search-companies` | `/api/search-companies` | Route to backend (via domain) | `/api/search-companies` |

### Important Notes

1. **Path Preservation**: When SWA routes to the linked backend, it **preserves the full path**. 
   - Request: `/api/search-companies` 
   - Forwarded to backend: `/api/search-companies` (not just `/search-companies`)

2. **Authentication**: `managedServiceIdentityType: "None"` means no special auth between SWA and Function App
   - Requests are made as if they're coming from a trusted internal system
   - No Function Key or access token is required for the SWA→Function App connection

3. **Domain Handling**:
   - On `tabarnam-frontend-v2.azurestaticapps.net`: Uses linked backend routing directly
   - On custom domain `tabarnam.com`: SWA still applies the same routing rules

4. **Region Alignment**: Both resources must be in the same region (`westus2`)
   - If regions differ, the linked backend won't work properly

## ARM Template Structure

The `linkedBackend.template.json` defines the deployment structure:

```json
{
  "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  "contentVersion": "1.0.0.0",
  "parameters": {
    "staticSiteName": { "type": "string" },
    "functionAppId": { "type": "string" },
    "region": { "type": "string", "defaultValue": "West US 2" },
    "routingPath": { "type": "string", "defaultValue": "/api" },
    "linkName": { "type": "string", "defaultValue": "funcapi" }
  },
  "resources": [
    {
      "type": "Microsoft.Web/staticSites/linkedBackends",
      "apiVersion": "2023-12-01",
      "name": "[format('{0}/{1}', parameters('staticSiteName'), parameters('linkName'))]",
      "location": "[parameters('region')]",
      "properties": {
        "backendResourceId": "[parameters('functionAppId')]",
        "region": "[parameters('region')]",
        "routingPath": "[parameters('routingPath')]",
        "managedServiceIdentityType": "None"
      }
    }
  ]
}
```

**Key points:**
- Resource type: `Microsoft.Web/staticSites/linkedBackends`
- API version: `2023-12-01`
- Parameters are substituted at deployment time
- The linked backend is created as a child of the SWA resource

## Testing Linked Backend Routing

### Test 1: Verify Linked Backend Configuration (Azure Portal)

1. Go to **Azure Portal**
2. Search for **"tabarnam-frontend-v2"** (SWA name)
3. Click **Settings** → **Configuration** (or **Functions**)
4. Look for **Linked Backends** or **Backend Routing**
5. Verify:
   - Name: `funcapi` (linkName)
   - Path: `/api` (routingPath)
   - Backend: `tabarnam-xai-dedicated` (extracted from backendResourceId)

### Test 2: Make a Request Through SWA

1. Access the app via SWA URL: `https://tabarnam-frontend-v2.azurestaticapps.net`
2. Make an API request (e.g., search for a company)
3. Open DevTools → **Network** tab
4. Find the `/api/...` request
5. Check response headers:
   - `x-functions-execution-id` (proves it reached Function App)
   - `x-ms-request-id` (Azure diagnostic header)
   - Status should be 2xx (success) or expected 4xx/5xx

### Test 3: Check Function App Received the Request

1. Go to **Azure Portal** → Function App **"tabarnam-xai-dedicated"**
2. Click **Monitor** → **Log stream**
3. Make the same API request from step 2
4. Look for `[WIRING DIAGNOSTIC]` logs:
   ```
   [WIRING DIAGNOSTIC] Inbound Request
     Endpoint: search-companies
     Method: GET /api/search-companies
     Host Header: tabarnam-xai-dedicated.azurewebsites.net
     ...
   ```

### Test 4: Via Custom Domain

1. Access the app via custom domain: `https://tabarnam.com`
2. Make an API request
3. DevTools Network tab should show request to `/api/...`
4. Response should have `x-functions-execution-id` header

### Test 5: Direct Function App Call (Should Still Work)

The external API can also be called directly:

```javascript
// This bypasses SWA routing
fetch('https://tabarnam-xai-externalapi.azurewebsites.net/api/...')
```

However, the frontend should **not** do this because:
1. It violates the routing plan in linkedBackend.json
2. It may trigger CORS issues (different origin)
3. It confuses diagnostics (requests appear to come from different origin)

## Troubleshooting Linked Backend Issues

### Issue: Requests get 404 Not Found with "No healthy upstream"

**Cause**: Linked backend not properly configured or disabled

**Solution:**
1. Verify linkedBackend.json is deployed
2. Check SWA settings (Portal → Settings → Configuration)
3. Verify Function App is running
4. Check region alignment (westus2)

### Issue: CORS Error: "Access to fetch has been blocked by CORS policy"

**Likely cause**: Frontend making direct call to Function App instead of through SWA

**Solution:**
1. Use relative paths: `/api/...` instead of absolute URLs
2. Let SWA routing handle the request
3. Verify API_BASE in frontend is `/api` (not absolute URL)

### Issue: Requests reach SWA but not Function App

**Cause**: Linked backend may be misconfigured or pointing to wrong Function App

**Solution:**
1. Check linkedBackend.json routing path
2. Verify backendResourceId is correct
3. Check if two linked backends exist (ensure only one for /api)
4. Look at Azure Monitor logs for routing errors

### Issue: Requests work from custom domain but not from SWA preview URL

**Cause**: Different routing rules or CORS settings per domain

**Solution:**
1. Both should route the same way (via linked backend)
2. Check if custom domain has different SWA configuration
3. Verify CORS headers are sent for both domains

## ARM Deployment

To update the linked backend configuration, modify the parameters and redeploy:

```bash
# Update linkedBackend.parameters.json with new values
# Then deploy:
az deployment group create \
  --name linkedbackend-deploy \
  --resource-group tabarnam-mvp-rg \
  --template-file linkedBackend.template.json \
  --parameters linkedBackend.parameters.json
```

**Safe changes:**
- Update `functionAppId` to point to a different backend
- Update `routingPath` to `/xapi` or similar (redirects that path)
- Update `region` if resources move

**Dangerous changes:**
- Removing the linked backend (breaks all /api/* requests)
- Changing `staticSiteName` (must match existing SWA)
- Setting `managedServiceIdentityType` to a managed identity (requires auth setup)

## Expected Behavior Summary

### For Frontend Requests to /api/*

```
Frontend makes: GET /api/search-companies
         ↓
SWA linked backend routing matches /api
         ↓
Request forwarded to: tabarnam-xai-dedicated/api/search-companies
         ↓
Function App processes /api/search-companies
         ↓
Response returned with x-functions-execution-id header
         ↓
Frontend receives: 200 OK with company search results
```

### For Frontend Requests to /admin

```
Frontend makes: GET /admin
         ↓
SWA routes to SPA (not to linked backend, doesn't match /api)
         ↓
SPA returns admin.html
         ↓
Browser loads admin page
```

## File References

- **Deployment**: `linkedBackend.json`, `linkedBackend.parameters.json`, `linkedBackend.template.json`
- **Frontend API config**: `src/lib/api.ts` (API_BASE resolution)
- **Frontend diagnostics**: `src/lib/diagnostics.ts` (logs routing info)
- **Backend diagnostics**: `api/_diagnostics.js` (Function App logging)
- **Example endpoint with logging**: `api/search-companies/index.js`

## Related Documentation

- [Azure Static Web Apps Linked Backends](https://learn.microsoft.com/en-us/azure/static-web-apps/functions-bring-your-own/)
- [Azure Function Apps Triggers and Bindings](https://learn.microsoft.com/en-us/azure/azure-functions/functions-triggers-bindings)
- [Azure Resource Manager Templates](https://learn.microsoft.com/en-us/azure/azure-resource-manager/templates/)
