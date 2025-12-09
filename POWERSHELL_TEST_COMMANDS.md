# PowerShell Testing Commands for XAI Import API

## Configuration

Replace `https://thankful-mushroom-0000a931e.2.azurestaticapps.net` with your actual Static Web Apps deployment URL if different.

```powershell
# Set this to your actual deployment URL
$baseUrl = "https://thankful-mushroom-0000a931e.2.azurestaticapps.net"
$apiBase = "$baseUrl/api"

# Or if testing locally:
# $apiBase = "http://localhost:5173/api"
```

---

## Test 1: Kick Off an Import for "omega-3" in USA with target of 1 result

```powershell
$baseUrl = "https://thankful-mushroom-0000a931e.2.azurestaticapps.net"
$apiBase = "$baseUrl/api"

$body = @{
    search_value   = "omega-3"
    target_results = 1
    country        = "USA"
    timeout_ms     = 240000
    queryType      = "product_keyword"
    query          = "omega-3"
    limit          = 1
    expand_if_few  = $false
} | ConvertTo-Json

Write-Host "Starting import..." -ForegroundColor Green
$resp = Invoke-WebRequest -Uri "$apiBase/import/start" `
  -Method POST `
  -ContentType "application/json" `
  -Body $body

Write-Host "Status Code: $($resp.StatusCode)" -ForegroundColor Green
$respJson = $resp.Content | ConvertFrom-Json
Write-Host "Response:" -ForegroundColor Green
$respJson | ConvertTo-Json -Depth 10

$sessionId = $respJson.session_id
Write-Host "Session ID: $sessionId" -ForegroundColor Cyan
Write-Host "Save Result: saved=$($respJson.saved), skipped=$($respJson.skipped), failed=$($respJson.failed)" -ForegroundColor Cyan
```

**Expected Output for successful import:**
- `ok: true`
- `session_id: <guid>`
- `saved: 1` (or higher if expansion finds more)
- `companies: [...]` (array of company objects with name, url, location fields)

**Expected Output if no results:**
- `ok: true`
- `session_id: <guid>`
- `saved: 0`
- `companies: []`
- `meta.no_results_reason: "XAI returned empty response"`

---

## Test 2: Poll Progress for a Known Session

```powershell
# Replace with the session ID from Test 1
$sessionId = "<paste-session-id-here>"

$apiBase = "https://thankful-mushroom-0000a931e.2.azurestaticapps.net/api"

Write-Host "Polling progress for session: $sessionId" -ForegroundColor Green
$prog = Invoke-WebRequest -Uri "$apiBase/import/progress?session_id=$sessionId" `
  -Method GET

Write-Host "Status Code: $($prog.StatusCode)" -ForegroundColor Green
$progJson = $prog.Content | ConvertFrom-Json
Write-Host "Response:" -ForegroundColor Green
$progJson | ConvertTo-Json -Depth 5

Write-Host ""
Write-Host "Summary:" -ForegroundColor Cyan
Write-Host "  - Session: $($progJson.session_id)" -ForegroundColor Cyan
Write-Host "  - Found: $($progJson.saved) companies" -ForegroundColor Cyan
Write-Host "  - Stopped: $($progJson.stopped)" -ForegroundColor Cyan
Write-Host "  - Timed Out: $($progJson.timedOut)" -ForegroundColor Cyan
```

**Expected Output when import is running:**
- `ok: true`
- `saved: 0` (if not started saving yet) or `>0` (if already saving)
- `stopped: false`
- `timedOut: false`
- `items: []` or `[...]` (list of companies found so far)

**Expected Output when import is stopped:**
- `ok: true`
- `stopped: true`
- `timedOut: false`

**Expected Output when import timed out:**
- `ok: true`
- `stopped: true` (will also be true for timeout)
- `timedOut: true`

---

## Test 3: Stop an Import Session

```powershell
# Replace with the session ID from Test 1
$sessionId = "<paste-session-id-here>"

$apiBase = "https://thankful-mushroom-0000a931e.2.azurestaticapps.net/api"

$stopBody = @{ session_id = $sessionId } | ConvertTo-Json

Write-Host "Stopping session: $sessionId" -ForegroundColor Yellow
$stop = Invoke-WebRequest -Uri "$apiBase/import/stop" `
  -Method POST `
  -ContentType "application/json" `
  -Body $stopBody

Write-Host "Status Code: $($stop.StatusCode)" -ForegroundColor Green
$stopJson = $stop.Content | ConvertFrom-Json
Write-Host "Response:" -ForegroundColor Green
$stopJson | ConvertTo-Json

Write-Host ""
Write-Host "Check progress again to verify stop signal took effect:" -ForegroundColor Cyan
$prog = Invoke-WebRequest -Uri "$apiBase/import/progress?session_id=$sessionId" `
  -Method GET
$progJson = $prog.Content | ConvertFrom-Json
Write-Host "  - Stopped: $($progJson.stopped)" -ForegroundColor Cyan
Write-Host "  - Timed Out: $($progJson.timedOut)" -ForegroundColor Cyan
Write-Host "  - Companies Found: $($progJson.saved)" -ForegroundColor Cyan
```

**Expected Output from stop:**
- `ok: true`
- `session_id: <sessionId>`
- `written: true` (if stop signal was successfully written)
- `message: "Import stop signal sent"`

