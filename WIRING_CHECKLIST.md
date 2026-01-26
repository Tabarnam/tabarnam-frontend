# API Wiring Validation Checklist

This document explains how to validate that API requests are routing correctly from the frontend to the Function App backends.

## Quick Reference: Azure Resource Identities (from repo config)

All identifiers extracted from repository configuration files:

| Property | Value | Source File |
|----------|-------|------------|
| Subscription ID | `78b03a8f-1fcd-4944-8793-8371ed2c7f55` | `linkedBackend.json:2` |
| Resource Group | `tabarnam-mvp-rg` | `linkedBackend.json:2` |
| SWA Frontend | `tabarnam-frontend-v2` | `linkedBackend.parameters.json:10` |
| Primary Function App | `tabarnam-xai-dedicated` | `linkedBackend.json:2` |
| External API Function App | `tabarnam-xai-externalapi` | `linkedBackend.parameters.json:5` |
| Region | `westus2` | `linkedBackend.json:3` |
| Cosmos DB Account | `tabarnamcosmos2356` | `BULK_IMPORT_TESTING_GUIDE.md:22` |
| Storage Account | `tabarnamstor2356` | `LOGO_UPLOAD_TROUBLESHOOTING.md:18` |

## Frontend API Wiring (SPA to Function App)

### 1. Where Frontend Logs Are Printed

When the frontend loads, it automatically logs API wiring diagnostics to the browser console.

**How to see it:**
1. Open your browser DevTools (F12 or right-click → Inspect)
2. Go to the **Console** tab
3. Look for the group labeled **`[API Wiring Diagnostics]`** (usually near the top)
4. Expand it to see:
   - Resolved API Base URL
   - Frontend host detection
   - Environment variables
   - SWA routing expectations
   - Validation checklist with status indicators

**Example output:**
```
[API Wiring Diagnostics]
Frontend Host: tabarnam.com
Resolved API Base: /api
Same Origin? Yes
Expected Behavior: Requests to /api should route to tabarnam-xai-dedicated...

Environment Variables
  VITE_XAI_FUNCTIONS_BASE: (not set)
  VITE_API_BASE: (not set)

Validation Checklist
  ✅ Production Host Detected: Running on production domain...
  ✅ SWA Linked Backend Routing: Requests will route to tabarnam-xai-dedicated...
  ✅ Production Build: Running in production build mode...

ℹ️ linkedBackend.json Configuration (from repo)
  SWA Resource Name: tabarnam-frontend-v2
  SWA Routing Path: /api
  Linked Backend Function App: tabarnam-xai-dedicated
  ...
```

### 2. Understanding API_BASE Resolution

The frontend resolves the API base URL in this order (see `src/lib/api.ts`):

```javascript
1. Check VITE_XAI_FUNCTIONS_BASE environment variable (if set)
2. Check VITE_API_BASE environment variable (if set)
3. If running outside Azure SWA (not on *.azurestaticapps.net or tabarnam.com/www.tabarnam.com):
   → Use https://tabarnam.com/api (production fallback)
4. Otherwise:
   → Use /api (same-origin, relies on SWA routing)
```

**Expected values by environment:**

| Environment | Resolved API Base | Routing Method |
|---|---|---|
| Production (tabarnam.com) | `/api` | SWA linked backend routing to tabarnam-xai-dedicated |
| Azure SWA Preview (*.azurestaticapps.net) | `/api` | SWA linked backend routing to tabarnam-xai-dedicated |
| Local dev (localhost) | `/api` | Dev server proxy (if configured) |
| Other hosts | `https://tabarnam.com/api` | Absolute URL to production |

### 3. Network Tab Validation

To verify requests are actually reaching the backend:

1. Open DevTools → **Network** tab
2. Make an API call (e.g., search for a company, import data)
3. Look for a request to `/api/...` or `/xapi/...`
4. Check the **Request headers**:
   - `Host: tabarnam.com` (if using absolute URL)
   - `Origin: https://tabarnam.com` (if from different origin)
