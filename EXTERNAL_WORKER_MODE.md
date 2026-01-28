# External Worker Mode: Implementation Guide

## Overview

This document describes the architecture and configuration of **external worker mode**, where Azure Static Web Apps (SWA) hosts HTTP-only functions, and a dedicated Azure Function App handles long-running queue-triggered background jobs.

**Status**: ✅ Production-ready  
**Effective Date**: 2026-01-28  
**Last Updated**: 2026-01-28

---

## Architecture

### Core Principle

- **SWA-managed Functions**: HTTP-only API endpoints (no queue triggers)
- **Dedicated Function App**: `tabarnam-xai-dedicated` - Queue triggers and long-running workers
- **Shared Logic**: Business logic is shared between both via relative imports from `api/` folder

### Why This Approach?

1. **SWA Limitation**: <cite index="2-2">Managed function apps in Static Web Apps are optimized for API scenarios and support only HTTP triggers.</cite>
2. **Queue Trigger Support**: Dedicated Function Apps fully support storage queue triggers (and other event-based triggers)
3. **Single Source of Truth**: Handler logic lives in `api/import/resume-worker/handler.js`, imported by both SWA HTTP endpoint and external worker queue trigger
4. **Independent Scaling**: Worker scales independently from the API

---

## Code Structure

```
project/
├── api/                               # SWA-managed HTTP-only API
│   ├── import/
│   │   ├── resume-enqueue/            # Enqueues messages to queue
│   │   └── resume-worker/
│   │       ├── index.js               # HTTP endpoint (POST /api/import/resume-worker)
│   │       ├── handler.js             # Shared business logic
│   │       └── (no queue trigger here)
│   ├── diag-queue-mismatch/           # Diagnostics endpoint (recognizes external mode)
│   ├── _enrichmentQueue.js            # Queue enqueue utility
│   ├── _buildInfo.js                  # Shared utility (build metadata)
│   ├── _cosmosPartitionKey.js         # Shared utility (Cosmos operations)
│   └── host.json                      # API configuration
│
├── worker/                            # Dedicated external Function App
│   ├── functions/
│   │   ├── import-resume-worker/
│   │   │   ├── index.js               # Queue trigger handler (converts queue → HTTP-like request)
│   │   │   └── handler.js             # Re-exports from api (or direct imports)
│   │   └── health/
│   │       └── index.js               # Health check endpoint (/api/health)
│   ├── host.json                      # Worker configuration (functionTimeout: 00:10:00)
│   ├── package.json                   # Worker dependencies
│   └── (deploys to tabarnam-xai-dedicated)
│
├── .github/workflows/
│   ├── deploy-swa.yml                 # Deploys api/ to SWA
│   └── deploy-worker.yml              # Deploys worker/ to tabarnam-xai-dedicated
│
└── EXTERNAL_WORKER_MODE.md            # This file
```

---

## Configuration

### SWA App Settings

Set these in Azure Portal > Static Web App > Settings > Application Settings:

```
Name: QUEUE_TRIGGER_MODE
Value: external

Name: WORKER_BASE_URL
Value: https://tabarnam-xai-dedicated.azurewebsites.net

Name: AZURE_STORAGE_CONNECTION_STRING
Value: DefaultEndpointsProtocol=https://;AccountName=tabarnamstor2356;AccountKey=...;EndpointSuffix=core.windows.net
(Keep existing enqueue settings unchanged)

Name: BUILD_ID
Value: (optional, for diagnostics)
```

### Dedicated Worker Function App Settings (tabarnam-xai-dedicated)

Set these in Azure Portal > Function App > Settings > Configuration:

```
Name: AzureWebJobsStorage
Value: DefaultEndpointsProtocol=https://;AccountName=tabarnamstor2356;AccountKey=...;EndpointSuffix=core.windows.net
(Must match the storage account referenced by enqueue side)

Name: COSMOS_DB_ENDPOINT
Value: https://tabarnam-cosmosdb.documents.azure.com:443/

Name: COSMOS_DB_KEY
Value: (primary key from Cosmos DB)

Name: COSMOS_DB_DATABASE
Value: tabarnam-db

Name: COSMOS_DB_COMPANIES_CONTAINER
Value: companies

Name: ENRICHMENT_QUEUE_CONNECTION_SETTING
Value: AzureWebJobsStorage
(or leave unset to default to AzureWebJobsStorage)

Name: WEBSITE_NODE_DEFAULT_VERSION
Value: 18.17.0

Name: NODE_ENV
Value: production
```

---

## Deployment

### GitHub Actions Workflows

#### SWA Workflow (`.github/workflows/deploy-swa.yml`)

**Trigger**: Push to `main` when `api/` or `src/` changes  
**Action**:
1. Verifies no queue triggers exist in `api/`
2. Installs `api/` dependencies
3. Deploys to Azure Static Web Apps
4. SWA CI/CD now succeeds (no queue trigger validation errors)

**Run manually**: GitHub UI > Actions > "Deploy SWA (HTTP-only API)" > Run workflow

#### Worker Workflow (`.github/workflows/deploy-worker.yml`)