**Then polling progress should show:**
- `stopped: true`
- `timedOut: false`

---

## Test 4: Complete Workflow (Test + Poll + Stop)

```powershell
# Set your base URL
$apiBase = "https://thankful-mushroom-0000a931e.2.azurestaticapps.net/api"

Write-Host "=== STARTING IMPORT ===" -ForegroundColor Cyan

# Start import
$body = @{
    queryType      = "product_keyword"
    query          = "omega-3"
    limit          = 1
    timeout_ms     = 240000
    expand_if_few  = $false
} | ConvertTo-Json

$resp = Invoke-WebRequest -Uri "$apiBase/import/start" `
  -Method POST `
  -ContentType "application/json" `
  -Body $body

$sessionId = ($resp.Content | ConvertFrom-Json).session_id
Write-Host "Session ID: $sessionId" -ForegroundColor Green

# Poll 3 times with 2-second delays
for ($i = 1; $i -le 3; $i++) {
    Start-Sleep -Seconds 2
    Write-Host ""
    Write-Host "=== POLL #$i ===" -ForegroundColor Cyan
    
    $prog = Invoke-WebRequest -Uri "$apiBase/import/progress?session_id=$sessionId" `
      -Method GET
    
    $progJson = $prog.Content | ConvertFrom-Json
    Write-Host "Found: $($progJson.saved) | Stopped: $($progJson.stopped) | TimedOut: $($progJson.timedOut)" -ForegroundColor Green
    
    if ($progJson.saved -gt 0) {
        Write-Host "Companies:" -ForegroundColor Green
        $progJson.items | ForEach-Object { Write-Host "  - $($_.company_name) ($($_.url))" }
    }
}

# Stop the import
Write-Host ""
Write-Host "=== STOPPING IMPORT ===" -ForegroundColor Yellow
$stopBody = @{ session_id = $sessionId } | ConvertTo-Json
$stop = Invoke-WebRequest -Uri "$apiBase/import/stop" `
  -Method POST `
  -ContentType "application/json" `
  -Body $stopBody

Write-Host "Stop response: $($stop.Content)" -ForegroundColor Green

# Poll one more time to confirm stop
Start-Sleep -Seconds 1
Write-Host ""
Write-Host "=== POLL AFTER STOP ===" -ForegroundColor Cyan
$prog = Invoke-WebRequest -Uri "$apiBase/import/progress?session_id=$sessionId" `
  -Method GET
$progJson = $prog.Content | ConvertFrom-Json
Write-Host "Found: $($progJson.saved) | Stopped: $($progJson.stopped) | TimedOut: $($progJson.timedOut)" -ForegroundColor Green
```

---

## Test 5: Check Backend Logs

After running the tests above, check the Azure Function logs for this session to see the explicit logging:

```powershell
# You'll need to check these in Azure Portal:
# 1. Go to the Function App: tabarnam-xai-dedicated (or your deployment)
# 2. Click "import-start", "import-progress", "import-stop" functions
# 3. Look at "Monitor" → "Application Insights" or "Logs"
# 4. Filter by your session_id to see all logs for that session

# Expected logs for a successful import of "omega-3":
# [import-start] session=<id> start
# [import-start] session=<id> xai request payload = {...}
# [import-start] session=<id> xai response status=200 companies=1
# [import-start] session=<id> geocoding start count=1
# [import-start] session=<id> geocoding done success=1 failed=0
# [import-start] session=<id> saveCompaniesToCosmos start count=1
# [import-start] session=<id> saveCompaniesToCosmos done saved=1 skipped=0 duplicates=0

# Expected logs if no results:
# [import-start] session=<id> xai response status=200 companies=0
# [import-start] session=<id> no companies found in XAI response, returning early
```

---

## Troubleshooting

### Status codes you should see:
- **200 OK**: Import started successfully, or no results found
- **400 Bad Request**: Missing required parameter (e.g., no session_id in progress)
- **500 Server Error**: Backend error (check logs)
- **502 Bad Gateway**: XAI API call failed

### If you get 0 companies but expect results:

1. **Check if XAI API returned empty:**
   - Look for log: `[import-start] session=<id> xai response status=200 companies=0`
   - This means the XAI API didn't return any matches for "omega-3"
   
2. **Check if companies were filtered during save:**
   - Look for log: `[import-start] session=<id> saveCompaniesToCosmos done saved=0 skipped=N`
   - This means companies were found but skipped (likely duplicates)

3. **Check if Cosmos DB is working:**
   - Verify Cosmos connection string in environment variables
   - Check if documents were actually created in the "companies" container

4. **Check the stop signal:**
   - Query Cosmos for document with id `_import_stop_<sessionId>`
   - If it exists, the import was stopped prematurely

### To manually query Cosmos DB for a session:

Use Azure Data Studio or the Cosmos DB Data Explorer:

```sql
-- Find all companies from a specific session
SELECT * FROM c 
WHERE c.session_id = '<your-session-id>'
  AND NOT STARTSWITH(c.id, '_import_')
ORDER BY c.created_at DESC

-- Find control documents for a session
SELECT * FROM c 
WHERE STARTSWITH(c.id, '_import_') 
  AND c.session_id = '<your-session-id>'
```