5. Check the **Response headers** for:
   - `x-functions-execution-id: {guid}` (indicates Function App processed it)
   - `x-ms-request-id: {guid}` (Azure diagnostic header)
   - `x-request-id: {value}` (custom request tracking)

## Function App Logging (Backend Request Handling)

### 1. Where Function App Logs Are Printed

Function Apps log diagnostic information to **Azure Monitor** and the **Log Stream**.

**How to see it:**

#### Option A: Azure Portal Log Stream (Real-time)
1. Go to **Azure Portal** → Search for **"tabarnam-xai-dedicated"** (Function App name)
2. Click **Monitor** → **Log stream**
3. Make an API request from the frontend
4. Look for lines starting with `[WIRING DIAGNOSTIC]`

#### Option B: Azure Monitor / Application Insights (Persistent)
1. Go to **Azure Portal** → Search for your Application Insights resource
2. Go to **Logs** (or **Analytics**)
3. Run this KQL query:
```kusto
traces
| where message contains "[WIRING DIAGNOSTIC]"
| order by timestamp desc
| project timestamp, message, customDimensions
| take 100
```

#### Option C: Local Azure Functions Core Tools
If running locally:
```bash
func start --verbose
# Logs appear in the terminal where the function is running
```

### 2. What Diagnostic Logs Tell You

#### Inbound Request Log Format
```
[WIRING DIAGNOSTIC] Inbound Request
  Endpoint: search-companies
  Method: POST /api/search-companies
  Host Header: tabarnam-xai-dedicated.azurewebsites.net
  Client IP (x-forwarded-for): 203.0.113.42
  Protocol (x-forwarded-proto): https
  Referer: https://tabarnam-frontend-v2.azurestaticapps.net
  User-Agent: Mozilla/5.0 ...
  Function App Name: tabarnam-xai-dedicated
  Request Time: 2024-01-26T10:30:45.123Z
```

**What this tells you:**
- ✅ **Function App Name** shows which Function App received the request
  - Should be `tabarnam-xai-dedicated` for requests from `/api` path
  - Should be `tabarnam-xai-externalapi` for requests to external API
- ✅ **Host Header** shows the inbound request domain
  - For SWA routed requests: `tabarnam-xai-dedicated.azurewebsites.net` (Azure internal)
  - For direct calls: whatever you called it with
- ✅ **Method + Path** shows the endpoint being called
- ✅ **Referer** shows where the request originated
  - Should be `tabarnam-frontend-v2.azurestaticapps.net` or `tabarnam.com` if from SPA
  - If referer is wrong, might indicate CORS issues or routing misconfiguration

#### Function App Configuration Log
Printed once on startup or first request:
```
[WIRING DIAGNOSTIC] Function App Configuration
  Website Instance ID: tabarnam-xai-dedicated
  Function URL: https://tabarnam-xai-dedicated.azurewebsites.net
  
  Expected Routing (from linkedBackend.json):
    - SWA: tabarnam-frontend-v2
    - SWA Routing Path: /api
    - Primary Function App Target: tabarnam-xai-dedicated
    ...
```

### 3. Using the Diagnostic Endpoint

A diagnostic endpoint is available to check Function App health:

```bash
curl https://tabarnam-xai-dedicated.azurewebsites.net/api/xadmin-api-storage-config
```

Or from the browser:
```
https://tabarnam.com/api/xadmin-api-storage-config
```

This returns JSON with:
```json
{
  "environmentStatus": {
    "AZURE_STORAGE_ACCOUNT_NAME": "SET",
    "AZURE_STORAGE_ACCOUNT_KEY": "SET",
    "COSMOS_DB_ENDPOINT": "SET",
    ...
  },
  "recommendations": [
    "✅ Storage configuration appears correct!"
  ]
}
```

## Wiring Validation Checklist