**Trigger**: Push to `main` when `worker/` changes  
**Action**:
1. Installs `worker/` dependencies
2. Verifies queue trigger configuration
3. Deploys to `tabarnam-xai-dedicated` Function App
4. Checks worker health endpoint

**Secrets required**:
- `WORKER_FUNCTIONAPP_PUBLISH_PROFILE`: Obtained from Azure Portal > Function App > Get Publish Profile

**Run manually**: GitHub UI > Actions > "Deploy Worker (Queue Trigger)" > Run workflow

---

## Verification Steps

### 1. Verify Configuration (Diagnostics Endpoint)

```bash
curl https://tabarnam.com/api/diag/queue-mismatch
```

Expected response:
```json
{
  "ok": true,
  "mode": "external_worker",
  "issue": {
    "title": "Queue Trigger Configuration (External Worker Mode)",
    "detected": false,
    "risk": "LOW"
  },
  "enqueue_side": {
    "resolved_storage_account": "tabarnamstor2356",
    "queue_name": "import-resume-worker"
  },
  "worker_side": {
    "mode": "external",
    "worker_base_url": "https://tabarnam-xai-dedicated.azurewebsites.net",
    "worker_configured": true,
    "worker_health_status": "reachable",
    "worker_health_ok": true
  },
  "fix": ["External worker mode is properly configured. Queue processing is delegated to dedicated worker."]
}
```

**Risk levels**:
- `LOW`: Everything configured correctly
- `HIGH`: Worker unreachable or health endpoint not responding
- `CRITICAL`: Required settings missing (WORKER_BASE_URL, storage connection)

### 2. Verify Worker Health

```bash
curl https://tabarnam-xai-dedicated.azurewebsites.net/api/health
```

Expected response:
```json
{
  "ok": true,
  "service": "tabarnam-xai-dedicated",
  "timestamp": "2026-01-28T10:30:00Z",
  "build_id": "abc123",
  "hostname": "tabarnam-xai-dedicated.azurewebsites.net",
  "environment": "production"
}
```

### 3. Test Queue Processing

```bash
# 1. Start a new import session
curl -X POST https://tabarnam.com/api/import-start \
  -H "Content-Type: application/json" \
  -d '{ "domain": "example.com" }'

# Extract session_id from response
SESSION_ID="<copy-from-response>"

# 2. Monitor import status
curl "https://tabarnam.com/api/import/status?session_id=$SESSION_ID"

# 3. Verify resume worker processing (check for non-null timestamps)
# Look for: "resume_worker.handler_entered_at", "resume_worker.last_finished_at"
# Before fix: these would be null (worker never ran)
# After fix: these should have timestamps within ~10 seconds of your request
```

### 4. Check Worker Logs

Azure Portal > Function App (`tabarnam-xai-dedicated`) > Functions > `import-resume-worker-queue-trigger`

Look for:
- Successful queue trigger invocations
- Message dequeue logs
- Handler execution logs
- No "Queue trigger not supported" errors

---

## Troubleshooting

### Issue: Diagnostics shows "CRITICAL" risk

**Cause**: Missing WORKER_BASE_URL or QUEUE_TRIGGER_MODE not set to "external"

**Fix**:
```bash
# In Azure Portal > Static Web App > Settings > Application Settings:
# 1. Add/update: QUEUE_TRIGGER_MODE = external
# 2. Add/update: WORKER_BASE_URL = https://tabarnam-xai-dedicated.azurewebsites.net

# Then redeploy SWA to refresh app settings
```

### Issue: Worker health check returns 404

**Cause**: Health endpoint not deployed or worker function app not running

**Fix**:
1. Redeploy worker: `git push` with changes to `worker/` folder
2. Or manually run workflow: GitHub > Actions > "Deploy Worker" > Run workflow
3. Verify worker/functions/health/index.js exists
4. Check Function App status in Azure Portal

### Issue: Queue messages accumulate but worker doesn't process them

**Cause**: 
- Worker not polling queue (not running)
- Storage account mismatch
- Queue name mismatch

**Debug**:
1. Check diagnostics: `curl https://tabarnam.com/api/diag/queue-mismatch`
2. Verify `AzureWebJobsStorage` points to correct storage account (tabarnamstor2356)
3. Verify queue name: should be `import-resume-worker`
4. Check worker logs for connection errors
5. In Azure Portal > Storage Account > Queues, verify queue exists and has pending messages

### Issue: SWA deployment fails with "invalid trigger type"

**Cause**: Queue trigger definition still exists in `api/` folder

**Fix**:
1. Ensure `api/import/resume-worker/index.js` has ONLY the HTTP endpoint
2. Run: `grep -r "storageQueue\|queueTrigger" api/` and remove any matches
3. Redeploy SWA

---

## Deployment Checklist

- [ ] **SWA Configuration**:
  - [ ] `QUEUE_TRIGGER_MODE` = `external`
  - [ ] `WORKER_BASE_URL` = `https://tabarnam-xai-dedicated.azurewebsites.net`
  - [ ] Keep existing enqueue settings (AZURE_STORAGE_CONNECTION_STRING, etc.)

