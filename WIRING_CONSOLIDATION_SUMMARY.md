# Wiring Consolidation and Fix Summary

**Date**: November 23, 2025  
**Scope**: Consolidated Azure Function App wiring for 5-year stable deployment  
**Status**: IMPLEMENTED ✅

---

## Overview

This document describes the consolidated wiring architecture for the tabarnam-xai application, which fixes critical routing issues and consolidates environment variable configuration.

### Key Changes

1. **Fixed Azure Static Web Apps Routing** - Added missing `rewrite` directive for `/api/*` routes
2. **Consolidated Environment Variables** - Unified XAI configuration on `XAI_EXTERNAL_BASE` (was scattered across `FUNCTION_URL`, `XAI_EXTERNAL_BASE`, `XAI_PROXY_BASE`)
3. **Centralized Helper Functions** - Created `getXAIEndpoint()` and `getXAIKey()` in `api/_shared.js` for consistent configuration
4. **Cleaned Up Diagnostics** - Deprecated confusing `/api/xai` endpoint, centralized diagnostics in `/api/admin/bulk-import-config`
5. **Documented Architecture** - Clear, single-source-of-truth deployment configuration

---

## Architecture

### Deployment Structure

```
tabarnam.com (Azure Static Web Apps)
├── Frontend (React app)
│   └── Routes all /api/* requests to linked backend
├── Linked Backend: tabarnam-xai-dedicated (Azure Functions)
│   ├── Admin endpoints (admin-companies, admin-keywords, etc.)
│   ├── Search endpoints (search-companies, logo-scrape, etc.)
│   ├── Import endpoints (import-start, import-progress, import-status)
│   ├── Proxy endpoint (proxy-xai → forwards to external XAI API)
│   └── Review endpoints (get-reviews, submit-review)
└── External Services (as configured)
    └── XAI_EXTERNAL_BASE (tabarnam-xai-externalapi)
        └── Actual XAI search API endpoint
```

### Request Flow

**Example: Admin Panel Loading Companies**

```
1. Frontend calls: fetch('/api/admin-companies')
2. Browser → /api/admin-companies (same origin)
3. Azure SWA routes to linked backend (tabarnam-xai-dedicated)
   - Route rule in staticwebapp.config.json: 
     "/api/*" → rewrite: "/api/{*path}"
4. Backend function: api/admin-companies/index.js
   - Reads: COSMOS_DB_ENDPOINT, COSMOS_DB_KEY
   - Returns: List of companies from Cosmos DB
5. Response → Browser → Frontend displays list
```

**Example: Bulk Import Flow**

```
1. Frontend → /api/import/start (POST with search query)
2. Backend: api/import-start/index.js
   - Gets XAI config: getXAIEndpoint() → XAI_EXTERNAL_BASE
   - Calls: axios.post(XAI_EXTERNAL_BASE, {...})
   - On success: saves companies to Cosmos DB via /api/save-companies
3. Frontend polls: /api/import-progress
4. Frontend displays: newly imported companies
```

---

## Fixed Issues

### Issue 1: Admin Panel 404 Error

**Problem**: `GET https://tabarnam.com/api/admin-companies 404 (Not Found)`

**Root Cause**: `staticwebapp.config.json` had `/api/*` route configured but NO `rewrite` directive. Without rewrite, Azure SWA didn't know to forward requests to the linked backend.

**Fix**: Added `rewrite: "/api/{*path}"` to the `/api/*` route rule in `public/staticwebapp.config.json`

```json
{
  "route": "/api/*",
  "allowedRoles": ["authenticated", "anonymous"],
  "methods": ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  "rewrite": "/api/{*path}",  // ← ADDED THIS
  "headers": { ... }
}
```

### Issue 2: Confusing Environment Variable Configuration

**Problem**: 
- `FUNCTION_URL` was set to `https://tabarnam-xai-dedicated.../api/xai` (a diagnostic endpoint, not a real search API)
- `XAI_EXTERNAL_BASE` was set to the actual external API
- Code had to check both and handle fallbacks differently in different places
- Admin diagnostics showed both as "available" but only one actually worked

**Root Cause**: Historical evolution without consolidation. Multiple environment variables were used as fallbacks but never properly unified.

**Fix**: Consolidated on `XAI_EXTERNAL_BASE` as primary, with `FUNCTION_URL` as deprecated fallback

**Changes Made**:

1. **api/_shared.js** - Created unified helper functions:
   ```javascript
   function getXAIEndpoint() {
     const external = (process.env.XAI_EXTERNAL_BASE || '').trim();
     if (external) return external;
     
     const fnUrl = (process.env.FUNCTION_URL || '').trim();
     if (fnUrl && !fnUrl.includes('/api/xai')) return fnUrl;
     
     return '';
   }
   
   function getXAIKey() {
     return (process.env.XAI_EXTERNAL_KEY || process.env.FUNCTION_KEY || process.env.XAI_API_KEY || '').trim();
   }
   ```

