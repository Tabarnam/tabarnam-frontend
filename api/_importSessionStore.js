const MAX_SESSIONS = 200;

function getState() {
  if (!globalThis.__tabarnamImportSessionStore) {
    globalThis.__tabarnamImportSessionStore = {
      map: new Map(),
      order: [],
    };
  }
  return globalThis.__tabarnamImportSessionStore;
}

function prune(state) {
  while (state.order.length > MAX_SESSIONS) {
    const oldest = state.order.shift();
    if (oldest) state.map.delete(oldest);
  }
}

function normalizeSessionId(sessionId) {
  const sid = String(sessionId || "").trim();
  return sid || null;
}

function nowIso() {
  return new Date().toISOString();
}

function upsertSession(input) {
  const state = getState();
  const session_id = normalizeSessionId(input?.session_id);
  if (!session_id) return null;

  const prev = state.map.get(session_id) || null;

  const mergeUniqueStrings = (a, b) => {
    const left = Array.isArray(a) ? a : [];
    const right = Array.isArray(b) ? b : [];
    const out = [];
    const seen = new Set();

    for (const item of [...left, ...right]) {
      const value = String(item || "").trim();
      if (!value) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(value);
    }

    return out;
  };

  const saved_verified_count = Number.isFinite(Number(input?.saved_verified_count))
    ? Number(input.saved_verified_count)
    : Number.isFinite(Number(prev?.saved_verified_count))
      ? Number(prev.saved_verified_count)
      : null;

  const saved_company_ids_verified = mergeUniqueStrings(prev?.saved_company_ids_verified, input?.saved_company_ids_verified);
  const saved_company_ids_unverified = mergeUniqueStrings(prev?.saved_company_ids_unverified, input?.saved_company_ids_unverified);

  const next = {
    session_id,
    request_id: typeof input?.request_id === "string" && input.request_id.trim() ? input.request_id.trim() : prev?.request_id || null,
    status:
      typeof input?.status === "string" && input.status.trim()
        ? input.status.trim()
        : prev?.status || "running",
    stage_beacon:
      typeof input?.stage_beacon === "string" && input.stage_beacon.trim()
        ? input.stage_beacon.trim()
        : prev?.stage_beacon || "init",
    companies_count: Number.isFinite(Number(input?.companies_count))
      ? Number(input.companies_count)
      : Number.isFinite(Number(prev?.companies_count))
        ? Number(prev.companies_count)
        : 0,

    // Optional session doc fields: allow status endpoint to surface verified save state even when Cosmos
    // isn't configured (tests/local runs).
    saved: Number.isFinite(Number(input?.saved))
      ? Number(input.saved)
      : Number.isFinite(Number(prev?.saved))
        ? Number(prev.saved)
        : undefined,
    saved_verified_count,
    saved_company_ids_verified,
    saved_company_ids_unverified,
    saved_company_urls: mergeUniqueStrings(prev?.saved_company_urls, input?.saved_company_urls),
    save_outcome:
      typeof input?.save_outcome === "string" && input.save_outcome.trim()
        ? input.save_outcome.trim()
        : typeof prev?.save_outcome === "string" && prev.save_outcome.trim()
          ? prev.save_outcome.trim()
          : null,
    resume_needed:
      typeof input?.resume_needed === "boolean"
        ? input.resume_needed
        : typeof prev?.resume_needed === "boolean"
          ? prev.resume_needed
          : undefined,
    resume_error:
      typeof input?.resume_error === "string" && input.resume_error.trim()
        ? input.resume_error.trim()
        : typeof prev?.resume_error === "string" && prev.resume_error.trim()
          ? prev.resume_error.trim()
          : null,

    created_at: prev?.created_at || nowIso(),
    updated_at: nowIso(),
  };

  state.map.set(session_id, next);
  if (!prev) state.order.push(session_id);

  prune(state);
  return next;
}

function getSession(sessionId) {
  const state = getState();
  const sid = normalizeSessionId(sessionId);
  if (!sid) return null;
  return state.map.get(sid) || null;
}

module.exports = {
  upsertSession,
  getSession,
  _test: { getState },
};