Use this checklist when troubleshooting routing issues:

### Frontend Checks

- [ ] Open DevTools → Console
- [ ] See `[API Wiring Diagnostics]` log group
- [ ] Verify `Resolved API Base` matches expected value:
  - Production: `/api`
  - Azure SWA: `/api`
  - Local dev: `/api` (with proxy) or `https://...`
- [ ] Check validation checklist for warning/error icons (⚠️ or ❌)
- [ ] If environment vars are shown, verify they're correct in `.env` or DevServerControl

### Network Request Checks

- [ ] DevTools → Network tab
- [ ] Make an API call
- [ ] Find the `/api/...` request in the list
- [ ] Check Request Headers:
  - [ ] `Host` header correct
  - [ ] `Origin` header matches frontend domain (if CORS involved)
- [ ] Check Response Headers:
  - [ ] `x-functions-execution-id` present (proves it reached a Function App)
  - [ ] `x-ms-request-id` present (Azure diagnostic)
  - [ ] Status is 2xx (success) or expected error (4xx/5xx with clear message)

### Function App Checks

- [ ] Go to Azure Portal → Search for `tabarnam-xai-dedicated` (Function App)
- [ ] Click **Monitor** → **Log stream**
- [ ] Make an API request from the frontend
- [ ] Look for `[WIRING DIAGNOSTIC]` log lines
- [ ] Verify:
  - [ ] `Function App Name` matches the name you expect
  - [ ] `Endpoint` matches what you called
  - [ ] Request method is correct (GET/POST/etc)
  - [ ] `Referer` header shows it came from the frontend

### linkedBackend.json Routing Rules

The SWA linked backend configuration is in `linkedBackend.json`:

```json
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
- Requests to `https://tabarnam-frontend-v2.azurestaticapps.net/api/*` are routed to `tabarnam-xai-dedicated`
- The routing path `/api` is preserved in the backend request
- When frontend makes a call to `/api/search-companies`, it reaches `tabarnam-xai-dedicated/api/search-companies`
- No identity/auth is used for the SWA → Function App link (managedServiceIdentityType: None)

**Current routing rules (from linkedBackend.* files):**

| Frontend Path | Target | Target Function App | Method |
|---|---|---|---|
| `https://tabarnam-frontend-v2.azurestaticapps.net/api/*` | `tabarnam-xai-dedicated` | tabarnam-xai-dedicated | Linked backend route |
| `https://tabarnam.com/api/*` | SWA (via domain) | tabarnam-xai-dedicated | Domain + SWA routing |
| Requests to `tabarnam-xai-externalapi.azurewebsites.net` | Direct call | tabarnam-xai-externalapi | HTTPS direct (not via SWA) |

## Common Issues & Solutions

### Issue: Frontend logs show `Resolved API Base: /api` but requests fail with 404

