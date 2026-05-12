import { describe, test, expect, beforeEach } from "vitest";

// Phase 3.5 — activeImports.js drives the "Importing…" badge on the Companies
// dashboard. AdminImport writes to this store on each poll cycle (writer);
// CompanyDashboard reads it to decide which rows to badge (reader). These
// tests lock down the public API contract used at the boundary.

// In-memory window + localStorage polyfills so the browser-only module loads
// cleanly under Vitest's jsdom-or-node-without-jsdom env.
const listeners = new Map();
const storage = new Map();

beforeEach(() => {
  storage.clear();
  listeners.clear();
});

globalThis.window = {
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
    clear: () => storage.clear(),
  },
  addEventListener: (name, fn) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(fn);
  },
  removeEventListener: (name, fn) => {
    const set = listeners.get(name);
    if (set) set.delete(fn);
  },
  dispatchEvent: (evt) => {
    const set = listeners.get(evt.type);
    if (set) for (const fn of set) try { fn(evt); } catch { /* swallow */ }
  },
};
globalThis.CustomEvent = class {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail || null;
  }
};

const {
  markImportActive,
  markImportInactive,
  isRowActivelyImporting,
  hasActiveImports,
  getActiveImports,
  IMPORT_PROGRESS_EVENT,
} = await import("./activeImports.js");

describe("Phase 3.5 — activeImports", () => {
  test("markImportActive + isRowActivelyImporting matches by company_id", () => {
    markImportActive({ session_id: "sess_1", company_id: "co_1", status: "running" });
    expect(isRowActivelyImporting({ id: "co_1" })).toBe(true);
    expect(isRowActivelyImporting({ id: "co_2" })).toBe(false);
  });

  test("isRowActivelyImporting matches by import_session_id fallback", () => {
    markImportActive({ session_id: "sess_2", status: "running" });
    expect(isRowActivelyImporting({ id: "co_2", import_session_id: "sess_2" })).toBe(true);
  });

  test("markImportInactive removes the entry by session_id and company_id", () => {
    markImportActive({ session_id: "sess_3", company_id: "co_3", status: "running" });
    expect(isRowActivelyImporting({ id: "co_3" })).toBe(true);
    markImportInactive({ session_id: "sess_3", company_id: "co_3" });
    expect(isRowActivelyImporting({ id: "co_3" })).toBe(false);
    expect(hasActiveImports()).toBe(false);
  });

  test("hasActiveImports reflects map state", () => {
    expect(hasActiveImports()).toBe(false);
    markImportActive({ session_id: "sess_4", company_id: "co_4", status: "running" });
    expect(hasActiveImports()).toBe(true);
    markImportInactive({ session_id: "sess_4", company_id: "co_4" });
    expect(hasActiveImports()).toBe(false);
  });

  test("markImportActive is idempotent — re-marking same session refreshes timestamp", () => {
    markImportActive({ session_id: "sess_5", company_id: "co_5", status: "running" });
    const first = getActiveImports()["co_5"];
    const before = first.updated_at_ms;
    markImportActive({ session_id: "sess_5", company_id: "co_5", status: "running" });
    const second = getActiveImports()["co_5"];
    expect(second.updated_at_ms).toBeGreaterThanOrEqual(before);
    // Two keyed entries: by company_id AND by session_id (cross-keyed for lookup).
    expect(Object.keys(getActiveImports()).length).toBe(2);
  });

  test("empty / invalid inputs are no-ops", () => {
    markImportActive({ session_id: "", company_id: "" });
    markImportActive({});
    markImportActive(null);
    expect(hasActiveImports()).toBe(false);
    expect(isRowActivelyImporting(null)).toBe(false);
    expect(isRowActivelyImporting(undefined)).toBe(false);
    expect(isRowActivelyImporting({})).toBe(false);
  });

  test("dispatches IMPORT_PROGRESS_EVENT on active and inactive", () => {
    const seen = [];
    const handler = (e) => seen.push({ action: e?.detail?.action, sid: e?.detail?.session_id });
    globalThis.window.addEventListener(IMPORT_PROGRESS_EVENT, handler);

    markImportActive({ session_id: "sess_6", company_id: "co_6", status: "running" });
    markImportInactive({ session_id: "sess_6", company_id: "co_6" });

    globalThis.window.removeEventListener(IMPORT_PROGRESS_EVENT, handler);

    expect(seen).toEqual([
      { action: "active", sid: "sess_6" },
      { action: "inactive", sid: "sess_6" },
    ]);
  });
});
