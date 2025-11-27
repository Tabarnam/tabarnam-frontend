# Bulk Import Fixes: Manufacturing Locations & Distance Display

## Changes Made

### 1. Added Geocoding Function for HQ Locations
**File**: `api/import-start/index.js`

Added new `geocodeHQLocation()` async function that:
- Takes a headquarters location string (e.g., "Santa Monica, CA")
- Calls the `/api/google/geocode` endpoint to convert address to lat/lng
- Returns `{hq_lat, hq_lng}` coordinates for storage in the company document
- Gracefully handles failures with fallback values

**Impact**: Newly imported companies now have hq_lat/hq_lng set, enabling distance calculations in the frontend.

### 2. Integrated Geocoding into Import Pipeline
**File**: `api/import-start/index.js`

Added geocoding at three points in the import flow:
1. **After initial enrichment**: All companies from XAI get geocoded
2. **After refinement pass**: If headquarters_location was updated, re-geocode with the new value
3. **For expansion search results**: Expansion companies also get geocoded

**Impact**: All imported companies get proper lat/lng coordinates regardless of which code path they take.

### 3. Aggressive Manufacturing Location Extraction
**File**: `api/import-start/index.js`

Completely rewrote the XAI prompt to emphasize multi-source, aggressive extraction:

**Primary Sources** (checked first):
- Official website pages: Facilities, Plants, Manufacturing, "Where We Make"
- Product pages with "Made in..." labels
- FAQ and sustainability sections
- Job postings mentioning factory/plant/warehouse locations
- LinkedIn company profile

**Secondary Sources** (used when website is vague):
- **Import/export records**: Trade databases showing goods origin
- **Supplier databases**: Third-party sources listing known manufacturing partners
- **Packaging and labels**: "Made in..." text on actual products
- **Media and press**: Industry articles mentioning manufacturing
- **Financial filings**: SEC/regulatory documents with facility mentions
- **Product sourcing**: Material and component sourcing information

**Confidence and Red Flags**:
- Do NOT leave manufacturing_locations empty without checking ALL sources
- location_confidence: "high" for official site info, "medium" for secondary sources, "low" for limited sources
- Only set red_flag: true if there's TRULY no credible signal after checking all sources
- Do NOT flag companies with manufacturing inferred from suppliers/customs/packaging

**Result**: For companies like Ridge Wallet:
- Will find manufacturing locations from import/export records (China, Vietnam)
- Will extract from supplier data and packaging claims
- Will set appropriate location_confidence and red_flag values

### 4. Updated Expansion Search
**File**: `api/import-start/index.js`

Updated the expansion search prompt to:
- Explicitly require headquarters_location and manufacturing_locations
- Use the same aggressive, multi-source extraction guidelines
- Geocode results using the same pipeline

## Frontend Impact

The frontend distance calculation is already set up to use hq_lat/hq_lng:

**ResultsPage.jsx** (`attachDistances` function):
- Checks for `company.hq_lat` and `company.hq_lng`
- Computes distance using Haversine formula if coordinates exist
- Sets `_hqDist` for display

**ExpandableCompanyRow.jsx**:
- Displays `_hqDist` with formatted distance (miles/km based on user location)
- Shows "X miles away" next to HQ location

## Testing Ridge Import

To verify the fixes work:

1. **Import Ridge** via bulk importer (https://ridge.com/)
2. **Check Cosmos DB** for the imported Ridge company:
   - `headquarters_location` should be: "Santa Monica, CA"
   - `hq_lat` and `hq_lng` should be populated (e.g., ~34.0195, ~-118.4912)
   - `manufacturing_locations` should include at least ["China", "Vietnam"]
   - `location_confidence` should be "medium" or "low" (not high, since inferred from secondary sources)
3. **View on frontend**:
   - Ridge HQ should show "Santa Monica, CA" with distance label (e.g., "1,234.5 mi away")
   - Manufacturing locations should list China and Vietnam

## Key Files Changed
- `api/import-start/index.js`: Added geocoding function and updated XAI prompts for aggressive manufacturing location extraction
- `api/save-companies/index.js`: Added geocoding support for manual company saves
- `api/admin-companies/index.js`: Added geocoding support for admin company edits

## Consistency Across All Endpoints
All three company-saving endpoints now consistently geocode headquarters_location:
- **import-start**: Geocodes as part of bulk XAI import (and refinement/expansion)
- **save-companies**: Geocodes when manually saving companies
- **admin-companies**: Geocodes when admin updates companies

This ensures that whether a company is imported via XAI, saved manually, or edited in the admin panel, it always gets proper lat/lng coordinates for distance calculation.

## Backward Compatibility
All changes are backward compatible:
- Existing companies without hq_lat/hq_lng will continue to work
- Frontend gracefully handles missing coordinates
- Manufacturing locations work as both strings and objects
- If geocoding fails or is skipped, companies are saved without lat/lng (no errors)