**Possible causes:**
1. Dev server doesn't have `/api` proxy configured
2. SWA linked backend not configured (but you're on Azure SWA)
3. Requests reaching wrong Function App

**Diagnostic steps:**
1. Check Function App logs for `[WIRING DIAGNOSTIC]` with correct endpoint
2. If no logs appear, request didn't reach the Function App
3. If logs show wrong Function App name, check linkedBackend.json routing

### Issue: Network tab shows request to `/api/...` but Function App logs don't appear

**Possible causes:**
1. Request failed before reaching Function App (DNS, network, firewall)
2. Request is hitting a different origin/domain that doesn't have logging
3. Logging is disabled or going to different Application Insights resource

**Diagnostic steps:**
1. Check Network tab response status
   - If 404/500: backend received it but errored (check Azure Monitor logs)
   - If network error: request never left the browser
2. Verify you're looking at logs for the right Function App
3. Verify Application Insights is configured on the Function App

### Issue: Requests go to wrong Function App (e.g., tabarnam-xai-externalapi instead of tabarnam-xai-dedicated)

**Possible causes:**
1. Environment variable `VITE_XAI_FUNCTIONS_BASE` is set to wrong URL
2. SWA linked backend routing is misconfigured
3. Frontend code explicitly calls the external API for certain endpoints

**Diagnostic steps:**
1. Check frontend console log: see `Resolved API Base` and environment variables
2. Check linkedBackend.json: verify `backendResourceId` points to `tabarnam-xai-dedicated`
3. Check if endpoint is meant to call external API (some endpoints intentionally call tabarnam-xai-externalapi)

### Issue: Seeing CORS errors in browser console

**Example error:**
```
Access to XMLHttpRequest at 'https://tabarnam-xai-dedicated.azurewebsites.net/api/...' 
from origin 'https://tabarnam-frontend-v2.azurestaticapps.net' has been blocked by CORS policy
```

**Causes:**
1. Frontend making direct call to Function App (should go through SWA)
2. Response missing `Access-Control-Allow-Origin` header
3. Preflight OPTIONS request rejected

**Solution:**
1. Use relative `/api/*` instead of absolute URLs
2. Ensure backend sets CORS headers on responses
3. Check that OPTIONS requests are handled

## Files Referenced

### Frontend
- `src/lib/api.ts` - API_BASE resolution logic
- `src/lib/diagnostics.ts` - Wiring diagnostic utility
- `src/App.jsx` - Calls logWiringDiagnostics() on startup

### Backend
- `api/_diagnostics.js` - Function App logging utility
- `linkedBackend.json` - SWA linked backend routing configuration
- `linkedBackend.parameters.json` - ARM template parameters
- `linkedBackend.template.json` - ARM template definition

### Configuration
- `linkedBackend.resource.json` - Additional resource definitions

## Testing the Wiring

### Test 1: Verify Frontend Diagnostics Logging

1. Open app in browser
2. Press F12 to open DevTools
3. Go to Console tab
4. Reload page
5. Look for `[API Wiring Diagnostics]` group
6. Verify all checklist items show ✅ or expected status
7. Verify linkedBackend.json config is displayed

### Test 2: Make an API Request and Check Routing

1. In the same console, make a request via Network tab
2. Search for a company or perform any API operation
3. Go to Network tab
4. Find the `/api/search-companies` (or similar) request
5. Check response headers for:
   - `x-functions-execution-id` (proves it hit Function App)
   - `x-ms-request-id` (Azure diagnostic)
6. Note the status code

### Test 3: Check Function App Logs

1. Go to Azure Portal
2. Search for `tabarnam-xai-dedicated` (Function App)
3. Click Monitor → Log stream
4. Do the same API request again from step 2
5. Verify `[WIRING DIAGNOSTIC]` logs appear showing:
   - Correct endpoint name
   - Correct HTTP method
   - Correct Function App name
   - Request from correct referer (should show frontend domain)

### Test 4: Verify linkedBackend Routing

1. Verify you're accessing the app via SWA URL:
   - Either `https://tabarnam-frontend-v2.azurestaticapps.net` (preview)
   - Or `https://tabarnam.com` (production custom domain)
2. Make API request
3. Check Network response headers contain `x-functions-execution-id`
4. Check Function App logs show `Function App Name: tabarnam-xai-dedicated`

## Next Steps If Issues Found

If validation fails:

1. **Document the failure:**
   - Screenshot of console diagnostic logs
   - Network request details (method, path, status)
   - Function App log messages (if visible)
   - Exact error message

2. **Check Azure Portal:**
   - Verify Function App is running
   - Verify Application Insights is connected
   - Verify linked backend configuration in SWA settings

3. **Check environment:**
   - Verify you're on the correct Azure subscription
   - Verify you're in the correct region (westus2)
   - Verify resource group is tabarnam-mvp-rg

4. **Escalate:**
   - Share the diagnostic logs (frontend console + Function App logs)
   - Share the network request details
   - Share the linkedBackend.json and linkedBackend.parameters.json files
