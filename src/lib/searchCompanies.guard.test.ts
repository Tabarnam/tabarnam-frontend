// Guards the "is this a complete search?" gate in searchCompanies/getSearchCount.
//
// Regression under test: the /made-in "Search within <country>" CTA links to
// /results?country=<display name>. ResultsPage blanks country/state/city into
// scope-only params (they rank, they never exclude), so a place-only search
// reaches the gate with the place named ONLY in scope — and the gate, which
// looked at the filter params alone, rejected it with "Please enter a search
// term…" on a link the user had just clicked.
//
// Every assertion here is on the pre-flight gate, which runs before any fetch,
// so these cases never touch the network.
import { describe, expect, it, vi } from "vitest";
import { searchCompanies, getSearchCount } from "./searchCompanies";

const NO_INPUT = /Please enter a search term/;

describe("searchCompanies place gate", () => {
  it("rejects a search with no query, no place and no domain", async () => {
    await expect(searchCompanies({})).rejects.toThrow(NO_INPUT);
  });

  it("accepts a scope-only search (the blanked-filter path)", async () => {
    // Fetch is stubbed rather than asserted on: reaching it at all is the
    // proof that the gate let this through.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network stub"));
    try {
      await expect(searchCompanies({ scopeCountry: "US" })).rejects.not.toThrow(NO_INPUT);
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it.each([
    ["scopeCountry", { scopeCountry: "US" }],
    ["scopeRegion", { scopeRegion: "US-CA" }],
    ["scopeCity", { scopeCity: "Portland" }],
  ])("treats %s as a location for the count call", async (_label, opts) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network stub"));
    try {
      // getSearchCount returns null when it decides the search is incomplete;
      // it swallows network failures, so a non-null-by-way-of-fetch outcome is
      // indistinguishable from a throw. Assert on the gate via fetch instead.
      await getSearchCount(opts).catch(() => null);
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("still returns null from the count call when nothing is specified", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network stub"));
    try {
      await expect(getSearchCount({})).resolves.toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("keeps accepting a bare domain search (no query, no place)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network stub"));
    try {
      await expect(searchCompanies({ domain: "example.com" })).rejects.not.toThrow(NO_INPUT);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
