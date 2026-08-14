import { describe, expect, test } from "vitest";
import { __test } from "./staleBuildRecovery";

// After a deploy the old hashed chunks are gone from the server, so a tab that
// was already open dies the moment it needs one it hasn't loaded yet. We detect
// that specific failure and reload once — but ONLY that one, because reloading
// on any error is how you build a reload loop out of an offline user.

const { looksLikeStaleBuild } = __test;

describe("stale build detection", () => {
  test("matches the browser messages for a missing chunk", () => {
    for (const msg of [
      "Failed to fetch dynamically imported module: https://tabarnam.com/assets/AdminAuditLog-DwDnFSfb.js",
      "error loading dynamically imported module",
      "Importing a module script failed.",
    ]) {
      expect(looksLikeStaleBuild(new Error(msg))).toBe(true);
    }
  });

  test("accepts a bare string reason", () => {
    expect(looksLikeStaleBuild("Failed to fetch dynamically imported module")).toBe(true);
  });

  test("reads a nested rejection reason", () => {
    expect(
      looksLikeStaleBuild({ reason: { message: "Failed to fetch dynamically imported module" } })
    ).toBe(true);
  });

  test("does NOT match ordinary failures — reloading on those loops", () => {
    for (const msg of [
      "NetworkError when attempting to fetch resource",
      "Failed to fetch",
      "Unexpected token < in JSON at position 0",
      "TypeError: undefined is not a function",
    ]) {
      expect(looksLikeStaleBuild(new Error(msg))).toBe(false);
    }
  });

  test("survives null and undefined without throwing", () => {
    expect(looksLikeStaleBuild(null)).toBe(false);
    expect(looksLikeStaleBuild(undefined)).toBe(false);
    expect(looksLikeStaleBuild({})).toBe(false);
  });
});