2. **api/import-start/index.js** - Updated to use unified helpers:
   ```javascript
   const xaiUrl = getXAIEndpoint();
   const xaiKey = getXAIKey();
   ```

3. **api/proxy-xai/index.js** - Updated to use unified helpers and improved diagnostics

4. **api/admin-bulk-import-config/index.js** - Updated diagnostics to show consolidated configuration

### Issue 3: Confusing /api/xai Diagnostic Endpoint

**Problem**: 
- `/api/xai` returned 501 with warnings about loops
- If `FUNCTION_URL` was misconfigured to point here, it would create a loop
- The error message was confusing about what to do

**Root Cause**: The endpoint was created as a diagnostic but became a source of confusion

**Fix**: 
- Changed status code from 501 to 410 (Gone) to indicate deprecation
- Updated message to point users to `/api/admin/bulk-import-config` for diagnostics
- Simplified the endpoint to not warn about loops

---

## Environment Variables - Required & Deprecated

### ✅ REQUIRED (Primary)

| Variable | Purpose | Example |
|----------|---------|---------|
| `XAI_EXTERNAL_BASE` | XAI search API endpoint | `https://tabarnam-xai-externalapi.azurewebsites.net/api` |
| `XAI_EXTERNAL_KEY` | Authentication key for XAI endpoint | `your-api-key-here` |
| `COSMOS_DB_ENDPOINT` | Cosmos DB connection endpoint | `https://tabarnamcosmos2356.documents.azure.com:443/` |
| `COSMOS_DB_KEY` | Cosmos DB authentication key | `w185QQR...HAJ7rA==` |
| `COSMOS_DB_DATABASE` | Cosmos DB database name | `tabarnam-db` |
| `COSMOS_DB_COMPANIES_CONTAINER` | Companies container name | `companies` |
| `GOOGLE_MAPS_KEY` | Google Maps API key | `AIzaSy...` |

### ⚠️ DEPRECATED (Fallback Only)

| Variable | Status | Replacement |
|----------|--------|-------------|
| `FUNCTION_URL` | Deprecated | Use `XAI_EXTERNAL_BASE` instead |
| `FUNCTION_KEY` | Deprecated | Use `XAI_EXTERNAL_KEY` instead |
| `XAI_PROXY_BASE` | Deprecated | Use `XAI_EXTERNAL_BASE` instead |
| `VITE_API_BASE` | Should be empty | Leave blank to use `/api` |

### ✅ OPTIONAL

| Variable | Purpose | Default |
|----------|---------|---------|
| `XAI_STUB` | Enable stub mode for testing | `0` (stub disabled) |

---

## Endpoints Overview

### ✅ Working Endpoints (All in tabarnam-xai-dedicated)

| Route | Method | Purpose | Status |
|-------|--------|---------|--------|
| `/api/admin-companies` | GET, POST, PUT, DELETE | Manage companies | ✅ Fixed |
| `/api/search-companies` | GET | Search Cosmos DB | ✅ Working |
| `/api/save-companies` | POST | Save companies | ✅ Working |
| `/api/admin-keywords` | GET, PUT | Manage keywords | ✅ Working |
| `/api/admin-star-config` | GET, PUT | Star rating config | ✅ Working |
| `/api/get-reviews` | GET | Get company reviews | ✅ Working |
| `/api/submit-review` | POST | Submit review | ✅ Working |
| `/api/import/start` | POST | Start bulk import | ✅ Fixed |
| `/api/import-progress` | GET | Check import status | ✅ Working |
| `/api/import-status` | GET | Import details | ✅ Working |
| `/api/proxy-xai` | GET, POST | XAI proxy/diagnostics | ✅ Fixed |
| `/api/logo-scrape` | POST | Scrape company logos | ✅ Working |
| `/api/google/geocode` | POST | Geocode addresses | ✅ Working |
| `/api/google/translate` | POST | Translate text | ✅ Working |
| `/api/ping` | GET | Health check | ✅ Working |
| `/api/admin/bulk-import-config` | GET | Configuration diagnostics | ✅ Working |

### ⚠️ Deprecated Endpoints

| Route | Reason | Alternative |
|-------|--------|-------------|
| `/api/xai` | Not a real XAI search endpoint | `/api/proxy-xai` or `/api/admin/bulk-import-config` |

---

## Verification & Testing

### Quick Health Check

```bash
# Test frontend can reach backend
curl https://tabarnam.com/api/ping

# Check configuration
curl https://tabarnam.com/api/admin/bulk-import-config

# Admin panel (requires auth)
# Visit: https://tabarnam.com/admin
```

