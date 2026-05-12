/**
 * Phase 3.5 — active-imports tracking shared by AdminImport.jsx (writer) and
 * CompanyDashboard.jsx (reader).
 *
 * Goal: give the Companies dashboard a way to know which company rows are
 * CURRENTLY being imported so it can render an "Importing…" badge instead of
 * a misleading "Stub-0%" badge while the resume-worker is still running.
 *
 * Mechanism: a small JSON document in localStorage, keyed by company_id,
 * each entry storing { session_id, company_id, updated_at_ms, status }.
 * Entries auto-expire after IMPORT_PROGRESS_TTL_MS to defend against
 * AdminImport crashing or being closed mid-import.
 *
 * Both same-tab (via window CustomEvent) and cross-tab (via storage event)
 * propagation are supported.
 *
 * NEVER fabricate company_ids or session_ids. Pass through the actual values
 * the polling response provides.
 */

const STORAGE_KEY = "tabarnam_active_imports_v1";
export const IMPORT_PROGRESS_TTL_MS = 10 * 60_000; // 10 min — covers worst-case
export const IMPORT_PROGRESS_EVENT = "tabarnam:import-progress";

function safeNow() {
  return Date.now();
}

function isBrowser() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function readMap() {
  if (!isBrowser()) return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeMap(map) {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* quota / privacy mode — ignore */
  }
}

function isExpired(entry, now = safeNow()) {
  if (!entry || typeof entry !== "object") return true;
  const ts = Number(entry.updated_at_ms || 0);
  if (!Number.isFinite(ts) || ts <= 0) return true;
  return (now - ts) > IMPORT_PROGRESS_TTL_MS;
}

function pruneExpired(map) {
  const now = safeNow();
  let mutated = false;
  for (const key of Object.keys(map)) {
    if (isExpired(map[key], now)) {
      delete map[key];
      mutated = true;
    }
  }
  return mutated;
}

/**
 * Returns the full active-imports map with expired entries pruned.
 * Keys are company_id (preferred) or session_id (fallback when no company_id known).
 */
export function getActiveImports() {
  const map = readMap();
  if (pruneExpired(map)) writeMap(map);
  return map;
}

/**
 * Returns true if the given row is currently in an active import session.
 *
 * Matches on company_id (row.id or row.company_id). Falls back to session_id
 * stored on the doc (row.import_session_id).
 */
export function isRowActivelyImporting(row, activeMap = null) {
  if (!row || typeof row !== "object") return false;
  const map = activeMap || getActiveImports();
  if (!map || Object.keys(map).length === 0) return false;

  const candidates = [
    row.id,
    row.company_id,
    row.import_session_id,
  ]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter(Boolean);

  for (const key of candidates) {
    const entry = map[key];
    if (entry && !isExpired(entry)) return true;
  }
  // Also scan values' session_id / company_id (since map is keyed both ways).
  const rowSessionId = typeof row.import_session_id === "string" ? row.import_session_id.trim() : "";
  if (rowSessionId) {
    for (const entry of Object.values(map)) {
      if (entry && !isExpired(entry) && entry.session_id === rowSessionId) return true;
    }
  }
  return false;
}

/**
 * Mark a session as actively importing. Called by AdminImport on each poll
 * cycle. company_id is optional (may not be known until after import-start
 * returns the verified id).
 *
 * Idempotent — re-marking the same session just refreshes the timestamp,
 * preventing TTL expiry on long-running imports.
 */
export function markImportActive(opts) {
  if (!isBrowser()) return;
  const { session_id, company_id, status } = (opts && typeof opts === "object") ? opts : {};
  const sid = typeof session_id === "string" ? session_id.trim() : "";
  const cid = typeof company_id === "string" ? company_id.trim() : "";
  if (!sid && !cid) return;

  const map = readMap();
  pruneExpired(map);

  const entry = {
    session_id: sid || null,
    company_id: cid || null,
    status: typeof status === "string" ? status.trim() : null,
    updated_at_ms: safeNow(),
  };

  // Key by company_id primarily so dashboard rows can lookup by id.
  // Also write a session_id-keyed entry so we can find by session before the
  // company_id is known (e.g., right after import-start).
  if (cid) map[cid] = entry;
  if (sid && !cid) map[sid] = entry;
  if (sid && cid && !map[sid]) map[sid] = entry;

  writeMap(map);

  try {
    window.dispatchEvent(new CustomEvent(IMPORT_PROGRESS_EVENT, {
      detail: { action: "active", session_id: sid || null, company_id: cid || null, status: entry.status },
    }));
  } catch { /* non-browser env */ }
}

/**
 * Remove a session from the active-imports map. Called when the AdminImport
 * dispatcher determines the session has reached a terminal state.
 */
export function markImportInactive(opts) {
  if (!isBrowser()) return;
  const { session_id, company_id } = (opts && typeof opts === "object") ? opts : {};
  const sid = typeof session_id === "string" ? session_id.trim() : "";
  const cid = typeof company_id === "string" ? company_id.trim() : "";
  if (!sid && !cid) return;

  const map = readMap();
  let mutated = false;
  if (cid && map[cid]) { delete map[cid]; mutated = true; }
  if (sid && map[sid]) { delete map[sid]; mutated = true; }
  // Also scan for matching entries to clean up the cross-keyed records.
  for (const key of Object.keys(map)) {
    const entry = map[key];
    if (entry && (entry.session_id === sid || (cid && entry.company_id === cid))) {
      delete map[key];
      mutated = true;
    }
  }
  if (mutated) writeMap(map);

  try {
    window.dispatchEvent(new CustomEvent(IMPORT_PROGRESS_EVENT, {
      detail: { action: "inactive", session_id: sid || null, company_id: cid || null },
    }));
  } catch { /* non-browser env */ }
}

/**
 * Convenience: returns true if there are any non-expired active import entries.
 * Used by CompanyDashboard to decide between fast-poll (10s) and normal-poll (60s).
 */
export function hasActiveImports() {
  const map = getActiveImports();
  return Object.keys(map).length > 0;
}
