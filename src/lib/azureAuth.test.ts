import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  __resetAuthCachesForTest,
  fetchAdminRoster,
  getAdminUser,
  getAuthorizedAdminEmails,
  getAdminPortalEmails,
  getContributorEmails,
  getCurrentRole,
  isContributor,
} from "./azureAuth";

// The admin allowlist lives on the BACKEND (api/_adminAuth.js). The frontend
// fetches it via /api/xadmin-api-roster; the hardcoded list here is only a
// pre-fetch fallback. These tests pin that contract so "add an admin on the
// backend, everything follows" keeps holding.

function mockRosterResponse(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }))
  );
}

beforeEach(() => {
  sessionStorage.clear();
  __resetAuthCachesForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getAuthorizedAdminEmails", () => {
  test("before any fetch, serves the hardcoded fallback", () => {
    expect(getAuthorizedAdminEmails()).toContain("jon@tabarnam.com");
  });

  test("after a roster fetch, serves the backend list — including admins the fallback doesn't know", async () => {
    mockRosterResponse({ ok: true, admins: ["jon@tabarnam.com", "newperson@tabarnam.com"] });
    const result = await fetchAdminRoster();
    expect(result.status).toBe("ok");
    expect(getAuthorizedAdminEmails()).toEqual(["jon@tabarnam.com", "newperson@tabarnam.com"]);
  });

  test("roster survives a module-cache reset via sessionStorage (page reload)", async () => {
    mockRosterResponse({ ok: true, admins: ["jon@tabarnam.com", "newperson@tabarnam.com"] });
    await fetchAdminRoster();
    __resetAuthCachesForTest(); // simulates a fresh module load; sessionStorage persists
    expect(getAuthorizedAdminEmails()).toContain("newperson@tabarnam.com");
  });

  test("a failed fetch leaves the fallback in place (no lockout)", async () => {
    mockRosterResponse({ error: "boom" }, 500);
    const result = await fetchAdminRoster();
    expect(result.status).toBe("error");
    expect(getAuthorizedAdminEmails()).toContain("jon@tabarnam.com");
  });

  test("403 reports forbidden — the caller is authenticated but not an admin", async () => {
    mockRosterResponse({ error: "Forbidden" }, 403);
    expect((await fetchAdminRoster()).status).toBe("forbidden");
  });

  // Regression: a 401 used to be reported as 'forbidden', so an expired or
  // not-yet-attached session told a legitimate admin "your account is not
  // authorized". 401 means re-authenticate, NOT unauthorized.
  test("401 reports unauthenticated — session expired, not an authorization failure", async () => {
    mockRosterResponse({ error: "Unauthorized", auth_error: "missing_auth" }, 401);
    expect((await fetchAdminRoster()).status).toBe("unauthenticated");
  });

  test("an empty admins array is treated as an error, never an empty allowlist", async () => {
    mockRosterResponse({ ok: true, admins: [] });
    expect((await fetchAdminRoster()).status).toBe("error");
    expect(getAuthorizedAdminEmails().length).toBeGreaterThan(0);
  });
});

describe("getAdminUser", () => {
  test("recognizes a session email that only the FETCHED roster contains", async () => {
    sessionStorage.setItem("azure_user_email", "newperson@tabarnam.com");
    expect(getAdminUser()).toBeNull(); // fallback list doesn't know them yet

    mockRosterResponse({ ok: true, admins: ["jon@tabarnam.com", "newperson@tabarnam.com"] });
    await fetchAdminRoster();
    expect(getAdminUser()?.email).toBe("newperson@tabarnam.com");
  });
});

// ── Contributor role ────────────────────────────────────────────────
// The two lists must stay separate. `admins` feeds owner/person dropdowns —
// companies are assigned to staff, and a contributor must not be able to hand
// work to themselves. The union only decides whether the portal renders.

describe("contributor role", () => {
  test("admins and contributors are kept in separate lists", async () => {
    mockRosterResponse({
      ok: true,
      admins: ["jon@tabarnam.com"],
      contributors: ["dana@tabarnam.com"],
      role: "admin",
    });
    await fetchAdminRoster();

    expect(getAuthorizedAdminEmails()).toEqual(["jon@tabarnam.com"]);
    expect(getContributorEmails()).toEqual(["dana@tabarnam.com"]);
  });

  test("a contributor never appears in the owner-dropdown source", async () => {
    mockRosterResponse({
      ok: true,
      admins: ["jon@tabarnam.com"],
      contributors: ["dana@tabarnam.com"],
      role: "contributor",
    });
    await fetchAdminRoster();

    expect(getAuthorizedAdminEmails()).not.toContain("dana@tabarnam.com");
  });

  test("the portal list is the union of both", async () => {
    mockRosterResponse({
      ok: true,
      admins: ["jon@tabarnam.com"],
      contributors: ["dana@tabarnam.com"],
      role: "admin",
    });
    await fetchAdminRoster();

    expect(getAdminPortalEmails().sort()).toEqual(["dana@tabarnam.com", "jon@tabarnam.com"]);
  });

  test("the caller's own role is exposed for UI gating", async () => {
    mockRosterResponse({ ok: true, admins: ["jon@tabarnam.com"], contributors: ["dana@tabarnam.com"], role: "contributor" });
    await fetchAdminRoster();

    expect(getCurrentRole()).toBe("contributor");
    expect(isContributor()).toBe(true);
  });

  test("an admin is not treated as scoped", async () => {
    mockRosterResponse({ ok: true, admins: ["jon@tabarnam.com"], contributors: [], role: "admin" });
    await fetchAdminRoster();

    expect(isContributor()).toBe(false);
  });

  test("before the roster resolves, nothing is assumed scoped", () => {
    // A null role must not read as "contributor" — that would hide staff nav
    // on a slow first load.
    expect(getCurrentRole()).toBeNull();
    expect(isContributor()).toBe(false);
  });

  test("a roster without the new fields degrades to admins-only", async () => {
    // An older API build, or a cached response from before this change.
    mockRosterResponse({ ok: true, admins: ["jon@tabarnam.com"] });
    await fetchAdminRoster();

    expect(getContributorEmails()).toEqual([]);
    expect(getCurrentRole()).toBeNull();
    expect(getAdminPortalEmails()).toEqual(["jon@tabarnam.com"]);
  });

  test("an unrecognised role value is ignored rather than trusted", async () => {
    mockRosterResponse({ ok: true, admins: ["jon@tabarnam.com"], role: "superuser" });
    await fetchAdminRoster();

    expect(getCurrentRole()).toBeNull();
  });

  test("role and contributors survive a page reload via sessionStorage", async () => {
    mockRosterResponse({
      ok: true,
      admins: ["jon@tabarnam.com"],
      contributors: ["dana@tabarnam.com"],
      role: "contributor",
    });
    await fetchAdminRoster();

    // Simulate a fresh module load with sessionStorage intact.
    __resetAuthCachesForTest();

    expect(getCurrentRole()).toBe("contributor");
    expect(getContributorEmails()).toEqual(["dana@tabarnam.com"]);
  });
});