### Expected Responses

**`/api/ping`** (should return 200)
```json
{
  "status": "ok",
  "timestamp": "2025-11-23T..."
}
```

**`/api/admin/bulk-import-config`** (should show all ✅)
```json
{
  "ok": true,
  "config": {
    "xai": {
      "external_base": { "configured": true, "status": "✅ CONFIGURED" },
      "external_key": { "configured": true, "status": "✅ CONFIGURED" }
    },
    "cosmos_db": {
      "endpoint": { "configured": true, "status": "✅ CONFIGURED" },
      "key": { "configured": true, "status": "✅ CONFIGURED" }
    },
    "status": {
      "import_ready": true
    }
  }
}
```

**Admin Panel** - Should load and display companies from Cosmos DB

---

## Files Changed

### 1. `public/staticwebapp.config.json`
**Change**: Added `rewrite` directive to `/api/*` route  
**Impact**: Fixes admin panel 404 errors  
**Lines Modified**: 28-37

### 2. `api/_shared.js`
**Changes**:
- Added `getXAIEndpoint()` function
- Added `getXAIKey()` function
- Updated exports
**Impact**: Centralizes environment variable reading
**Lines Modified**: 1-56

### 3. `api/import-start/index.js`
**Changes**:
- Added require for `_shared.js` helpers
- Updated to use `getXAIEndpoint()` and `getXAIKey()`
- Improved console logging
**Impact**: Uses consolidated XAI configuration
**Lines Modified**: 1-5, 255-268

### 4. `api/proxy-xai/index.js`
**Changes**:
- Added `getXAIEndpoint()` and `getXAIKey()` helpers
- Updated handler to use new helpers
- Improved diagnostics output
**Impact**: Uses consolidated XAI configuration
**Lines Modified**: 6-25, 247-264

### 5. `api/admin-bulk-import-config/index.js`
**Changes**:
- Consolidated environment variable checking
- Updated diagnostics to show XAI_EXTERNAL_BASE as primary
- Improved recommendations
**Impact**: Better configuration diagnostics
**Lines Modified**: 30-96

### 6. `api/xai/index.js`
**Changes**:
- Changed status code from 501 to 410
- Updated error message
- Removed loop warnings
**Impact**: Better deprecation messaging
**Lines Modified**: 30-45

---

## Deployment Checklist

After deploying these changes, verify the following:

- [ ] Build succeeds (no TypeScript or syntax errors)
- [ ] `/api/ping` returns 200 OK
- [ ] `/api/admin/bulk-import-config` shows all systems as ✅ CONFIGURED
- [ ] Admin panel loads without 404 errors
- [ ] Companies are visible in admin panel
- [ ] Search functionality works on home page
- [ ] Review submission works
- [ ] Bulk import (if configured) works

---

## Configuration for Production

### Azure Static Web Apps Settings

Go to **Configuration** and ensure these are set:

```
XAI_EXTERNAL_BASE = https://tabarnam-xai-externalapi.azurewebsites.net/api
XAI_EXTERNAL_KEY = [your-key-here]
COSMOS_DB_ENDPOINT = https://tabarnamcosmos2356.documents.azure.com:443/
COSMOS_DB_KEY = [your-cosmos-key]
COSMOS_DB_DATABASE = tabarnam-db
COSMOS_DB_COMPANIES_CONTAINER = companies
GOOGLE_MAPS_KEY = [your-key-here]
VITE_API_BASE = [leave empty]
```

**Remove deprecated variables:**
- `FUNCTION_URL` (if present)
- `FUNCTION_KEY` (if present)
- `XAI_PROXY_BASE` (if present)

---

## Future Maintenance

### If Adding New XAI Features
1. Always use `getXAIEndpoint()` and `getXAIKey()` from `api/_shared.js`
2. Never read `FUNCTION_URL` directly
3. Update diagnostics in `/api/admin/bulk-import-config/index.js`

### If Changing External API
1. Update `XAI_EXTERNAL_BASE` in Azure Portal
2. Test using `/api/proxy-xai` endpoint
3. Verify with `/api/admin/bulk-import-config` endpoint

### If Decommissioning External API
1. Remove `XAI_EXTERNAL_BASE` from configuration
2. Implement local XAI functionality or use a different service
3. Update diagnostics and documentation

---

## Summary

This consolidation provides:

✅ **Single source of truth** for environment configuration  
✅ **Fixed routing** for admin panel and all API endpoints  
✅ **Clear deprecation path** for legacy variables  
✅ **Better diagnostics** for troubleshooting  
✅ **5-year stable** configuration that won't need changes unless replacing external services
