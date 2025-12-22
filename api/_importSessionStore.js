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