- [ ] **Worker Configuration** (`tabarnam-xai-dedicated`):
  - [ ] `AzureWebJobsStorage` points to `tabarnamstor2356`
  - [ ] `COSMOS_DB_ENDPOINT`, `COSMOS_DB_KEY`, `COSMOS_DB_DATABASE` configured
  - [ ] `ENRICHMENT_QUEUE_CONNECTION_SETTING` = `AzureWebJobsStorage` (or unset to default)

- [ ] **Code**:
  - [ ] No queue triggers in `api/` folder
  - [ ] Queue trigger in `worker/functions/import-resume-worker/index.js`
  - [ ] Health endpoint in `worker/functions/health/index.js`
  - [ ] Diagnostics updated to recognize external mode

- [ ] **GitHub Actions**:
  - [ ] `.github/workflows/deploy-swa.yml` in place
  - [ ] `.github/workflows/deploy-worker.yml` in place
  - [ ] Secrets configured: `WORKER_FUNCTIONAPP_PUBLISH_PROFILE`

- [ ] **Testing**:
  - [ ] `GET /api/diag/queue-mismatch` shows `mode: "external_worker"` and `risk: "LOW"`
  - [ ] `GET /api/health` (worker) returns `ok: true`
  - [ ] New import processes queue messages successfully
  - [ ] Resume worker handler logs show execution

---

## Architecture Diagrams

### Flow: Import Enqueue → Queue → Worker Processing

```
1. User initiates import (POST /api/import-start)
   ↓
2. SWA API: /api/import-start → enqueues message to tabarnamstor2356/import-resume-worker
   ↓
3. Queue service detects new message
   ↓
4. tabarnam-xai-dedicated worker: Queue trigger fires
   ↓
5. Worker function: import-resume-worker-queue-trigger → calls shared handler
   ↓
6. Shared handler (api/import/resume-worker/handler.js):
   - Connects to Cosmos DB
   - Fetches seed companies
   - Enriches data via Grok API
   - Updates Cosmos docs
   - Optionally re-enqueues for next cycle
   ↓
7. Response logged to worker app insights / Function App logs
```

### HTTP Request Flow (For Comparison)

```
1. User: POST /api/import/resume-worker?session_id=xyz (optional manual trigger)
   ↓
2. SWA API: HTTP endpoint routes to shared handler
   ↓
3. Shared handler executes same logic as queue version
   ↓
4. Response returned to client (HTTP 200 or error)
```

---

## Performance & Scaling

### SWA API
- Scales with demand
- No queue trigger overhead
- HTTP endpoints respond immediately

### Dedicated Worker
- Scales independently from SWA
- Queue trigger polling: ~10-30 second latency per message
- Configurable function timeout: `00:10:00` (10 minutes) in `worker/host.json`
- Batch processing: configurable via host.json extensions

### Storage Account
- Both enqueue and worker trigger use same connection to `tabarnamstor2356`
- Queue: `import-resume-worker`
- No cross-account issues or mismatches

---

## Monitoring & Alerts

### Key Metrics to Monitor

1. **Queue Depth**: Azure Portal > Storage Account > Queues > `import-resume-worker`
   - Should process messages within 30 seconds
   - If depth > 100 and not decreasing: worker may be failing

2. **Worker Execution**: Azure Portal > Function App > Functions > `import-resume-worker-queue-trigger`
   - Monitor success rate
   - Check error logs for handler failures

3. **Diagnostics Endpoint**: `GET /api/diag/queue-mismatch`
   - Regularly check `risk` level
   - If `CRITICAL` or `HIGH`: investigate immediately

4. **Worker Health**: `GET /api/health` (worker)
   - Should return 200 OK
   - If 500+: worker is in error state

### Alert Recommendations

- Alert if `GET /api/diag/queue-mismatch` returns `risk: "HIGH"` or `"CRITICAL"`
- Alert if `GET /api/health` returns non-200 status
- Alert if queue depth exceeds threshold (e.g., 50 messages)
- Alert if worker invocation failure rate > 5%

---

## References

- [Azure Static Web Apps FAQ](https://learn.microsoft.com/en-us/azure/static-web-apps/faq)
- [Azure Functions Queue Storage Trigger](https://learn.microsoft.com/en-us/azure/azure-functions/functions-bindings-storage-queue-trigger)
- [Bring Your Own Functions App to SWA](https://learn.microsoft.com/en-us/azure/static-web-apps/functions-bring-your-own)
- [Azure Functions Best Practices](https://learn.microsoft.com/en-us/azure/azure-functions/functions-best-practices)

---

## Version History

| Date | Author | Change |
|------|--------|--------|
| 2026-01-28 | AI Assistant | Initial external worker mode architecture & runbook |

---

## Questions or Issues?

For questions about this implementation:
1. Check the **Troubleshooting** section above
2. Review diagnostics output: `GET /api/diag/queue-mismatch`
3. Check GitHub Actions workflow logs
4. Review worker Function App logs in Azure Portal
